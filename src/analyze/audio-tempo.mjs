// 从原曲 WAV 估速度：对 RMS 包络做自相关，找节拍周期
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const path = `${B}/styx_helix_full.wav`;
const buf = fs.readFileSync(path);
let q = 12, fmt = null, dataOff = 0, dataLen = 0;
while (q + 8 <= buf.length) {
  const id = buf.toString('ascii', q, q + 4), size = buf.readUInt32LE(q + 4);
  if (id === 'fmt ') fmt = { ch: buf.readUInt16LE(q + 10), sr: buf.readUInt32LE(q + 12), bits: buf.readUInt16LE(q + 22) };
  if (id === 'data') { dataOff = q + 8; dataLen = size; }
  q += 8 + size + (size % 2);
}
const sr = fmt.sr, total = Math.floor(dataLen / (fmt.ch * fmt.bits / 8));
const hop = 441;   // 10ms 一帧
const env = [];
for (let i = 0; i + hop <= total; i += hop) {
  let sum = 0;
  for (let j = 0; j < hop; j++) {
    const idx = dataOff + (i + j) * fmt.ch * (fmt.bits / 8);
    const v = buf.readInt16LE(idx === 0 ? 0 : idx - (idx % 2)) / 32768;
    sum += v * v;
  }
  env.push(Math.sqrt(sum / hop));
}
// 去掉直流
const mean = env.reduce((a, b) => a + b, 0) / env.length;
const e = env.map((v) => v - mean);
console.log(`包络帧数 ${e.length}（每帧 10ms，总 ${(e.length / 100).toFixed(1)} 秒）`);

let best = null;
for (let lag = 20; lag <= 150; lag++) {            // 0.2s ~ 1.5s 周期
  let s = 0;
  for (let i = 0; i + lag < e.length; i++) s += e[i] * e[i + lag];
  s /= (e.length - lag);
  if (!best || s > best.s) best = { lag, s };
}
console.log(`最佳周期 lag=${best.lag} 帧 → ${(best.lag * 10)}ms  → ${(60000 / (best.lag * 10)).toFixed(1)} BPM（按四分音符算）`);
// 也看看 2 倍/4 倍关系
for (const mult of [2, 4]) {
  const lag = best.lag * mult;
  if (lag < e.length) {
    let s = 0; for (let i = 0; i + lag < e.length; i++) s += e[i] * e[i + lag];
    console.log(`  周期×${mult} = ${lag * 10}ms 相关=${(s / (e.length - lag)).toFixed(4)}`);
  }
}
console.log(`注：0.12 秒/步 的网格 = ${(60000 / 120).toFixed(1)} BPM 的十六分音符`);
