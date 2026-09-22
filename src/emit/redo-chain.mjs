// 生成「一条命令跑完全部」的链式函数：/function styx:redo（精确模式 styx:redo_hi）
//
// 链的设计（M3-70 重写）：**每个窗口都要等区块真正加载好，再摆音符盒，摆完还要抽查、不合格就补一遍**。
//
// 为什么必须这样：`setblock` 只对**已加载**的区块生效，而 `forceload` 之后区块是**异步**加载的
// （虚空存档开了世界高度 mod 之后每个区块 250+ 个 section，加载更慢）。2026-09-22 实测：
// 旧链在 forceload 后 6~10 秒就 `apply_notes_v3`，第三个窗口（x1783..2566）整段没铺上——
// 用户看到的就是"提示重做完成，世界里半台机器（甚至一台都没有）"。
//
// 两个入口只差一个 #hiwant：0 = 20 tps 表（默认，开箱即用），1 = 100 tps 表（需先 /tick rate 100）。
// 为什么不直接在函数里写 tick rate：函数权限等级 2 < `/tick` 需要的 3，写了整文件加载失败（实测）。
import fs from 'node:fs';
import { resolvePaths } from '../core/paths.mjs';

const P = resolvePaths();
const DP = P.functionsDir;
const prof = JSON.parse(fs.readFileSync(P.profile, 'utf8'));
const X0 = prof[0].x0, X1 = prof[prof.length - 1].x0 + 47;
const ZB = prof[0].z0 ?? -172, ZE = ZB + 24 + 3;
/** 音符盒所在的那一层（甲板 y 的上一格）——`if loaded` / `if block` 抽查都用它 */
const NY = prof[0].y + 1;
const STEP = Math.ceil((X1 - X0 + 1) / 3);
const WIN = [
  [X0, X0 + STEP - 1],
  [X0 + STEP, X0 + 2 * STEP - 1],
  [X0 + 2 * STEP, X1],
];
// forceload 单次上限 256 区块：顺手断言一次，免得又出现"命令静默失败 → 方块没铺上"
for (const [a, b] of WIN) {
  const cx = Math.floor(b / 16) - Math.floor(a / 16) + 1;
  const cz = Math.floor(ZE / 16) - Math.floor(ZB / 16) + 1;
  if (cx * cz > 256) throw new Error(`forceload 窗口 x${a}..${b} 需要 ${cx}×${cz}=${cx * cz} 个区块，超过 256 上限`);
}
/** `forceload add`：窗口 + 机器那条 z 带（x/z 都是方块坐标，命令内部自己折算区块） */
const fl = (win) => `forceload add ${win[0]} ${ZB} ${win[1]} ${ZE}`;

// 抽查点：直接读刚生成的 `apply_notes_v3.mcfunction`，每个窗口取它真正摆过的 3 格（首/中/末）——
// 这样抽查点一定是"本该有音符盒"的位置，不会因为谱面空格误报。
const applyFn = `${DP}/apply_notes_v3.mcfunction`;
const placed = fs.existsSync(applyFn)
  ? [...fs.readFileSync(applyFn, 'utf8').matchAll(/^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:note_block/gm)]
    .map((m) => [+m[1], +m[2], +m[3]])
  : [];
if (placed.length < 30) throw new Error(`从 ${applyFn} 里读到的音符盒太少（${placed.length}）——先跑 note-blocks.mjs 再跑本脚本`);
const samples = WIN.map(([a, b]) => {
  const inWin = placed.filter(([x]) => x >= a && x <= b);
  if (inWin.length < 3) throw new Error(`窗口 x${a}..${b} 里只有 ${inWin.length} 个音符盒，无法抽查`);
  return [inWin[0], inWin[Math.floor(inWin.length / 2)], inWin[inWin.length - 1]];
});

