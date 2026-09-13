// 从 MIDI 解析真实时间轴（含 tempo map）+ 与现有 CSV 配对拿到声部标签
// 同时读原曲 WAV，取每个音符位置的响度（做力度用）
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';

/* ---------- MIDI ---------- */
const mid = fs.readFileSync(`${B}/styx_helix_minecraft.mid`);
let p = 0;
const u16 = (o) => mid.readUInt16BE(o);
const u32 = (o) => mid.readUInt32BE(o);
const division = u16(12);
console.log(`MIDI: format ${u16(8)} tracks ${u16(10)} division ${division}`);

p = 14;
const notes = [];         // {tick, midi, dur, vel}
const tempos = [];        // {tick, usPerQuarter}
while (p < mid.length - 8) {
  const type = mid.toString('ascii', p, p + 4);
  const len = u32(p + 4);
  if (type !== 'MTrk') { p += 8 + len; continue; }
  let q = p + 8, end = q + len, t = 0, running = 0;
  const open = new Map();
  while (q < end) {
    let d = 0, b;
    do { b = mid[q++]; d = (d << 7) | (b & 0x7f); } while (b & 0x80);
    t += d;
    let st = mid[q];
    if (st & 0x80) { q++; running = st; } else st = running;
    const cmd = st & 0xf0;
    if (cmd === 0x90 || cmd === 0x80) {
      const note = mid[q++], v = mid[q++];
      if (cmd === 0x90 && v > 0) { open.set(note, { tick: t, vel: v }); }
      else {
        const o = open.get(note);
        if (o) { notes.push({ tick: o.tick, midi: note, dur: t - o.tick, vel: o.vel }); open.delete(note); }
      }
    } else if (cmd === 0xc0 || cmd === 0xd0) q += 1;
    else if (cmd === 0xa0 || cmd === 0xb0 || cmd === 0xe0) q += 2;
    else if (st === 0xff) {
      const mtype = mid[q++];
      let n2 = 0, b2; do { b2 = mid[q++]; n2 = (n2 << 7) | (b2 & 0x7f); } while (b2 & 0x80);
      if (mtype === 0x51 && n2 === 3) tempos.push({ tick: t, us: (mid[q] << 16) | (mid[q + 1] << 8) | mid[q + 2] });
      q += n2;
    } else if (st === 0xf0 || st === 0xf7) { let n2 = 0, b2; do { b2 = mid[q++]; n2 = (n2 << 7) | (b2 & 0x7f); } while (b2 & 0x80); q += n2; }
    else break;
  }
  p += 8 + len;
}
console.log('音符数:', notes.length, ' tempo 事件:', tempos.length);
console.log('tempo:', tempos.slice(0, 8).map((x) => `${x.tick}:${(60000000 / x.us).toFixed(1)}BPM`).join(' '));

// tick → 秒
const sortedTempos = tempos.slice().sort((a, b) => a.tick - b.tick);
if (!sortedTempos.length) sortedTempos.push({ tick: 0, us: 500000 });
function tickToSec(tick) {
  let sec = 0, last = 0, us = sortedTempos[0].us;
  for (const tp of sortedTempos) {
    if (tp.tick >= tick) break;
    sec += ((tp.tick - last) / division) * (us / 1e6);
    last = tp.tick; us = tp.us;
  }
  sec += ((tick - last) / division) * (us / 1e6);
  return sec;
}
for (const n of notes) { n.t = tickToSec(n.tick); n.durSec = tickToSec(n.tick + n.dur) - n.t; }
notes.sort((a, b) => a.t - b.t || a.midi - b.midi);
const last = notes[notes.length - 1];
console.log(`总时长 ≈ ${last.t.toFixed(1)} 秒（${Math.floor(last.t / 60)}:${String(Math.round(last.t % 60)).padStart(2, '0')}）`);

// 起音间隔分布（前 2000 个）
const gaps = {};
for (let i = 1; i < Math.min(notes.length, 2000); i++) {
  const g = Math.round((notes[i].t - notes[i - 1].t) * 1000);
  gaps[g] = (gaps[g] ?? 0) + 1;
}
const top = Object.entries(gaps).sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('相邻起音间隔(ms) 最常见:', top.map(([k, v]) => `${k}ms×${v}`).join(' '));

/* ---------- 与旧 CSV 配对，取得声部标签 ---------- */
const csv = fs.readFileSync(`${B}/styx_helix_notes.csv`, 'utf8').trim().split(/\r?\n/).slice(1)
  .map((l) => { const [step, time, instr, midi, pitch] = l.split(','); return { step: +step, t: +time, instr, midi: +midi, pitch: +pitch }; });
console.log('\n旧 CSV: 音符', csv.length);
let matched = 0;
for (const c of csv) {
  const hit = notes.find((n) => n.midi === c.midi && Math.abs(n.t - c.t) < 0.06);
  if (hit) { c.matched = true; hit.instr = c.instr; matched++; }
}
console.log('按 (midi, 时间±60ms) 配对成功:', matched, '/', csv.length);

const byInstr = {};
for (const n of notes) {
  const k = n.instr ?? 'unknown';
  byInstr[k] = byInstr[k] ?? { n: 0, min: 999, max: -999, ticks: [] };
  const r = byInstr[k];
  r.n++; r.min = Math.min(r.min, n.midi); r.max = Math.max(r.max, n.midi);
  r.ticks.push(n.tick);
}
console.log('\n各声部音域（原始 MIDI 音高）:');
for (const [k, r] of Object.entries(byInstr)) console.log(`  ${k}: ${r.n} 音, midi ${r.min}..${r.max}（${(r.max - r.min)} 个半音）`);

/* ---------- 原曲 WAV（力度用） ---------- */
for (const f of ['styx_helix_full.wav', 'styx_helix_preview.wav']) {
  const path = `${B}/${f}`;
  if (!fs.existsSync(path)) { console.log(`\n${f}: 不存在`); continue; }
  const buf = fs.readFileSync(path);
  let q = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (q + 8 <= buf.length) {
    const id = buf.toString('ascii', q, q + 4), size = buf.readUInt32LE(q + 4);
    if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(q + 10), sr: buf.readUInt32LE(q + 12), bits: buf.readUInt16LE(q + 22) };
    if (id === 'data') { dataOff = q + 8; dataLen = size; }
    q += 8 + size + (size % 2);
  }
  const dur = fmt ? dataLen / (fmt.ch * fmt.bits / 8) / fmt.sr : 0;
  console.log(`\n${f}: ${(buf.length / 1048576).toFixed(1)}MB  ${fmt ? `${fmt.sr}Hz ${fmt.ch}ch ${fmt.bits}bit` : '?'}  时长 ${dur.toFixed(1)} 秒`);
  // 取几个时间点的响度
  if (fmt) {
    const probes = [0.5, 5, 20, 60, 120, 200].filter((t) => t < dur);
    const out = [];
    for (const t of probes) {
      const start = dataOff + Math.floor(t * fmt.sr) * fmt.ch * (fmt.bits / 8);
      let sum = 0, cnt = 0;
      for (let i = 0; i < fmt.sr / 10 && start + i * fmt.ch * 2 + 1 < dataOff + dataLen; i++) {
        const v = buf.readInt16LE(start + i * fmt.ch * 2) / 32768;
        sum += v * v; cnt++;
      }
      out.push(`${t}s:${Math.sqrt(sum / Math.max(1, cnt)).toFixed(3)}`);
    }
    console.log('  响度采样 RMS:', out.join(' '));
  }
}
