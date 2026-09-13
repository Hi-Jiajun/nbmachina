// 把 49 个 flat_b 结构从「26 格宽」加宽到「32 格宽」：音符整体向南挪 2 格，
// 这样最高音(pitch24)不再贴边，两侧各留出空行给灯带。
//   新布局(局部 z): 0=红石总线  1..2=北侧空行(灯带)  3..28=音区(pitch+3)  29..31=南侧空行(灯带)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DIR = 'C:/Users/hiliang/Documents/minecraft/build/styx_build/data/styx/structure';
const BAK = 'C:/Users/hiliang/Documents/minecraft/build/structures_26deep_backup';
const DEEP = 32;          // 新的进深
const SHIFT = 2;          // 音符向南挪几格

class R {
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

fs.mkdirSync(BAK, { recursive: true });

let done = 0;
for (let k = 0; k < 49; k++) {
  const name = `flat_b_${String(k).padStart(2, '0')}.nbt`;
  const src = path.join(DIR, name);
  const root = readNbt(src);
  const bakPath = path.join(BAK, name);
  if (!fs.existsSync(bakPath)) fs.copyFileSync(src, bakPath);

  const palette = root.palette;                       // 保持原样（索引不变）
  const glassIdx = palette.findIndex((p) => p.Name === 'minecraft:black_stained_glass');
  if (glassIdx < 0) throw new Error('no glass in ' + name);

  const blocks = [];
  for (const b of root.blocks) {
    const [x, y, z] = b.pos;
    const nm = palette[b.state].Name;
    if (z === 0) { blocks.push({ state: b.state, pos: [x, y, z] }); continue; }   // 总线那一条原样保留
    if (nm === 'minecraft:note_block') { blocks.push({ state: b.state, pos: [x, y, z + SHIFT] }); continue; }
    if (nm === 'minecraft:black_stained_glass') continue;                          // 甲板按新尺寸重建
  }
  for (let x = 0; x < 48; x++) for (let z = 1; z < DEEP; z++) blocks.push({ state: glassIdx, pos: [x, 0, z] });

  const w = new W();
  w.u1(10); w.str('');
  w.u1(3); w.str('DataVersion'); w.i4(4556);
  w.u1(9); w.str('size'); w.u1(3); w.i4(3); w.i4(48); w.i4(2); w.i4(DEEP);
  w.u1(9); w.str('palette'); w.u1(10); w.i4(palette.length);
  for (const e of palette) {
    w.u1(8); w.str('Name'); w.str(e.Name);
    if (e.Properties) {
      w.u1(10); w.str('Properties');
      for (const [pk, pv] of Object.entries(e.Properties)) { w.u1(8); w.str(pk); w.str(String(pv)); }
      w.u1(0);
    }
    w.u1(0);
  }
  w.u1(9); w.str('blocks'); w.u1(10); w.i4(blocks.length);
  for (const b of blocks) {
    w.u1(3); w.str('state'); w.i4(b.state);
    w.u1(9); w.str('pos'); w.u1(3); w.i4(3);
    w.i4(b.pos[0]); w.i4(b.pos[1]); w.i4(b.pos[2]);
    w.u1(0);
  }
  w.u1(9); w.str('entities'); w.u1(10); w.i4(0);
  w.u1(0);
  fs.writeFileSync(src, zlib.gzipSync(w.build(), { level: 9 }));
  done++;
}
console.log(`已重建 ${done} 个 flat_b 结构：48×2×${DEEP}，音符向南挪 ${SHIFT} 格`);
console.log('旧结构备份在:', BAK);

// 抽查一个
const chk = readNbt(path.join(DIR, 'flat_b_00.nbt'));
const zs = chk.blocks.filter((b) => chk.palette[b.state].Name === 'minecraft:note_block').map((b) => b.pos[2]);
console.log('抽查 flat_b_00：size=' + JSON.stringify(chk.size) + '  音符 z 范围=' + Math.min(...zs) + '..' + Math.max(...zs));
