// 生成「自动播放器」数据包函数（实体音符盒发声版）：
//   每个音符：在音符盒**水平相邻**的空位瞬放红石块、下一刻拆掉 —— 音符盒收到充能就自己发声（真·红石音乐）
//   同时点亮它正下方两格处的红石灯做视觉指示
//
// M3-37（2026-09-19）：触发位必须在**同一层的水平相邻格**。无头实验证明 1.21.10 里
// 红石块放在正上方 / 正下方 / 隔着导体甲板下方都**不会**触发音符盒（docs/M3-37-noteblock-trigger-matrix.md）。
// 触发位由 src/emit/trigger-map.mjs 统一算（与 note-blocks.mjs 摆块/清位同源）。
// 发声默认走音符盒本体（`#nb=1` + `#snd=0`）：装了 mod 由 mixin 换成无损采样，
// 没装 mod 就是原版音符盒声；`/function styx:play/sound_on` 可切回"数据包直派 mod 引擎"。
//
// 生成物（两级派发，单刻只碰「当前组里的桶」）：
//   styx:play/tick            每刻入口（tick 标签指向它）
//   styx:play/lo/tick|binNN|bNNN   20 tps 模式（默认，无需任何前置操作）
//   styx:play/hi/tick|binNN|bNNN   100 tps 模式（需玩家先在聊天里执行 /tick rate 100）
//   styx:play/start  start_hi  stop  reset  report  doctor(+probe/check)  monitor_on/off
//
// 为什么不写 `/tick rate`（2026-09-14 实测，见 docs/DISCUSSION-B-architecture.md）：
//   数据包函数以权限等级 2 运行，而 `/tick rate` 需要等级 3 —— 含该命令的函数会整文件加载失败，
//   于是 `styx:play/start` 变成 Unknown function，redo 链的最后一步静默失败、世界还停在 20 tps，
//   而谱面按 100 tps 计时 → 整曲被拉成 5 倍慢。现在刻率完全由玩家/控制台决定，函数只负责按模式取表。
import fs from 'node:fs';
import {
  STEP_SECONDS, switchTick, buildTickGroups, planBuckets, planBins, callsPerTick, pad,
} from './tick-map.mjs';
import { makePos } from './layout-pos.mjs';
import { buildTriggerMap } from './trigger-map.mjs';
import { resolvePaths } from '../core/paths.mjs';

const P = resolvePaths();
const DP = P.datapackDir;

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
// 口径修正（M2-3）：默认吃 arrange-all 的最终机器谱面。过去默认 notes_v3（**没经过编排**的那一版），
// 结果 M2-1 轮次重生成数据包时把力度/延音/打击乐全丢了、e2e 触发数对不上（279 vs 295）。
const NOTES_CSV = opt('notes', P.machineScore);
// M3-37：红石块要**提前一刻**放。方块事件（NoteBlock.onSyncedBlockEvent）是排队到**下一 tick 开头**
// 才真正执行的，所以"在第 T 刻放红石块"听到的声音落在 T+1；提前到 T-1 放，声音才和灯/粒子/时刻表对齐。
const TRIGGER_LEAD = Math.max(0, Number(opt('trigger-lead', '1')));

// 方案 A：单排（49 段一条线），逐段高度从 single_row_profile.json 读
const ROWS_PROFILE = JSON.parse(fs.readFileSync(P.profile, 'utf8'));

/* ---------- 读谱面数据：step/声部/midi/机行/力度 ---------- */
const rows = fs.readFileSync(NOTES_CSV, 'utf8').trim().split(/\r?\n/);
const header = rows[0].split(',');
const col = (n) => header.indexOf(n);
const iStep = col('step'), iInstr = col('instrument'), iMidi = col('midi'), iRow = col('row'), iVol = col('volume');
if ([iStep, iInstr, iRow, iVol].some((i) => i < 0)) throw new Error(`CSV 缺列: ${header.join(',')}`);
// M3-24：可选列 `time_seconds` —— 参考演奏的真实时间。有它就用它触发（精确到刻），
// 没有就退回 `step × 0.12`（机器格位）。
const iTime = col('time_seconds');
const notes = rows.slice(1).map((l) => {
  const c = l.split(',');
  return {
    step: +c[iStep], instr: c[iInstr], midi: +c[iMidi], pitch: +c[iRow], vol: +c[iVol],
    timeSec: iTime >= 0 && `${c[iTime] ?? ''}`.trim() !== '' ? +c[iTime] : undefined,
  };
});

