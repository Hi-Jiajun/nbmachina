#!/usr/bin/env node
// M3-11 · SoundFont（.sf2）取样器：把 SF2 里的采样导出成 wav + 生成同目录 .sfz
//
// 为什么要它：候选钢琴里 Yamaha Disklavier Pro（Zenph 录音，CC-BY 3.0）只以 SF2 形态存在，
// 而我们的整曲渲染吃的是 SFZ（见 src/sample/sfz.mjs）。与其引一个采样器依赖，
// 不如把 116 个采样读出来 + 按采样表生成 SFZ —— 顺带把 SF2 这条路修通（以后 GM 鼓等都能用）。
//
// 只读 SF2 的 `sdta/smpl`（16bit PCM）与 `pdta/shdr`（采样头：音高、修正、循环点）：
//   · 音高键位区间用**相邻根音的中点**划分（钢琴这类单乐器标准做法；SF2 的 zone 键位区间同源）
//   · pitchCorrection（±50 cent）写进 SFZ 的 tune
//   · `--normalize <dBFS>` 可选：按峰值把采样拉到同一响度（默认关，先看原始数据）
//
// 用法：node tools/sf2-dump.mjs --sf2 <file.sf2> --out <dir> [--normalize -6]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SF2 = opt('sf2');
const OUT = opt('out');
const NORM = opt('normalize') === undefined ? null : Number(opt('normalize'));
if (!SF2 || !OUT) {
  console.error('用法：node tools/sf2-dump.mjs --sf2 <file.sf2> --out <dir> [--normalize -6]');
  process.exit(2);
}

const buf = fs.readFileSync(SF2);
// SoundFont 的外壳是 RIFF，但 form type 是 `sfbk`（不是 wav 的 `WAVE`）
if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'sfbk') {
  throw new Error(`不是 RIFF/sfbk 文件（前 12 字节：${buf.toString('ascii', 0, 12)}）`);
}

/** RIFF 子块遍历：回调 (id, start, size) */
function chunks(start, end, cb) {
  let p = start;
  while (p + 8 <= end) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    cb(id, p + 8, size);
    p += 8 + size + (size % 2);          // RIFF 块按偶数字节对齐
  }
}

// 收集 sdta/smpl 与 pdta 各子块
let smpl = null;
const pdta = {};
chunks(12, buf.length, (id, start, size) => {
  if (id !== 'LIST') return;
  const type = buf.toString('ascii', start, start + 4);
  const body = start + 4;
  if (type === 'sdta') chunks(body, body + size - 4, (sid, s, sz) => { if (sid === 'smpl') smpl = { start: s, size: sz }; });
  if (type === 'pdta') chunks(body, body + size - 4, (sid, s, sz) => { pdta[sid] = { start: s, size: sz }; });
});
if (!smpl) throw new Error('没有 sdta/smpl（24bit 变体 sm24 未支持）');
if (!pdta.shdr) throw new Error('没有 pdta/shdr');

/* ---------------- 采样头（shdr）：46 字节/条 ---------------- */
const shdrCount = pdta.shdr.size / 46;
if (!Number.isInteger(shdrCount)) throw new Error(`shdr 长度 ${pdta.shdr.size} 不是 46 的整数倍`);
const samples = [];
for (let i = 0; i < shdrCount; i++) {
  const p = pdta.shdr.start + i * 46;
  const name = buf.toString('ascii', p, p + 20).replace(/\0.*$/, '').trim();
  samples.push({
    index: i,
    name: name || `sample_${String(i).padStart(3, '0')}`,
    start: buf.readUInt32LE(p + 20),
    end: buf.readUInt32LE(p + 24),
    startLoop: buf.readUInt32LE(p + 28),
    endLoop: buf.readUInt32LE(p + 32),
    sampleRate: buf.readUInt32LE(p + 36),
    originalKey: buf.readUInt8(p + 40),
    pitchCorrection: buf.readInt8(p + 41),
    link: buf.readUInt16LE(p + 42),
    type: buf.readUInt16LE(p + 44),
  });
}
// 最后一条是 EOI 哨兵（start=end=0）
const real = samples.filter((s) => s.end > s.start && s.type === 1);
console.log(`采样 ${real.length} 条（shdr ${shdrCount} 条，含哨兵/立体声链接）`);

