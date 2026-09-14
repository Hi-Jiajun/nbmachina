// M1-4 · 打击乐起音检测（底鼓 / 军鼓 / 踩镲）
//
// 问题的来源：谱面只有 harp + bass 两层，原曲的鼓一点都没有（`docs/DISCUSSION-C-music.md`
// §2.1：鼓与贝斯吉他是"听不出就不像原曲"的那一类）。这一层要把鼓**从音频里**检出来。
//
// 做法（复用 M1-3 的分频带谱通量，不另起一套 DSP）：
//   ① **三类频带各自取峰**：底鼓 40–120Hz（低频能量爆发）、军鼓 150–400Hz（鼓皮 + 噪声性宽带）、
//      踩镲 >6000Hz（高频瞬态）。三条带各自算对数谱通量并按自身最大值归一化（`bandFluxes`），
//      逐带取局部极大 + 突出度门槛（`pickBandPeaks`），再跨带合并到同一个攻击（`mergeBandPeaks`）。
//   ② **判别用"频谱形状"而不是只靠"哪条带的通量大"**：在攻击处取一帧 2048 点 FFT，量
//      五个频段的能量占比（low 40–120 / mid 150–400 / body 400–1500 / upper 1500–6000 /
//      high 6000–16000）、150–6000Hz 的**谱平坦度**（噪声性，军鼓的判别特征）与谱重心。
//      ——三条带里两条在真实混音里会互相串（贝斯的低音攻击会点亮 40–120 带，
//      人声/弦乐的高频泛音会点亮 >6kHz 带），所以"哪条带看到"只作为**一项**证据，
//      与频谱形状一起算三个类别的分数，取最高者（并给出 margin，便于报告里复核）。
//   ③ **闸门**：突出度（局部均值倍数）、带内归一化通量、攻击处混音 RMS 三道，
//      防止底噪/衰减尾巴刷出候选（与 M1-3 同款口径，参数见 DEFAULT_DRUM_CONFIG）。
//
// 口径的诚实边界（写进 docs/M1-4-report.md）：
//   · 这是**整段混音**上的检测，没有分轨。底鼓与同时发声的贝斯在同一频段（40–120Hz）无法分离，
//     因此"检出的底鼓"里必然混有低音音符的攻击——报告里给出"与谱面低音音同时刻重合"的比例。
//   · 分类准确率只能在**自己合成的**三类样本上给出（≥90%，见 tests/drums.test.mjs）；
//     真实数据只报告检出数量与对齐误差，不谎称准确率。
import fs from 'node:fs';

import { fftInPlace, hannWindow, readWav, rmsOf, sliceWindow } from './dsp.mjs';
import { bandFluxes, mergeBandPeaks, pickBandPeaks } from './onset-detect.mjs';
import { resolvePaths } from '../core/paths.mjs';

export const PERCUSSION_KINDS = ['kick', 'snare', 'hat'];

/** 三类打击乐的检测频带（一条带 ≈ 该乐器的能量集中区；帧率 5ms 抓瞬态） */
export const DEFAULT_DRUM_BANDS = [
  { name: 'kick', loHz: 40, hiHz: 120, hopSec: 0.005 },
  { name: 'snare', loHz: 150, hiHz: 400, hopSec: 0.005 },
  { name: 'hat', loHz: 6000, hiHz: 16000, hopSec: 0.005 },
];

/** 判别用的五个频段（占比之和 = 1） */
export const FEATURE_RANGES = [
  { key: 'low', loHz: 40, hiHz: 120 },
  { key: 'mid', loHz: 150, hiHz: 400 },
  { key: 'body', loHz: 400, hiHz: 1500 },
  { key: 'upper', loHz: 1500, hiHz: 6000 },
  { key: 'high', loHz: 6000, hiHz: 16000 },
];

