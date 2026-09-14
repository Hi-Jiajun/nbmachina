// 分析录到的 WAV：是不是有声音、有没有音符（起始点）节奏
import fs from 'node:fs';
import { resolveExternal } from '../core/paths.mjs';

// M2-3：默认录音路径 = 测试服目录下的 capture.wav（--server / NBFORGE_SERVER 可覆盖）
const file = process.argv[2] ?? `${resolveExternal().server}/capture.wav`;
if (!fs.existsSync(file)) { console.log('WAV 不存在:', file); process.exit(0); }
const buf = fs.readFileSync(file);
console.log('文件大小:', (buf.length / 1024 / 1024).toFixed(2), 'MB');
if (buf.toString('ascii', 0, 4) !== 'RIFF') { console.log('不是 RIFF/WAV 文件，头部:', buf.subarray(0, 16).toString('hex')); process.exit(0); }

let pos = 12, fmt = null, data = null;
while (pos + 8 <= buf.length) {
  const id = buf.toString('ascii', pos, pos + 4);
  const size = buf.readUInt32LE(pos + 4);
  if (id === 'fmt ') {
    fmt = {
      format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10),
      sampleRate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22),
    };
  } else if (id === 'data') { data = buf.subarray(pos + 8, pos + 8 + size); }
  pos += 8 + size + (size % 2);
}
console.log('格式:', JSON.stringify(fmt), ' 数据字节:', data?.length ?? 0);
if (!fmt || !data) { console.log('缺少 fmt 或 data 块'); process.exit(0); }

const bytesPerSample = fmt.bits / 8;
const total = Math.floor(data.length / (bytesPerSample * fmt.channels));
const dur = total / fmt.sampleRate;
console.log(`时长: ${dur.toFixed(1)} 秒, 采样率 ${fmt.sampleRate}, ${fmt.channels} 声道, ${fmt.bits} bit`);

// 每 50ms 一窗，算 RMS
const win = Math.floor(fmt.sampleRate * 0.05);
const rms = [];
for (let w = 0; w + win <= total; w += win) {
  let sum = 0;
  for (let i = 0; i < win; i++) {
    const idx = (w + i) * fmt.channels * bytesPerSample;
    let v;
    if (fmt.bits === 16) v = data.readInt16LE(idx) / 32768;
    else if (fmt.bits === 32) v = data.readInt32LE(idx) / 2147483648;
    else v = (data[idx] - 128) / 128;
    sum += v * v;
  }
  rms.push(Math.sqrt(sum / win));
}
const peak = Math.max(...rms);
const avg = rms.reduce((a, b) => a + b, 0) / rms.length;
const loud = rms.filter((v) => v > Math.max(0.005, peak * 0.15)).length;
console.log(`RMS: 峰值 ${peak.toFixed(4)}, 平均 ${avg.toFixed(4)}, 有声窗口 ${loud}/${rms.length} (${(100 * loud / rms.length).toFixed(1)}%)`);

// 打印活动时间线（每 0.5 秒一个字符，'#'=响 '.'=静）
let timeline = '';
for (let i = 0; i < rms.length; i += 10) {
  const seg = rms.slice(i, i + 10);
  const m = Math.max(...seg);
  timeline += m > Math.max(0.005, peak * 0.15) ? '#' : (m > 0.001 ? '+' : '.');
}
console.log('时间线(每字符≈0.5秒):');
console.log(timeline);

// 粗略数一下"响→静"的段落数（音符事件估计）
let bursts = 0, inBurst = false, thr = Math.max(0.005, peak * 0.15);
for (const v of rms) { if (v > thr && !inBurst) { bursts++; inBurst = true; } else if (v <= thr * 0.5) inBurst = false; }
console.log('检测到的声音段数(≈音符事件数):', bursts);
