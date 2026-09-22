// 生成「一条命令跑完全部」的链式函数：/function styx:redo（精确模式 styx:redo_hi）
//
// 链的设计（M3-73 重写）：**先把整台机器的区块全部强加载 + 密集等待就绪 → 一次铺完 → 全量核对 3044 格 →
// 有缺口就自动补（最多 3 次）→ 只有当 3044/3044 都对上时才报"完成"**。
//
// 为什么改（2026-09-22 用户："后面这一段的音符盒怎么没有渲染出来呢？"）：
// 上一版是"分 3 个窗口，每窗口抽查 3 个点，通过就切下一个窗口"。实测用户存档扫出来 **2157/3044**：
// 缺的 887 个全部集中在窗口 2 的中段（chunk x65..108，共 100 个 chunk 整块为空）——
// `forceload` 之后区块是**异步**加载的，抽查的 3 个点恰好落在已经就绪的 chunk 上，于是"抽查通过 ✔"，
// 而中段 100 个 chunk 还没加载好 → `setblock` 静默失败。抽查 3 点分辨不出这种"整段缺失"。
//
// 两个入口只差一个 #hiwant：0 = 20 tps 表（默认），1 = 100 tps 表（需先 /tick rate 100）。
// 为什么不直接在函数里写 tick rate：函数权限等级 2 < `/tick` 需要的 3，写了整文件加载失败（实测）。
import fs from 'node:fs';
import { resolvePaths } from '../core/paths.mjs';

const P = resolvePaths();
const DP = P.functionsDir;
const prof = JSON.parse(fs.readFileSync(P.profile, 'utf8'));
const X0 = prof[0].x0, X1 = prof[prof.length - 1].x0 + 47;
const ZB = prof[0].z0 ?? -172, ZE = ZB + 24 + 3;
/** 音符盒所在的那一层（甲板 y 的上一格）——`if loaded` / `if block` 核对都用它 */
const NY = prof[0].y + 1;
const STEP = Math.ceil((X1 - X0 + 1) / 3);
const WIN = [
  [X0, X0 + STEP - 1],
  [X0 + STEP, X0 + 2 * STEP - 1],
  [X0 + 2 * STEP, X1],
];
// forceload 单次上限 256 区块：逐个窗口断言（三个窗口可以分别 add，总量没有上限）
for (const [a, b] of WIN) {
  const cx = Math.floor(b / 16) - Math.floor(a / 16) + 1;
  const cz = Math.floor(ZE / 16) - Math.floor(ZB / 16) + 1;
  if (cx * cz > 256) throw new Error(`forceload 窗口 x${a}..${b} 需要 ${cx}×${cz}=${cx * cz} 个区块，超过 256 上限`);
}
const flLines = WIN.map((w) => `forceload add ${w[0]} ${ZB} ${w[1]} ${ZE}`);

// 期望坐标：直接读刚生成的 `apply_notes_v3.mcfunction`（摆块与核对同源，绝不各说各话）
const applyFn = `${DP}/apply_notes_v3.mcfunction`;
const placed = fs.existsSync(applyFn)
  ? [...fs.readFileSync(applyFn, 'utf8').matchAll(/^setblock (-?\d+) (-?\d+) (-?\d+) minecraft:note_block/gm)]
    .map((m) => [+m[1], +m[2], +m[3]])
  : [];
if (placed.length < 30) throw new Error(`从 ${applyFn} 里读到的音符盒太少（${placed.length}）——先跑 note-blocks.mjs 再跑本脚本`);

// 等待就绪的抽样点：**每 32 格一个**铺满整台机器（~74 点）——上一版 3 个点分辨不出"整段未加载"
const waitPts = [];
for (let x = X0; x <= X1; x += 32) waitPts.push([x, NY, ZB + 13]);