/* ---------- step/pitch -> 世界坐标（与 note-blocks.mjs 共用同一个规则） ---------- */
const pos = makePos(ROWS_PROFILE);

const soundName = (i) => `minecraft:block.note_block.${['bass', 'basedrum', 'hat'].includes(i) ? i : 'harp'}`;
const pitchMul = (n) => (2 ** ((n - 12) / 12)).toFixed(4);

// 单排 2352 格超过 forceload 上限（256 区块），所以按 x 分两段自动切换：
//   前段 x480..1735 ≈237 区块；后段 x1728..2880 ≈216 区块（切换点 = 第 1248 步）
const MODES = [
  { id: 'lo', tps: 20, hi: 0, label: '20 tps 模式（默认）' },
  { id: 'hi', tps: 100, hi: 1, label: '100 tps 精确模式' },
];

fs.rmSync(`${DP}/function/play`, { recursive: true, force: true });
fs.mkdirSync(`${DP}/function/play`, { recursive: true });
fs.mkdirSync(P.tagDir, { recursive: true });

const summary = [];
const allLastPos = new Map(); // "x,y,z" -> pos（stop 时熄灯）

// M3-37：每个音符的**水平触发位**（放红石块 → 音符盒响 → mod 接管音色）。
// 两套表（lo/hi）用的是同一批坐标，算一次即可。
const TRIG = buildTriggerMap(notes, pos);
if (TRIG.missing > 0) {
  throw new Error(`有 ${TRIG.missing} 个音符找不到水平触发位 —— 布局需要加触发道（见 docs/M3-37）`);
}
const trigKey = (n) => {
  const p = pos(n.step, n.pitch);
  return `${p.x},${p.y},${p.z}`;
};
const trigCellOf = new Map(notes.map((n, i) => [trigKey(n), TRIG.cells[i]]));
/** 落在"没有任何音符的窗口"里的触发位清理：交给 stop 兜底（去重） */
const pendingStopClears = new Set();

