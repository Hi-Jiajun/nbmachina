// M1-3 · 分频带多分辨率谱通量起音检测器
//
// 要打掉的现状（M0-3 §3.1 / BASELINE §3.3）：`score.mjs` 原先的检测器是**单带**的——
// 60Hz–8kHz 全部谱 bins 的对数幅度正通量求和，再用"全局阈值 + 自适应局部阈值"取峰。
// 在密集 16 分格段落里，低音的强攻击把整条通量曲线的局部均值抬起来，旋律的相邻攻击
// 就够不到 1.5× 局部均值 → 相邻音被并成一个峰 → 谱面起音 recall 只有 0.805
// （谱面 1821 个起音 vs 音频 1481 个检出，容差 50ms）。
//
// 本模块的做法（三条，每条都有实测依据，见 docs/M1-3-report.md）：
//   ① **分频带**：≥4 个（默认 6 个）频带各自算对数谱通量，各自取峰——一个带里的强音
//      不再压制另一个带的峰。逐带通量按自身最大值归一化，突出度 = 峰 / 带内局部均值。
//   ② **多分辨率**：每条带有自己的分析窗长与帧率（默认低频加窗更长、帧率 20ms，
//      高频帧率 5ms）。实测：窗长决定"通量峰相对真实起音提前多少"（见下），
//      **混用窗长会让各带在 50ms 容差里互相错位**（实测 recall 0.79 vs 同窗 0.95），
//      所以默认 profile 用同一个窗长（2048 点 ≈ 46ms）+ 逐带帧率，把分辨率差异放在时间维。
//   ③ **延迟补偿**：加窗通量的峰出现在真实起音**之前**（冲击进入 Hann 窗的上升段时通量增量最大）。
//      合成点击实测：6ms 窗 −2.4ms、23ms 窗 −14.6ms、46ms 窗 −32.5ms ≈ 0.5–0.7 × 窗长。
//      所以每带按 `time = 帧号 × 帧长 + latencyFactor × 窗长` 补偿（默认 0.5）。
//
// 一个起音要被**至少 minBands 个带**在同一时刻（≤ mergeSec）看到，且最强带的突出度
// ≥ minPeakProminence、局部混音 RMS ≥ minRms，才输出。这三道闸门是精度闸（实测精度 0.975）。
import fs from 'node:fs';

import { fftInPlace, hannWindow, readWav, rmsOf, sliceWindow } from './dsp.mjs';
import { resolvePaths } from '../core/paths.mjs';

/** 默认频带：一条带 ≈ 一个倍频程；帧率低频 20ms / 中频 10ms / 高频 5ms（多分辨率） */
export const DEFAULT_ONSET_BANDS = [
  { name: 'b1', loHz: 60, hiHz: 125, hopSec: 0.02 },
  { name: 'b2', loHz: 125, hiHz: 260, hopSec: 0.02 },
  { name: 'b3', loHz: 260, hiHz: 540, hopSec: 0.01 },
  { name: 'b4', loHz: 540, hiHz: 1100, hopSec: 0.01 },
  { name: 'b5', loHz: 1100, hiHz: 2200, hopSec: 0.005 },
  { name: 'b6', loHz: 2200, hiHz: 6000, hopSec: 0.005 },
];

export const DEFAULT_ONSET_DETECT_CONFIG = {
  bands: DEFAULT_ONSET_BANDS,
  frameSize: 2048,          // 44.1kHz → 46.4ms；逐带可用 frameSize 覆盖（多分辨率）
  hopSec: 0.01,             // 逐带未给 hopSec 时的默认帧长
  promWindowSec: 0.1,       // 突出度 = 峰 / ±100ms 局部均值（逐带换算成帧数）
  latencyFactor: 0.5,       // 通量峰提前量 ≈ 0.5 × 窗长（合成点击实测 0.5–0.7）
  minProminence: 1.2,       // 逐带入选：峰至少是局部均值的 1.2 倍
  minSepSec: 0.05,          // 逐带最小起音间隔
  mergeSec: 0.035,          // 跨带合并窗口（同一起音被多个带看到）
  minBands: 3,              // 一个起音至少要被 3 个带看到
  minPeakProminence: 4,     // 最强带的突出度门槛
  minStrength: 0.1,         // 最强带的归一化通量门槛（该带全曲最大值 = 1）
  // 备用通道：不止靠"单带突出度"，"多个带同时看到一个不弱但不出挑的通量峰"也算证据。
  // 依据：慢起振/弱攻击（钢琴弱奏、弦乐）在 ±100ms 局部均值里抬不起 4 倍突出度，
  // 但会同时出现在 ≥5 个带上且归一化通量不低（实测见 docs/M1-3-report.md §3.6）。
  altBands: 5,              // 备用通道要求的带数
  altStrength: 0.5,         // 备用通道要求的归一化通量
  minRms: 0.02,             // 起音处的局部混音 RMS 地板（挡静音/底噪里的假峰）
  rmsWindowSec: 0.023,
  clusterRef: 'first',      // 合并时以簇内第一个峰为时间基准（避免链式合并出长簇）
  spectralSmoothFrames: 1,  // 差分前对幅度谱做 k 帧移动平均（1 = 不平滑）；抗"相邻音衰减尾巴互相拍频"造成的通量抖动
};

