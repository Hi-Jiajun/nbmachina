// 生成「自动播放器」数据包函数（实体音符盒发声版）：
//   每个音符：在音符盒【上方】瞬放红石方块再拆掉 —— 音符盒收到充能就自己发声（真·红石音乐）
//   同时点亮它正下方两格处的红石灯做视觉指示
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

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const DP = `${B}/styx_build/data/styx`;

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; };
const NOTES_CSV = opt('notes', `${B}/styx_helix_notes_v3.csv`);

// 方案 A：单排（49 段一条线），逐段高度从 single_row_profile.json 读
const ROWS_PROFILE = JSON.parse(fs.readFileSync(`${B}/single_row_profile.json`, 'utf8'));

/* ---------- 读谱面数据：step/声部/midi/机行/力度 ---------- */
const rows = fs.readFileSync(NOTES_CSV, 'utf8').trim().split(/\r?\n/);
const header = rows[0].split(',');
const col = (n) => header.indexOf(n);
const iStep = col('step'), iInstr = col('instrument'), iMidi = col('midi'), iRow = col('row'), iVol = col('volume');
if ([iStep, iInstr, iRow, iVol].some((i) => i < 0)) throw new Error(`CSV 缺列: ${header.join(',')}`);
const notes = rows.slice(1).map((l) => {
  const c = l.split(',');
  return { step: +c[iStep], instr: c[iInstr], midi: +c[iMidi], pitch: +c[iRow], vol: +c[iVol] };
});

/* ---------- step/pitch -> 世界坐标（与结构生成规则一致） ---------- */
function pos(step, pitch) {
  const seg = Math.floor(step / 48), lx = step % 48;
  const r = ROWS_PROFILE[Math.min(seg, ROWS_PROFILE.length - 1)];
  return { x: r.x0 + lx, y: r.y, z: -172 + pitch + 3 };
}

const soundName = (i) => `minecraft:block.note_block.${i === 'bass' ? 'bass' : 'harp'}`;
const pitchMul = (n) => (2 ** ((n - 12) / 12)).toFixed(4);

// 单排 2352 格超过 forceload 上限（256 区块），所以按 x 分两段自动切换：
//   前段 x480..1735 ≈237 区块；后段 x1728..2880 ≈216 区块（切换点 = 第 1248 步）
const MODES = [
  { id: 'lo', tps: 20, hi: 0, label: '20 tps 模式（默认）' },
  { id: 'hi', tps: 100, hi: 1, label: '100 tps 精确模式' },
];

fs.rmSync(`${DP}/function/play`, { recursive: true, force: true });
fs.mkdirSync(`${DP}/function/play`, { recursive: true });
fs.mkdirSync(`${B}/styx_build/data/minecraft/tags/function`, { recursive: true });

const summary = [];
const allLastPos = new Map(); // "x,y,z" -> pos（stop 时熄灯）

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

  for (const bucket of buckets) {
    const out = [];
    for (const t of bucket.ticks) {
      const list = groups.get(t);
      const guard = `execute if score #t styx.t matches ${t} run`;
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
        out.push(`${guard} setblock ${x} ${y + 2} ${z} minecraft:redstone_block`);
        out.push(`${guard} setblock ${x} ${y + 2} ${z} minecraft:air`);
        out.push(`${guard} scoreboard players add #hits styx.flag 1`);
        out.push(`${guard} setblock ${x} ${y - 1} ${z} minecraft:redstone_lamp[lit=true]`);
        // 监听模式（#mon=1）：在每位玩家自己脚下再放一遍同样的音，保证多远都听得到
        //   实体音符盒照常发声，播放的只是同一音高/音色的提示音
        out.push(`${guard} execute if score #mon styx.flag matches 1 as @a at @s run playsound ${soundName(n.instr)} master @s ~ ~ ~ ${n.vol.toFixed(2)} ${pitchMul(n.pitch)}`);
        out.push(`${guard} execute if score #mon styx.flag matches 1 run scoreboard players add ${n.instr === 'bass' ? '#mb' : '#mh'} styx.flag 1`);
        triggers++;
      }
      prevNotes = list.map((n) => pos(n.step, n.pitch));
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
fs.writeFileSync(`${DP}/function/play/stop.mcfunction`, [
  'scoreboard players set #on styx.flag 0',
  'scoreboard players set #t styx.t -1',
  ...stopOff,
  'forceload remove all',
  'tellraw @a {"text":"[Styx] 演奏结束/已停止","color":"aqua"}',
].join('\n') + '\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/reset.mcfunction`, [
  ...objectiveGuard,
  'scoreboard players set #on styx.flag 0',
  ...counterReset,
  'scoreboard players set #mon styx.flag 0',
  ...stopOff,
  'forceload remove all',
].join('\n') + '\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/monitor_on.mcfunction`,
  'scoreboard objectives add styx.flag dummy\n'
  + 'scoreboard players set #mon styx.flag 1\n'
  + 'tellraw @a {"text":"[Styx] 监听模式：开（每个音符都会在你当前位置再响一次，走远也听得见）","color":"gold"}\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/monitor_off.mcfunction`,
  'scoreboard players set #mon styx.flag 0\n'
  + 'tellraw @a {"text":"[Styx] 监听模式：关（只靠实体音符盒发声，需要站在音轨附近）","color":"gray"}\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/report.mcfunction`, [
  'tellraw @s {"text":"[Styx] 已触发音符数：","color":"aqua","extra":[{"score":{"name":"#hits","objective":"styx.flag"},"color":"yellow"}]}',
  'tellraw @s {"text":"[Styx] 当前刻：","color":"aqua","extra":[{"score":{"name":"#t","objective":"styx.t"},"color":"yellow"},{"text":"  监听模式：","color":"aqua"},{"score":{"name":"#mon","objective":"styx.flag"},"color":"yellow"},{"text":"  播放中：","color":"aqua"},{"score":{"name":"#on","objective":"styx.flag"},"color":"yellow"}]}',
  'tellraw @s {"text":"[Styx] 刻率模式 #hi：","color":"aqua","extra":[{"score":{"name":"#hi","objective":"styx.flag"},"color":"yellow"},{"text":"（0 = 20 tps 表，1 = 100 tps 表）","color":"gray"}]}',
  'tellraw @s {"text":"[Styx] 监听已播：钢琴 ","color":"aqua","extra":[{"score":{"name":"#mh","objective":"styx.flag"},"color":"yellow"},{"text":" 个，贝斯 ","color":"aqua"},{"score":{"name":"#mb","objective":"styx.flag"},"color":"yellow"},{"text":" 个","color":"aqua"}]}',
].join('\n') + '\n', 'utf8');