for (const mode of MODES) {
  const groups = buildTickGroups(notes, mode.tps);
  const ticks = [...groups.keys()];
  const lastTick = ticks[ticks.length - 1];
  const buckets = planBuckets(ticks, 100);
  const bins = planBins(buckets, 15);
  const dir = `${DP}/function/play/${mode.id}`;
  fs.mkdirSync(dir, { recursive: true });

  let triggers = 0;
  let prevNotes = [];
  let switched = false;
  const sw = switchTick(mode.tps);
  // 待清除的触发位（音符盒触发后下一刻把红石块拆掉）：
  // 桶是按 100 刻分组的区间，所以先用"目标刻所在桶"归位；落在**没有任何音符的窗口**里的清理
  // 统一交给 stop（那里会兜底清一遍，避免世界留下散落的红石块）。
  const bucketByIndex = new Map(buckets.map((b) => [b.index, b]));
  const clearsByBucket = new Map();   // bucketIndex -> [{tick, cmd}]
  const addClear = (tick, cmd) => {
    const bucket = bucketByIndex.get(Math.floor(tick / 100));
    if (!bucket) {
      pendingStopClears.add(cmd);
      return;
    }
    if (!clearsByBucket.has(bucket.index)) clearsByBucket.set(bucket.index, []);
    clearsByBucket.get(bucket.index).push({ tick, cmd });
  };

  for (const bucket of buckets) {
    const out = [];
    for (const t of bucket.ticks) {
      const list = groups.get(t);
      const guard = `execute if score #t styx.t matches ${t} run`;
      // M3-21：**音符盒永远照常触发**。声音由 mod（mixin 拦 NoteBlock.onSyncedBlockEvent）接管：
      //   · 装了 mod  → 原版声音被掐掉，改播无损采样（力度取谱面里的真实力度）；
      //   · 没装 mod  → 就是原版音符盒声音（可用的降级路径）。
      // 旧行为（`#hifi=1` 时不触发 + 数据包用 /playsound 补音）会与 mod 双响，故废弃。
      const guardNoHifi = guard;
      if (!switched && t >= sw) {
        switched = true;
        out.push(`${guard} forceload remove all`);
        out.push(`${guard} forceload add 1728 -176 2880 -136`);
        out.push(`${guard} tellraw @a {"text":"[Styx] 已自动切换强加载范围（后半段）","color":"gray"}`);
      }
      for (const p of prevNotes) {
        out.push(`${guard} setblock ${p.x} ${p.y - 1} ${p.z} minecraft:redstone_lamp[lit=false]`);
      }
      for (const n of list) {
        const { x, y, z } = pos(n.step, n.pitch);
        // M3-4：`#hifi=1`（自研音色模式）时**不触发**音符盒 —— 否则原版 harp/bass 会和
        // 数据包播的自研音色叠在一起（玩家实测"音符盒还是原版声音"就是这个叠加）。
        // 音符粒子由 styx:play/hifi/* 用粒子命令补回来，灯与计数照旧。
        // M3-21c（实测结论）：这个密集单排布局里**音符盒本体发不出声**——
        //   ① 旧触发位在音符盒正上方（y+2）：`NoteBlock.playNote` 里
        //      `if (!INSTRUMENT.isNotBaseBlock() && !world.getBlockState(pos.up()).isAir()) return;`
        //      直接把它拦掉（harp/bass 都是基座类乐器，上方必须空气）；
        //   ② 改成"红石块给甲板充能（y-1）"后实测**仍然不响**（这条间接充能路径在 1.21.10 不成立）。
        // 所以发声交给**自研演奏器**：数据包逐音调用 mod 的 `/nbm playat`，
        // 由 mod 的无损引擎在同一刻发声（与机器同 tick，不会漂移）；机器这边只保留灯与粒子。
        // M3-29：发声行加 `#snd` 守卫（默认开）。客户端高精度播放（/nbmc play）要接管声音时，
        // 用 `/function styx:play/sound_off` 把这条关掉，避免数据包与客户端双响；
        // 机器照样亮灯/出粒子（视觉仍由数据包驱动）。
        // M3-37：默认改成**音符盒本体触发**（`#nb=1` + `#snd=0`）：
        //   在水平相邻的空位瞬放红石块 → 音符盒真的响 → mod 的 mixin 掐掉原版声音换无损采样。
        //   `sound_on` 会把这条切回"数据包直接派发给 mod 引擎"（`#nb=0` + `#snd=1`），两条互斥。
        const cell = trigCellOf.get(`${x},${y},${z}`);
        if (cell.strict) {
          // 提前 TRIGGER_LEAD 刻放红石块（默认 1）：方块事件下一 tick 才执行，这样声音与灯/粒子同刻
          const placeTick = Math.max(0, t - TRIGGER_LEAD);
          const placeGuard = placeTick === t ? guard : `execute if score #t styx.t matches ${placeTick} run`;
          out.push(`${placeGuard} execute if score #nb styx.flag matches 1 run setblock `
            + `${cell.x} ${cell.y} ${cell.z} minecraft:redstone_block`);
          addClear(placeTick + 1, `setblock ${cell.x} ${cell.y} ${cell.z} minecraft:air`);
        } else {
          // 没有"只点亮自己"的触发位（实测 18/3044）：这一颗音改走 mod 引擎，避免顺手点亮旁边的音符盒。
          // 只在**音符盒模式**（#nb=1）下跑，免得和下面那条 #snd 的派发行重复。
          out.push(`${guard} execute if score #nb styx.flag matches 1 run nbm playat ${x} ${y} ${z}`);
        }
        out.push(`${guard} execute unless score #snd styx.flag matches 0 run nbm playat ${x} ${y} ${z}`);
        // 音符粒子：本题材里音符盒本体发不出声（见上），粒子也就没有；这里按 vanilla 的
        // addParticle(NOTE, x+0.5, y+1.2, z+0.5, row/24, 0, 0) 口径补一发。
        out.push(`${guard} particle minecraft:note ${x + 0.5} ${y + 1.2} ${z + 0.5} `
          + `${(n.pitch / 24).toFixed(3)} 0 0 1 1 normal`);
        out.push(`${guard} setblock ${x} ${y - 1} ${z} minecraft:redstone_lamp[lit=true]`);
        out.push(`${guard} scoreboard players add #hits styx.flag 1`);
        // 监听模式（#mon=1）：在每位玩家自己脚下再放一遍同样的音，保证多远都听得到
        //   实体音符盒照常发声，播放的只是同一音高/音色的提示音
        out.push(`${guard} execute if score #mon styx.flag matches 1 as @a at @s run playsound ${soundName(n.instr)} master @s ~ ~ ~ ${n.vol.toFixed(2)} ${pitchMul(n.pitch)}`);
        out.push(`${guard} execute if score #mon styx.flag matches 1 run scoreboard players add ${n.instr === 'bass' ? '#mb' : '#mh'} styx.flag 1`);
        triggers++;
      }
      prevNotes = list.map((n) => pos(n.step, n.pitch));
    }
    // M3-37：本桶内到期的"拆触发位"（带自己的刻守卫，可能落在没有音符的刻上）
    for (const { tick, cmd } of clearsByBucket.get(bucket.index) ?? []) {
      out.push(`execute if score #t styx.t matches ${tick} run ${cmd}`);
    }
    fs.writeFileSync(`${dir}/b${pad(bucket.index)}.mcfunction`, out.join('\n') + '\n', 'utf8');
  }

  for (const bin of bins) {
    const lines = bin.buckets.map((b) => `execute if score #t styx.t matches ${b.startTick}..${b.endTick} run function styx:play/${mode.id}/b${pad(b.index)}`);
    fs.writeFileSync(`${dir}/bin${pad(bin.index, 2)}.mcfunction`, lines.join('\n') + '\n', 'utf8');
  }

  const tickLines = [
    ...bins.map((bin) => `execute if score #t styx.t matches ${bin.fromTick}..${bin.toTick} run function styx:play/${mode.id}/bin${pad(bin.index, 2)}`),
    `execute if score #t styx.t matches ${lastTick + 1}.. run function styx:play/stop`,
  ];
  fs.writeFileSync(`${dir}/tick.mcfunction`, tickLines.join('\n') + '\n', 'utf8');

  for (const n of groups.get(lastTick)) {
    const p = pos(n.step, n.pitch);
    allLastPos.set(`${p.x},${p.y},${p.z}`, p);
  }

  const maxPerBin = Math.max(...bins.map((b) => b.buckets.length));
  summary.push({
    mode: mode.id, tps: mode.tps, ticks: ticks.length, buckets: buckets.length, bins: bins.length,
    callsPerTick: callsPerTick(bins.length, maxPerBin), lastTick, durationSec: +(lastTick / mode.tps).toFixed(1),
    triggers, switchTick: sw,
  });
}

