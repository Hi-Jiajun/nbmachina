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

// 机器区域（含历史布局的余量）：x 480..2831、y 84..110 是当前机器；老布局更低/更靠 z 负方向
const X0 = 430, X1 = 2900, Y0 = 55, Y1 = 130, Z0 = -235, Z1 = -115;

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
for (let x = X0; x <= X1; x++) {
  for (let z = Z0; z <= Z1; z++) {
    for (let y = Y0; y <= Y1; y++) {
      const name = at(x, y, z);
      if (!name) continue;
      if (name === 'minecraft:note_block') noteBlocks.push([x, y, z]);
      else if (name === 'minecraft:redstone_block') redstoneBlocks.push([x, y, z]);
    }
  }
  if (x % 400 === 0) process.stdout.write(`  扫描到 x=${x}（音符盒 ${noteBlocks.length}）\n`);
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
// 拆成几段、每隔 1 tick 执行一段：2.9 万条 setblock 一次性跑会让服务器卡住好几秒
const CHUNK = 6000;
const body = lines.slice(2, lines.length - 1);
const parts = [];
for (let i = 0; i < body.length; i += CHUNK) parts.push(body.slice(i, i + CHUNK));
const dir = path.dirname(OUT);
fs.mkdirSync(path.join(dir, 'wipe'), { recursive: true });
parts.forEach((cmds, i) => {
  fs.writeFileSync(path.join(dir, 'wipe', `s${i + 1}.mcfunction`), cmds.join('\n') + '\n', 'utf8');
});
const entry = [
  ...lines.slice(0, 2),
  ...parts.map((_, i) => `schedule function styx:wipe/s${i + 1} ${i + 1}t`),
  'tellraw @a {"text":"[Styx] 正在清除机器区域的历史方块（分 ' + parts.length + ' 段，约 ' + parts.length + ' 秒）…","color":"gold"}',
  '',
];
fs.writeFileSync(OUT, entry.join('\n'), 'utf8');
console.log(`写出 ${OUT} + wipe/s1..s${parts.length}：共 ${body.length} 条指令（每段 ${CHUNK}）`);