export const DEFAULT_DRUM_CONFIG = {
  bands: DEFAULT_DRUM_BANDS,
  // 46.4ms @44.1kHz。**不能更短**：40–120Hz 这条带在 1024 点（bin=43Hz）下只剩 2 个 bin
  // （86–107Hz），底鼓 45–60Hz 的基频直接落在带外 → 检测到的是"80Hz 以上的那半截"。
  // 2048 点（bin=21.5Hz）下是 4 个 bin（43/65/86/107Hz），这才是 40–120Hz。
  // 代价是时间分辨率变粗（见下面 latencyFactor 的标定），16 分格（0.12s）仍远大于窗长。
  frameSize: 2048,
  hopSec: 0.005,             // 5ms 帧长
  promWindowSec: 0.1,        // 突出度 = 峰 / ±100ms 局部均值
  // 加窗通量峰比真实起音**提前**的量（合成三类鼓点实测，每类 10 次取中位）：
  //   补偿 0.5×窗长 → kick −14.3ms / snare −14.8ms / hat −12.2ms（三类一致，可用同一个系数）
  //   补偿 0.8×窗长 → kick −0.4ms  / snare −0.9ms  / hat +1.7ms  ← 默认值
  //   补偿 0.9×窗长 → kick +4.2ms  / snare +3.8ms  / hat +6.3ms（且有一类开始判错）
  // M1-3 的钢琴点击实测是 0.5–0.7×窗长，这里偏大是因为打击乐的起振更陡、通量峰更靠前。
  latencyFactor: 0.8,
  minProminence: 1.5,        // 单带入选：峰至少是局部均值的 1.5 倍
  // 突出度是**比值**，对"衰减尾巴里的噪声起伏"太宽松：军鼓的 0.09s 噪声衰减里，
  // 随机起伏很容易做到 2–4 倍局部均值（实测合成的军鼓尾巴上有 4–6 个这样的假峰）。
  // 再加一道**绝对**闸门：峰的归一化通量比局部均值高出的**绝对量**（= flux×(1−1/突出度)）。
  //   · 合成样本上"事件数正好 30/30 且分类 100%"的区间是 0.15 ≤ minExcess ≤ 0.45（再往下
  //     噪声尾巴的假峰开始进来：0.1→33 个事件 97%、0.05→51 个 84%、0→69 个 74%），
  //     所以默认取区间中点 0.3。真实数据上的敏感性表见 docs/M1-4-report.md §3.4。
  minExcess: 0.3,
  minSepSec: 0.045,          // 单带最小间隔（一秒钟最多 22 下，够十六分格的镲）
  mergeSec: 0.03,            // 跨带合并：≤30ms 内的峰算同一次攻击
  minStrength: 0.05,         // 归一化通量门槛（该带全曲最大值 = 1）
  minRms: 0.01,              // 攻击处 30ms 窗 RMS 地板（挡静音/底噪里的假峰）
  rmsWindowSec: 0.03,
  featureFrameSize: 2048,    // 46.4ms：判别用的谱窗（比检测窗长，取到足够频率分辨率）
  featurePreRollSec: 0.005,  // 判别窗从"起音前 5ms"开始，保证攻击本体在窗内
  flatnessRange: [150, 6000], // 谱平坦度的统计范围：军鼓噪声落在这里
  flatnessFloorDb: -35,      // 平坦度只统计"高于峰值 35dB"的 bin，避免把噪声底算成噪声性
  flatnessPoints: [0.02, 0.2], // 平坦度 → 0..1 的线性映射（实测底鼓 ≈0.01–0.03、军鼓 ≈0.2–0.5）
  // 三类分数 =（该带看到了攻击）×（频谱形状像该乐器），两项**相乘**而不是相加。
  // 为什么必须相乘（两版实测的教训，见 docs/M1-4-report.md §3）：
  //   · 带内通量是按**每条带自己的最大值**归一化的，所以一条几乎没能量的带（本曲 6–16kHz
  //     只占总能量 0.31%）里，底噪起伏也能拿到接近 1 的通量——只看通量会把噪声判成踩镲。
  //     乘上"高频占比"之后，空带里的假峰分数 ≈ 0。
  //   · 形状项用**同一组三路占比**（低 40–120 / 中 150–1500 / 高 6000–16000，相加 = 1），
  //     而不是"各自加几个频段"：否则军鼓天然占三个频段，分数系统性偏高。
  //   · 噪声性只给军鼓加分（它是军鼓的判别特征）。
  weights: {
    snareMid: 0.6,           // 军鼓形状 = 0.6×中频占比 + 0.4×噪声性
    snareNoise: 0.4,
  },
  // 通量项的幂次：0.5 = 开方（几何平均口径）。形状是主判据，通量只用来回答
  // "这条带**确实**在这一刻看到了攻击吗"；用开方把通量的影响压到一半，
  // 因为带内最大归一化在本曲上不跨带可比（40–120Hz 带被持续的贝斯抬高了底噪：
  // 实测底鼓带通量在事件处的中位数只有 0.121，而军鼓带是 0.469）。
  fluxPower: 0.5,
};

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** 频段 → FFT bin 区间（闭区间，含端点内） */
function binRange(frameSize, sampleRate, loHz, hiHz) {
  const binHz = sampleRate / frameSize;
  const kLo = Math.max(1, Math.ceil(loHz / binHz));
  const kHi = Math.min(frameSize / 2 - 1, Math.floor(hiHz / binHz));
  return { kLo, kHi, n: Math.max(0, kHi - kLo + 1), binHz };
}