/* ---------- 每刻入口 ---------- */
fs.writeFileSync(`${DP}/function/play/tick.mcfunction`, [
  'execute if score #on styx.flag matches 1 run scoreboard players add #t styx.t 1',
  'execute if score #on styx.flag matches 1 if score #hi styx.flag matches 1 run function styx:play/hi/tick',
  'execute if score #on styx.flag matches 1 unless score #hi styx.flag matches 1 run function styx:play/lo/tick',
].join('\n') + '\n', 'utf8');

// 注意：这里**不能**用 `execute unless score #x styx.flag matches …` 去"判断目标是否存在"——
// 目标不存在时 score 条件本身执行失败，`run` 不会触发。函数里 `scoreboard objectives add`
// 对已存在的目标只会静默失败（实测 1.21.10：不写日志、不影响函数其余行），所以直接无条件 add。
const objectiveGuard = [
  'scoreboard objectives add styx.t dummy',
  'scoreboard objectives add styx.flag dummy',
];
const counterReset = [
  'scoreboard players set #t styx.t -1',
  'scoreboard players set #hits styx.flag 0',
  'scoreboard players set #mh styx.flag 0',
  'scoreboard players set #mb styx.flag 0',
  // M3-37：默认走**音符盒本体触发**（#nb=1），数据包直接派发 mod 引擎那条路（#snd=1）关掉，
  // 否则同一个音会响两遍（音符盒 + playat）。用 /function styx:play/sound_on|off 切换。
  'scoreboard players set #nb styx.flag 1',
  'scoreboard players set #snd styx.flag 0',
];