const isPow2 = (n) => n > 0 && (n & (n - 1)) === 0;
const nextPow2 = (n) => {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
};

/** 频带配置归一化：定下窗长（采样点）、跳步（采样点）、帧长（秒） */
export function normalizeBands({ bands = DEFAULT_ONSET_BANDS, frameSize = 2048, hopSec = 0.01, sampleRate }) {
  if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new Error('sampleRate 必须是正数');
  return bands.map((b, i) => {
    const name = b.name ?? `b${i + 1}`;
    if (!(b.hiHz > b.loHz)) throw new Error(`频带 ${name} 需要 hiHz > loHz（收到 ${b.loHz}..${b.hiHz}）`);
    let fs2 = Math.round(b.frameSize ?? frameSize);
    if (!isPow2(fs2)) fs2 = nextPow2(fs2);
    const hop = Math.max(1, Math.round((b.hopSec ?? hopSec) * sampleRate));
    return {
      name,
      loHz: b.loHz,
      hiHz: b.hiHz,
      frameSize: fs2,
      hop,
      hopSec: hop / sampleRate,
      frameSec: fs2 / sampleRate,
      latencyFactor: b.latencyFactor ?? null,   // 逐带覆盖（异窗时的标定值）
    };
  });
}

/** 逐带对数谱通量（按自身最大值归一化）+ 突出度序列 */
export function bandFluxes({ samples, sampleRate, config = {} }) {
  const cfg = { ...DEFAULT_ONSET_DETECT_CONFIG, ...config };
  const bands = normalizeBands({ bands: cfg.bands, frameSize: cfg.frameSize, hopSec: cfg.hopSec, sampleRate });

  const groups = new Map();
  for (const b of bands) {
    const key = `${b.frameSize}|${b.hop}`;
    if (!groups.has(key)) groups.set(key, { frameSize: b.frameSize, hop: b.hop, bands: [] });
    groups.get(key).bands.push(b);
  }

  const out = [];
  for (const group of groups.values()) {
    const { frameSize, hop } = group;
    const win = hannWindow(frameSize);
    const binHz = sampleRate / frameSize;
    const ranges = group.bands.map((b) => {
      const kLo = Math.max(1, Math.ceil(b.loHz / binHz));
      const kHi = Math.min(frameSize / 2 - 1, Math.floor(b.hiHz / binHz));
      return { kLo, kHi, n: Math.max(1, kHi - kLo + 1) };
    });
    const frames = samples.length > frameSize ? Math.floor((samples.length - frameSize) / hop) + 1 : 0;
    const flux = group.bands.map(() => new Float64Array(frames));
    const re = new Float64Array(frameSize);
    const im = new Float64Array(frameSize);
    let prev = ranges.map((r) => new Float64Array(r.n));
    const smoothK = Math.max(1, Math.round(cfg.spectralSmoothFrames));
    // 平滑缓冲：每带保留最近 smoothK 帧的幅度谱（用于差分前的移动平均）
    const ring = ranges.map((r) => Array.from({ length: smoothK }, () => new Float64Array(r.n)));
    const ringSum = ranges.map((r) => new Float64Array(r.n));
    for (let fi = 0; fi < frames; fi++) {
      const start = fi * hop;
      for (let i = 0; i < frameSize; i++) {
        re[i] = samples[start + i] * win[i];
        im[i] = 0;
      }
      fftInPlace(re, im);
      for (let bi = 0; bi < group.bands.length; bi++) {
        const { kLo, n } = ranges[bi];
        const slot = fi % smoothK;
        const mag = ring[bi][slot];
        const sum = ringSum[bi];
        for (let k = 0; k < n; k++) {
          sum[k] -= mag[k];
          mag[k] = Math.log1p(Math.hypot(re[kLo + k], im[kLo + k]));
          sum[k] += mag[k];
        }
        const inv = 1 / Math.min(smoothK, fi + 1);
        let fluxSum = 0;
        for (let k = 0; k < n; k++) {
          const s = sum[k] * inv;                    // 差分前先做 k 帧移动平均（k=1 时即原口径）
          const d = s - prev[bi][k];
          if (d > 0) fluxSum += d;
          prev[bi][k] = s;
        }
        flux[bi][fi] = fluxSum;
      }
    }
    group.bands.forEach((b, bi) => {
      const f = flux[bi];
      let max = 0;
      for (const v of f) max = Math.max(max, v);
      const norm = max > 0 ? f.map((v) => v / max) : f;
      const promW = Math.max(1, Math.round((b.promWindowSec ?? cfg.promWindowSec) / b.hopSec));
      const prom = new Float64Array(frames);
      for (let i = 1; i < frames - 1; i++) {
        const lo = Math.max(0, i - promW);
        const hi = Math.min(frames - 1, i + promW);
        let sum = 0;
        for (let j = lo; j <= hi; j++) sum += norm[j];
        const mean = sum / (hi - lo + 1);
        prom[i] = mean > 0 ? norm[i] / mean : 0;
      }
      out.push({
        name: b.name,
        loHz: b.loHz,
        hiHz: b.hiHz,
        frameSize: b.frameSize,
        frameSec: b.frameSec,
        hopSec: b.hopSec,
        latencyFactor: b.latencyFactor ?? cfg.latencyFactor,
        bins: ranges[bi].n,
        frames,
        flux: norm,
        prom,
      });
    });
  }
  return out;
}