console.log(`redo forceload 窗口：${WIN.map((w) => `${w[0]}..${w[1]} z${ZB}..${ZE}`).join(' / ')}`);
console.log(`  等待就绪抽样点 ${waitPts.length} 个（每 32 格一个）；全量核对 ${placed.length} 格`);

fs.mkdirSync(`${DP}/redo`, { recursive: true });
// 清掉旧版链留下的分段函数（w1/w1go/…/s1..s4），免得有人手滑直接跑旧段
for (const f of fs.readdirSync(`${DP}/redo`)) {
  if (/^(w\d+(go|next)?|s\d+)\.mcfunction$/.test(f)) fs.rmSync(`${DP}/redo/${f}`);
}
const w = (name, lines) => fs.writeFileSync(`${DP}/${name}`, lines.join('\n') + '\n', 'utf8');

/* ---------- 入口 ---------- */
const entry = (name, hiwant, title) => w(name, [
  'scoreboard objectives add styx.flag dummy',
  `scoreboard players set #hiwant styx.flag ${hiwant}`,
  'scoreboard players set #try styx.flag 0',
  'scoreboard players set #fix styx.flag 0',
  'scoreboard players set #miss styx.flag 0',
  `tellraw @a {"text":"[Styx] ${title}：① 强加载整台机器 → ② 等区块就绪 → ③ 铺音符盒 + 全量核对（1~4 分钟，请勿离开太远）","color":"gold"}`,
  'forceload remove all',
  ...flLines,
  'schedule function styx:redo/wait 40t',
]);
entry('redo.mcfunction', 0, '开始重做（20 tps 模式）');
entry('redo_hi.mcfunction', 1, '开始重做（100 tps 精确模式，需已执行 /tick rate 100）');

/* ---------- ① 等整台机器的区块都就绪 ---------- */
w('redo/wait.mcfunction', [
  '# 等就绪：每 32 格一个抽样点，全部 `if loaded` 为真才动手（最多 40 次 × 1 秒）',
  'scoreboard objectives add styx.flag dummy',
  'scoreboard players add #try styx.flag 1',
  'scoreboard players set #rdy styx.flag 1',
  ...waitPts.map(([x, y, z]) => `execute unless loaded ${x} ${y} ${z} run scoreboard players set #rdy styx.flag 0`),
  'execute if score #rdy styx.flag matches 1 run function styx:redo/go',
  'execute if score #rdy styx.flag matches 0 if score #try styx.flag matches ..40 run schedule function styx:redo/wait 20t',
  'execute if score #rdy styx.flag matches 0 if score #try styx.flag matches 41.. run tellraw @a {"text":"[Styx] ⚠ 区块加载超时（40s），仍然尝试铺设（后面会全量核对并自动补）","color":"yellow"}',
  'execute if score #rdy styx.flag matches 0 if score #try styx.flag matches 41.. run function styx:redo/go',
]);

/* ---------- ② 备份 → 清旧红石块 → 铺 → 全量核对 ---------- */
w('redo/go.mcfunction', [
  '# 清掉旧版残留（红石块/旧回退快照）→ 摆音符盒 → 全量核对',
  'scoreboard objectives add styx.flag dummy',
  'scoreboard players add #fix styx.flag 1',
  'function styx:apply_notes_v3',
  'function styx:redo/check',
]);

// M3-84：清场从这里**整体移出**。redo 只负责"强加载 → 等就绪 → 摆音符盒 → 全量核对"，
// 清旧方块/清残留/清快照一律交给 wipe 侧（`src/scan/wipe-machine-region.mjs` 按真实存档扫描生成），
// 避免"重做"顺手改世界、也避免 redo 在没有清场授权的情况下把别的东西铲掉。