const startLines = (mode) => [
  ...objectiveGuard,
  ...counterReset,
  `scoreboard players set #hi styx.flag ${mode.hi}`,
  'scoreboard players set #on styx.flag 1',
  '# 自动强加载前半段音轨（x480..1735, z-176..-136），保证整排音符盒和灯都能工作',
  'forceload remove all',
  'forceload add 480 -176 1735 -136',
  `tellraw @a {"text":"[Styx] 开始演奏（${mode.label}，全长约 4 分 38 秒）","color":"aqua"}`,
];
fs.writeFileSync(`${DP}/function/play/start.mcfunction`, startLines(MODES[0]).join('\n') + '\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/start_hi.mcfunction`, [
  ...startLines(MODES[1]),
  'tellraw @a {"text":"[Styx] 精确模式要求世界刻率 = 100：没执行过 /tick rate 100 的话整曲会慢 5 倍。自检：/function styx:play/doctor","color":"yellow"}',
].join('\n') + '\n', 'utf8');

const stopOff = [...allLastPos.values()].map((p) => `setblock ${p.x} ${p.y - 1} ${p.z} minecraft:redstone_lamp[lit=false]`);
// M3-37：清触发位。正常播放时每颗音的触发位在下一刻就被拆掉，这里只管两种情况：
//   ① 演奏中途 stop（当前刻刚放下的红石块还没来得及拆）；
//   ② 落在"没有音符的窗口"里的清理（生成时归到 pendingStopClears）。
const clearTriggerLines = [
  ...[...TRIG.cells].map((c) => `setblock ${c.x} ${c.y} ${c.z} minecraft:air`),
  ...pendingStopClears,
];
fs.writeFileSync(`${DP}/function/play/clear_triggers.mcfunction`, clearTriggerLines.join('\n') + '\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/stop.mcfunction`, [
  'scoreboard players set #on styx.flag 0',
  'scoreboard players set #t styx.t -1',
  ...stopOff,
  ...clearTriggerLines,
  'forceload remove all',
  'tellraw @a {"text":"[Styx] 演奏结束/已停止","color":"aqua"}',
].join('\n') + '\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/reset.mcfunction`, [
  ...objectiveGuard,
  'scoreboard players set #on styx.flag 0',
  ...counterReset,
  'scoreboard players set #mon styx.flag 0',
  ...stopOff,
  ...clearTriggerLines,
  'forceload remove all',
].join('\n') + '\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/monitor_on.mcfunction`,
  'scoreboard objectives add styx.flag dummy\n'
  + 'scoreboard players set #mon styx.flag 1\n'
  + 'tellraw @a {"text":"[Styx] 监听模式：开（每个音符都会在你当前位置再响一次，走远也听得见）","color":"gold"}\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/monitor_off.mcfunction`,
  'scoreboard players set #mon styx.flag 0\n'
  + 'tellraw @a {"text":"[Styx] 监听模式：关（只靠实体音符盒发声，需要站在音轨附近）","color":"gray"}\n', 'utf8');

