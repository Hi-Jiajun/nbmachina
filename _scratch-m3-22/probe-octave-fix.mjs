// M3-22 探针 4：按"参考转谱"给每颗谱面音挑八度 —— 先量出可提升空间，再决定要不要落地
//
// 做法：
//   ① 时移曲线：10s 窗 × 5s 步进的软匹配最优 d，中值滤波后线性插值（把 sawtooth 噪声压掉）
//   ② 每颗音在候选八度 k∈[-48..48, step12] 里挑证据最强的：同音高转谱音在 ±0.2s 内的加权命中，
//      证据不足时偏向小 |k|
//   ③ 对比修正前后的"精确同音高命中率"
import fs from 'node:fs';
import path from 'node:path';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const lines = fs.readFileSync(path.join(B, 'machine_pipeline_video_phrase.csv'), 'utf8').trim().split(/\r?\n/);
const idx = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
const score = lines.slice(1).map((l) => l.split(',')).map((c) => ({
  t: Number(c[idx.time_seconds]), midi: Number(c[idx.midi]), voice: c[idx.instrument], step: Number(c[idx.step]),
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

// ① 时移曲线
const raw = [];
for (let t0 = 0; t0 + 10 <= 290; t0 += 5) {
  const A = score.filter((n) => n.t >= t0 && n.t < t0 + 10);
  if (A.length < 6) continue;
  let b = { d: 0, s: -1 };
  for (let d = -1.5; d <= 1.5; d += 0.005) { const s = scoreAt(A, d); if (s > b.s) b = { d, s }; }
  raw.push({ t: t0 + 5, d: b.d, s: b.s });
}
// 中值滤波（窗 5）+ 线性插值
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

// ② 每颗音挑八度
const SHIFTS = [-48, -36, -24, -12, 0, 12, 24, 36, 48];
const fixed = [];
for (const s of score) {
  const target = s.t + lagAt(s.t);
  let bestK = 0, bestV = -1;
  for (const k of SHIFTS) {
    const dt = nearestDt(s.midi + k, target);
    // 证据：±0.2s 内线性衰减；|k| 越大越保守（每半音 0.2% 的代价，避免没证据时乱跳）
    const v = dt <= 0.2 ? (1 - dt / 0.2) - Math.abs(k) * 0.002 : -1;
    if (v > bestV) { bestV = v; bestK = k; }
  }
  fixed.push({ ...s, k: bestK, midi2: s.midi + bestK, target, evidence: bestV });
}

const hit = (arr, key) => arr.filter((s) => {
  const target = s.target ?? (s.t + lagAt(s.t));
  return ref.some((n) => n.midi === s[key] && Math.abs(n.onset - target) <= TOL);
}).length;
const withTarget = fixed;
console.log(`谱面 ${score.length} 颗：`);
console.log(`  修正前 精确同音高命中 = ${(hit(withTarget, 'midi') / score.length * 100).toFixed(1)}%`);
console.log(`  修正后 精确同音高命中 = ${(hit(withTarget, 'midi2') / score.length * 100).toFixed(1)}%`);
const kHist = {};
for (const f of withTarget) kHist[f.k] = (kHist[f.k] ?? 0) + 1;
console.log('  八度修正分布：' + Object.entries(kHist).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k > 0 ? '+' : ''}${k}:${v}`).join('  '));
for (const v of ['harp', 'bass']) {
  const A = withTarget.filter((f) => f.voice === v);
  const kb = {};
  for (const f of A) kb[f.k] = (kb[f.k] ?? 0) + 1;
  console.log(`  [${v}] 修正前 ${(hit(A, 'midi') / A.length * 100).toFixed(1)}% → 修正后 `
    + `${(hit(A, 'midi2') / A.length * 100).toFixed(1)}%；修正分布 `
    + Object.entries(kb).sort((a, b) => b[1] - a[1]).map(([k, v2]) => `${k > 0 ? '+' : ''}${k}:${v2}`).join(' '));
}
// ③ 音域对比
const rng = (arr, key) => `${Math.min(...arr.map((a) => a[key]))}..${Math.max(...arr.map((a) => a[key]))}`;
console.log(`  谱面音域 ${rng(withTarget, 'midi')} → 修正后 ${rng(withTarget, 'midi2')}；`
  + `参考转谱音域 ${Math.min(...ref.map((n) => n.midi))}..${Math.max(...ref.map((n) => n.midi))}`);
fs.writeFileSync(path.join(B, '_probe_octave_fixed.json'),
  JSON.stringify(withTarget.map((f) => ({ t: +f.t.toFixed(3), voice: f.voice, midi: f.midi, k: f.k, midi2: f.midi2 })), null, 0));