/** 单带取峰：局部极大 + 突出度门槛 + 最小间隔；时间按窗长补偿 */
export function pickBandPeaks(band, config = {}) {
  const cfg = { ...DEFAULT_ONSET_DETECT_CONFIG, ...config };
  const { flux, prom } = band;
  const latency = (band.latencyFactor ?? cfg.latencyFactor) * band.frameSec;
  const peaks = [];
  let lastT = -Infinity;
  for (let i = 1; i < band.frames - 1; i++) {
    if (!(flux[i] >= flux[i - 1] && flux[i] > flux[i + 1])) continue;
    if (prom[i] < cfg.minProminence) continue;
    const t = i * band.hopSec + latency;
    if (t - lastT < cfg.minSepSec) continue;
    peaks.push({ time: Number(t.toFixed(5)), band: band.name, strength: Number(flux[i].toFixed(6)), prominence: Number(prom[i].toFixed(4)) });
    lastT = t;
  }
  return peaks;
}

/** 跨带合并：时间相近（≤ mergeSec）的峰算同一次攻击 */
export function mergeBandPeaks(peaks, { mergeSec = DEFAULT_ONSET_DETECT_CONFIG.mergeSec, clusterRef = 'first' } = {}) {
  const sorted = [...peaks].sort((a, b) => a.time - b.time);
  const clusters = [];
  for (const p of sorted) {
    const last = clusters[clusters.length - 1];
    const ref = last ? (clusterRef === 'first' ? last.members[0].time : last.members[last.members.length - 1].time) : -Infinity;
    if (last && p.time - ref <= mergeSec) {
      last.members.push(p);
      if (p.prominence > last.bestProm) {
        last.bestProm = p.prominence;
        last.time = p.time;                    // 簇的时间取"最强带"的峰时刻
      }
      last.prominence = Math.max(last.prominence, p.prominence);
      if (p.strength > last.strength) last.strength = p.strength;
      continue;
    }
    clusters.push({
      time: p.time,
      strength: p.strength,
      prominence: p.prominence,
      bestProm: p.prominence,
      bands: [p.band],
      members: [p],
    });
  }
  for (const c of clusters) c.bands = [...new Set(c.members.map((m) => m.band))];
  return clusters;
}

