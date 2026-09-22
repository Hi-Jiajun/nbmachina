#!/usr/bin/env node
// M3-38c · 扫描存档里"机器区域"的全部音符盒/红石块（含历史遗留），生成 styx:wipe 函数把它们清空。
//
// 为什么需要它：几次改布局（单排 / 双排 / 折叠口径变化）在世界里留下了**不在当前谱面里**的音符盒。
// 数据包按新坐标放红石块时，会顺手点亮这些遗留方块 → 每一步都混进"不该出现的音"（真机实测：
// 音符盒事件里约 10% 命中不了谱面映射）。与其逐个猜坐标，不如**直接扫存档**把它们全清掉。
//
// 只清机器自己的方块（音符盒 / 灯 / 红石块），不动地形；重建交给 `styx:redo`。
//
// 用法：node src/scan/wipe-machine-region.mjs [--out <函数路径>]
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths, resolveExternal } from '../core/paths.mjs';
import { makeSaveReader } from './mca.mjs';

const P = resolvePaths();
const EX = resolveExternal();
const SAVE = EX.save;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('out', path.join(P.datapackDir, 'function', 'wipe.mcfunction'));

// M3-70：扫描范围**按剖面推导**（顺带把历史上用过的旧 z 带也扫进去）——
// 换原点/换存档之后 wipe 依然扫得到残留，不用再改代码。
const prof = JSON.parse(fs.readFileSync(P.profile, 'utf8'));
const MX0 = prof[0].x0, MX1 = prof[prof.length - 1].x0 + 47;
const MZ0 = prof[0].z0 ?? -172, MZ1 = MZ0 + 27;
const MY = prof[0].y;
// 按 section 的 palette 先判"这一格区有没有音符盒"，只有命中的 section 才逐格解 —— 快得多。
const X0 = Math.min(MX0 - 400, 300), X1 = Math.max(MX1 + 400, 3050);
// y 下限压到 −128：虚空存档的机器现在贴在 y≈−62，而且区块 section 的 Y 是**有符号 byte**
// （见 src/scan/mca.mjs 顶部注释），范围放宽一点才不会漏掉负高度里的残留
const Y0 = Math.min(MY - 64, -128), Y1 = 320;
const Z0 = Math.min(MZ0 - 120, -220), Z1 = Math.max(MZ1 + 120, -100);

const reader = makeSaveReader(SAVE);
const hits = reader.scan({ x0: X0, x1: X1, y0: Y0, y1: Y1, z0: Z0, z1: Z1 },
  ['minecraft:note_block', 'minecraft:redstone_block']);
const noteBlocks = hits.get('minecraft:note_block');
const redstoneBlocks = hits.get('minecraft:redstone_block');
const at = reader.blockAt;

// 当前谱面的音符盒坐标（甲板坐标 +1 层）→ 用来区分"该留的"和"遗留的"
// machine_map.csv 在客户端游戏目录的 nbmachina/ 下；存档目录的上一级就是游戏目录（saves/<世界>）
const gameDir = path.dirname(path.dirname(SAVE));
const mapCsv = fs.readFileSync(path.join(gameDir, 'nbmachina', 'machine_map.csv'), 'utf8').trim().split(/\r?\n/);
const hdr = mapCsv[0].split(',');
const ix = hdr.indexOf('x'), iy = hdr.indexOf('y'), iz = hdr.indexOf('z');
const expected = new Set(mapCsv.slice(1).map((l) => {
  const c = l.split(',');
  return `${+c[ix]},${+c[iy] + 1},${+c[iz]}`;
}));

