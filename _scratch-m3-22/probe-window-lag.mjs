// M3-22 探针 2：分窗口测"我们的谱面 vs 参考转谱"的时移与音高命中
// 结论用途：判断是"常数偏移"还是"速度比例错"（两者要用不同的修法）。
import fs from 'node:fs';
import path from 'node:path';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const lines = fs.readFileSync(path.join(B, 'machine_pipeline_video_phrase.csv'), 'utf8').trim().split(/\r?\n/);
const idx = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
const score = lines.slice(1).map((l) => l.split(',')).map((c) => ({
  t: Number(c[idx.time_seconds]), midi: Number(c[idx.midi]), voice: c[idx.instrument],
})).filter((n) => n.voice === 'harp' || n.voice === 'bass');
const ref = JSON.parse(fs.readFileSync(path.join(B, 'ref_transcription.json'), 'utf8')).note_events;

const BIN = 0.01;
/** 在 [t0,t1) 窗口内，找让"谱面 + lag"最贴合参考的 lag（10ms 分辨率 + 抛物线插值） */
function bestLag(t0, t1, lo = -1.0, hi = 1.0) {
  const X = new Float64Array(Math.round((t1 - t0) / BIN) + Math.round((hi - lo) / BIN) + 2);
  const Y = X.slice();
  const off = Math.round(-lo / BIN);
  for (const n of score) if (n.t >= t0 && n.t < t1) X[Math.round((n.t - t0) / BIN) + off]++;
  for (const n of ref) if (n.onset >= t0 && n.onset < t1) Y[Math.round((n.onset - t0) / BIN) + off]++;
  let best = 0, bestV = -1;
  const vals = new Map();
  for (let d = Math.round(lo / BIN); d <= Math.round(hi / BIN); d++) {
    let s = 0;
    for (let i = 0; i < X.length; i++) {
      const j = i + d;
      if (j >= 0 && j < X.length) s += X[i] * Y[j];
    }
    vals.set(d, s);
    if (s > bestV) { bestV = s; best = d; }
  }
  const y1 = vals.get(best - 1) ?? bestV;
  const y3 = vals.get(best + 1) ?? bestV;
  const den = y1 - 2 * bestV + y3;
  const delta = den === 0 ? 0 : 0.5 * (y1 - y3) / den;
  return (best + delta) * BIN;
}

console.log('窗口  最佳时移(秒)  精确同音高命中率(±0.15s)  同音名命中率');
const rows = [];
for (let t0 = 0; t0 + 20 <= 290; t0 += 20) {
  const lag = bestLag(t0, t0 + 20);
  const A = score.filter((n) => n.t >= t0 && n.t < t0 + 20);
  if (!A.length) continue;
  let pitch = 0, pc = 0;
  for (const s of A) {
    const target = s.t + lag;
    let hitP = false, hitPc = false;
    for (const n of ref) {
      if (Math.abs(n.onset - target) > 0.15) continue;
      if (n.midi === s.midi) hitP = true;
      if (((n.midi - s.midi) % 12 + 12) % 12 === 0) hitPc = true;
      if (hitP && hitPc) break;
    }
    if (hitP) pitch++;
    if (hitPc) pc++;
  }
  rows.push({ t0, lag, pitch: pitch / A.length, pc: pc / A.length, n: A.length });
  console.log(`  ${String(t0).padStart(3)}s  ${lag.toFixed(3).padStart(6)}        ${(pitch / A.length * 100).toFixed(1).padStart(5)}%              ${(pc / A.length * 100).toFixed(1).padStart(5)}%   (${A.length} 颗)`);
}

// 线性拟合 lag(t) = a + b·t：b 就是"速度比例误差"（正=参考更快，需要压缩谱面）
const n = rows.length;
const mx = rows.reduce((s, r) => s + (r.t0 + 10), 0) / n;
const my = rows.reduce((s, r) => s + r.lag, 0) / n;
const b = rows.reduce((s, r) => s + (r.t0 + 10 - mx) * (r.lag - my), 0)
  / rows.reduce((s, r) => s + (r.t0 + 10 - mx) ** 2, 0);
console.log(`\n拟合：时移 ≈ ${my.toFixed(3)}s ${b >= 0 ? '+' : '-'} ${Math.abs(b * 100).toFixed(2)}% × t`);