fs.mkdirSync(OUT, { recursive: true });

/* ---------------- 导出 wav + 记录峰值 ---------------- */
const pcmBase = smpl.start;
const exported = [];
for (const s of real) {
  const n = s.end - s.start;
  const data = Buffer.alloc(n * 2);
  buf.copy(data, 0, pcmBase + s.start * 2, pcmBase + s.end * 2);
  // 去直流：SF2 采样偶尔带直流偏置，会吃动态余量
  let mean = 0;
  for (let i = 0; i < n; i++) mean += data.readInt16LE(i * 2);
  mean /= n;
  let peak = 0;
  const shifted = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-32768, Math.min(32767, Math.round(data.readInt16LE(i * 2) - mean)));
    shifted.writeInt16LE(v, i * 2);
    peak = Math.max(peak, Math.abs(v) / 32768);
  }
  const file = `${String(s.index).padStart(3, '0')}_${s.name.replace(/[^A-Za-z0-9._-]/g, '_')}.wav`;
  fs.writeFileSync(path.join(OUT, file), wav16(shifted, s.sampleRate, 1));
  exported.push({ ...s, file, peak, frames: n });
}
exported.sort((a, b) => a.originalKey - b.originalKey || a.name.localeCompare(b.name));
console.log(`导出 wav ${exported.length} 个 → ${OUT.replace(/\\/g, '/')}`);

const peaks = exported.map((e) => e.peak);
const db = (x) => (20 * Math.log10(Math.max(1e-6, x))).toFixed(1);
console.log(`峰值分布：最小 ${db(Math.min(...peaks))}dB / 中位 ${db(peaks.slice().sort((a, b) => a - b)[Math.floor(peaks.length / 2)])}dB / 最大 ${db(Math.max(...peaks))}dB`);

/* ---------------- 生成 SFZ（键位区间 = 相邻根音中点） ---------------- */
const roots = [...new Set(exported.map((e) => e.originalKey))].sort((a, b) => a - b);
const mid = (k) => {
  const i = roots.indexOf(k);
  const lo = i > 0 ? Math.floor((roots[i - 1] + k) / 2) + 1 : 0;
  const hi = i < roots.length - 1 ? Math.floor((k + roots[i + 1]) / 2) : 127;
  return [lo, hi];
};
const lines = [
  '// 由 tools/sf2-dump.mjs 从 SoundFont 自动生成：键位区间 = 相邻根音中点',
  '<control>',
  'default_path=',
  '<global>',
  'ampeg_release=1',
];
for (const e of exported) {
  const [lo, hi] = mid(e.originalKey);
  const gainDb = NORM === null ? 0 : Math.max(-12, Math.min(12, NORM - 20 * Math.log10(Math.max(1e-6, e.peak))));
  lines.push(`<region> sample=${e.file} lokey=${lo} hikey=${hi} pitch_keycenter=${e.originalKey}`
    + (e.pitchCorrection ? ` tune=${e.pitchCorrection}` : '')
    + (gainDb ? ` volume=${gainDb.toFixed(1)}` : ''));
}
const sfz = path.join(OUT, path.basename(SF2).replace(/\.sf2$/i, '') + '.sfz');
fs.writeFileSync(sfz, lines.join('\n') + '\n', 'utf8');
console.log(`SFZ → ${sfz.replace(/\\/g, '/')}（${exported.length} 区域，根音 ${roots[0]}..${roots.at(-1)}）`);

/** 16bit 单声道 WAV 头 + 数据 */
function wav16(pcm, sampleRate, channels) {
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + pcm.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([head, pcm]);
}