// 自检函数放在 play/ 下，名字就是 styx:play/doctor（与 start_hi、验收脚本里写的引用一致）
fs.mkdirSync(`${DP}/function/play/doctor`, { recursive: true });
fs.writeFileSync(`${DP}/function/play/doctor.mcfunction`, [
  'tellraw @a {"text":"[Styx] 自检开始（≈1 秒）：播放中才能测出刻推进速率","color":"gold"}',
  'scoreboard players operation #t0 styx.t = #t styx.t',
  'scoreboard players set #dt styx.t 0',
  'execute if score #on styx.flag matches 1 run schedule function styx:play/doctor/check 20t',
  'execute unless score #on styx.flag matches 1 run tellraw @a {"text":"[Styx] 当前未在播放（#on=0）——刻率自检跳过；请先 styx:play/start 再自检","color":"yellow"}',
  'execute if block 480 85 -160 minecraft:note_block run say [Styx/doctor] 音符盒在位 ✔',
  'execute unless block 480 85 -160 minecraft:note_block run say [Styx/doctor] 音符盒缺失 ✘（先跑 styx:redo）',
  'execute if block 480 86 -160 minecraft:air run say [Styx/doctor] 触发位空闲 ✔',
  'execute unless block 480 86 -160 minecraft:air run say [Styx/doctor] 触发位被占 ✘（有方块挡住红石触发）',
].join('\n') + '\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/doctor/check.mcfunction`, [
  'scoreboard players operation #dt styx.t = #t styx.t',
  'scoreboard players operation #dt styx.t -= #t0 styx.t',
  'execute if score #hi styx.flag matches 1 if score #dt styx.t matches 95..105 run tellraw @a {"text":"[Styx/doctor] ✔ 100 tps 模式：20 刻内推进 ","color":"green","extra":[{"score":{"name":"#dt","objective":"styx.t"},"color":"yellow"},{"text":" 刻（预期 100）","color":"green"}]}',
  'execute if score #hi styx.flag matches 1 unless score #dt styx.t matches 95..105 run tellraw @a {"text":"[Styx/doctor] ✘ 100 tps 模式但 20 刻内只推进 ","color":"red","extra":[{"score":{"name":"#dt","objective":"styx.t"},"color":"yellow"},{"text":" 刻（预期 100）→ 请先在聊天里执行 /tick rate 100 再开播","color":"red"}]}',
  'execute unless score #hi styx.flag matches 1 if score #dt styx.t matches 19..21 run tellraw @a {"text":"[Styx/doctor] ✔ 20 tps 模式：20 刻内推进 ","color":"green","extra":[{"score":{"name":"#dt","objective":"styx.t"},"color":"yellow"},{"text":" 刻（预期 20）","color":"green"}]}',
  'execute unless score #hi styx.flag matches 1 unless score #dt styx.t matches 19..21 run tellraw @a {"text":"[Styx/doctor] ✘ 20 tps 模式但 20 刻内推进了 ","color":"red","extra":[{"score":{"name":"#dt","objective":"styx.t"},"color":"yellow"},{"text":" 刻 → 世界刻率不是 20：要精确节奏请 /tick rate 100 + styx:play/start_hi","color":"red"}]}',
].join('\n') + '\n', 'utf8');

// 挂到每刻（必须放在 minecraft 命名空间！）
fs.writeFileSync(`${B}/styx_build/data/minecraft/tags/function/tick.json`, JSON.stringify({ values: ['styx:play/tick'] }, null, 2) + '\n', 'utf8');
fs.rmSync(`${DP}/tags/function/tick.json`, { force: true });

console.log(`谱面：${NOTES_CSV}`);
console.log(`音符 ${notes.length} 个；步长 ${STEP_SECONDS}s`);
for (const s of summary) {
  console.log(`  ${s.mode}（${s.tps} tps）：${s.ticks} 个时刻 / ${s.buckets} 桶 / ${s.bins} 组 / 单刻 ${s.callsPerTick} 次调用 / 末刻 ${s.lastTick}（≈${(s.lastTick / s.tps / 60).toFixed(1)} 分）/ 触发 ${s.triggers} / 窗口切换刻 ${s.switchTick}`);
}
const lo = summary[0], hi = summary[1];
console.log(`对比旧的单级全扫：100 tps 单刻调用 ${hi.buckets} → ${hi.callsPerTick}（${((1 - hi.callsPerTick / hi.buckets) * 100).toFixed(0)}%↓）；20 tps 单刻调用 ${hi.buckets} → ${lo.callsPerTick}`);
console.log('已生成 play/{tick,start,start_hi,stop,reset,report,monitor_on,monitor_off}、play/{lo,hi}/{tick,binNN,bNNN}、doctor(+check)');
