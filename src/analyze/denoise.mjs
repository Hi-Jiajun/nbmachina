// M3-8 · 谱减法降噪（Berouti 式过减 + 谱底保留）：比 ffmpeg 的 afftdn 更可控
//
// 为什么自己写：afftdn 只有"整体降多少 dB"一个旋钮，实测 tn=0/nr=8 时
// 9–16kHz 的嘶声能降 4.8dB，但 **120–1200Hz 的室内/编码噪声一点没动**（17.1→17.3），
// 而用户听到的"还有底噪"主要就在中低频。谱减法可以：① 每根频点各自估噪声底（min-statistics）；
// ② 用**过减系数**把噪声压到谱底以下；③ 设**谱底**（每频点最多衰多少 dB）避免把琴声削空。
import { fftInPlace, hannWindow } from './dsp.mjs';

/**
 * @param {Float64Array} samples 单声道
 * @param {object} [opts]
 * @param {number} [opts.fftSize] 窗长（2048 ≈ 46ms；越小越能跟瞬态，越大频率分辨率越好）
 * @param {number} [opts.oversub] 过减系数（1.0 = 经典谱减；1.5–2.5 更狠）
 * @param {number} [opts.floorDb] 谱底：每频点最多衰减这么多 dB（-20 = 留 10% 幅度）
 * @param {number} [opts.noisePct] 噪声底估计用"每频点第几百分位"（钢琴录音里每根频点都会在某个时刻落到噪声底）
 */