/**
 * 攻击处的判别特征：五段能量占比 + 150–6000Hz 谱平坦度 + 谱重心。
 * 单帧 FFT（Hann 窗，起点 = timeSec − preRollSec），不做时间平滑——判别要的是"这一瞬间的形状"。
 *
 * @returns {{energies: object, shares: object, flatness: number, centroidHz: number, rms: number, windowSec: number}}
 */
export function measureDrumFeatures({ samples, sampleRate, timeSec, config = {} }) {
  const cfg = { ...DEFAULT_DRUM_CONFIG, ...config };
  const n = Math.max(16, Math.round(cfg.featureFrameSize));
  const win = hannWindow(n);
  const start = Math.max(0, Math.round((timeSec - cfg.featurePreRollSec) * sampleRate));
  const seg = sliceWindow(samples, start, n);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = seg[i] * win[i];
  fftInPlace(re, im);

  const power = new Float64Array(n / 2);
  for (let k = 0; k < power.length; k++) power[k] = re[k] * re[k] + im[k] * im[k];

  const energies = {};
  let total = 0;
  for (const r of FEATURE_RANGES) {
    const { kLo, kHi } = binRange(n, sampleRate, r.loHz, r.hiHz);
    let e = 0;
    for (let k = kLo; k <= kHi; k++) e += power[k];
    energies[r.key] = e;
    total += e;
  }
  const shares = {};
  for (const r of FEATURE_RANGES) shares[r.key] = total > 0 ? energies[r.key] / total : 0;

  // 谱平坦度（几何平均 / 算术平均），只在"高于峰值 floorDb"的 bin 上统计
  const [flow, fhigh] = cfg.flatnessRange;
  const { kLo, kHi } = binRange(n, sampleRate, flow, fhigh);
  let peak = 0;
  for (let k = kLo; k <= kHi; k++) peak = Math.max(peak, power[k]);
  const keep = [];
  const floor = peak * 10 ** (cfg.flatnessFloorDb / 10);
  for (let k = kLo; k <= kHi; k++) if (power[k] >= floor && power[k] > 0) keep.push(power[k]);
  let flatness = 0;
  if (keep.length > 1) {
    let logSum = 0;
    let sum = 0;
    for (const p of keep) {
      logSum += Math.log(p);
      sum += p;
    }
    flatness = Math.exp(logSum / keep.length) / (sum / keep.length);
  }

  const [clo, chi] = [40, 16000];
  const { kLo: cLo, kHi: cHi, binHz } = binRange(n, sampleRate, clo, chi);
  let num = 0;
  let den = 0;
  for (let k = cLo; k <= cHi; k++) {
    num += k * binHz * power[k];
    den += power[k];
  }

  const [pLow, pHigh] = cfg.flatnessPoints;
  return {
    energies,
    shares,
    flatness: Number(flatness.toFixed(6)),
    noise: Number(clamp01((flatness - pLow) / (pHigh - pLow)).toFixed(6)),
    centroidHz: Number((den > 0 ? num / den : 0).toFixed(1)),
    rms: Number(rmsOf(seg).toFixed(6)),
    windowSec: n / sampleRate,
  };
}

/**
 * 判别：三个类别的分数各由"哪条带看到它"（带内归一化通量）与"频谱形状"两部分组成，取最高分。
 * 三条规则的物理依据：
 *   · 底鼓 = 低频（40–120Hz）占比高 + 低频带有峰
 *   · 军鼓 = 中频（150–1500Hz）占比高 + 噪声性（谱平坦度高）+ 军鼓带有峰
 *   · 踩镲 = 高频（6–16kHz）占比高 + 高频带有峰
 * 形状项用**同一组三路占比**（low / mid+body / high，三者相加 = 1）保证三类可比；
 * 噪声性只给军鼓加分（它是军鼓的判别特征，底鼓/踩镲不该靠它得分）。
 * 分数都是 0..1 的归一化量，所以 margin（最高 − 次高）可以直接当成"这一判有多确定"。
 */
