// 让音符盒的音色永久正确：
//   实测（1.21.10 无头服务器）：下方是 dirt/sand/grass → harp（钢琴）；oak_planks/oak_log → bass；
//   stone → basedrum；glass → hat（你们现在就是这个，所以只有"哒"声）。
// 做法：
//   1) 改结构文件：每颗音符正下方那格甲板换成 sand(harp) / oak_planks(bass)
//   2) 生成 styx:fix_instruments —— 对已经在世界里的机器就地修复（不用重铺）
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { resolvePaths } from '../core/paths.mjs';

// M2-3：结构/函数/备份目录都走 paths.mjs
const P = resolvePaths();
const B = P.build;
const DIR = P.structuresDir;
const DP = P.functionsDir;
const BAK = P.file('structures_before_instrument_fix');
const HARP_BLOCK = 'minecraft:sand';        // 钢琴
const BASS_BLOCK = 'minecraft:oak_planks';  // 贝斯

/* ---------- NBT 读写 ---------- */
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
const readNbt = (p) => { const r = new R(zlib.gunzipSync(fs.readFileSync(p))); const t = r.u1(); r.str(); return r.val(t); };
class W {
  constructor() { this.parts = []; }
  raw(b) { this.parts.push(b); }
  u1(v) { this.raw(Buffer.from([v])); }
  i4(v) { const b = Buffer.alloc(4); b.writeInt32BE(v); this.raw(b); }
  str(s) { const b = Buffer.from(s, 'utf8'); const l = Buffer.alloc(2); l.writeUInt16BE(b.length); this.raw(l); this.raw(b); }
  build() { return Buffer.concat(this.parts); }
}
function writeNbt(root, out) {
  const w = new W();
  w.u1(10); w.str('');
  w.u1(3); w.str('DataVersion'); w.i4(root.DataVersion ?? 4556);
  w.u1(9); w.str('size'); w.u1(3); w.i4(3); for (const v of root.size) w.i4(v);
  w.u1(9); w.str('palette'); w.u1(10); w.i4(root.palette.length);
  for (const e of root.palette) {
    w.u1(8); w.str('Name'); w.str(e.Name);
    if (e.Properties) { w.u1(10); w.str('Properties'); for (const [k, v] of Object.entries(e.Properties)) { w.u1(8); w.str(k); w.str(String(v)); } w.u1(0); }
    w.u1(0);
  }
  w.u1(9); w.str('blocks'); w.u1(10); w.i4(root.blocks.length);
  for (const b of root.blocks) {
    w.u1(3); w.str('state'); w.i4(b.state);
    w.u1(9); w.str('pos'); w.u1(3); w.i4(3); w.i4(b.pos[0]); w.i4(b.pos[1]); w.i4(b.pos[2]);
    w.u1(0);
  }
  w.u1(9); w.str('entities'); w.u1(10); w.i4(0);
  w.u1(0);
  fs.writeFileSync(out, zlib.gzipSync(w.build(), { level: 9 }));
}

/* ---------- 1) 改结构 ---------- */
fs.mkdirSync(BAK, { recursive: true });
const segInfo = [];
let fixed = 0;
for (let k = 0; k < 49; k++) {
  const name = `flat_b_${String(k).padStart(2, '0')}.nbt`;
  const file = path.join(DIR, name);
  const bak = path.join(BAK, name);
  if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
  const root = readNbt(file);
  const idxOf = (n) => root.palette.findIndex((p) => p.Name === n);
  const pushIdx = (n) => { let i = idxOf(n); if (i < 0) { root.palette.push({ Name: n }); i = root.palette.length - 1; } return i; };
  const sandIdx = pushIdx(HARP_BLOCK), plankIdx = pushIdx(BASS_BLOCK);
  // 找到每颗音符，把它下面那格换成对应"乐器方块"
  const byXZ = new Map();
  for (const b of root.blocks) if (b.pos[1] === 0) byXZ.set(b.pos[0] + ',' + b.pos[2], b);
  for (const b of root.blocks) {
    if (b.pos[1] !== 1) continue;
    const pal = root.palette[b.state];
    if (pal.Name !== 'minecraft:note_block') continue;
    const under = byXZ.get(b.pos[0] + ',' + b.pos[2]);
    if (!under) continue;
    under.state = (pal.Properties.instrument === 'bass') ? plankIdx : sandIdx;
    fixed++;
  }
  writeNbt(root, file);
  const row = k <= 24 ? 0 : 1;
  const x0 = row === 0 ? 480 + 48 * k : 480 + 48 * (k - 25);
  const z0 = row === 0 ? -172 : -212;
  segInfo.push({ k, x0, z0 });
}
console.log(`结构已修：${fixed} 个音符下方的甲板换成了 sand/oak_planks（备份在 ${BAK}）`);

/* ---------- 2) 生成就地修复函数（按 CSV，含音高） ---------- */
const csv = fs.readFileSync(P.notes, 'utf8').trim().split(/\r?\n/).slice(1);
const lines = ['# 就地修复：把每颗音符下方那格换成对应乐器方块，并重写音符盒的 instrument/note'];
const seen = new Set();
let n = 0;
for (const line of csv) {
  const [stepS, , instr, , pitchS] = line.split(',');
  const step = +stepS, pitch = +pitchS;
  const seg = Math.floor(step / 48), lx = step % 48;
  const row = seg <= 24 ? 0 : 1;
  const x0 = row === 0 ? 480 + 48 * seg : 480 + 48 * (seg - 25);
  const z0 = row === 0 ? -172 : -212;
  const x = x0 + lx, z = z0 + pitch + 3;
  const key = x + ',' + z;
  if (seen.has(key)) continue;              // 同一格只写一次
  seen.add(key);
  const inst = instr === 'bass' ? 'bass' : 'harp';
  const blk = instr === 'bass' ? BASS_BLOCK : HARP_BLOCK;
  lines.push(`setblock ${x} 84 ${z} ${blk}`);
  lines.push(`setblock ${x} 85 ${z} minecraft:note_block[instrument=${inst},note=${pitch},powered=false]`);
  n++;
}
fs.writeFileSync(`${DP}/fix_instruments.mcfunction`, lines.join('\n') + '\n', 'utf8');
console.log(`fix_instruments.mcfunction: ${n} 个音符格，${lines.length - 1} 条指令`);
