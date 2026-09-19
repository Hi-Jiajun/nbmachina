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
import zlib from 'node:zlib';

import { resolvePaths, resolveExternal } from '../core/paths.mjs';

const P = resolvePaths();
const EX = resolveExternal();
const SAVE = EX.save;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('out', path.join(P.datapackDir, 'function', 'wipe.mcfunction'));

// 扫描范围：机器本体 + 周围山地（2026-09-19 用户："后面山地这一块没有清除，一并清除掉"）。
// 按 section 的 palette 先判"这一格区有没有音符盒"，只有命中的 section 才逐格解 —— 快得多。
const X0 = 300, X1 = 3050, Y0 = -60, Y1 = 255, Z0 = -600, Z1 = 200;

class Reader {
  constructor(d) { this.d = d; this.p = 0; }
  u1() { return this.d[this.p++]; }
  i2() { const v = this.d.readInt16BE(this.p); this.p += 2; return v; }
  i4() { const v = this.d.readInt32BE(this.p); this.p += 4; return v; }
  str() { const n = this.d.readUInt16BE(this.p); this.p += 2; const s = this.d.toString('utf8', this.p, this.p + n); this.p += n; return s; }
  val(t) {
    switch (t) {
      case 1: return this.u1();
      case 2: return this.i2();
      case 3: return this.i4();
      case 4: { const v = this.d.readBigInt64BE(this.p); this.p += 8; return v; }
      case 5: { const v = this.d.readFloatBE(this.p); this.p += 4; return v; }
      case 6: { const v = this.d.readDoubleBE(this.p); this.p += 8; return v; }
      case 7: { const n = this.i4(); const v = this.d.subarray(this.p, this.p + n); this.p += n; return v; }
      case 8: return this.str();
      case 9: { const it = this.u1(); const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.val(it)); return a; }
      case 10: { const o = {}; for (;;) { const tt = this.u1(); if (tt === 0) return o; o[this.str()] = this.val(tt); } }
      case 11: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.i4()); return a; }
      case 12: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) { a.push(this.d.readBigInt64BE(this.p)); this.p += 8; } return a; }
      default: throw new Error('tag ' + t);
    }
  }
}

/** 读一个区块（含所有 section）；不存在返回 null */
function readChunk(cx, cz) {
  const p = path.join(SAVE, 'region', `r.${cx >> 5}.${cz >> 5}.mca`);
  if (!fs.existsSync(p)) return null;
  const fd = fs.openSync(p, 'r');
  try {
    const hdr = Buffer.alloc(8192);
    fs.readSync(fd, hdr, 0, 8192, 0);
    const i = (cx & 31) + (cz & 31) * 32;
    const off = hdr.readUIntBE(i * 4, 3);
    if (!off) return null;
    const hb = Buffer.alloc(5);
    fs.readSync(fd, hb, 0, 5, off * 4096);
    const len = hb.readInt32BE(0), ct = hb.readUInt8(4);
    const raw = Buffer.alloc(len - 1);
    fs.readSync(fd, raw, 0, len - 1, off * 4096 + 5);
    const data = ct === 2 ? zlib.inflateSync(raw) : zlib.gunzipSync(raw);
    const r = new Reader(data);
    const t = r.u1();
    r.str();
    return r.val(t);
  } finally {
    fs.closeSync(fd);
  }
}

/** section 内单点取方块名（不认识的东西返回 null） */
function blockAt(sec, x, y, z) {
  const bs = sec?.block_states;
  if (!bs?.palette) return null;
  const n = bs.palette.length;
  const bits = n === 1 ? 0 : Math.max(4, Math.ceil(Math.log2(n)));
  let idx = 0;
  if (bits) {
    const i2 = ((y & 15) << 8) | ((z & 15) << 4) | (x & 15);
    const bit = BigInt(i2 * bits);
    const li = Number(bit >> 6n);
    const off = Number(bit & 63n);
    if (li >= (bs.data?.length ?? 0)) return null;
    let v = BigInt.asUintN(64, BigInt(bs.data[li])) >> BigInt(off);
    if (off + bits > 64 && li + 1 < bs.data.length) v |= BigInt.asUintN(64, BigInt(bs.data[li + 1])) << BigInt(64 - off);
    idx = Number(v & ((1n << BigInt(bits)) - 1n));
  }
  return bs.palette[idx]?.Name ?? null;
}

const chunks = new Map();
const getChunk = (cx, cz) => {
  const k = `${cx},${cz}`;
  if (!chunks.has(k)) chunks.set(k, readChunk(cx, cz));
  return chunks.get(k);
};
const at = (x, y, z) => {
  const root = getChunk(x >> 4, z >> 4);
  const sec = root?.sections?.find((s) => s.Y === (y >> 4));
  return sec ? blockAt(sec, x, y, z) : null;
};

