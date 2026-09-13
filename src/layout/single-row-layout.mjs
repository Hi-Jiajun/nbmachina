// 方案 A 修正版：按「实际扫描到的地形」重算单排剖面（尽量不削山，改为让音轨爬得更高）
// 输出：single_row_profile.json（覆盖）+ flat_build_v2a/b/c + lamps_v2
import fs from 'node:fs';
import zlib from 'node:zlib';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const DP = `${B}/styx_build/data/styx/function`;
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
function surf(x, z) {
  const cx = x >> 4, cz = z >> 4, key = cx + ',' + cz;
  let hm = cache.get(key);
  if (hm === undefined) {
    hm = null;
    try {
      const p = `${SAVE}/region/r.${cx >> 5}.${cz >> 5}.mca`;
      if (fs.existsSync(p)) {
        const hdr = fs.readFileSync(p).subarray(0, 8192);
        const i = (cx & 31) + (cz & 31) * 32;
        if (i * 4 + 3 <= hdr.length) {
          const off = Buffer.from(hdr.subarray(i * 4, i * 4 + 3)).readUIntBE(0, 3);
          if (off) {
            const fd = fs.openSync(p, 'r');
            const hb = Buffer.alloc(5); fs.readSync(fd, hb, 0, 5, off * 4096);
            const ln = hb.readInt32BE(0), ct = hb.readUInt8(4);
            const d = Buffer.alloc(ln - 1); fs.readSync(fd, d, 0, ln - 1, off * 4096 + 5); fs.closeSync(fd);
            const raw = ct === 2 ? zlib.inflateSync(d) : zlib.gunzipSync(d);
            const r = new R(raw); const t = r.u1(); r.str(); const root = r.val(t);
            if (root.Heightmaps) {
              const arr = [];
              for (const w0 of root.Heightmaps.WORLD_SURFACE) { const w = BigInt.asUintN(64, BigInt(w0)); for (let k = 0; k < 7; k++) arr.push(Number((w >> BigInt(9 * k)) & 0x1FFn)); }
              hm = arr;
            }
          }
        }
      }
    } catch { hm = null; }
    cache.set(key, hm);
  }
  if (!hm) return null;
  const v = hm[(z & 15) * 16 + (x & 15)];
  return v === undefined ? null : v + MINY - 1;
}

// 扫描：每段在带内的最高地表；同时把「音轨自身」的高度排除掉（甲板/音符所在高度）
const OLD = JSON.parse(fs.readFileSync(`${B}/single_row_profile.json`, 'utf8'));
const terrain = [];
for (let k = 0; k < 49; k++) {
  const x0 = 480 + 48 * k;
  const oldY = OLD[k].y;
  let mx = -999, miss = 0;
  for (let x = x0; x <= x0 + 47; x += 2) {
    for (let z = -172; z <= -141; z += 2) {
      const h = surf(x, z);
      if (h === null) { miss++; continue; }
      // 音轨自身（旧甲板 y..y+1、灯 y-1）不算地形
      if (h >= oldY - 1 && h <= oldY + 1) continue;
      if (h > mx) mx = h;
    }
  }
  terrain.push(mx === -999 ? null : { max: mx, miss });
}

const BASE = 84;
const rows = [];
let y = BASE;
let maxStep = 0;
const MAX_STEP = 3;      // 每段最多爬 3 格；挡路的山尖就削平（只在音轨宽度内削）
for (let k = 0; k < 49; k++) {
  let deck = BASE, cutAboveFrom = null;
  if (k > 38 && terrain[k]) {
    const need = terrain[k].max + 2;
    const capped = y + MAX_STEP;
    if (need > capped) { deck = capped; cutAboveFrom = capped + 2; }      // 削掉甲板上方的山体
    else deck = Math.max(y + 1, need);
    maxStep = Math.max(maxStep, deck - y);
  }
  y = deck;
  rows.push({ k, x0: 480 + 48 * k, z0: -172, y: deck, terrain: terrain[k]?.max ?? null, cutAboveFrom });
}
fs.writeFileSync(`${B}/single_row_profile.json`, JSON.stringify(rows, null, 1), 'utf8');
console.log('新剖面（东段）:');
for (const r of rows.slice(38)) console.log(`  段${String(r.k).padStart(2)} x${r.x0} 地形≈${r.terrain ?? '未生成'} → 甲板 y=${r.y}`);
console.log('最大单段爬升:', maxStep, '格');