/**
 * 分频带多分辨率起音检测（本模块的主入口）。
 * @returns {{times: number[], onsets: Array, peaks: Array, bands: Array, envelope: object, meta: object}}
 */
export function detectBandOnsets({ samples, sampleRate, config = {} }) {
  const cfg = { ...DEFAULT_ONSET_DETECT_CONFIG, ...config };
  const bands = bandFluxes({ samples, sampleRate, config: cfg });
  const peaks = [];
  for (const b of bands) peaks.push(...pickBandPeaks(b, cfg));
  const clusters = mergeBandPeaks(peaks, { mergeSec: cfg.mergeSec, clusterRef: cfg.clusterRef });

  const rmsWin = Math.max(16, Math.round(cfg.rmsWindowSec * sampleRate));
  const onsets = [];
  const rejected = { fewBands: 0, weakPeak: 0, faint: 0, quiet: 0 };
  for (const c of clusters) {
    if (c.bands.length < cfg.minBands) {
      rejected.fewBands++;
      continue;
    }
    const strongByAgreement = c.bands.length >= cfg.altBands && c.strength >= cfg.altStrength;
    if (c.prominence < cfg.minPeakProminence && !strongByAgreement) {
      rejected.weakPeak++;
      continue;
    }
    if (c.strength < cfg.minStrength) {
      rejected.faint++;
      continue;
    }
    const rms = rmsOf(sliceWindow(samples, Math.round(c.time * sampleRate), rmsWin));
    if (rms < cfg.minRms) {
      rejected.quiet++;
      continue;
    }
    onsets.push({
      time: Number(c.time.toFixed(4)),
      bands: c.bands,
      nBands: c.bands.length,
      strength: c.strength,
      prominence: c.prominence,
      evidence: c.members
        .map((m) => ({ band: m.band, strength: m.strength, prominence: m.prominence }))
        .sort((a, b) => b.prominence - a.prominence),
      rms: Number(rms.toFixed(6)),
      members: c.members,
    });
  }
  onsets.sort((a, b) => a.time - b.time);

  return {
    times: onsets.map((o) => o.time),
    onsets,
    peaks,
    bands: bands.map((b) => ({
      name: b.name, loHz: b.loHz, hiHz: b.hiHz, frameSize: b.frameSize,
      frameSec: b.frameSec, hopSec: b.hopSec, bins: b.bins, frames: b.frames,
    })),
    envelope: bandEnvelope({ bands, hopSec: 0.01 }),
    meta: {
      sampleRate,
      seconds: Number((samples.length / sampleRate).toFixed(3)),
      onsetBands: bands.length,
      peaks: peaks.length,
      clusters: clusters.length,
      onsets: onsets.length,
      rejected,
      config: {
        frameSize: cfg.frameSize,
        latencyFactor: cfg.latencyFactor,
        minProminence: cfg.minProminence,
        mergeSec: cfg.mergeSec,
        minBands: cfg.minBands,
        minPeakProminence: cfg.minPeakProminence,
        minStrength: cfg.minStrength,
        altBands: cfg.altBands,
        altStrength: cfg.altStrength,
        minRms: cfg.minRms,
        bands: bands.map((b) => `${b.name}:${b.loHz}-${b.hiHz}Hz@${(b.hopSec * 1000).toFixed(0)}ms/${b.frameSize}`),
      },
    },
  };
}

/** 别名：语义上强调"分频带"，API 与 detectBandOnsets 相同 */
export const detectOnsetsBanded = detectBandOnsets;

/**
 * 宽带起音强度包络（把所有带的归一化通量搬到同一 10ms 栅格上相加）。
 * score.mjs 的"力度 vs 起音强度"诊断要一条宽带包络——分频带路径没有单带包络，
 * 用这条代替（只用于诊断，不参与打分）。
 */
export function bandEnvelope({ bands, hopSec = 0.01 }) {
  let frames = 0;
  for (const b of bands) frames = Math.max(frames, Math.round(((b.frames - 1) * b.hopSec) / hopSec) + 1);
  const flux = new Float64Array(frames);
  for (const b of bands) {
    const ratio = hopSec / b.hopSec;
    for (let j = 0; j < frames; j++) {
      const i = Math.min(b.frames - 1, Math.max(0, Math.round(j * ratio)));
      flux[j] += b.flux[i];
    }
  }
  let max = 0;
  for (const v of flux) max = Math.max(max, v);
  if (max > 0) for (let i = 0; i < flux.length; i++) flux[i] /= max;
  return { flux, hopSec, frames, frameSec: bands[0]?.frameSec ?? 0, banded: true };
}