const noteBlocks = [];
const redstoneBlocks = [];
/** 一个 section 里所有目标方块的位置（只遍历 4096 格，且只在 palette 命中时做） */
function scanSection(sec, cx, cz, target, out) {
  const bs = sec?.block_states;
  if (!bs?.palette) return;
  const idx = bs.palette.findIndex((p) => p.Name === target);
  if (idx < 0) return;
  const n = bs.palette.length;
  const bits = n === 1 ? 0 : Math.max(4, Math.ceil(Math.log2(n)));
  const mask = bits ? (1n << BigInt(bits)) - 1n : 0n;
  const data = bs.data ?? [];
  const longs = data.map((v) => BigInt.asUintN(64, BigInt(v)));
  for (let y = 0; y < 16; y++) {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let v = 0;
        if (bits) {
          const i2 = (y << 8) | (z << 4) | x;
          const bit = BigInt(i2 * bits);
          const li = Number(bit >> 6n);
          const off = Number(bit & 63n);
          if (li >= longs.length) continue;
          v = longs[li] >> BigInt(off);
          if (off + bits > 64 && li + 1 < longs.length) v |= longs[li + 1] << BigInt(64 - off);
          v &= mask;
        }
        if (Number(v) !== idx) continue;
        const wx = cx * 16 + x, wy = sec.Y * 16 + y, wz = cz * 16 + z;
        if (wx < X0 || wx > X1 || wy < Y0 || wy > Y1 || wz < Z0 || wz > Z1) continue;
        out.push([wx, wy, wz]);
      }
    }
  }
}
for (let cx = X0 >> 4; cx <= (X1 >> 4); cx++) {
  for (let cz = Z0 >> 4; cz <= (Z1 >> 4); cz++) {
    const root = getChunk(cx, cz);
    if (!root?.sections) continue;
    for (const sec of root.sections) {
      scanSection(sec, cx, cz, 'minecraft:note_block', noteBlocks);
      scanSection(sec, cx, cz, 'minecraft:redstone_block', redstoneBlocks);
    }
  }
  if (cx % 32 === 0) process.stdout.write(`  扫描到 cx=${cx}（音符盒 ${noteBlocks.length}）\n`);
}

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
const WINDOWS = [[430, 830], [830, 1230], [1230, 1630], [1630, 2030], [2030, 2430], [2430, 2900]];
// ⚠ forceload 单次上限 256 区块 —— 2026-09-19 的坑：窗口 6 用了 z −240..−110（9 个 chunk）× x 470 格（30 chunk）
// = 270 > 256 → **这条 forceload 静默失败**（函数里的报错不写日志）→ 该窗口的 fill 全在未加载区块上执行 →
// 全部失败 → 用户看到的"末尾那一长段没清掉"。现在把 z 收敛到 fill 真正覆盖的 −200..−110（7 chunk），
// 并在生成时**断言每个窗口 ≤256 区块**，避免同类问题再偷偷回来。
const ZA = -200, ZB = -110;
// 过滤式清除的盒子（机器 + 山地遗留所在的带）：y 55..165、z -200..-110
const WY0 = 55, WY1 = 165, WZ0 = -200, WZ1 = -110;
for (const [xa, xb] of WINDOWS) {
  const cx = Math.floor(xb / 16) - Math.floor(xa / 16) + 1;
  const cz = Math.floor(ZB / 16) - Math.floor(ZA / 16) + 1;
  if (cx * cz > 256) throw new Error(`窗口 x${xa}..${xb} 需要 ${cx}×${cz}=${cx * cz} 个区块，超过 forceload 的 256 上限`);
}
const dir = path.dirname(OUT);
fs.mkdirSync(path.join(dir, 'wipe'), { recursive: true });
const body = lines.slice(2, lines.length - 1);

// ⚠ 2026-09-19 教训：逐格 setblock 依赖"扫描到的坐标"——存档还没落盘时就会漏。
// 改成**过滤式 fill**：`fill <box> air replace minecraft:note_block` 只删音符盒、保留地形，
// 不管方块是哪一版留下的、扫描有没有看见，一律清掉。
const steps = [];
WINDOWS.forEach(([xa, xb], i) => {
  const cmds = [];
  for (let x = xa; x < xb; x += 3) {
    const x2 = Math.min(x + 2, xb - 1);
    cmds.push(`fill ${x} ${WY0} ${WZ0} ${x2} ${WY1} ${WZ1} minecraft:air replace minecraft:note_block`);
    cmds.push(`fill ${x} ${WY0} ${WZ0} ${x2} ${WY1} ${WZ1} minecraft:air replace minecraft:redstone_block`);
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
  const cmds = [];
  for (let x = xa; x < xb; x += 5) {
    cmds.push(`fill ${x} 80 -178 ${Math.min(x + 4, xb - 1)} 165 -114 minecraft:air`);
  }
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
    tail.push('tellraw @a {"text":"[Styx] 区域已整体清空（y80..130）—— 现在跑 /function styx:redo 重建","color":"green"}');
  }
  fs.writeFileSync(path.join(dir, 'wipe_all', `${st.name}.mcfunction`), [...st.cmds, ...tail, ''].join('\n'), 'utf8');
});
fs.writeFileSync(ALL_OUT, [
  '# M3-38c · 彻底清空机器工作空间（y80..130 / z-178..-114），比 styx:wipe 更粗暴：连甲板/灯/遗留方块一起填成空气',
  'scoreboard objectives add styx.flag dummy',
  'forceload remove all',
  `forceload add ${allSteps[0].xa} ${ZA} ${allSteps[0].xb} ${ZB}`,
  `schedule function styx:wipe_all/${allSteps[0].name} 40t`,
  `tellraw @a {"text":"[Styx] 正在整体清空机器区域（分 ${allSteps.length} 个窗口，约 30 秒）…","color":"gold"}`,
  '',
].join('\n'), 'utf8');
console.log(`写出 ${ALL_OUT} + wipe_all/${allSteps.map((s) => `${s.name}(${s.cmds.length}条)`).join(' ')}`);