/* ---------- 重写三个建造批次（无削山，只有铺装） ---------- */
const batches = [
  { from: 0, to: 25, name: 'a', head: '# 第 1 批：x 480..1727（先 /forceload add 480 -176 1735 -136）' },
  { from: 26, to: 38, name: 'b', head: '# 第 2 批：x 1728..2351（先 /forceload add 1728 -176 2359 -136）' },
  { from: 39, to: 48, name: 'c', head: '# 第 3 批：x 2352..2831（先 /forceload add 2352 -176 2839 -136）' },
];
for (const b of batches) {
  const lines = [b.head];
  // 削山：① 甲板下方到 y84 之间清空；② 甲板上方（y+2 到山顶）清空 → 音轨像嵌在山体里的直槽
  for (const r of rows.slice(b.from, b.to + 1)) {
    if (r.k <= 38) continue;
    for (let x = r.x0; x <= r.x0 + 47; x += 8) {
      const x1 = Math.min(x + 7, r.x0 + 47);
      if (r.y - 1 >= 84) lines.push(`fill ${x} 84 -172 ${x1} ${r.y - 1} -141 minecraft:air`);
      if (r.cutAboveFrom !== null && r.terrain !== null && r.terrain >= r.cutAboveFrom) {
        lines.push(`fill ${x} ${r.cutAboveFrom} -172 ${x1} ${r.terrain} -141 minecraft:air`);
      }
    }
  }
  for (const r of rows.slice(b.from, b.to + 1)) lines.push(`place template styx:flat_b_${String(r.k).padStart(2, '0')} ${r.x0} ${r.y} ${r.z0}`);
  for (const r of rows.slice(b.from, b.to + 1)) for (let x = r.x0; x <= r.x0 + 47; x += 8) lines.push(`setblock ${x} ${r.y - 1} -156 minecraft:sea_lantern`);
  fs.writeFileSync(`${DP}/flat_build_v2${b.name}.mcfunction`, lines.join('\n') + '\n', 'utf8');
  console.log(`flat_build_v2${b.name}: ${lines.length - 1} 条（段 ${rows[b.from].k}..${rows[b.to].k}）`);
}

/* ---------- 重写 lamps_v2 ---------- */
const csv = fs.readFileSync(`${B}/styx_helix_notes.csv`, 'utf8').trim().split(/\r?\n/).slice(1);
const cellY = new Map();
for (const line of csv) {
  const [stepS, , , , pitchS] = line.split(',');
  const step = +stepS, pitch = +pitchS;
  const k = Math.floor(step / 48), lx = step % 48;
  if (k > 48) continue;
  cellY.set(`${rows[k].x0 + lx},${-172 + pitch + 3}`, rows[k].y - 1);
}
fs.writeFileSync(`${DP}/lamps_v2.mcfunction`, [...cellY.entries()].map(([key, ly]) => { const [x, z] = key.split(',').map(Number); return `setblock ${x} ${ly} ${z} minecraft:redstone_lamp[lit=false]`; }).join('\n') + '\n', 'utf8');
fs.writeFileSync(`${DP}/lamps_v2_clear.mcfunction`, [...cellY.entries()].map(([key]) => { const [x, z] = key.split(',').map(Number); return `setblock ${x} 83 ${z} minecraft:air`; }).join('\n') + '\n', 'utf8');
console.log('lamps_v2 灯位:', cellY.size);