/* ------------------------------------------------- 对照：现有单带检测器 */

/**
 * 窗长 → 通量峰提前量的实测标定（`--calibrate`）。
 *
 * 合成一段"钢琴式点击"（基频 + 2/3 次谐波、10ms 起振、0.3s 指数衰减、间隔 0.5s），
 * 对每个窗长取该宽带通量，再对每颗真值在 ±150ms 内找最强峰并走到局部极大，
 * 统计"峰时刻 − 真值"的中位数。这就是 `latencyFactor` 的来源：
 * 46ms 窗实测约 −32ms（≈ −0.7×窗长），默认取 0.5×窗长（0.4–0.6 三档在真实数据上等价，见报告 §3.6）。
 */
export function calibrateLatency({
  sampleRate = 44100,
  frameSizes = [256, 512, 1024, 2048, 4096, 8192],
  clicks = 20,
  spacingSec = 0.5,
  loHz = 55,
  hiHz = 5000,
} = {}) {
  const n = Math.round((clicks * spacingSec + 0.6) * sampleRate);
  const samples = new Float64Array(n);
  let seed = 5;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed / 4294967296) * 2 - 1;
  };
  for (let i = 0; i < n; i++) samples[i] = rnd() * 0.002;
  const truth = [];
  for (let c = 0; c < clicks; c++) {
    const start = Math.round((0.3 + c * spacingSec) * sampleRate);
    truth.push(start / sampleRate);
    const f0 = 523.251;
    for (let k = 0; k < Math.round(0.45 * sampleRate); k++) {
      const idx = start + k;
      if (idx >= n) break;
      const t = k / sampleRate;
      const env = Math.min(1, k / (0.01 * sampleRate)) * Math.exp(-t / 0.3);
      let v = 0;
      for (let h = 1; h <= 3; h++) v += (1 / h) * Math.sin(2 * Math.PI * f0 * h * t);
      samples[idx] += 0.25 * v * env;
    }
  }
  const rows = frameSizes.map((frameSize) => {
    const hop = Math.max(1, Math.round(frameSize / 4));
    const [band] = bandFluxes({
      samples,
      sampleRate,
      config: { bands: [{ name: 'all', loHz, hiHz, frameSize, hopSec: hop / sampleRate }], promWindowSec: 0.1, latencyFactor: 0 },
    });
    const offs = [];
    for (const t0 of truth) {
      const lo = Math.max(1, Math.floor((t0 - 0.15) / band.hopSec));
      const hi = Math.min(band.frames - 2, Math.ceil((t0 + 0.15) / band.hopSec));
      let best = lo;
      for (let i = lo; i <= hi; i++) if (band.flux[i] > band.flux[best]) best = i;
      while (best + 1 <= hi && band.flux[best + 1] > band.flux[best]) best++;
      while (best - 1 >= lo && band.flux[best - 1] > band.flux[best]) best--;
      offs.push(best * band.hopSec - t0);
    }
    offs.sort((a, b) => a - b);
    const medianMs = 1000 * offs[Math.floor(offs.length / 2)];
    const meanMs = (1000 * offs.reduce((a, b) => a + b, 0)) / offs.length;
    const sdMs = Math.sqrt(offs.reduce((a, b) => a + (1000 * b - meanMs) ** 2, 0) / offs.length);
    return {
      frameSize,
      frameSec: frameSize / sampleRate,
      hopSec: band.hopSec,
      meanMs: Number(meanMs.toFixed(1)),
      medianMs: Number(medianMs.toFixed(1)),
      sdMs: Number(sdMs.toFixed(1)),
      quarterWindowMs: Number(((1000 * frameSize) / (4 * sampleRate)).toFixed(1)),
      ratioToWindow: Number((-medianMs / ((1000 * frameSize) / sampleRate)).toFixed(3)),
      withinTolerance: offs.filter((o) => Math.abs(1000 * o) <= 50).length,
      clicks,
    };
  });
  return { rows, sampleRate, clicks, spacingSec };
}