const leftover = noteBlocks.filter(([x, y, z]) => !expected.has(`${x},${y},${z}`));
console.log(`扫描完成：音符盒 ${noteBlocks.length} 个（当前谱面应有 ${expected.size} 个），其中**遗留 ${leftover.length}** 个；红石块 ${redstoneBlocks.length} 个`);
{
  const box = (arr) => (arr.length
    ? `x ${Math.min(...arr.map((a) => a[0]))}..${Math.max(...arr.map((a) => a[0]))} / `
      + `y ${Math.min(...arr.map((a) => a[1]))}..${Math.max(...arr.map((a) => a[1]))} / `
      + `z ${Math.min(...arr.map((a) => a[2]))}..${Math.max(...arr.map((a) => a[2]))}`
    : '（无）');
  console.log(`  全部音符盒包围盒：${box(noteBlocks)}`);
  console.log(`  遗留音符盒包围盒：${box(leftover)}`);
  const hist = new Map();
  for (const [, y] of noteBlocks) hist.set(y, (hist.get(y) ?? 0) + 1);
  console.log('  y 分布：' + [...hist.entries()].sort((a, b) => a[0] - b[0])
    .map(([y, n]) => `${y}:${n}`).join(' '));
}

const lines = [
  '# M3-38c 由 src/scan/wipe-machine-region.mjs 生成：清掉机器区域里的所有音符盒/红石块（含历史遗留）',
  `# 音符盒 ${noteBlocks.length}（遗留 ${leftover.length}） / 红石块 ${redstoneBlocks.length}`,
];
for (const [x, y, z] of noteBlocks) {
  lines.push(`setblock ${x} ${y} ${z} minecraft:air`);
  // 灯也一起清（重建时 apply_notes_v3 会重新摆）
  if (at(x, y - 1, z) === 'minecraft:redstone_lamp') lines.push(`setblock ${x} ${y - 1} ${z} minecraft:air`);
}
for (const [x, y, z] of redstoneBlocks) lines.push(`setblock ${x} ${y} ${z} minecraft:air`);
lines.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });

// ⚠ 关键：`setblock` **只对已加载的区块生效**。机器长 2400 格，站在这头时那头的 setblock 会静默失败
// （2026-09-19 第一次 wipe 只清掉一小部分就是这个原因）。所以按 x 分窗口，每个窗口先 forceload、
// 等 2 秒再清，清完换下一个窗口。forceload 单次上限 256 区块 → 窗口取 400 格宽（25×9=225 区块）。
// 清理范围 = **机器本体 ∪ 这次扫描到的实际残留**（旧版写死 430..2900 / −200..−110，换原点后清的是空带）
const hit = [...noteBlocks, ...redstoneBlocks];
let hMinX = MX0, hMaxX = MX1, hMinY = MY, hMaxY = MY, hMinZ = MZ0, hMaxZ = MZ1;
for (const [x, y, z] of hit) {
  hMinX = Math.min(hMinX, x); hMaxX = Math.max(hMaxX, x);
  hMinY = Math.min(hMinY, y); hMaxY = Math.max(hMaxY, y);
  hMinZ = Math.min(hMinZ, z); hMaxZ = Math.max(hMaxZ, z);
}
// x 边界按区块对齐（16 的整数倍）——不然窗口跨半块，chunk 数会比 winWidth/16 多 1
const align = (v, dir) => dir < 0 ? Math.floor(v / 16) * 16 : Math.ceil(v / 16) * 16 - 1;
const XA = align(hMinX - 8, -1), XB = align(hMaxX + 8, +1);
const ZA = hMinZ - 2, ZB = hMaxZ + 2;
// y 上限取"甲板上方 +48"：把 undo 快照那条带（clone 到 +40 格）也一起清掉
const WY0 = hMinY - 8, WY1 = hMaxY + 48;
// ⚠ forceload 单次上限 256 区块 —— 2026-09-19 的坑：窗口 6 用 30×9=270 区块 → **这条 forceload 静默失败**
// → 该窗口的 fill 全在未加载区块上执行 → 全部失败 → "末尾那一长段没清掉"。
// 现在窗口宽度按"z 带占几个 chunk"反推，并在生成时再断言一次。
const czSpan = Math.floor(ZB / 16) - Math.floor(ZA / 16) + 1;
// 留一格余量：256 正好卡满时容易因为边界差异溢出（实测踩过 86×3=258）
const maxChunks = Math.max(1, Math.floor(256 / czSpan) - 1);
const winWidth = maxChunks * 16;
const NWIN = Math.ceil((XB - XA + 1) / winWidth);
const WINDOWS = Array.from({ length: NWIN }, (_, i) =>
  [XA + i * winWidth, Math.min(XA + (i + 1) * winWidth - 1, XB)]);
