// M3-22 探针 3：用"同音名 + 时间软匹配"来定对齐（比纯 onset 互相关更锐）
//
// 思路：纯 onset 互相关在密集织体里峰值又宽又平（前两个探针就栽在这）。
// 这里对每个候选时移 d，给每颗谱面音找"同音名、时间最近的转谱音"，得分 = max(0, 1-Δt/0.15)，
// 再求和。只有 d 真的对上了，全部几百颗音才会同时命中 —— 峰值锐利得多。
import fs from 'node:fs';
import path from 'node:path';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const lines = fs.readFileSync(path.join(B, 'machine_pipeline_video_phrase.csv'), 'utf8').trim().split(/\r?\n/);
const idx = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
const score = lines.slice(1).map((l) => l.split(',')).map((c) => ({
  t: Number(c[idx.time_seconds]), midi: Number(c[idx.midi]), voice: c[idx.instrument],
})).filter((n) => n.voice === 'harp' || n.voice === 'bass');
const ref = JSON.parse(fs.readFileSync(path.join(B, 'ref_transcription.json'), 'utf8')).note_events;

const TOL = 0.15;
/** 音名（0..11）→ 转谱音的 onset 列表（升序） */
const byPc = Array.from({ length: 12 }, () => []);
for (const n of ref) byPc[((n.midi % 12) + 12) % 12].push(n.onset);
for (const a of byPc) a.sort((x, y) => x - y);
/** 该音名在 target 附近 TOL 内最近的时间差绝对值（找不到返回 Infinity） */
function nearestDt(midi, target) {
  const a = byPc[((midi % 12) + 12) % 12];
  let lo = 0, hi = a.length - 1, best = Infinity;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const d = a[m] - target;
    if (Math.abs(d) < best) best = Math.abs(d);
    if (d < 0) lo = m + 1; else hi = m - 1;
  }
  return best;
}
function scoreAt(notes, d) {
  let s = 0;
  for (const n of notes) {
    const dt = nearestDt(n.midi, n.t + d);
    if (dt <= TOL) s += 1 - dt / TOL;
  }
  return s / notes.length;
}

const LO = -1.5, HI = 1.5, STEP = 0.005;
let best = { d: 0, s: -1 };
for (let d = LO; d <= HI; d += STEP) {
  const s = scoreAt(score, d);
  if (s > best.s) best = { d, s };
}
console.log(`全局最佳时移 = ${best.d.toFixed(3)}s（软匹配得分 ${(best.s * 100).toFixed(1)}%）；`
  + `d=0 时得分 ${(scoreAt(score, 0) * 100).toFixed(1)}%`);

console.log('\n分窗口（10s 窗、5s 步进）：');
const pts = [];
for (let t0 = 0; t0 + 10 <= 290; t0 += 5) {
  const A = score.filter((n) => n.t >= t0 && n.t < t0 + 10);
  if (A.length < 6) continue;
  let b = { d: 0, s: -1 };
  for (let d = LO; d <= HI; d += STEP) {
    const s = scoreAt(A, d);
    if (s > b.s) b = { d, s };
  }
  pts.push([t0 + 5, b.d, b.s]);
  console.log(`  t≈${String(t0 + 5).padStart(3)}s  d=${b.d.toFixed(3).padStart(6)}s  命中 ${(b.s * 100).toFixed(0)}%  (${A.length} 颗)`);
}
const n = pts.length;
const mx = pts.reduce((s, p) => s + p[0], 0) / n;
const my = pts.reduce((s, p) => s + p[1], 0) / n;
const b1 = pts.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0) / pts.reduce((s, p) => s + (p[0] - mx) ** 2, 0);
console.log(`\n线性拟合：时移 ≈ ${my.toFixed(3)}s ${b1 >= 0 ? '+' : '-'} ${Math.abs(b1 * 100).toFixed(3)}% × t`
  + `   （残差 ±${Math.sqrt(pts.reduce((s, p) => s + (p[1] - my - b1 * (p[0] - mx)) ** 2, 0) / n).toFixed(3)}s）`);
