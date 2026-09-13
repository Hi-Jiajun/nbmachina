// 生成「自动播放器」数据包函数（实体音符盒发声版）：
//   每个音符：在音符盒【上方】瞬放红石方块再拆掉 —— 音符盒收到充能就自己发声（真·红石音乐）
//   同时点亮它正下方两格处的红石灯做视觉指示
//   styx:play/start / stop / tick / bNN    lamps / lamps_clear
//   注意：tick 标签必须挂在 minecraft 命名空间下才会被游戏执行
import fs from 'node:fs';
import path from 'node:path';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const DP = `${B}/styx_build/data/styx`;
fs.mkdirSync(`${DP}/function`, { recursive: true });
fs.mkdirSync(`${DP}/function/play`, { recursive: true });
fs.mkdirSync(`${B}/styx_build/data/minecraft/tags/function`, { recursive: true });

// 方案 A：单排（49 段一条线），逐段高度从 single_row_profile.json 读
const ROWS_PROFILE = JSON.parse(fs.readFileSync(`${B}/single_row_profile.json`, 'utf8'));

/* ---------- 读 v3 数据：step/tick/声部/新音高/力度 ---------- */
const csv = fs.readFileSync(`${B}/styx_helix_notes_v3.csv`, 'utf8').trim().split(/\r?\n/).slice(1);
const notes = csv.map((l) => {
  const [step, tick, time, instr, midi, row, vol] = l.split(',');
  return { step: +step, tick: +tick, time: +time, instr, pitch: +row, vol: +vol };
});

/* ---------- step/pitch -> 世界坐标（与结构生成规则一致） ---------- */
function pos(step, pitch) {
  const seg = Math.floor(step / 48), lx = step % 48;
  const r = ROWS_PROFILE[Math.min(seg, ROWS_PROFILE.length - 1)];
  return { x: r.x0 + lx, y: r.y, z: -172 + pitch + 3 };
}

/* ---------- 按「刻」分组 ---------- */
const groups = new Map();  // tick -> notes[]
for (const n of notes) {
  const tick = n.tick;
  if (!groups.has(tick)) groups.set(tick, []);
  groups.get(tick).push(n);
}
const ticks = [...groups.keys()].sort((a, b) => a - b);
const lastTick = ticks[ticks.length - 1];
console.log(`音符 ${notes.length} 个，时间点 ${ticks.length} 个，最后一刻 ${lastTick}（≈${(lastTick / 20).toFixed(1)} 秒）`);

/* ---------- 每 100 刻一个桶 ---------- */
const BUCKET = 100;
const nBuckets = Math.ceil((lastTick + 1) / BUCKET);
const bucketLines = Array.from({ length: nBuckets }, () => []);
let prevNotes = [];
const soundName = (i) => `minecraft:block.note_block.${i === 'bass' ? 'bass' : 'harp'}`;
const pitchMul = (n) => (2 ** ((n - 12) / 12)).toFixed(4);
let hits = 0;

// 单排 2352 格超过 forceload 上限（256 区块），所以按 x 分两段自动切换：
//   前段 x480..1735 ≈237 区块；后段 x1728..2880 ≈216 区块（切换点 ≈ 第 26 段 / tick 2995）
const SWITCH_TICK = Math.round(1248 * 0.12 * 20);
let switched = false;

for (const t of ticks) {
  const list = groups.get(t);
  const bi = Math.floor(t / BUCKET);
  const out = bucketLines[bi];
  const guard = `execute if score #t styx.t matches ${t} run`;
  if (!switched && t >= SWITCH_TICK) {
    switched = true;
    out.push(`${guard} forceload remove all`);
    out.push(`${guard} forceload add 1728 -176 2880 -136`);
    out.push(`${guard} tellraw @a {"text":"[Styx] 已自动切换强加载范围（后半段）","color":"gray"}`);
  }
  // 关掉上一组灯
  for (const p of prevNotes) {
    out.push(`${guard} setblock ${p.x} ${p.y - 1} ${p.z} minecraft:redstone_lamp[lit=false]`);
  }
  // 触发实体音符盒 + 点亮本组灯
  for (const n of list) {
    const { x, y, z } = pos(n.step, n.pitch);
    out.push(`${guard} setblock ${x} ${y + 2} ${z} minecraft:redstone_block`);
    out.push(`${guard} setblock ${x} ${y + 2} ${z} minecraft:air`);
    out.push(`${guard} scoreboard players add #hits styx.flag 1`);
    out.push(`${guard} setblock ${x} ${y - 1} ${z} minecraft:redstone_lamp[lit=true]`);
    // 监听模式（#mon=1 时）：在每位玩家自己脚下再放一遍同样的音，保证多远都听得到
    //   贝斯音色本身很低，小音箱放不出来 → 监听里把贝斯升高八度（实体音符盒/录像里的音高不变）
    const isBass = n.instr === 'bass';
    // 监听：原版音色 + 原始音高 + v3 力度（0.35~1.0）
    out.push(`${guard} execute if score #mon styx.flag matches 1 as @a at @s run playsound ${soundName(n.instr)} master @s ~ ~ ~ ${n.vol.toFixed(2)} ${pitchMul(n.pitch)}`);
    out.push(`${guard} execute if score #mon styx.flag matches 1 run scoreboard players add ${isBass ? '#mb' : '#mh'} styx.flag 1`);
    hits++;
  }
  prevNotes = list.map((n) => pos(n.step, n.pitch));
}

