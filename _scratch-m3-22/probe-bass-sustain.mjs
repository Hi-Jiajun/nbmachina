// M3-22 探针 6：低音"糊"到底糊在哪 —— 时值分布 / 同时发声数 / 与参考演奏的衰减对比
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const L = fs.readFileSync(`${B}/machine_pipeline_calibrated.csv`, 'utf8').trim().split(/\r?\n/);
const i = Object.fromEntries(L[0].split(',').map((h, k) => [h, k]));
const all = L.slice(1).map((l) => l.split(',')).map((c) => ({
  t: +c[i.time_seconds], v: c[i.instrument], midi: +c[i.midi], row: +c[i.row],
  dur: +c[i.durMs], ref: +c[i.refMatched], vel: +c[i.velMidi],
}));
const b = all.filter((x) => x.v === 'bass');
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p * (s.length - 1))]; };

console.log(`bass ${b.length} 颗，midi ${Math.min(...b.map((x) => x.midi))}..${Math.max(...b.map((x) => x.midi))}`);
console.log(`  durMs：p10 ${q(b.map((x) => x.dur), 0.1)} / 中位 ${q(b.map((x) => x.dur), 0.5)} / p90 ${q(b.map((x) => x.dur), 0.9)}`);
const m = b.filter((x) => x.ref === 1), f = b.filter((x) => x.ref !== 1);
console.log(`  匹配到的 ${m.length} 颗 中位 ${q(m.map((x) => x.dur), 0.5)}ms；兜底的 ${f.length} 颗 中位 ${q(f.map((x) => x.dur), 0.5)}ms`);
const gaps = [];
const ts = b.map((x) => x.t).sort((p, r) => p - r);
for (let k = 1; k < ts.length; k++) gaps.push(ts[k] - ts[k - 1]);
console.log(`  相邻间隔：p10 ${q(gaps, 0.1).toFixed(3)}s / 中位 ${q(gaps, 0.5).toFixed(3)}s`);

console.log('\n同时发声的 bass 数（0.1s 采样）：');
for (const [a, z] of [[0, 10], [20, 30], [60, 70], [80, 90], [140, 150], [200, 210]]) {
  let peak = 0, sum = 0, n = 0;
  for (let t = a; t < z; t += 0.1) {
    const c = b.filter((x) => x.t <= t && x.t + x.dur / 1000 > t).length;
    peak = Math.max(peak, c); sum += c; n++;
  }
  console.log(`  ${a}-${z}s：平均 ${(sum / n).toFixed(1)} / 峰值 ${peak}`);
}

// 每颗 bass 音"响多久" vs "参考里同一时刻低音区还有多少能量"
console.log('\n55–95s 的 bass 事件（前 40 条）：');
for (const x of b.filter((y) => y.t >= 55 && y.t < 95).slice(0, 40)) {
  console.log(`  t=${x.t.toFixed(2)} midi=${x.midi} dur=${x.dur}ms 匹配=${x.ref} vel=${x.vel}`);
}