export function classifyPercussion(features, config = {}) {
  const cfg = { ...DEFAULT_DRUM_CONFIG, ...config };
  const { weights } = cfg;
  const flux = features.flux ?? { kick: 0, snare: 0, hat: 0 };
  const shares = features.shares ?? { low: 0, mid: 0, body: 0, upper: 0, high: 0 };
  const noise = features.noise ?? 0;

  const lowE = shares.low ?? 0;
  const midE = (shares.mid ?? 0) + (shares.body ?? 0);
  const highE = shares.high ?? 0;
  const shapeTotal = lowE + midE + highE;
  const shape = shapeTotal > 0
    ? { low: lowE / shapeTotal, mid: midE / shapeTotal, high: highE / shapeTotal }
    : { low: 0, mid: 0, high: 0 };

  const snareShape = weights.snareMid * shape.mid + weights.snareNoise * noise;
  const power = cfg.fluxPower ?? 0.5;
  const f = (v) => (power === 1 ? (v ?? 0) : (v ?? 0) ** power);
  const scores = {
    kick: f(flux.kick) * shape.low,
    snare: f(flux.snare) * snareShape,
    hat: f(flux.hat) * shape.high,
  };
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const [kind, top] = ranked[0];
  const second = ranked[1][1];
  return {
    kind,
    score: Number(top.toFixed(6)),
    margin: Number((top - second).toFixed(6)),
    reason: `score ${kind} ${top.toFixed(3)} vs ${ranked[1][0]} ${second.toFixed(3)}`
      + `（三路占比 低 ${shape.low.toFixed(3)} / 中 ${shape.mid.toFixed(3)} / 高 ${shape.high.toFixed(3)}`
      + `；原始段 低 ${lowE.toFixed(3)} / 中 ${midE.toFixed(3)} / 高 ${highE.toFixed(3)}`
      + ` / 噪声性 ${noise.toFixed(3)}）`,
    scores: Object.fromEntries(Object.entries(scores).map(([k, v]) => [k, Number(v.toFixed(6))])),
  };
}

/** 某条带在某个时刻（已补偿）的归一化通量：取最近帧 ±1 帧内的最大值 */
function fluxAtTime(band, timeSec) {
  const latency = band.latencyFactor * band.frameSec;
  const i = Math.round((timeSec - latency) / band.hopSec);
  let best = 0;
  for (let j = i - 1; j <= i + 1; j++) {
    if (j < 0 || j >= band.frames) continue;
    best = Math.max(best, band.flux[j]);
  }
  return best;
}

/**
 * 打击乐检测（主入口）。
 *
 * @param {{samples: Float64Array, sampleRate: number, config?: object}} args
 * @returns {{events: Array, bands: Array, meta: object}}
 *   events[i] = {time, kind, strength, margin, score, features, evidence}
 */
