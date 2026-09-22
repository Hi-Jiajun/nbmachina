// 存档 `region/*.mca` 只读读取器（M3-70 从 `wipe-machine-region.mjs` 抽出来共用）。
//
// 为什么单独一个模块：wipe 生成器要"扫存档里到底有哪些残留方块"，无头验收
// （`src/test/verify-redo-generation.mjs`）也要"扫存档证明音符盒真的铺出来了"——
// 两边必须是同一套解析口径，否则"验收通过"和"wipe 清不干净"会各说各话。
//
// 用法：
//   const reader = makeSaveReader(saveDir);
//   const hits = reader.scan({ x0, x1, y0, y1, z0, z1 }, ['minecraft:note_block']);
//   hits.get('minecraft:note_block')   // → [[x, y, z], ...]
//   reader.blockAt(x, y, z)            // → 'minecraft:air' / null（区块缺失）
//
// ⚠ 坑（2026-09-22 实测）：区块里 `sections[].Y` 是**有符号 byte**，但 NBT 里按 unsigned 读出来，
// 负的 section 会变成 251..255（−5 存成 251）。不还原符号的话，凡是在 y<0 的方块都扫不到 ——
// 虚空机器搬到 y=−62 之后，这个坑直接表现为"扫出来 0 个音符盒，但游戏里明明有"。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** 极简 NBT 读取器（只认我们在区块里会遇到的那几种 tag） */
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

/** section 的 Y：NBT 里是 byte，读成 unsigned 后要把 251..255 还原成 −5..−1 */
const secY = (sec) => (sec.Y > 127 ? sec.Y - 256 : sec.Y);

/** 读一个区块（含所有 section）；不存在返回 null */
function readChunk(saveDir, cx, cz) {
  const p = path.join(saveDir, 'region', `r.${cx >> 5}.${cz >> 5}.mca`);
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
function blockAtSection(sec, x, y, z) {
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

/** 一个 section 里所有目标方块的位置（只在 palette 命中时才逐格解 —— 比全量扫快得多） */
function scanSection(sec, cx, cz, target, out, box) {
  const bs = sec?.block_states;
  if (!bs?.palette) return;
  // ⚠ 坑（2026-09-22 实测）：palette 是**按方块状态**去重的，同一个方块名会出现多次
  // （机器上 `note_block` 至少两档：instrument=harp 与 instrument=bass）→ 只取 findIndex 会漏掉另一档，
  // 表现为"扫出来只有一半音符盒"。这里必须把所有同名的 palette 下标都收进来。
  const idxs = new Set();
  bs.palette.forEach((p, i) => { if (p.Name === target) idxs.add(i); });
  if (!idxs.size) return;
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
        if (!idxs.has(Number(v))) continue;
        const wx = cx * 16 + x, wy = secY(sec) * 16 + y, wz = cz * 16 + z;
        if (wx < box.x0 || wx > box.x1 || wy < box.y0 || wy > box.y1 || wz < box.z0 || wz > box.z1) continue;
        out.push([wx, wy, wz]);
      }
    }
  }
}

/**
 * 建立一个存档读取器（内部缓存已读区块，重复访问同区块不会重复解压）。
 *
 * @param {string} saveDir 存档目录（里面有 `region/`）
 */
export function makeSaveReader(saveDir) {
  const chunks = new Map();
  const getChunk = (cx, cz) => {
    const k = `${cx},${cz}`;
    if (!chunks.has(k)) chunks.set(k, readChunk(saveDir, cx, cz));
    return chunks.get(k);
  };
  const blockAt = (x, y, z) => {
    const root = getChunk(x >> 4, z >> 4);
    const sec = root?.sections?.find((s) => secY(s) === (y >> 4));
    return sec ? blockAtSection(sec, x, y, z) : null;
  };
  /**
   * 扫一个长方体里所有目标方块。
   * @param {{x0:number,x1:number,y0:number,y1:number,z0:number,z1:number}} box
   * @param {string[]} targets 例如 `['minecraft:note_block']`
   * @returns {Map<string, Array<[number,number,number]>>}
   */
  const scan = (box, targets) => {
    const out = new Map(targets.map((t) => [t, []]));
    for (let cx = box.x0 >> 4; cx <= (box.x1 >> 4); cx++) {
      for (let cz = box.z0 >> 4; cz <= (box.z1 >> 4); cz++) {
        const root = getChunk(cx, cz);
        if (!root?.sections) continue;
        for (const sec of root.sections) {
          const sy = secY(sec);
          if (sy * 16 > box.y1 || sy * 16 + 15 < box.y0) continue;
          for (const target of targets) scanSection(sec, cx, cz, target, out.get(target), box);
        }
      }
    }
    return out;
  };
  return { blockAt, scan };
}
