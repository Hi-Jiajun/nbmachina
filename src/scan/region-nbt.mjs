// 存档 region（.mca）只读解析：给定世界坐标 → 方块 id + 状态（palette 里的 Name + Properties）。
//
// 为什么要自己读存档：M1-6 实测 1.21.10 的 `/data get block` 只认方块实体 —— 对红石灯 / 音符盒 /
// 沙子一律回 "The target block is not a block entity"，**拿不到 id 和状态**（原始回包见 docs/M1-6-report.md）。
// "前像必须可信"这条要求，只有在能逐格读出 Name+Properties 时才成立，所以前像身份取自这里，
// 控制台的 `/data get block` 只用来做"这一格加载了吗"的旁证与交叉校验。
//
// 只读：本模块只读 region 文件，从不写。缓存按区块，避免对同一区块重复解压。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

class NbtReader {
  constructor(buf) { this.d = buf; this.p = 0; }
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
      case 12: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) { a.push(BigInt.asUintN(64, this.d.readBigInt64BE(this.p))); this.p += 8; } return a; }
      default: throw new Error(`NBT: 不认识的 tag 类型 ${t}（偏移 ${this.p}）`);
    }
  }
}

/** 读一个"有名根的" NBT 缓冲（region 里的区块数据就是这种） */
export function readNbt(buf) {
  const r = new NbtReader(buf);
  const t = r.u1();
  r.str(); // 根名，通常是空串
  return r.val(t);
}

const AIR = { name: 'minecraft:air', properties: {} };

/** palette 里的条目（{Name, Properties}）→ 统一形态 {name, properties}（properties 按 key 排序） */
function paletteEntry(e) {
  const props = e?.Properties ?? {};
  return { name: e?.Name ?? 'minecraft:air', properties: sortProps(props) };
}

export function sortProps(props) {
  const out = {};
  for (const k of Object.keys(props ?? {}).sort()) out[k] = String(props[k]);
  return out;
}

/**
 * 打开一个 region 目录（如 `<world>/region`），返回逐格查询接口。
 * 语义边界（很重要，调用方靠它区分"空气"和"读不到"）：
 *   - 区块条目不存在（未生成/未存盘）→ `blockAt()` 返回 **null**
 *   - 区块在、但该 y 所在的 section 不在存档里 → **空气**（原版不存空 section）
 */
export function createRegionReader(regionDir) {
  const cache = new Map(); // "cx,cz" -> sections Map | null
  const stats = { chunksRead: 0, chunksMissing: 0, chunksCached: 0 };

  function readRawChunk(cx, cz) {
    const file = path.join(regionDir, `r.${cx >> 5}.${cz >> 5}.mca`);
    if (!fs.existsSync(file)) return null;
    const fd = fs.openSync(file, 'r');
    try {
      const hdr = Buffer.alloc(4096);
      fs.readSync(fd, hdr, 0, 4096, 0);
      const i = (cx & 31) + (cz & 31) * 32;
      const off = hdr.readUIntBE(i * 4, 3);
      const sectors = hdr[i * 4 + 3];
      if (!off || !sectors) return null;
      const head = Buffer.alloc(5);
      fs.readSync(fd, head, 0, 5, off * 4096);
      const len = head.readInt32BE(0);
      if (len <= 0) return null;
      const body = Buffer.alloc(len - 1);
      fs.readSync(fd, body, 0, len - 1, off * 4096 + 5);
      const ct = head[4];
      const raw = ct === 2 ? zlib.inflateSync(body) : ct === 1 ? zlib.gunzipSync(body) : body;
      return readNbt(raw);
    } finally {
      fs.closeSync(fd);
    }
  }

  function sectionsOf(cx, cz) {
    const key = `${cx},${cz}`;
    if (cache.has(key)) { stats.chunksCached++; return cache.get(key); }
    let map = null;
    const root = readRawChunk(cx, cz);
    if (root) {
      stats.chunksRead++;
      map = new Map();
      for (const sec of root.sections ?? []) {
        const bs = sec.block_states;
        if (!bs?.palette) continue;
        const palette = bs.palette.map(paletteEntry);
        const bits = palette.length === 1 ? 0 : Math.max(4, Math.ceil(Math.log2(palette.length)));
        map.set(sec.Y, { palette, bits, data: (bs.data ?? []).map((v) => BigInt.asUintN(64, BigInt(v))) });
      }
    } else {
      stats.chunksMissing++;
    }
    cache.set(key, map);
    return map;
  }

  function blockAt(x, y, z) {
    const sections = sectionsOf(x >> 4, z >> 4);
    if (!sections) return null; // 区块不存在 → 读不到
    const sec = sections.get(y >> 4);
    if (!sec) return { ...AIR };
    const lx = x & 15, ly = y & 15, lz = z & 15;
    let idx = 0;
    if (sec.bits) {
      const li = ((ly << 8) | (lz << 4) | lx);
      const bit = BigInt(li * sec.bits);
      const word = Number(bit >> 6n);
      const off = Number(bit & 63n);
      if (word >= sec.data.length) return { ...AIR };
      let v = sec.data[word] >> BigInt(off);
      if (off + sec.bits > 64 && word + 1 < sec.data.length) v |= sec.data[word + 1] << BigInt(64 - off);
      idx = Number(v & ((1n << BigInt(sec.bits)) - 1n));
    }
    const e = sec.palette[idx];
    return e ? { name: e.name, properties: { ...e.properties } } : { ...AIR };
  }

  return { blockAt, stats, chunkOf: (x, z) => (sectionsOf(x >> 4, z >> 4) ? 'present' : 'missing') };
}