for (const [xa, xb] of WINDOWS) {
  const cx = Math.floor(xb / 16) - Math.floor(xa / 16) + 1;
  if (cx * czSpan > 256) throw new Error(`窗口 x${xa}..${xb} 需要 ${cx}×${czSpan} 个区块，超过 forceload 的 256 上限`);
}
/**
 * 体积安全的 fill 生成器：先按 z 切、再按 x 切，保证每条指令 ≤32768 格。
 * 旧版把宽度写死（2 格 / 1 格），z 带一变宽就会**静默失败**（`/fill` 超限不报错、直接不执行）。
 */
const fillBox = (xa, xb, y0, y1, z0, z1, block, replace) => {
  const out = [];
  const maxVol = 32768;
  const yLen = y1 - y0 + 1;
  const zStep = Math.max(1, Math.floor(maxVol / yLen));
  for (let z = z0; z <= z1; z += zStep) {
    const z2 = Math.min(z + zStep - 1, z1);
    const volYZ = yLen * (z2 - z + 1);
    const xStep = Math.max(1, Math.floor(maxVol / volYZ));
    for (let x = xa; x <= xb; x += xStep) {
      const x2 = Math.min(x + xStep - 1, xb);
      out.push(`fill ${x} ${y0} ${z} ${x2} ${y1} ${z2} ${block}${replace ? ` replace ${replace}` : ''}`);
    }
  }
  return out;
};
const dir = path.dirname(OUT);
fs.mkdirSync(path.join(dir, 'wipe'), { recursive: true });
const body = lines.slice(2, lines.length - 1);

// ⚠ 2026-09-19 教训：逐格 setblock 依赖"扫描到的坐标"——存档还没落盘时就会漏。
// 改成**过滤式 fill**：`fill <box> air replace minecraft:note_block` 只删音符盒、保留地形，
// 不管方块是哪一版留下的、扫描有没有看见，一律清掉。
const steps = [];
WINDOWS.forEach(([xa, xb], i) => {
  const cmds = [];
  for (const target of ['minecraft:note_block', 'minecraft:redstone_block', 'minecraft:redstone_lamp']) {
    cmds.push(...fillBox(xa, xb, WY0, WY1, ZA, ZB, 'minecraft:air', target));
  }
  steps.push({ name: `s${i + 1}`, xa, xb, cmds });
});

steps.forEach((st, i) => {
  const tail = [];
  if (i + 1 < steps.length) {
    tail.push('forceload remove all');
    tail.push(`forceload add ${steps[i + 1].xa} ${ZA} ${steps[i + 1].xb} ${ZB}`);
    tail.push(`schedule function styx:wipe/${steps[i + 1].name} 60t`);   // 60t=3s，给区块加载留足时间
    tail.push(`tellraw @a {"text":"[Styx] 清理中…窗口 ${i + 2}/${steps.length}","color":"gray"}`);
  } else {
    // M3-46：**自检抽查** —— 拿几个"扫描到的遗留位置"当样本，清完立刻验一遍，
    // 免得再出现"提示说清理完成、实际末尾没清掉"（2026-09-19 连续踩了两次）。
    const probes = [];
    if (leftover.length) {
      const stride = Math.max(1, Math.floor(leftover.length / 8));
      for (let k = 0; k < leftover.length && probes.length < 8; k += stride) probes.push(leftover[k]);
    }
    tail.push('forceload remove all');
    tail.push('scoreboard objectives add styx.flag dummy');
    tail.push('scoreboard players set #left styx.flag 0');
    for (const [x, y, z] of probes) {
      tail.push(`execute if block ${x} ${y} ${z} minecraft:note_block run scoreboard players add #left styx.flag 1`);
    }
    tail.push('execute if score #left styx.flag matches 1.. run tellraw @a {"text":"[Styx] ⚠ 抽查发现仍有残留音符盒（清理没完全生效）——把这条截图发给 Codex","color":"red"}');
    tail.push('execute if score #left styx.flag matches 0 run tellraw @a {"text":"[Styx] 机器区域清理完成 + 抽查通过 ✔ —— 现在跑 /function styx:redo 重建","color":"green"}');
  }
  const head = i === 0 ? [] : [];
  fs.writeFileSync(path.join(dir, 'wipe', `${st.name}.mcfunction`),
    [...head, ...st.cmds, ...tail, ''].join('\n'), 'utf8');
});