console.log(`redo forceload 窗口（按剖面推导）：${WIN.map((w) => `${w[0]}..${w[1]} z${ZB}..${ZE}`).join(' / ')}`);
console.log(`  抽查点：${samples.map((s, i) => `#${i + 1}[${s.map(([x, , z]) => `x${x}z${z}`).join(' ')}]`).join(' ')}`);

fs.mkdirSync(`${DP}/redo`, { recursive: true });
// M3-70：清掉旧版链留下的分段函数（s2..s4），免得有人手滑直接跑旧段
for (const stale of ['s2', 's3', 's4']) {
  const p = `${DP}/redo/${stale}.mcfunction`;
  if (fs.existsSync(p) && !WIN.some((_, i) => `w${i + 1}` === stale)) fs.rmSync(p);
}
const w = (name, lines) => fs.writeFileSync(`${DP}/${name}`, lines.join('\n') + '\n', 'utf8');

/* ---------- 入口 ---------- */
const entry = (name, hiwant, title) => w(name, [
  'scoreboard objectives add styx.flag dummy',
  `scoreboard players set #hiwant styx.flag ${hiwant}`,
  'scoreboard players set #w1 styx.flag 0',
  'scoreboard players set #t1 styx.flag 0',
  'scoreboard players set #t2 styx.flag 0',
  'scoreboard players set #t3 styx.flag 0',
  `tellraw @a {"text":"[Styx] ${title}：① 修地形 → ② 分段等区块加载 + 摆音符盒（全程 1~3 分钟，请勿离开太远）","color":"gold"}`,
  'forceload remove all',
  fl(WIN[0]),
  'schedule function styx:redo/s1 40t',
]);
entry('redo.mcfunction', 0, '开始重做（20 tps 模式）');
entry('redo_hi.mcfunction', 1, '开始重做（100 tps 精确模式，需已执行 /tick rate 100）');

/* ---------- ① 修地形（虚空世界下是空操作，保留给带地形的存档） ---------- */
w('redo/s1.mcfunction', [
  'function styx:flat_build_v2c',
  'forceload remove all',
  fl(WIN[0]),
  'scoreboard players set #w1 styx.flag 0',
  'schedule function styx:redo/w1 40t',
]);

/* ---------- ② 每个窗口：等加载 → 存快照 → 摆音符盒 → 抽查（不合格补一遍）→ 下一段 ---------- */
WIN.forEach(([a, b], i) => {
  const n = i + 1;
  const pt = samples[i];
  w(`redo/w${n}.mcfunction`, [
    `# 窗口 ${n}（x ${a}..${b}）：等这一步涉及的区块真的加载好（最多 40 次 × 1 秒）`,
    'scoreboard objectives add styx.flag dummy',
    `scoreboard players add #w${n} styx.flag 1`,
    'scoreboard players set #rdy styx.flag 1',
    ...pt.map(([x, , z]) => `execute unless loaded ${x} ${NY} ${z} run scoreboard players set #rdy styx.flag 0`),
    `execute if score #rdy styx.flag matches 1 run schedule function styx:redo/w${n}go 20t`,
    `execute if score #rdy styx.flag matches 0 if score #w${n} styx.flag matches ..40 run schedule function styx:redo/w${n} 20t`,
    `execute if score #rdy styx.flag matches 0 if score #w${n} styx.flag matches 41.. run tellraw @a {"text":"[Styx] ⚠ 窗口 ${n} 区块加载超时（40s），仍然尝试铺设","color":"yellow"}`,
    `execute if score #rdy styx.flag matches 0 if score #w${n} styx.flag matches 41.. run schedule function styx:redo/w${n}go 20t`,
  ]);
  w(`redo/w${n}go.mcfunction`, [
    `# 窗口 ${n}：存回退快照 → 摆音符盒 → 抽查 3 点；不合格最多补 2 次`,
    `scoreboard players add #t${n} styx.flag 1`,
    `function styx:undo/backup${n}`,
    'function styx:apply_notes_v3',
    'scoreboard players set #ok styx.flag 1',
    ...pt.map(([x, , z]) => `execute unless block ${x} ${NY} ${z} minecraft:note_block run scoreboard players set #ok styx.flag 0`),
    `execute if score #ok styx.flag matches 0 if score #t${n} styx.flag matches ..2 run tellraw @a {"text":"[Styx] 窗口 ${n} 抽查有缺口 → 再补一遍","color":"yellow"}`,
    `execute if score #ok styx.flag matches 0 if score #t${n} styx.flag matches ..2 run schedule function styx:redo/w${n}go 60t`,
    `execute if score #ok styx.flag matches 1 run function styx:redo/w${n}next`,
    `execute if score #ok styx.flag matches 0 if score #t${n} styx.flag matches 3.. run tellraw @a {"text":"[Styx] ⚠ 窗口 ${n} 补了两遍仍有缺口（区块加载太慢），先往下走","color":"red"}`,
    `execute if score #ok styx.flag matches 0 if score #t${n} styx.flag matches 3.. run function styx:redo/w${n}next`,
  ]);
  if (i + 1 < WIN.length) {
    w(`redo/w${n}next.mcfunction`, [
      `# 窗口 ${n} 完成 → 切到窗口 ${n + 1}`,
      'forceload remove all',
      fl(WIN[n]),
      `scoreboard players set #w${n + 1} styx.flag 0`,
      `schedule function styx:redo/w${n + 1} 40t`,
    ]);
  } else {
    w(`redo/w${n}next.mcfunction`, [
      '# 最后一个窗口完成：撤掉强加载、关掉数据包播放链路，机器交给 /nbm machine start',
      'forceload remove all',
      'scoreboard objectives add styx.flag dummy',
      // M3-69：redo 不再开监听、也不再自动播放（历史教训见 AUTONOMOUS_LOG M3-38：这里曾残留改名前的
      // `nbmachina listen on`，导致整个 s4 加载失败）。演奏由 mod 驱动，手动 `/nbm machine start`。
      'scoreboard players set #mon styx.flag 0',
      'tellraw @a {"text":"[Styx] 重做完成：音符盒已就位（抽查通过 ✔）—— 用 /nbm machine start 开始演奏","color":"gold"}',
    ]);
  }
});

/* ---------- 单独一个「只开监听」的入口，方便手动试听 ---------- */
w('redo/monitor.mcfunction', [
  'scoreboard objectives add styx.flag dummy',
  'function styx:play/monitor_on',
]);

console.log(`已生成: styx:redo、styx:redo_hi、styx:redo/s1、styx:redo/w1..w${WIN.length}（含 go/next）、styx:redo/monitor`);
