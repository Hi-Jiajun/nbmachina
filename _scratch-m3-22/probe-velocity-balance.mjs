// M3-22 探针 8：左手 vs 旋律的**力度平衡**——参考演奏里这两层到底差多少？
// 用途：用户在 B 里听出"低音之间污染太严重"，很可能是"左手被弹得和旋律一样响"。
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const L = fs.readFileSync(`${B}/machine_pipeline_calibrated.csv`, 'utf8').trim().split(/\r?\n/);
const i = Object.fromEntries(L[0].split(',').map((h, k) => [h, k]));
const score = L.slice(1).map((l) => l.split(',')).map((c) => ({
  t: +c[i.time_seconds], v: c[i.instrument], midi: +c[i.midi], vel: +c[i.velMidi],
}));
const rep = JSON.parse(fs.readFileSync(`${B}/calibration_report.json`, 'utf8'));
const curve = rep.lag_curve;
const lagAt = (t) => {
  if (t <= curve[0].t) return curve[0].lag;
  if (t >= curve.at(-1).t) return curve.at(-1).lag;
  for (let k = 1; k < curve.length; k++) {
    if (t <= curve[k].t) {
      const a = curve[k - 1], b = curve[k];
      return a.lag + (b.lag - a.lag) * (t - a.t) / (b.t - a.t);
    }
  }
  return 0;
};

const ref = JSON.parse(fs.readFileSync(`${B}/ref_transcription.json`, 'utf8')).note_events;
const byMidi = new Map();
ref.forEach((n, k) => {
  if (!byMidi.has(n.midi)) byMidi.set(n.midi, []);
  byMidi.get(n.midi).push(k);
});
const used = new Uint8Array(ref.length);
const per = { harp: [], bass: [] };
for (const s of score) {
  if (!per[s.v]) continue;
  const target = s.t + lagAt(s.t);
  let best = -1, bestDt = Infinity;
  for (const k of byMidi.get(s.midi) ?? []) {
    if (used[k]) continue;
    const dt = Math.abs(ref[k].onset - target);
    if (dt > 0.2) continue;
    if (dt < bestDt) { bestDt = dt; best = k; }
  }
  if (best < 0) continue;
  used[best] = 1;
  per[s.v].push({ vel: ref[best].velocity, midi: s.midi, t: s.t, ours: s.vel });
}
const q = (a, p) => { const x = a.slice().sort((m, n) => m - n); return x[Math.floor(p * (x.length - 1))]; };
for (const [v, list] of Object.entries(per)) {
  const vels = list.map((x) => x.vel);
  const ours = list.map((x) => x.ours);
  console.log(`[${v}] 匹配 ${list.length} 颗`);
  console.log(`   参考模型力度：p10 ${q(vels, 0.1).toFixed(0)} / 中位 ${q(vels, 0.5).toFixed(0)} / p90 ${q(vels, 0.9).toFixed(0)}`);
  console.log(`   我们现用力度：p10 ${q(ours, 0.1).toFixed(0)} / 中位 ${q(ours, 0.5).toFixed(0)} / p90 ${q(ours, 0.9).toFixed(0)}`);
}
const med = (a) => q(a, 0.5);
// 按音区分桶：低音区是不是被我们弹得太响了？
console.log('\nbass 按音区：参考模型力度 / 我们现用力度（中位）');
for (const [lo, hi] of [[42, 47], [48, 53], [54, 59], [60, 65], [66, 71], [72, 90]]) {
  const list = per.bass.filter((x) => x.midi >= lo && x.midi <= hi);
  if (list.length < 10) continue;
  console.log(`  midi ${lo}-${hi}: 参考 ${med(list.map((x) => x.vel)).toFixed(0)} / 我们 ${med(list.map((x) => x.ours)).toFixed(0)}`
    + `  (${list.length} 颗)`);
}
const bassRef = per.bass.map((x) => x.vel), harpRef = per.harp.map((x) => x.vel);
console.log(`\n参考里"左手 − 旋律"= ${med(bassRef).toFixed(0)} − ${med(harpRef).toFixed(0)} = ${(med(bassRef) - med(harpRef)).toFixed(0)}（MIDI 力度；每 1 ≈ 0.2dB 左右）`);
console.log(`我们现用"左手 − 旋律"= ${med(per.bass.map((x) => x.ours)).toFixed(0)} − ${med(per.harp.map((x) => x.ours)).toFixed(0)} = ${(med(per.bass.map((x) => x.ours)) - med(per.harp.map((x) => x.ours))).toFixed(0)}`);

// 分段看（歌曲内部的平衡变化）
console.log('\n每 40s：参考左手中位 / 参考旋律中位 / 差值');
for (let t0 = 0; t0 + 40 <= 280; t0 += 40) {
  const bs = per.bass.filter((x) => x.t >= t0 && x.t < t0 + 40).map((x) => x.vel);
  const hs = per.harp.filter((x) => x.t >= t0 && x.t < t0 + 40).map((x) => x.vel);
  if (!bs.length || !hs.length) continue;
  console.log(`  ${t0}-${t0 + 40}s: ${med(bs).toFixed(0)} / ${med(hs).toFixed(0)} / ${(med(bs) - med(hs)).toFixed(0)}`);
}