fs.writeFileSync(OUT, [
  ...lines.slice(0, 2),
  'scoreboard objectives add styx.flag dummy',
  'forceload remove all',
  `forceload add ${steps[0].xa} ${ZA} ${steps[0].xb} ${ZB}`,
  `schedule function styx:wipe/${steps[0].name} 40t`,
  `tellraw @a {"text":"[Styx] 正在清除机器区域的历史方块（分 ${steps.length} 个窗口，先强加载区块，约 30 秒）…","color":"gold"}`,
  '',
].join('\n'), 'utf8');
console.log(`写出 ${OUT} + wipe/${steps.map((s) => `${s.name}(${s.cmds.length}条)`).join(' ')}`);

// ---- 彻底版：把整条机器的**工作空间**直接 fill 成空气（用户 2026-09-19："直接把这个区域清空都行"）----
// 范围取 y 80..130 / z -178..-114（机器甲板 84..110、音符盒 85..111、扫描到的遗留最高 129），
// 不碰 y<80 的地面。每条 fill 控制在 32768 格以内（6 × 51 × 65 = 19890）。
const ALL_OUT = path.join(dir, 'wipe_all.mcfunction');
fs.mkdirSync(path.join(dir, 'wipe_all'), { recursive: true });
const allSteps = [];
WINDOWS.forEach(([xa, xb], i) => {
  // ⚠ /fill 单次上限 32768 格 —— 切块交给 fillBox（旧版写死 2 格宽，范围一变宽就静默失败）
  const cmds = fillBox(xa, xb, WY0, WY1, ZA, ZB, 'minecraft:air');
  allSteps.push({ name: `a${i + 1}`, xa, xb, cmds });
});
allSteps.forEach((st, i) => {
  const tail = [];
  if (i + 1 < allSteps.length) {
    tail.push('forceload remove all');
    tail.push(`forceload add ${allSteps[i + 1].xa} ${ZA} ${allSteps[i + 1].xb} ${ZB}`);
    tail.push(`schedule function styx:wipe_all/${allSteps[i + 1].name} 40t`);
  } else {
    tail.push('forceload remove all');
    tail.push(`tellraw @a {"text":"[Styx] 区域已整体清空（y${WY0}..${WY1} / z${ZA}..${ZB}，含旧平台/一切方块）—— 现在跑 /function styx:redo 重建","color":"green"}`);
  }
  fs.writeFileSync(path.join(dir, 'wipe_all', `${st.name}.mcfunction`), [...st.cmds, ...tail, ''].join('\n'), 'utf8');
});
fs.writeFileSync(ALL_OUT, [
  `# M3-70 · 彻底清空机器工作空间（y${WY0}..${WY1} / z${ZA}..${ZB}，按剖面 + 扫描残留推导）：连甲板/灯/旧平台/遗留方块一起填成空气`,
  'scoreboard objectives add styx.flag dummy',
  'forceload remove all',
  `forceload add ${allSteps[0].xa} ${ZA} ${allSteps[0].xb} ${ZB}`,
  `schedule function styx:wipe_all/${allSteps[0].name} 40t`,
  `tellraw @a {"text":"[Styx] 正在整体清空机器区域（分 ${allSteps.length} 个窗口，约 30 秒）…","color":"gold"}`,
  '',
].join('\n'), 'utf8');
console.log(`写出 ${ALL_OUT} + wipe_all/${allSteps.map((s) => `${s.name}(${s.cmds.length}条)`).join(' ')}`);