export function spectralDenoise(samples, {
  sampleRate = 44100, fftSize = 2048, oversub = 2.0, floorDb = -22, noisePct = 0.04,
  mode = 'wiener',   // 'wiener' = g = p²/(p² + o·n²)（保留更多音乐）；'subtract' = 经典谱减
  noiseWindow = null, // {startSec, endSec}：用这一段**纯噪声**的频谱当 profile（Audacity/sox 的做法），
                      // 比"分位数盲估"准确得多 —— 盲估会被琴声污染（实测音乐损失≈噪声下降）。
  // M3-8b：非平稳模式（等价 noisereduce 的 non-stationary 思路）——噪声不再是一个固定 profile，
  // 而是**每根频点各自的时间轨迹**：取滑动窗内的最小值（窗口内该频点最安静的瞬间≈噪声），
  // 再乘 margin 当噪声估计。这样"和琴声一起出现、随时间变化的噪声"才估得准（用户反馈：
  // profile 法在尾声有效，但在弱奏句'还不够'）。
  // ⚠️ 听感判负（2026-09-14，用户：'二级比一级更糟糕'）：slidingMin（等价 noisereduce 非平稳思路）虽然能把安静段噪声再降 11dB，但会带来比一级更差的听感伪影 —— 默认不启用，只作研究留档。
  noiseMode = 'profile',   // 'profile'（默认，已过听感）| 'slidingMin'（未过听感）
  minWinSec = 1.5,
  minMargin = 1.4,
} = {}) {
  const hop = fftSize >> 2;                       // 75% 重叠（Hann 满足 COLA）
  const win = hannWindow(fftSize);
  const nFrames = Math.max(1, Math.ceil((samples.length - fftSize) / hop) + 1);
  const binCount = fftSize / 2 + 1;

  // ---- ① 正变换，保留复数谱
  const re = new Float64Array(nFrames * binCount);
  const im = new Float64Array(nFrames * binCount);
  const mags = new Float64Array(nFrames * binCount);
  for (let f = 0; f < nFrames; f++) {
    const off = f * hop;
    const r = new Float64Array(fftSize);
    const i = new Float64Array(fftSize);
    for (let k = 0; k < fftSize; k++) r[k] = (samples[off + k] ?? 0) * win[k];
    fftInPlace(r, i);
    for (let b = 0; b < binCount; b++) {
      re[f * binCount + b] = r[b];
      im[f * binCount + b] = i[b];
      mags[f * binCount + b] = Math.hypot(r[b], i[b]);
    }
  }

  // ---- ② 每根频点的噪声底：优先用给定的纯噪声窗（profile），否则退回分位数盲估
  const noise = new Float64Array(binCount);
  const magsNoise = new Float64Array(nFrames * binCount);
  const col = new Float64Array(nFrames);
  if (noiseMode === 'slidingMin') {
    const half = Math.max(1, Math.round(minWinSec / 2 / (hop / sampleRate)));
    const colOut = new Float64Array(nFrames);   // ⚠️ 必须双缓冲：原地覆写会让"前一个帧的结果"
                                                // 被后一个帧当成原始值读 → 最小值一路衰减到 0 → 掩码恒 1（实测各档参数输出完全相同）
    for (let b = 0; b < binCount; b++) {
      for (let f = 0; f < nFrames; f++) col[f] = mags[f * binCount + b];
      for (let f = 0; f < nFrames; f++) {
        let lo = Infinity;
        const f0 = Math.max(0, f - half);
        const f1 = Math.min(nFrames - 1, f + half);
        for (let g = f0; g <= f1; g++) if (col[g] < lo) lo = col[g];
        colOut[f] = lo * minMargin;
      }
      for (let f = 0; f < nFrames; f++) magsNoise[f * binCount + b] = colOut[f];
    }
  } else if (noiseWindow) {
    const f0 = Math.max(0, Math.floor((noiseWindow.startSec * sampleRate) / hop));
    const f1 = Math.min(nFrames - 1, Math.ceil((noiseWindow.endSec * sampleRate) / hop));
    const cnt = Math.max(1, f1 - f0 + 1);
    for (let b = 0; b < binCount; b++) {
      let acc = 0;
      for (let f = f0; f <= f1; f++) acc += mags[f * binCount + b];
      noise[b] = acc / cnt;
    }
  } else {
    for (let b = 0; b < binCount; b++) {
      for (let f = 0; f < nFrames; f++) col[f] = mags[f * binCount + b];
      const sorted = Float64Array.from(col).sort();
      noise[b] = sorted[Math.floor(nFrames * noisePct)] ?? 0;
    }
  }

  // ---- ③ 逐帧逐频点算增益并做反变换
  const out = new Float64Array(samples.length + fftSize);
  const floor = 10 ** (floorDb / 20);
  const norm = new Float64Array(samples.length + fftSize);
  for (let f = 0; f < nFrames; f++) {
    const r = new Float64Array(fftSize);
    const i = new Float64Array(fftSize);
    for (let b = 0; b < binCount; b++) {
      const p = mags[f * binCount + b];
      const n = noiseMode === 'slidingMin' ? magsNoise[f * binCount + b] : noise[b];
      const g = mode === 'wiener'
        ? Math.min(1, Math.max(floor, (p * p) / (p * p + oversub * n * n + 1e-20)))
        : Math.min(1, Math.max(floor, 1 - oversub * (n / (p + 1e-12))));
      r[b] = re[f * binCount + b] * g;
      i[b] = im[f * binCount + b] * g;
      if (b > 0 && b < fftSize / 2) {           // 对称补回共轭，保证反变换是实数
        r[fftSize - b] = r[b];
        i[fftSize - b] = -i[b];
      }
    }
    // 反变换：不假设 fftInPlace 的缩放/符号约定 —— 用"共轭 → 前向 FFT → 共轭 → /N"的标准等价式。
    // （第一版直接对共轭对称谱再调一次 fftInPlace，实测重建有 5–8dB 的频带失真：增益全 1 时
    //   输出也不等于输入 —— 这正是"越调越糟"的根因。）
    for (let k = 0; k < fftSize; k++) i[k] = -i[k];
    fftInPlace(r, i);
    for (let k = 0; k < fftSize; k++) i[k] = -i[k];
    const off = f * hop;
    for (let k = 0; k < fftSize; k++) {
      out[off + k] += r[k] / fftSize;
      norm[off + k] += win[k];
    }
  }
  const res = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) res[i] = norm[i] > 1e-6 ? out[i] / norm[i] : samples[i];
  return res;
}


