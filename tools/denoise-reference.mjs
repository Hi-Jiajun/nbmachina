#!/usr/bin/env node
// 参考演奏的底噪处理（M3-8）：视频抽出来的音频带 AAC/录音底噪，
// 它会影响后面所有"用音频标定"的判断（八度证据、力度、频谱对照），所以先清干净。
//
// 做法：① 用 50ms 帧的 RMS 找出**最安静的 5% 帧**，作为底噪估计；
//      ② 交给 ffmpeg 的 afftdn（FFT 降噪 + 噪声跟踪）处理；
//      ③ 双向验证：静音段噪声必须显著下降，**有音符段**的频带能量必须几乎不变（别把琴声也削了）。
//
//   node tools/denoise-reference.mjs [--in build/animenz_styx_helix.wav] [--out build/animenz_styx_helix_clean.wav] [--nr 15]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readWav } from '../src/analyze/dsp.mjs';
import { magnitudeSpectrum } from '../src/synth/spectrum.mjs';
import { resolvePaths } from '../src/core/paths.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();

const IN = opt('in', path.join(P.build, 'animenz_styx_helix.wav'));
const OUT = opt('out', path.join(P.build, 'animenz_styx_helix_clean.wav'));
const NR = Number(opt('nr', 8));

const { samples, sampleRate } = readWav(IN);
const frames = [];
const hop = Math.round(0.05 * sampleRate);
for (let off = 0; off + hop <= samples.length; off += hop) {
  let acc = 0;
  for (let i = off; i < off + hop; i++) acc += samples[i] * samples[i];
  frames.push({ off, rms: Math.sqrt(acc / hop) });
}
const sorted = [...frames].sort((a, b) => a.rms - b.rms);
// ⚠️ 视频里有**数字静音**段（RMS 精确为 0）：用它们测"底噪"会得到 -180dBFS 的假值。
// 所以底噪要从"安静但非静音"的帧里测（取 RMS 排序后的 5%..25% 区间）。
const nonSilent = sorted.filter((f) => f.rms > 1e-6);
const quiet = nonSilent.slice(Math.floor(nonSilent.length * 0.05), Math.floor(nonSilent.length * 0.25));
const loud = sorted.slice(-Math.max(1, Math.floor(sorted.length * 0.4)));   // 最响的 40% 当"有音符段"
const noiseFloorDb = 20 * Math.log10(Math.max(1e-9, quiet[Math.floor(quiet.length / 2)].rms));
console.log(`底噪估计：${noiseFloorDb.toFixed(1)} dBFS（"安静但非静音"帧：${quiet.length} 个；数字静音帧 ${frames.length - nonSilent.length} 个已排除）`);

const bandDb = (samplesIn, off, seconds = 1.0) => {
  const win = Math.min(samplesIn.length - off, Math.round(seconds * sampleRate));
  const { magnitudes } = magnitudeSpectrum(samplesIn.subarray(off, off + win), { sampleRate, fftSize: 16384, windowSec: win / sampleRate });
  const binHz = sampleRate / 16384;
  const bands = [[60, 300], [300, 1200], [1200, 4000], [4000, 9000], [9000, 16000]];
  return bands.map(([lo, hi]) => { let e = 0; for (let i = Math.ceil(lo / binHz); i <= Math.floor(hi / binHz) && i < magnitudes.length; i++) e += magnitudes[i] ** 2; return 10 * Math.log10(Math.max(1e-20, e)); });
};
const probe = (s) => quiet.slice(0, 8).map((f) => 20 * Math.log10(Math.max(1e-9, Math.sqrt(s.subarray(f.off, f.off + hop).reduce((a, v) => a + v * v, 0) / hop))));
const probeLoud = (s) => loud.slice(0, 5).map((f) => 20 * Math.log10(Math.max(1e-9, Math.sqrt(s.subarray(f.off, f.off + hop).reduce((a, v) => a + v * v, 0) / hop))));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;

const beforeQuiet = mean(probe(samples));
const beforeLoud = mean(probeLoud(samples));
const beforeQuietBand = bandDb(samples, quiet[0].off);
const beforeLoudBand = bandDb(samples, loud[Math.floor(loud.length / 2)].off);

// 保守链（2026-09-14 变体矩阵实测后选定）：
//   ① 25Hz 高通去隆隆；② afftdn **tn=0**（固定噪声底、不做跟踪）—— tn=1 会在有音符段
//   加 4.4dB 高频伪影（"音乐噪声"）；③ 16kHz 低通切掉录音嘶声。
// 实测：静音段 9–16kHz 降 20.0dB、有音符段该带只降 3.76dB（没有新增）；300–9kHz 变化 0.12dB。
const chain = `highpass=f=25,afftdn=nr=${NR}:nf=-60:tn=0,lowpass=f=16000`;
execFileSync('ffmpeg', ['-y', '-i', IN, '-af', chain, '-c:a', 'pcm_s16le', OUT], { stdio: 'ignore' });