// M3-29：机器"只做视觉"开关 —— 关掉数据包的发声行，把声音交给客户端高精度播放（/nbmc play），避免双响。
fs.writeFileSync(`${DP}/function/play/sound_off.mcfunction`,
  'scoreboard objectives add styx.flag dummy\n'
  + 'scoreboard players set #snd styx.flag 0\n'
  + 'scoreboard players set #nb styx.flag 1\n'
  + 'tellraw @a {"text":"[Styx] 发声：音符盒本体（红石块触发 → mod 接管音色；没装 mod 就是原版音符盒声）","color":"gold"}\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/sound_on.mcfunction`,
  'scoreboard players set #snd styx.flag 1\n'
  + 'scoreboard players set #nb styx.flag 0\n'
  + 'tellraw @a {"text":"[Styx] 发声：数据包直派 mod 引擎（不触发音符盒；/nbmc play 的客户端播放也用这一档）","color":"gray"}\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/report.mcfunction`, [
  'tellraw @s {"text":"[Styx] 已触发音符数：","color":"aqua","extra":[{"score":{"name":"#hits","objective":"styx.flag"},"color":"yellow"}]}',
  'tellraw @s {"text":"[Styx] 当前刻：","color":"aqua","extra":[{"score":{"name":"#t","objective":"styx.t"},"color":"yellow"},{"text":"  监听模式：","color":"aqua"},{"score":{"name":"#mon","objective":"styx.flag"},"color":"yellow"},{"text":"  播放中：","color":"aqua"},{"score":{"name":"#on","objective":"styx.flag"},"color":"yellow"}]}',
  'tellraw @s {"text":"[Styx] 刻率模式 #hi：","color":"aqua","extra":[{"score":{"name":"#hi","objective":"styx.flag"},"color":"yellow"},{"text":"（0 = 20 tps 表，1 = 100 tps 表）","color":"gray"}]}',
  'tellraw @s {"text":"[Styx] 监听已播：钢琴 ","color":"aqua","extra":[{"score":{"name":"#mh","objective":"styx.flag"},"color":"yellow"},{"text":" 个，贝斯 ","color":"aqua"},{"score":{"name":"#mb","objective":"styx.flag"},"color":"yellow"},{"text":" 个","color":"aqua"}]}',
].join('\n') + '\n', 'utf8');