/**
 * 现有检测器（M0 T6，`score.mjs` 原实现）原样搬到这里，作为对照口径：
 * 单带 1024 点 / 10ms 帧长 / 对数谱通量，全局阈值（均值 + globalSigma×σ）+
 * 自适应局部阈值（≥ localDelta × ±300ms 局部均值）+ 50ms 最小间隔。
 * 时间**不做**窗长补偿（M0 口径如此，改了就不再是同一把尺子）。
 */
export function legacyOnsets({ samples, sampleRate, config = {} }) {
  const cfg = {
    frameSize: 1024,
    hop: Math.round(0.01 * sampleRate),
    fminHz: 60,
    fmaxHz: 8000,
    globalSigma: 0.5,
    localMeanWindow: 30,
    localDelta: 1.5,
    minSepSec: 0.05,
    ...config,
  };
  const win = hannWindow(cfg.frameSize);
  const binHz = sampleRate / cfg.frameSize;
  const kLo = Math.max(1, Math.ceil(cfg.fminHz / binHz));
  const kHi = Math.min(cfg.frameSize / 2 - 1, Math.floor(cfg.fmaxHz / binHz));
  const nBins = kHi - kLo + 1;
  const frames = samples.length > cfg.frameSize ? Math.floor((samples.length - cfg.frameSize) / cfg.hop) + 1 : 0;
  const flux = new Float64Array(frames);
  const re = new Float64Array(cfg.frameSize);
  const im = new Float64Array(cfg.frameSize);
  let prev = new Float64Array(nBins);
  for (let fi = 0; fi < frames; fi++) {
    const start = fi * cfg.hop;
    for (let i = 0; i < cfg.frameSize; i++) {
      re[i] = samples[start + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const mag = new Float64Array(nBins);
    let sum = 0;
    for (let k = 0; k < nBins; k++) {
      mag[k] = Math.log1p(Math.hypot(re[kLo + k], im[kLo + k]));
      const d = mag[k] - prev[k];
      if (d > 0) sum += d;
    }
    flux[fi] = sum;
    prev = mag;
  }
  let max = 0;
  for (const v of flux) max = Math.max(max, v);
  if (max > 0) for (let i = 0; i < flux.length; i++) flux[i] /= max;

  const hopSec = cfg.hop / sampleRate;
  const env = { flux, hopSec, frameSec: cfg.frameSize / sampleRate, frames, config: cfg };
  const times = [];
  if (frames === 0) return { times, env, globalThreshold: 0, mean: 0, std: 0 };
  let mean = 0;
  for (const v of flux) mean += v;
  mean /= frames;
  let variance = 0;
  for (const v of flux) variance += (v - mean) * (v - mean);
  const std = Math.sqrt(variance / frames);
  const globalThreshold = mean + cfg.globalSigma * std;
  let lastT = -Infinity;
  for (let i = 1; i < frames - 1; i++) {
    if (flux[i] <= globalThreshold) continue;
    if (!(flux[i] >= flux[i - 1] && flux[i] > flux[i + 1])) continue;
    const lo = Math.max(0, i - cfg.localMeanWindow);
    const hi = Math.min(frames - 1, i + cfg.localMeanWindow);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += flux[j];
    if (flux[i] < (sum / (hi - lo + 1)) * cfg.localDelta) continue;
    const t = i * hopSec;
    if (t - lastT < cfg.minSepSec) continue;
    times.push(Number(t.toFixed(4)));
    lastT = t;
  }
  return { times, env, globalThreshold, mean, std };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/analyze/onset-detect.mjs');

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const P = resolvePaths({ argv });
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const audioPath = args.audio ?? P.audio;
  const outPath = typeof args.out === 'string' ? args.out : null;
  const tolSec = Number(args.tol ?? 0.05);
  const notesPath = typeof args.notes === 'string' ? args.notes : null;

  if (args.calibrate) {
    const cal = calibrateLatency({ sampleRate: 44100 });
    console.log('窗长 → 通量峰提前量标定（合成钢琴式点击，间隔 0.5s）');
    console.log('  窗长(ms)  帧长(ms)  峰−真值 均值 / 中位 / 标准差 (ms)   窗长/4   提前量/窗长   ≤50ms 命中');
    for (const r of cal.rows) {
      console.log(`  ${String((1000 * r.frameSec).toFixed(0)).padStart(7)} ${String((1000 * r.hopSec).toFixed(1)).padStart(9)}`
        + `  ${String(r.meanMs).padStart(7)} / ${String(r.medianMs).padStart(6)} / ${String(r.sdMs).padStart(6)}`
        + `${String(r.quarterWindowMs).padStart(10)}${String(r.ratioToWindow).padStart(12)}`
        + `${String(`${r.withinTolerance}/${r.clicks}`).padStart(12)}`);
    }
    console.log('  读法：负值 = 通量峰比真实起音**提前**；默认 latencyFactor=0.5 就是按"提前量 ≈ 0.5–0.7×窗长"补的。');
    process.exit(0);
  }

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(audioPath);
  const result = detectBandOnsets({ samples, sampleRate });
  const dt = ((Date.now() - t0) / 1000).toFixed(1);

  console.log(`分频带起音检测：${audioPath}（${seconds.toFixed(1)}s，${sampleRate}Hz）`);
  for (const b of result.bands) {
    console.log(`  带 ${b.name.padEnd(3)} ${String(b.loHz).padStart(5)}–${String(b.hiHz).padEnd(5)}Hz`
      + ` 窗 ${(1000 * b.frameSec).toFixed(1)}ms 帧长 ${(1000 * b.hopSec).toFixed(1)}ms bins ${String(b.bins).padStart(3)} 帧 ${b.frames}`);
  }
  console.log(`  峰 ${result.meta.peaks} → 簇 ${result.meta.clusters} → 起音 ${result.meta.onsets}`
    + `（带数不足 ${result.meta.rejected.fewBands} / 突出度不足 ${result.meta.rejected.weakPeak} / 太静 ${result.meta.rejected.quiet}）`);
  console.log(`  闸门：带数 ≥${result.meta.config.minBands}｜突出度 ≥${result.meta.config.minPeakProminence}｜RMS ≥${result.meta.config.minRms}`
    + `｜合并 ${(1000 * result.meta.config.mergeSec).toFixed(1)}ms｜窗长补偿 ${result.meta.config.latencyFactor}×窗长`);

  if (notesPath) {
    const chartTimes = [...new Set(fs.readFileSync(notesPath, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => Number(l.split(',')[2])))];
    const legacy = legacyOnsets({ samples, sampleRate });
    const match = (chart, audio) => {
      const c = [...chart].sort((a, b) => a - b);
      const a = [...audio].sort((x, y) => x - y);
      let i = 0;
      let j = 0;
      let matched = 0;
      while (i < c.length && j < a.length) {
        const d = a[j] - c[i];
        if (Math.abs(d) <= tolSec) {
          matched++;
          i++;
          j++;
        } else if (d < 0) j++;
        else i++;
      }
      return { matched, audioN: a.length, mapN: c.length, precision: matched / (a.length || 1), recall: matched / (c.length || 1) };
    };
    const nb = match(chartTimes, result.times);
    const nl = match(chartTimes, legacy.times);
    const f1 = (m) => 2 * m.precision * m.recall / (m.precision + m.recall);
    console.log(`  谱面 ${notesPath}：${nb.mapN} 个起音，容差 ${tolSec * 1000}ms`);
    console.log(`    现有单带检测器：音频 ${nl.audioN}｜匹配 ${nl.matched}｜P ${nl.precision.toFixed(3)} R ${nl.recall.toFixed(3)} F1 ${f1(nl).toFixed(3)}`);
    console.log(`    分频带多分辨率：音频 ${nb.audioN}｜匹配 ${nb.matched}｜P ${nb.precision.toFixed(3)} R ${nb.recall.toFixed(3)} F1 ${f1(nb).toFixed(3)}`);
  }

  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({
      meta: { audioPath, notesPath, ...result.meta },
      bands: result.bands,
      times: result.times,
      onsets: result.onsets.map((o) => ({
        time: o.time, bands: o.bands, nBands: o.nBands, strength: o.strength, prominence: o.prominence, rms: o.rms,
      })),
    }, null, 1) + '\n', 'utf8');
    console.log(`  → ${outPath}`);
  }
  console.log(`  用时 ${dt}s`);
}
