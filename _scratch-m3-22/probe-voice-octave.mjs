// M3-22 探针 5：在对齐曲线修正之后，逐声部量"整体移多少半音才命中"，并看它随时间是否稳定
import fs from 'node:fs';
import path from 'node:path';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const lines = fs.readFileSync(path.join(B, 'machine_pipeline_video_phrase.csv'), 'utf8').trim().split(/\r?\n/);
const idx = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
const score = lines.slice(1).map((l) => l.split(',')).map((c) => ({
  t: Number(c[idx.time_seconds]), midi: Number(c[idx.midi]), voice: c[idx.instrument],
})).filter((n) => n.voice === 'harp' || n.voice === 'bass');
const ref = JSON.parse(fs.readFileSync(path.join(B, 'ref_transcription.json'), 'utf8')).note_events;

const byPc = Array.from({ length: 12 }, () => []);
for (const n of ref) byPc[((n.midi % 12) + 12) % 12].push(n.onset);
for (const a of byPc) a.sort((x, y) => x - y);
function nearestDt(midi, target) {
  const a = byPc[((midi % 12) + 12) % 12];
  let lo = 0, hi = a.length - 1, best = Infinity;
  while (lo <= hi) {
    const m = (lo + hi) >> 1; const d = a[m] - target;
    if (Math.abs(d) < best) best = Math.abs(d);
    if (d < 0) lo = m + 1; else hi = m - 1;
  }
  return best;
}
const TOL = 0.15;
const scoreAt = (notes, d) => {
  let s = 0;
  for (const n of notes) { const dt = nearestDt(n.midi, n.t + d); if (dt <= TOL) s += 1 - dt / TOL; }
  return s / notes.length;
};
const raw = [];
for (let t0 = 0; t0 + 10 <= 290; t0 += 5) {
  const A = score.filter((n) => n.t >= t0 && n.t < t0 + 10);
  if (A.length < 6) continue;
  let b = { d: 0, s: -1 };
  for (let d = -1.5; d <= 1.5; d += 0.005) { const s = scoreAt(A, d); if (s > b.s) b = { d, s }; }
  raw.push({ t: t0 + 5, d: b.d });
}
const smooth = raw.map((p, i) => {
  const w = raw.slice(Math.max(0, i - 2), Math.min(raw.length, i + 3)).map((q) => q.d).sort((a, b) => a - b);
  return { t: p.t, d: w[w.length >> 1] };
});
const lagAt = (t) => {
  if (t <= smooth[0].t) return smooth[0].d;
  if (t >= smooth.at(-1).t) return smooth.at(-1).d;
  for (let i = 1; i < smooth.length; i++) {
    if (t <= smooth[i].t) {
      const a = smooth[i - 1], b = smooth[i];
      return a.d + (b.d - a.d) * (t - a.t) / (b.t - a.t);
    }
  }
  return 0;
};
const exactHit = (s, midi) => {
  const target = s.t + lagAt(s.t);
  return ref.some((n) => n.midi === midi && Math.abs(n.onset - target) <= TOL);
};

for (const voice of ['harp', 'bass']) {
  const A = score.filter((n) => n.voice === voice);
  const rows = [];
  for (let k = -48; k <= 60; k += 12) {
    rows.push([k, A.filter((s) => exactHit(s, s.midi + k)).length / A.length]);
  }
  rows.sort((a, b) => b[1] - a[1]);
  console.log(`[${voice}] ${A.length} 颗，整体移调后的精确命中率（TOP5）：`
    + rows.slice(0, 5).map(([k, r]) => `${k > 0 ? '+' : ''}${k}: ${(r * 100).toFixed(1)}%`).join('  '));
}

// 逐 20s 看 bass 的最佳 k（稳不稳？）
console.log('\nbass 逐窗最佳 k：');
const out = [];
for (let t0 = 0; t0 + 20 <= 300; t0 += 20) {
  const A = score.filter((n) => n.voice === 'bass' && n.t >= t0 && n.t < t0 + 20);
  if (A.length < 4) continue;
  let bk = 0, bs = -1;
  for (let k = -24; k <= 60; k += 12) {
    const s = A.filter((x) => exactHit(x, x.midi + k)).length / A.length;
    if (s > bs) { bs = s; bk = k; }
  }
  out.push(bk);
  console.log(`  ${String(t0).padStart(3)}s  k=${(bk > 0 ? '+' : '')}${bk}  命中 ${(bs * 100).toFixed(0)}%  (${A.length} 颗)`);
}
const med = out.slice().sort((a, b) => a - b)[out.length >> 1];
console.log(`  中位 k = ${med > 0 ? '+' : ''}${med}；取值集合 ${JSON.stringify([...new Set(out)].sort((a, b) => a - b))}`);