const clean = readWav(OUT);
const afterQuiet = mean(probe(clean.samples));
const afterLoud = mean(probeLoud(clean.samples));
const afterQuietBand = bandDb(clean.samples, quiet[0].off);
const afterLoudBand = bandDb(clean.samples, loud[Math.floor(loud.length / 2)].off);

const bands = ['60-300', '300-1200', '1200-4000', '4000-9000', '9000-16000'];
console.log(`\n静音段 RMS：${beforeQuiet.toFixed(1)} → ${afterQuiet.toFixed(1)} dBFS（降 ${(beforeQuiet - afterQuiet).toFixed(1)} dB）`);
console.log(`有音符段 RMS：${beforeLoud.toFixed(1)} → ${afterLoud.toFixed(1)} dBFS（变化 ${(afterLoud - beforeLoud).toFixed(2)} dB，应接近 0）`);
console.log('静音段频带（dB）:');
bands.forEach((b, i) => console.log(`  ${b.padEnd(9)} ${beforeQuietBand[i].toFixed(1)} → ${afterQuietBand[i].toFixed(1)}（${(afterQuietBand[i] - beforeQuietBand[i]).toFixed(1)}）`));
console.log('有音符段频带（dB，变化应 <1.5dB）:');
bands.forEach((b, i) => console.log(`  ${b.padEnd(9)} ${beforeLoudBand[i].toFixed(1)} → ${afterLoudBand[i].toFixed(1)}（${(afterLoudBand[i] - beforeLoudBand[i]).toFixed(2)}）`));

// 静音段的"嘶声带"（9–16kHz）必须在降噪后显著下降；有音符段该带的变化要小（不许新增伪影）。
// ⚠️ 必须**多帧平均**：单帧会随机挑到"衬着乐音尾巴"或"纯嘶声"的帧，得出互相矛盾的结论
// （实测工具第一版报 +4.08dB 伪影，40 帧平均后其实是 −0.12dB）。
const avgBand = (s, framesIn, lo, hi) => framesIn.slice(0, 40)
  .reduce((acc, f) => acc + (() => {
    const win = Math.round(0.5 * sampleRate);
    const { magnitudes } = magnitudeSpectrum(s.subarray(f.off, f.off + win), { sampleRate, fftSize: 8192, windowSec: 0.5 });
    const binHz = sampleRate / 8192;
    let e = 0;
    for (let i = Math.ceil(lo / binHz); i <= Math.floor(hi / binHz) && i < magnitudes.length; i++) e += magnitudes[i] ** 2;
    return 10 * Math.log10(Math.max(1e-20, e));
  })(), 0) / Math.min(40, framesIn.length);
const hb = avgBand(samples, quiet, 9000, 16000);
const ha = avgBand(clean.samples, quiet, 9000, 16000);
const lb = avgBand(samples, loud.slice().reverse(), 9000, 16000);
const la = avgBand(clean.samples, loud.slice().reverse(), 9000, 16000);
const mb = avgBand(samples, loud.slice().reverse(), 300, 9000);
const ma = avgBand(clean.samples, loud.slice().reverse(), 300, 9000);
console.log(`\n安静帧（40 帧平均）9–16kHz：${hb.toFixed(1)} → ${ha.toFixed(1)} dB（降 ${(hb - ha).toFixed(1)} dB 嘶声）`);
console.log(`响帧（40 帧平均）9–16kHz：${lb.toFixed(1)} → ${la.toFixed(1)} dB（${(la - lb).toFixed(2)}，为正是伪影，需 <1.5）`);
console.log(`响帧（40 帧平均）300–9kHz：${mb.toFixed(1)} → ${ma.toFixed(1)} dB（${(ma - mb).toFixed(2)}，应 ≈0）`);
const report = {
  in: IN, out: OUT, nr: NR, noiseFloorDb: +noiseFloorDb.toFixed(1),
  chain,
  quietRmsDb: [+beforeQuiet.toFixed(2), +afterQuiet.toFixed(2)],
  loudRmsDb: [+beforeLoud.toFixed(2), +afterLoud.toFixed(2)],
  quietBands: bands.map((b, i) => [b, +beforeQuietBand[i].toFixed(1), +afterQuietBand[i].toFixed(1)]),
  loudBands: bands.map((b, i) => [b, +beforeLoudBand[i].toFixed(1), +afterLoudBand[i].toFixed(1)]),
};
fs.writeFileSync(path.join(P.build, 'denoise-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n产物：${OUT.replace(/\\/g, '/')}（报告 build/denoise-report.json）`);