for (let i = 0; i < nBuckets; i++) {
  fs.writeFileSync(`${DP}/function/play/b${String(i).padStart(2, '0')}.mcfunction`, bucketLines[i].join('\n') + '\n', 'utf8');
}

/* ---------- tick / start / stop ---------- */
const tickFn = [
  'execute if score #on styx.flag matches 1 run scoreboard players add #t styx.t 1',
  'execute if score #on styx.flag matches 1 run function styx:play/b00',
  ...Array.from({ length: nBuckets - 1 }, (_, i) => `execute if score #on styx.flag matches 1 run function styx:play/b${String(i + 1).padStart(2, '0')}`),
  `execute if score #t styx.t matches ${lastTick + 1}.. run function styx:play/stop`,
];
fs.writeFileSync(`${DP}/function/play/tick.mcfunction`, tickFn.join('\n') + '\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/start.mcfunction`, [
  'scoreboard objectives add styx.t dummy',
  'scoreboard objectives add styx.flag dummy',
  'scoreboard players set #t styx.t -1',
  'scoreboard players set #hits styx.flag 0',
  'scoreboard players set #mh styx.flag 0',
  'scoreboard players set #mb styx.flag 0',
  'scoreboard players set #on styx.flag 1',
  '# 把刻率提到 100：原曲 0.12 秒/步 = 正好 12 刻，节奏精确；演奏结束会恢复 20',
  'tick rate 100',
  '# 自动强加载前半段音轨（x480..1735, z-176..-136），保证整排音符盒和灯都能工作',
  'forceload remove all',
  'forceload add 480 -176 1735 -136',
  'tellraw @a {"text":"[Styx] 开始演奏（全长约 4 分 38 秒）","color":"aqua"}',
].join('\n') + '\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/monitor_on.mcfunction`,
  'scoreboard players set #mon styx.flag 1\n'
  + 'tellraw @a {"text":"[Styx] 监听模式：开（每个音符都会在你当前位置再响一次，走远也听得见）","color":"gold"}\n', 'utf8');
fs.writeFileSync(`${DP}/function/play/monitor_off.mcfunction`,
  'scoreboard players set #mon styx.flag 0\n'
  + 'tellraw @a {"text":"[Styx] 监听模式：关（只靠实体音符盒发声，需要站在音轨附近）","color":"gray"}\n', 'utf8');

fs.writeFileSync(`${DP}/function/play/report.mcfunction`,
  'tellraw @s {"text":"[Styx] 已触发音符数：","color":"aqua","extra":[{"score":{"name":"#hits","objective":"styx.flag"},"color":"yellow"}]}\n'
  + 'tellraw @s {"text":"[Styx] 当前刻：","color":"aqua","extra":[{"score":{"name":"#t","objective":"styx.t"},"color":"yellow"},{"text":"  监听模式：","color":"aqua"},{"score":{"name":"#mon","objective":"styx.flag"},"color":"yellow"}]}\n', 'utf8');
// 追加一行：分别报告监听模式里钢琴/贝斯各播了多少
{
  const p = `${DP}/function/play/report.mcfunction`;
  fs.appendFileSync(p, 'tellraw @s {"text":"[Styx] 监听已播：钢琴 ","color":"aqua","extra":[{"score":{"name":"#mh","objective":"styx.flag"},"color":"yellow"},{"text":" 个，贝斯 ","color":"aqua"},{"score":{"name":"#mb","objective":"styx.flag"},"color":"yellow"},{"text":" 个","color":"aqua"}]}\n', 'utf8');
}

// stop：停止推进 + 熄掉最后一组灯
const stopOff = prevNotes.map((p) => `setblock ${p.x} ${p.y - 1} ${p.z} minecraft:redstone_lamp[lit=false]`);
fs.writeFileSync(`${DP}/function/play/stop.mcfunction`, [
  'scoreboard players set #on styx.flag 0',
  ...stopOff,
  'forceload remove all',
  'tick rate 20',
  'tellraw @a {"text":"[Styx] 演奏结束/已停止","color":"aqua"}',
].join('\n') + '\n', 'utf8');

// 挂到每刻（必须放在 minecraft 命名空间！）
fs.writeFileSync(`${B}/styx_build/data/minecraft/tags/function/tick.json`, JSON.stringify({ values: ['styx:play/tick'] }, null, 2) + '\n', 'utf8');
fs.rmSync(`${DP}/tags/function/tick.json`, { force: true });

/* ---------- 红石灯由 gen_single_row.mjs 生成：lamps_v2（跟随每段高度） ---------- */

fs.writeFileSync(`${DP}/function/play/reset.mcfunction`, [
  'scoreboard players set #on styx.flag 0',
  'scoreboard players set #t styx.t -1',
  'scoreboard players set #hits styx.flag 0',
  'scoreboard players set #mh styx.flag 0',
  'scoreboard players set #mb styx.flag 0',
  ...stopOff,
  'forceload remove all',
  'tick rate 20',
].join('\n') + '\n', 'utf8');

console.log(`桶文件 ${nBuckets} 个`);
console.log(`音符触发总数（含重复列）: ${hits}`);
console.log('play/start, play/stop, play/tick, play/reset, play/report, play/monitor_on/off 已生成');
console.log('tick 标签: data/minecraft/tags/function/tick.json -> styx:play/tick');