// ---- 彻底铲平版（用户 2026-09-19："把区块内所有方块都清除掉"）：整列清空（y −64..319）
// 注意：这会把地形一起抹掉（机器所在的那条带会变成虚空），重建只能用 styx:redo 铺机器本身。
const VOID_OUT = path.join(dir, 'wipe_void.mcfunction');
fs.mkdirSync(path.join(dir, 'wipe_void'), { recursive: true });
const voidSteps = [];
WINDOWS.forEach(([xa, xb], i) => {
  // 整列清空（y −64..319）：体积更大，fillBox 会同时按 z / x 切（旧版手写"z 切两半 + x 每次 1 格"）
  const cmds = fillBox(xa, xb, -64, 319, ZA, ZB, 'minecraft:air');
  voidSteps.push({ name: `v${i + 1}`, xa, xb, cmds });
});
voidSteps.forEach((st, i) => {
  const tail = [];
  if (i + 1 < voidSteps.length) {
    tail.push('forceload remove all');
    tail.push(`forceload add ${voidSteps[i + 1].xa} ${ZA} ${voidSteps[i + 1].xb} ${ZB}`);
    tail.push(`schedule function styx:wipe_void/${voidSteps[i + 1].name} 60t`);
    tail.push('tellraw @a {"text":"[Styx] 铲平中…下一个窗口","color":"gray"}');
  } else {
    tail.push('forceload remove all');
    tail.push('tellraw @a {"text":"[Styx] ⚠ 整列已清空（地形也没了）—— 现在跑 /function styx:redo 重建机器","color":"red"}');
  }
  fs.writeFileSync(path.join(dir, 'wipe_void', `${st.name}.mcfunction`), [...st.cmds, ...tail, ''].join('\n'), 'utf8');
});
fs.writeFileSync(VOID_OUT, [
  `# M3-70 · 彻底铲平：把机器那条带（z ${ZA}..${ZB}）整列 y −64..319 清成空气（地形一起没）`,
  'scoreboard objectives add styx.flag dummy',
  'forceload remove all',
  `forceload add ${voidSteps[0].xa} ${ZA} ${voidSteps[0].xb} ${ZB}`,
  `schedule function styx:wipe_void/${voidSteps[0].name} 60t`,
  'tellraw @a {"text":"[Styx] ⚠ 开始整列清空（地形会消失，只保留机器重建能力）…","color":"red"}',
  '',
].join('\n'), 'utf8');
console.log(`写出 ${VOID_OUT} + wipe_void/${voidSteps.map((s) => `${s.name}(${s.cmds.length}条)`).join(' ')}`);

// M3-56（用户："wipe脚本要清理干净所有包括音符盒方块"）：
// **默认 `styx:wipe` 改成彻底清**（把机器工作空间整段清空，含旧平台/灯/甲板/一切方块），
// 想只清音符盒+红石块+灯（保留地形）就用 `styx:wipe_notes`。
fs.copyFileSync(OUT, path.join(dir, 'wipe_notes.mcfunction'));
fs.writeFileSync(OUT, [
  `# M3-70 默认 wipe = 彻底清：把机器工作空间 y${WY0}..${WY1} / z${ZA}..${ZB} 清成空气（范围按剖面 + 扫描残留推导）`,
  '# 只想清音符盒/红石块/灯、保留地形 → 用 styx:wipe_notes',
  'function styx:wipe_all',
  '',
].join('\n'), 'utf8');
console.log('默认 wipe 已改为"彻底清"（调 wipe_all）；过滤版保留为 styx:wipe_notes');
