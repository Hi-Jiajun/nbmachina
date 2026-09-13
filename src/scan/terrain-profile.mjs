// 扫地形：z -172..-141 这条带子上，x 从 480 到 2900 的最高地表（用来设计"一条连续音轨"的高度）
import fs from 'node:fs';
import zlib from 'node:zlib';

const SAVE = 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5/saves/Styx Helix';
const MINY = -64;
class R {
  constructor(d) { this.d = d; this.p = 0; }
  u1() { return this.d[this.p++]; }
  i2() { const v = this.d.readInt16BE(this.p); this.p += 2; return v; }
  i4() { const v = this.d.readInt32BE(this.p); this.p += 4; return v; }
  str() { const n = this.d.readUInt16BE(this.p); this.p += 2; const s = this.d.toString('utf8', this.p, this.p + n); this.p += n; return s; }
  val(t) {
    switch (t) {
      case 1: return this.u1(); case 2: return this.i2(); case 3: return this.i4();
      case 4: { const v = this.d.readBigInt64BE(this.p); this.p += 8; return v; }
      case 5: { const v = this.d.readFloatBE(this.p); this.p += 4; return v; }
      case 6: { const v = this.d.readDoubleBE(this.p); this.p += 8; return v; }
      case 7: { const n = this.i4(); const v = this.d.subarray(this.p, this.p + n); this.p += n; return v; }
      case 8: return this.str();
      case 9: { const it = this.u1(); const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.val(it)); return a; }
      case 10: { const o = {}; for (;;) { const tt = this.u1(); if (tt === 0) return o; const nm = this.str(); o[nm] = this.val(tt); } }
      case 11: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) a.push(this.i4()); return a; }
      case 12: { const n = this.i4(); const a = []; for (let i = 0; i < n; i++) { a.push(this.d.readBigInt64BE(this.p)); this.p += 8; } return a; }
      default: throw new Error('tag ' + t);
    }
  }
}
const cache = new Map();
function readChunk(cx, cz) {
  const key = cx + ',' + cz;
  if (cache.has(key)) return cache.get(key);
  let out = null;
  const p = `${SAVE}/region/r.${cx >> 5}.${cz >> 5}.mca`;
  try {
    if (fs.existsSync(p)) {
      const hdr = fs.readFileSync(p).subarray(0, 8192);
      const i = (cx & 31) + (cz & 31) * 32;
      if (i * 4 + 3 <= hdr.length) {
        const off = Buffer.from(hdr.subarray(i * 4, i * 4 + 3)).readUIntBE(0, 3);
        if (off) {
          const fd = fs.openSync(p, 'r');
          const hb = Buffer.alloc(5);
          fs.readSync(fd, hb, 0, 5, off * 4096);
          const ln = hb.readInt32BE(0), ct = hb.readUInt8(4);
          const d = Buffer.alloc(ln - 1);
          fs.readSync(fd, d, 0, ln - 1, off * 4096 + 5);
          fs.closeSync(fd);
          const raw = ct === 2 ? zlib.inflateSync(d) : zlib.gunzipSync(d);
          const r = new R(raw);
          const t = r.u1(); r.str();
          const root = r.val(t);
          out = root.Heightmaps ? Object.fromEntries(Object.entries(root.Heightmaps).map(([k, a]) => {
            const arr = [];
            for (const w0 of a) { const w = BigInt.asUintN(64, BigInt(w0)); for (let k2 = 0; k2 < 7; k2++) arr.push(Number((w >> BigInt(9 * k2)) & 0x1FFn)); }
            return [k, arr];
          })) : null;
        }
      }
    }
  } catch { out = null; }
  cache.set(key, out);
  return out;
}
function surf(x, z) {
  const hm = readChunk(x >> 4, z >> 4);
  if (!hm?.WORLD_SURFACE) return null;
  const i = (z & 15) * 16 + (x & 15);
  const v = hm.WORLD_SURFACE[i];
  return v === undefined ? null : v + MINY - 1;
}

console.log('=== z 带 -172..-141 每 48 格一段的最高地表（x 480..2900）===');
console.log(' 段   x起   带内最高   建议甲板高(最高+2)');
const plan = [];
for (let k = 0; k <= 51; k++) {
  const x0 = 480 + 48 * k;
  let mx = -999, miss = 0;
  for (let x = x0; x < x0 + 48; x += 4) {
    for (let z = -172; z <= -141; z += 3) {
      const h = surf(x, z);
      if (h === null) { miss++; continue; }
      if (h > mx) mx = h;
    }
  }
  const deck = mx >= 84 ? mx + 2 : 84;
  plan.push({ k, x0, mx, deck });
  if (k >= 36 || k <= 3) console.log(`${String(k).padStart(3)}  ${String(x0).padStart(4)}   ${String(mx).padStart(5)}      ${String(deck).padStart(4)}${miss ? `  (缺 ${miss})` : ''}`);
  if (k === 3) console.log('   ...');
}
console.log('\n=== 84 格甲板会撞到的段 ===');
console.log(plan.filter((p) => p.mx >= 83).map((p) => `段${p.k}(x${p.x0}, 地面${p.mx})`).join(' ') || '（无）');
