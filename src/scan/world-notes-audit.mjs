// 逐格扫存档里的音符盒：和 CSV 对账，找出「音色不对」和「CSV 里没有」的音符格，生成针对性修复函数
import fs from 'node:fs';
import zlib from 'node:zlib';
import { resolvePaths, resolveExternal } from '../core/paths.mjs';

// M2-3：存档目录 / build 目录 / 数据包函数目录都走 paths.mjs
const P = resolvePaths();
const EX = resolveExternal();
const SAVE = EX.save;
const B = P.build;
const DP = P.functionsDir;

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
function readChunk(cx, cz) {
  const p = `${SAVE}/region/r.${cx >> 5}.${cz >> 5}.mca`;
  if (!fs.existsSync(p)) return null;
  const hdr = fs.readFileSync(p).subarray(0, 8192);
  const i = (cx & 31) + (cz & 31) * 32;
  if (i * 4 + 3 > hdr.length) return null;
  const off = Buffer.from(hdr.subarray(i * 4, i * 4 + 3)).readUIntBE(0, 3);
  if (!off) return null;
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
  return r.val(t);
}

/* 世界里的音符盒（按 section 逐个解码） */
const world = new Map(); // "x,z" -> {inst, note, y}
for (let cx = 30; cx <= 105; cx++) {
  for (let cz = -14; cz <= -9; cz++) {
    const root = readChunk(cx, cz);
    if (!root?.sections) continue;
    for (const sec of root.sections) {
      const bs = sec.block_states;
      if (!bs?.palette) continue;
      const noteIdx = bs.palette.findIndex((p) => p.Name === 'minecraft:note_block');
      if (noteIdx < 0) continue;
      const n = bs.palette.length;
      const bits = n === 1 ? 0 : Math.max(4, Math.ceil(Math.log2(n)));
      const longs = bits && bs.data ? bs.data.map((v) => BigInt.asUintN(64, BigInt(v))) : null;
      const mask = bits ? (1n << BigInt(bits)) - 1n : 0n;
      // section 的 Y 是绝对 section 坐标（y = Y*16..Y*16+15）
      for (let y = 0; y < 16; y++) for (let z = 0; z < 16; z++) for (let x = 0; x < 16; x++) {
        let idx = 0;
        if (bits) {
          const i2 = (y << 8) | (z << 4) | x;
          const bit = BigInt(i2 * bits);
          const li = Number(bit >> 6n);
          const off = Number(bit & 63n);
          if (li >= longs.length) continue;
          let v = longs[li] >> BigInt(off);
          if (off + bits > 64 && li + 1 < longs.length) v |= longs[li + 1] << BigInt(64 - off);
          idx = Number(v & mask);
        }
        if (idx !== noteIdx) continue;
        const e = bs.palette[idx];
        const wx = cx * 16 + x, wy = sec.Y * 16 + y, wz = cz * 16 + z;
        world.set(`${wx},${wz}`, { inst: e.Properties?.instrument ?? '?', note: e.Properties?.note ?? '?', y: wy });
      }
    }
  }
}
console.log('世界里机器区域的音符盒格数:', world.size);

/* CSV 的期望值 */
const csv = fs.readFileSync(P.notes, 'utf8').trim().split(/\r?\n/).slice(1);
const expect = new Map(); // "x,z" -> {inst, note}
for (const line of csv) {
  const [stepS, , instr, , pitchS] = line.split(',');
  const step = +stepS, pitch = +pitchS;
  const seg = Math.floor(step / 48), lx = step % 48;
  const row = seg <= 24 ? 0 : 1;
  const x0 = row === 0 ? 480 + 48 * seg : 480 + 48 * (seg - 25);
  const z0 = row === 0 ? -172 : -212;
  expect.set(`${x0 + lx},${z0 + pitch + 3}`, { inst: instr === 'bass' ? 'bass' : 'harp', note: pitch });
}

let ok = 0, wrongInst = 0, notInCsv = 0;
const wrongSamples = [], extraSamples = [];
const fixLines = [];
for (const [key, w] of world) {
  const e = expect.get(key);
  const [x, z] = key.split(',').map(Number);
  if (e) {
    if (w.inst === e.inst && +w.note === +e.note) { ok++; continue; }
    wrongInst++;
    if (wrongSamples.length < 6) wrongSamples.push(`${key} 现=${w.inst}/${w.note} 应=${e.inst}/${e.note}`);
    fixLines.push(`setblock ${x} 84 ${z} ${e.inst === 'bass' ? 'minecraft:oak_planks' : 'minecraft:sand'}`);
    fixLines.push(`setblock ${x} 85 ${z} minecraft:note_block[instrument=${e.inst},note=${e.note},powered=false]`);
  } else {
    notInCsv++;
    if (extraSamples.length < 6) extraSamples.push(`${key} 现=${w.inst}/${w.note}`);
    // CSV 里没有的格子 = 旧版(26格,pitch+1)残留的音符 → 删掉（新版在 pitch+3 行有正确的音）
    const row = z <= -181 ? 1 : 0;                 // 排 1 的带在 -212..-181，排 2 在 -172..-141
    const z0 = row === 0 ? -172 : -212;
    const localZ = z - z0;
    const isOldLayout = localZ === (+w.note) + 1;   // 旧版映射
    if (isOldLayout) fixLines.push(`setblock ${x} 85 ${z} minecraft:air`);
    else {                                          // 其它意外情况：按钢琴音补正
      const isBass = w.inst === 'bass' || (+w.note <= 12);
      fixLines.push(`setblock ${x} 84 ${z} ${isBass ? 'minecraft:oak_planks' : 'minecraft:sand'}`);
      fixLines.push(`setblock ${x} 85 ${z} minecraft:note_block[instrument=${isBass ? 'bass' : 'harp'},note=${w.note},powered=false]`);
    }
  }
}
console.log(`对账：完全正确 ${ok}，音色/音高不符 ${wrongInst}，CSV 里没有的格子 ${notInCsv}`);
if (wrongSamples.length) console.log('  不符示例:', wrongSamples.join(' | '));
if (extraSamples.length) console.log('  额外格示例:', extraSamples.join(' | '));

fs.writeFileSync(`${DP}/fix_instruments2.mcfunction`,
  ['# 针对性修复：把世界里每个音符盒的音色/音高都对齐 CSV（含 CSV 没覆盖的格子）', ...fixLines, ''].join('\n'), 'utf8');
console.log('fix_instruments2.mcfunction 指令数:', fixLines.length);
