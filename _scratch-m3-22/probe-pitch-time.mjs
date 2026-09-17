// M3-22 探针：我们的机器谱面 vs 参考演奏转谱 —— 逐音时间差 + 八度差
//
// 目的：先把"到底差多少"量出来，再谈怎么改。
//   ① 每个声部的最佳全局时移（onset 直方图互相关，10ms 格）
//   ② 时移对齐后，同音名（pitch class）最近的转谱音 → 半音差分布（找八度错位）
//   ③ 对齐后的精确同音高命中率
import fs from 'node:fs';
import path from 'node:path';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const scoreLines = fs.readFileSync(path.join(B, 'machine_pipeline_video_phrase.csv'), 'utf8')
  .trim().split(/\r?\n/);
const idx = Object.fromEntries(scoreLines[0].split(',').map((h, i) => [h, i]));
const score = scoreLines.slice(1).map((l) => l.split(',')).map((c) => ({
  t: Number(c[idx.time_seconds]), midi: Number(c[idx.midi]), voice: c[idx.instrument], step: Number(c[idx.step]),
})).filter((n) => n.voice === 'harp' || n.voice === 'bass');

const tr = JSON.parse(fs.readFileSync(path.join(B, 'ref_transcription.json'), 'utf8'));
const ref = tr.note_events;

const BIN = 0.01;               // 10ms
const hist = (arr, n) => {
  const h = new Float64Array(Math.ceil(n / BIN) + 1);
  for (const t of arr) { const k = Math.round(t / BIN); if (k >= 0) h[k]++; }
  return h;
};
const X = hist(score.map((n) => n.t), 290);
const Y = hist(ref.map((n) => n.onset), 290);
/** 互相关：Y 相对 X 移动 lag 秒后的重叠（lag>0 表示"参考更晚"） */
const xcorr = (lagBins) => {
  let s = 0;
  for (let i = 0; i < X.length; i++) {
    const j = i + lagBins;
    if (j >= 0 && j < Y.length) s += X[i] * Y[j];
  }
  return s;
};
const lags = [];
for (let b = -120; b <= 120; b++) lags.push([b * BIN, xcorr(b)]);
lags.sort((a, b) => b[1] - a[1]);
console.log('全体最佳时移（TOP5，正=参考更晚/我们更早）：');
console.log('  ' + lags.slice(0, 5).map(([l, v]) => `${l.toFixed(2)}s`).join('  '));

// 粗一步：抛物线插值找峰值
const peakBin = Math.round(lags[0][0] / BIN);
const y1 = xcorr(peakBin - 1), y2 = xcorr(peakBin), y3 = xcorr(peakBin + 1);
const delta = 0.5 * (y1 - y3) / (y1 - 2 * y2 + y3);
const bestLag = (peakBin + delta) * BIN;
console.log(`  插值后最佳时移 = ${bestLag.toFixed(3)}s（即谱面要整体平移 ${(-bestLag).toFixed(3)}s）`);

for (const voice of ['harp', 'bass', 'all']) {
  const A = voice === 'all' ? score : score.filter((n) => n.voice === voice);
  const R = voice === 'all' ? ref : ref;   // 转谱不分声部
  // 八度差：同音名最近的转谱音
  const hist2 = {};
  let samePitch = 0, anyHit = 0;
  for (const s of A) {
    let best = null, bestDt = Infinity;
    for (const n of R) {
      if (((n.midi - s.midi) % 12 + 12) % 12 !== 0) continue;
      const dt = Math.abs(n.onset - (s.t - bestLag));
      if (dt < bestDt) { bestDt = dt; best = n; }
    }
    if (!best || bestDt > 0.25) continue;
    hist2[best.midi - s.midi] = (hist2[best.midi - s.midi] ?? 0) + 1;
    if (bestDt <= 0.18) samePitch++;
  }
  // 精确同音高命中率（对齐后 ±0.18s）
  for (const s of A) {
    for (const n of R) {
      if (n.midi === s.midi && Math.abs(n.onset - (s.t - bestLag)) <= 0.18) { anyHit++; break; }
    }
  }
  console.log(`\n[${voice}] ${A.length} 颗`);
  console.log(`  同音名最近的半音差（TOP8）：`
    + Object.entries(hist2).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, v]) => `${k > 0 ? '+' : ''}${k}:${v}`).join('  '));
  console.log(`  精确同音高命中率（±0.18s）= ${(anyHit / A.length * 100).toFixed(1)}%`
    + `；同音名且 ≤0.18s = ${(samePitch / A.length * 100).toFixed(1)}%`);
}