/* ---------- ③ 全量核对：3044 格逐格查，缺一格都算不合格 ---------- */
w('redo/check.mcfunction', [
  `# 全量核对 ${placed.length} 格（缺一格就 +1 #miss）——抽样会漏，这里一格不放过`,
  'scoreboard objectives add styx.flag dummy',
  'scoreboard players set #miss styx.flag 0',
  ...placed.map(([x, y, z]) => `execute unless block ${x} ${y} ${z} minecraft:note_block run scoreboard players add #miss styx.flag 1`),
  'execute if score #miss styx.flag matches 0 run function styx:redo/done',
  'execute if score #miss styx.flag matches 1.. if score #fix styx.flag matches ..3 run tellraw @a {"text":"[Styx] 全量核对发现缺口（第 ","color":"yellow","extra":[{"score":{"name":"#fix","objective":"styx.flag"}},{"text":" 次铺设）：仍缺 "},{"score":{"name":"#miss","objective":"styx.flag"}},{"text":" 格 → 40 秒后再铺一遍"}]}',
  'execute if score #miss styx.flag matches 1.. if score #fix styx.flag matches ..3 run schedule function styx:redo/go 40t',
  'execute if score #miss styx.flag matches 1.. if score #fix styx.flag matches 4.. run tellraw @a {"text":"[Styx] ⚠ 铺了 3 遍仍有缺口：仍缺 ","color":"red","extra":[{"score":{"name":"#miss","objective":"styx.flag"}},{"text":" 格。请跑 /function styx:redo/patch 再补（或把这段截图发给 Codex）"}]}',
  'execute if score #miss styx.flag matches 1.. if score #fix styx.flag matches 4.. run scoreboard players set #mon styx.flag 0',
]);

/* ---------- ④ 完成 / 手动补铺入口 / 只开监听 ---------- */
w('redo/done.mcfunction', [
  '# 全量核对通过：撤强加载、关掉数据包播放链路，机器交给 /nbm machine start',
  'forceload remove all',
  'scoreboard objectives add styx.flag dummy',
  // M3-69：redo 不再开监听、也不再自动播放（历史教训见 AUTONOMOUS_LOG M3-38）。
  'scoreboard players set #mon styx.flag 0',
  `tellraw @a {"text":"[Styx] 重做完成：音符盒全量核对通过（${placed.length}/${placed.length}）—— 用 /nbm machine start 开始演奏","color":"gold"}`,
]);
w('redo/patch.mcfunction', [
  '# 手动补铺：重新强加载整台机器 → 等就绪 → 铺 + 全量核对（缺格时用这个，或直接再跑 styx:redo）',
  'scoreboard objectives add styx.flag dummy',
  'scoreboard players set #try styx.flag 0',
  'scoreboard players set #fix styx.flag 0',
  'forceload remove all',
  ...flLines,
  'tellraw @a {"text":"[Styx] 开始补铺：重新加载整台机器并全量核对…","color":"gold"}',
  'schedule function styx:redo/wait 40t',
]);
w('redo/monitor.mcfunction', [
  'scoreboard objectives add styx.flag dummy',
  'function styx:play/monitor_on',
]);

/* ---------- 回退功能整体移除（M3-75；用户："我不想要回退功能"） ---------- */
// 以前这里会额外生成 styx:undo —— 把每条轨道 clone 到机器上方 +40（后来 +900）格当快照。
// 现在不再生成任何 undo/*，并把老存档里遗留的那批函数删掉（`tools/install-datapack.mjs` 的镜像也会清）；
// 只留一个 /function styx:undo 的提示入口，免得手滑时只看到"未知函数"。
fs.rmSync(`${DP}/undo`, { recursive: true, force: true });
w('undo.mcfunction', [
  '# M3-75：回退功能已移除（用户不需要）。清空机器 → /function styx:wipe；重新铺 → /function styx:redo',
  'tellraw @a {"text":"[Styx] 回退功能已在 M3-75 移除：清空机器用 /function styx:wipe，重新铺用 /function styx:redo","color":"gold"}',
]);

console.log('已生成: styx:redo、styx:redo_hi、styx:redo/{wait,go,check,done,patch,monitor}；undo 功能已移除（只留提示入口）');
