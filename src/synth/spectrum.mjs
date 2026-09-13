// M2-1 · 频谱自查（只读工具，用于"基频误差 ≤1%"这条验收，以及报告里的频谱数据）
//
// 口径（写进 docs/M2-1-report.md §2）：
//   · 窗：默认取**信号开头** 0.37 秒（起音段泛音最全）加 Hann 窗，零填充到 65536 点做 FFT
//     → bin 间隔 44100/65536 = 0.673 Hz
//   · 峰值频率：在 [minHz, maxHz] 内取**全局最强谱峰**，再用对数幅度做抛物线插值（亚 bin 精度）
//     —— 刻意不做"在目标频率附近找峰"，否则"误差 ≤1%"就是自证
//   · 谱心（spectral centroid）：Σ(f·|X|)/Σ|X|，用 0.19 秒短窗（看起音亮度，力度→亮度的判据）
import { fftInPlace, hannWindow } from '../analyze/dsp.mjs';

import { SAMPLE_RATE } from './synth.mjs';

const DEFAULT_FFT = 65536;

/** 加窗幅度谱（返回的 magnitudes 与 fftSize 等长，只有前半段有意义） */
export function magnitudeSpectrum(samples, { sampleRate = SAMPLE_RATE, fftSize = DEFAULT_FFT, windowSec = 0.37 } = {}) {
  const n = Math.min(samples.length, Math.max(16, Math.round(windowSec * sampleRate)));
  const win = hannWindow(n);
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  for (let i = 0; i < n; i++) re[i] = samples[i] * win[i];
  fftInPlace(re, im);
  const magnitudes = new Float64Array(fftSize / 2);
  for (let i = 0; i < magnitudes.length; i++) magnitudes[i] = Math.hypot(re[i], im[i]);
  return { magnitudes, binHz: sampleRate / fftSize, fftSize, windowSamples: n };
}

/**
 * 全局最强谱峰（含亚 bin 插值）。minHz/maxHz 只用来"圈定合法的音频带"（默认 20Hz..Nyquist），
 * 不在目标频率附近开小窗 —— 这样测出来的误差才说明问题。
 */
export function dominantPeak(samples, {
  sampleRate = SAMPLE_RATE, fftSize = DEFAULT_FFT, windowSec = 0.37, minHz = 20, maxHz = null,
} = {}) {
  const { magnitudes, binHz } = magnitudeSpectrum(samples, { sampleRate, fftSize, windowSec });
  const last = magnitudes.length - 2;
  const lo = Math.max(1, Math.ceil(minHz / binHz));
  const hi = Math.min(last, maxHz ? Math.floor(maxHz / binHz) : last);
  let best = lo;
  for (let k = lo; k <= hi; k++) if (magnitudes[k] > magnitudes[best]) best = k;
  // 对数幅度抛物线插值：hann 窗主瓣内偏差 <0.05 bin
  const y0 = Math.log(magnitudes[Math.max(0, best - 1)] + 1e-12);
  const y1 = Math.log(magnitudes[best] + 1e-12);
  const y2 = Math.log(magnitudes[Math.min(magnitudes.length - 1, best + 1)] + 1e-12);
  const denom = y0 - 2 * y1 + y2;
  const delta = denom === 0 ? 0 : Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / denom));
  return { freq: (best + delta) * binHz, magnitude: magnitudes[best], binHz, bin: best };
}

/** 谱心（Hz）：亮度代理。力度→亮度映射的判据。 */
export function spectralCentroid(samples, {
  sampleRate = SAMPLE_RATE, fftSize = 16384, windowSec = 0.19, minHz = 20,
} = {}) {
  const { magnitudes, binHz } = magnitudeSpectrum(samples, { sampleRate, fftSize, windowSec });
  let num = 0;
  let den = 0;
  const lo = Math.max(1, Math.ceil(minHz / binHz));
  for (let k = lo; k < magnitudes.length; k++) {
    num += magnitudes[k] * (k * binHz);
    den += magnitudes[k];
  }
  return den === 0 ? 0 : num / den;
}