// 自检函数放在 play/ 下，名字就是 styx:play/doctor（与 start_hi、验收脚本里写的引用一致）
fs.mkdirSync(`${DP}/function/play/doctor`, { recursive: true });
fs.writeFileSync(`${DP}/function/play/doctor.mcfunction`, [
  'tellraw @a {"text":"[Styx] 自检开始（≈1 秒）。注意：函数无法读出服务器刻率（#t 是按刻递增的），它只能证明 tick 函数在推进；刻率请用 /tick query 看","color":"gold"}',
  'scoreboard players operation #t0 styx.t = #t styx.t',
  'scoreboard players set #dt styx.t 0',
  'execute if score #on styx.flag matches 1 run schedule function styx:play/doctor/check 20t',
  'execute unless score #on styx.flag matches 1 run tellraw @a {"text":"[Styx] 当前未在播放（#on=0）——刻率自检跳过；请先 styx:play/start 再自检","color":"yellow"}',
  // 机器布局（profile.y = 84）：灯/触发位 83、甲板 84、音符盒 85、音符盒上方 86 必须是空气
  'execute if block 480 85 -160 minecraft:note_block run say [Styx/doctor] 音符盒在位 ✔',
  'execute unless block 480 85 -160 minecraft:note_block run say [Styx/doctor] 音符盒缺失 ✘（先跑 styx:redo）',
  'execute if block 480 84 -160 minecraft:oak_planks run say [Styx/doctor] 甲板在位 ✔',
  'execute unless block 480 84 -160 minecraft:oak_planks run say [Styx/doctor] 甲板缺失 ✘（先跑 styx:redo）',
  'execute if block 480 83 -160 minecraft:redstone_lamp run say [Styx/doctor] 指示灯在位 ✔',
  'execute unless block 480 83 -160 minecraft:redstone_lamp run say [Styx/doctor] 指示灯缺失 ✘（先跑 styx:redo）',
  'execute unless block 480 86 -160 minecraft:air run say [Styx/doctor] ⚠ 音符盒上方被占（不影响触发，但视觉上会挤）',
  'execute if block 480 85 -161 minecraft:air run say [Styx/doctor] 触发位在位 ✔（音符盒同层水平相邻那格是空气）',
  'tellraw @a {"text":"[Styx/doctor] 默认：红石块触发音符盒本体 → 装 mod 时由 mixin 换成无损采样（没装 mod 即原版音符盒声）；/function styx:play/sound_on 可切回数据包直派 mod 引擎","color":"gray"}',
].join('\n') + '\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/doctor/check.mcfunction`, [
  'scoreboard players operation #dt styx.t = #t styx.t',
  'scoreboard players operation #dt styx.t -= #t0 styx.t',
  '# 20 刻内 #t 应 +20（#t 每个服务器刻 +1，与刻率无关；这一条只验"tick 函数确实在跑"）',
  'execute if score #dt styx.t matches 19..21 run tellraw @a {"text":"[Styx/doctor] ✔ tick 函数推进正常（20 刻内 #t +","color":"green","extra":[{"score":{"name":"#dt","objective":"styx.t"},"color":"yellow"},{"text":"）。实际刻率请再执行 /tick query 核对（模式 #hi=","color":"green"},{"score":{"name":"#hi","objective":"styx.flag"},"color":"yellow"},{"text":"）","color":"green"}]}',
  'execute unless score #dt styx.t matches 19..21 run tellraw @a {"text":"[Styx/doctor] ✘ tick 函数没在正常推进（20 刻内 #t 只 +","color":"red","extra":[{"score":{"name":"#dt","objective":"styx.t"},"color":"yellow"},{"text":"）→ 依次检查：#on 是否为 1、styx:play/tick 是否挂在 tick 标签、服务器是否卡到掉刻","color":"red"}]}',
].join('\n') + '\n', 'utf8');

// 挂到每刻（必须放在 minecraft 命名空间！）
fs.writeFileSync(`${P.tagDir}/tick.json`, JSON.stringify({ values: ['styx:play/tick'] }, null, 2) + '\n', 'utf8');
fs.rmSync(`${DP}/tags/function/tick.json`, { force: true });

console.log(`谱面：${NOTES_CSV}`);
console.log(`音符 ${notes.length} 个；步长 ${STEP_SECONDS}s`);
for (const s of summary) {
  console.log(`  ${s.mode}（${s.tps} tps）：${s.ticks} 个时刻 / ${s.buckets} 桶 / ${s.bins} 组 / 单刻 ${s.callsPerTick} 次调用 / 末刻 ${s.lastTick}（≈${(s.lastTick / s.tps / 60).toFixed(1)} 分）/ 触发 ${s.triggers} / 窗口切换刻 ${s.switchTick}`);
}
const lo = summary[0], hi = summary[1];
console.log(`对比旧的单级全扫：100 tps 单刻调用 ${hi.buckets} → ${hi.callsPerTick}（${((1 - hi.callsPerTick / hi.buckets) * 100).toFixed(0)}%↓）；20 tps 单刻调用 ${hi.buckets} → ${lo.callsPerTick}`);
console.log(`触发位：${TRIG.cells.length} 个音符各有一个水平触发位（首选方向 z+1 ${TRIG.cells.filter((c) => c.dir === 'zPlus').length} 个）；兜底清理 ${pendingStopClears.size} 条`);
console.log('已生成 play/{tick,start,start_hi,stop,reset,clear_triggers,report,monitor_on,monitor_off,sound_on,sound_off}、play/{lo,hi}/{tick,binNN,bNNN}、doctor(+check)');