export function detectPercussion({ samples, sampleRate, config = {} }) {
  const cfg = { ...DEFAULT_DRUM_CONFIG, ...config };
  const bands = bandFluxes({
    samples,
    sampleRate,
    config: {
      bands: cfg.bands,
      frameSize: cfg.frameSize,
      hopSec: cfg.hopSec,
      promWindowSec: cfg.promWindowSec,
      latencyFactor: cfg.latencyFactor,
      spectralSmoothFrames: 1,
    },
  });

  // 逐带取峰 → 绝对超额闸门（见 minExcess 注释）→ 跨带合并
  const peaks = [];
  const rejected = { weakAttack: 0, faint: 0, quiet: 0 };
  for (const b of bands) {
    for (const p of pickBandPeaks(b, { minProminence: cfg.minProminence, minSepSec: cfg.minSepSec })) {
      // 归一化通量比 ±100ms 局部均值高出的绝对量：prominence = flux / localMean
      const excess = p.strength * (1 - 1 / p.prominence);
      if (excess < cfg.minExcess) {
        rejected.weakAttack++;
        continue;
      }
      peaks.push({ ...p, excess: Number(excess.toFixed(6)) });
    }
  }
  const clusters = mergeBandPeaks(peaks, { mergeSec: cfg.mergeSec });

  const rmsWin = Math.max(16, Math.round(cfg.rmsWindowSec * sampleRate));
  const events = [];
  for (const c of clusters) {
    if (c.strength < cfg.minStrength) {
      rejected.faint++;
      continue;
    }
    const rms = rmsOf(sliceWindow(samples, Math.round(c.time * sampleRate), rmsWin));
    if (rms < cfg.minRms) {
      rejected.quiet++;
      continue;
    }
    const flux = { kick: 0, snare: 0, hat: 0 };
    for (const b of bands) flux[b.name] = Number(fluxAtTime(b, c.time).toFixed(6));
    const shape = measureDrumFeatures({ samples, sampleRate, timeSec: c.time, config: cfg });
    const cls = classifyPercussion({ flux, shares: shape.shares, noise: shape.noise }, cfg);
    events.push({
      time: Number(c.time.toFixed(4)),
      kind: cls.kind,
      strength: Number(c.strength.toFixed(6)),
      margin: cls.margin,
      score: cls.score,
      reason: cls.reason,
      scores: cls.scores,
      features: {
        flux,
        shares: shape.shares,
        flatness: shape.flatness,
        noise: shape.noise,
        centroidHz: shape.centroidHz,
      },
      rms: Number(rms.toFixed(6)),
      evidence: c.members
        .map((m) => ({ band: m.band, strength: m.strength, prominence: m.prominence, excess: m.excess }))
        .sort((a, b) => b.prominence - a.prominence),
    });
  }
  events.sort((a, b) => a.time - b.time);

  const counts = { kick: 0, snare: 0, hat: 0 };
  for (const e of events) counts[e.kind]++;
  return {
    events,
    bands: bands.map((b) => ({
      name: b.name, loHz: b.loHz, hiHz: b.hiHz, frameSize: b.frameSize,
      frameSec: Number(b.frameSec.toFixed(5)), hopSec: b.hopSec, bins: b.bins, frames: b.frames,
    })),
    meta: {
      sampleRate,
      seconds: Number((samples.length / sampleRate).toFixed(3)),
      peaks: peaks.length,
      clusters: clusters.length,
      events: events.length,
      counts,
      rejected,
      config: {
        frameSize: cfg.frameSize,
        hopSec: cfg.hopSec,
        latencyFactor: cfg.latencyFactor,
        minProminence: cfg.minProminence,
        minExcess: cfg.minExcess,
        minSepSec: cfg.minSepSec,
        mergeSec: cfg.mergeSec,
        minStrength: cfg.minStrength,
        minRms: cfg.minRms,
        bands: bands.map((b) => `${b.name}:${b.loHz}-${b.hiHz}Hz@${(b.hopSec * 1000).toFixed(0)}ms`),
      },
    },
  };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/analyze/drums.mjs');

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

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(audioPath);
  const result = detectPercussion({ samples, sampleRate });

  console.log(`打击乐检测：${audioPath}（${seconds.toFixed(1)}s，${sampleRate}Hz）`);
  for (const b of result.bands) {
    console.log(`  带 ${b.name.padEnd(6)} ${String(b.loHz).padStart(5)}–${String(b.hiHz).padEnd(6)}Hz`
      + ` 窗 ${(1000 * b.frameSec).toFixed(1)}ms 帧长 ${(1000 * b.hopSec).toFixed(1)}ms bins ${String(b.bins).padStart(4)} 帧 ${b.frames}`);
  }
  console.log(`  峰 ${result.meta.peaks} → 簇 ${result.meta.clusters} → 事件 ${result.meta.events}`
    + `（超额不足 ${result.meta.rejected.weakAttack} / 太弱 ${result.meta.rejected.faint} / 太静 ${result.meta.rejected.quiet}）`
    + `｜底鼓 ${result.meta.counts.kick} 军鼓 ${result.meta.counts.snare} 踩镲 ${result.meta.counts.hat}`);
  console.log(`  闸门：突出度 ≥${result.meta.config.minProminence}｜绝对超额 ≥${result.meta.config.minExcess}｜通量 ≥${result.meta.config.minStrength}`
    + `｜RMS ≥${result.meta.config.minRms}｜合并 ${(1000 * result.meta.config.mergeSec).toFixed(0)}ms`
    + `｜窗长补偿 ${result.meta.config.latencyFactor}×窗长`);
  if (args.dump) {
    for (const e of result.events) {
      console.log(`  ${e.time.toFixed(3)}s ${e.kind.padEnd(5)} 强度 ${e.strength.toFixed(3)} margin ${e.margin.toFixed(3)}｜${e.reason}`);
    }
  }
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({
      meta: { audioPath, ...result.meta },
      bands: result.bands,
      events: result.events,
    }, null, 1) + '\n', 'utf8');
    console.log(`  → ${outPath}`);
  }
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
