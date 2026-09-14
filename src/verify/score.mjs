// T6 · 客观指标 + 综合评分
//
// SPEC §6：`verify` 输出 起音对齐 F1、音级 chroma 相似度、八度命中率、力度包络相关、漏音率，
// 加权成综合分（客观 70% + 人耳清单 30%，权重可配）。本文件实现前半句；人耳清单是人工项，
// 没录进来时 overall 一律为 null（不编造一个人耳分）。
//
// 五项指标的口径（全部写进 docs/M0-3-report.md）：
//   ① 起音对齐 F1：音频侧取起音时刻，谱面侧取不同起音时刻，50ms 容差内最近邻匹配 → F1。
//      检测器默认 = `analyze/onset-detect.mjs` 的**分频带多分辨率谱通量**检测器（M1-3）；
//      `--detector legacy` 可切回 M0 的单带实现（1024 点 STFT / 10ms hop / 全局 + 自适应局部阈值）。
//      两者的 recall 差是 M1-3 的主要结论：0.805 → 0.974（谱面 1821 个起音，容差 50ms）。
//      注意 P 是**下界**：原曲里有谱面没有的乐器（鼓、人声、弦乐），它们的起音没有谱面
//      对应，会被算成"误报"。所以报告里同时给 P、R，R（谱面起音被音频认领的比例）才是
//      "对齐"的主要信号。
//   ② chroma 相似度：音频整曲折叠式 chromagram（见 analyze/chroma.mjs）与谱面音级直方图
//      的余弦相似度（都 l1 归一）。另给 shift≠0 的最好移调，用来区分"整体移调"与"音级吸附"。
//   ③ 八度命中率：对每颗音，在**该声部音域内**的候选八度上量 |X(f0)|²+½|X(2f0)|²，取最大者；
//      与谱面 midi 完全一致算命中。这是**独立实现**（不做 T2 的谱白化、只用 2 个谐波），
//      所以能与 T2 的 evidence 互相对拍（--octave-evidence）。
//   ④ 力度包络相关：谱面力度（velocity 列或混音 RMS）与该音 (音级+八度) 短时窄带能量的
//      Pearson r（谱面力度先归一到 0..1）。附两个诊断：与**同一窗混音 RMS** 的相关
//      （说明新力度不是旧的混音响度）、与**音频起音强度**的相关（非循环、直接可听）。
//   ⑤ 漏音率：谱面上有、但音频在该 (音级+八度) 上没有可测能量的比例
//      （阈值 = 0.1 × 全曲能量中位数）。给了 --expected（基准谱面）时另算"基准 vs 结果"的
//      漏音率/多音率，用来量化去撞格这类结构性改动的代价。
//
// 默认权重（可配，按比例归一）：
//   八度命中率 .25 / 起音对齐 F1 .25 / chroma 相似度 .20 / 力度包络相关 .15 / 有支撑率 .15
//   理由：音乐组把"旋律音级与走向、重音位置、低音根音进行、16 分格节奏"列为必保项——
//   节奏由起音对齐、音高由八度命中率、色彩由 chroma 承担；力度与漏音是次级损失。
import fs from 'node:fs';

import {
  DEFAULT_CHROMA_CONFIG,
  chromaBestShift,
  chromaCos,
  chromagram,
  normalizeChroma,
  notesChroma,
} from '../analyze/chroma.mjs';
import {
  midiName,
  narrowbandEnergy,
  pcOf,
  pearson,
  percentile,
  readNotesCsv,
  readWav,
  rmsOf,
  sliceWindow,
  spearman,
} from '../analyze/dsp.mjs';
import {
  DEFAULT_ONSET_DETECT_CONFIG,
  bandEnvelope,
  detectBandOnsets,
  legacyOnsets,
} from '../analyze/onset-detect.mjs';
import { VOICE_OF_INSTRUMENT } from '../arrange/velocity.mjs';
import { resolvePaths } from '../core/paths.mjs';

export { readNotesCsv, readWav };

const voiceOf = (instrument) => VOICE_OF_INSTRUMENT[String(instrument ?? '').trim()] ?? 'inner';

/* ------------------------------------------------------------------ 配置 */

export const DEFAULT_SCORE_WEIGHTS = {
  octaveHit: 0.25,
  onsetF1: 0.25,
  chromaCos: 0.2,
  velocityCorr: 0.15,
  noteSupport: 0.15,
};

export const DEFAULT_SCORE_CONFIG = {
  onset: {
    // 检测器：'banded' = analyze/onset-detect.mjs 的分频带多分辨率（M1-3 默认）；
    //         'legacy' = M0 的单带实现（1024 点 / 10ms hop / 全局+自适应局部阈值）
    detector: 'banded',
    banded: {},          // 分频带检测器的覆盖项（见 DEFAULT_ONSET_DETECT_CONFIG）
    // ↓ 以下只对 legacy 生效（M0 口径原样保留，任何改动都会让 M0-3 的基线不可比）
    frameSize: 1024,
    hop: 441,            // 10ms
    fminHz: 60,
    fmaxHz: 8000,
    globalSigma: 0.5,    // 全局阈值 = 均值 + 0.5σ；实测比 1σ 多检出 7% 起音，精度仅由 1.000 降到 0.990
    localMeanWindow: 30, // 自适应阈值窗口（±300ms）
    localDelta: 1.5,     // 必须超过局部均值 1.5 倍
    minSepSec: 0.05,     // 最小起音间隔
    tolSec: 0.05,        // 与谱面起音的对齐容差
  },
  chroma: { ...DEFAULT_CHROMA_CONFIG },
  localChroma: { windowSec: 4, minNotes: 8 },
  octave: {
    windowSec: 0.1,
    harmonicWeights: [1, 0.5],
    a4: 440,
    minRms: 0.01,
    // 声部音域：与 T2 同一先验（来自第三方谱峰基准实测到的基频分布）
    registers: { melody: [47, 102], inner: [47, 102], bass: [21, 63], perc: [0, 127] },
  },
  // 力度描述子：与 arranges/velocity.mjs 同口径（基频、旋律 100ms / 低音 120ms）
  velocity: { windowSec: 0.1, harmonicWeights: [1], a4: 440, windows: { melody: 0.1, inner: 0.1, bass: 0.12, perc: 0.1 } },
  support: { minRms: 0.01, floorFraction: 0.1, a4: 440, windowSec: 0.1 },
  humanWeight: 0.3,
};

/* ------------------------------------------------------------ 起音对齐 F1 */

/**
 * 现有（M0 T6）起音检测器：单带对数谱通量 + 全局阈值 + 自适应局部阈值 + 最小间隔。
 * 实现已搬到 `analyze/onset-detect.mjs`（`legacyOnsets`）；这里保留同名入口以免破坏
 * tests/score.test.mjs 与 M0 的对照口径（行为逐字节不变，时间**不做**窗长补偿）。
 */
export function onsetEnvelope({ samples, sampleRate, config = {} }) {
  const cfg = { ...DEFAULT_SCORE_CONFIG.onset, ...config };
  return legacyOnsets({ samples, sampleRate, config: cfg }).env;
}

/** 现有（M0）检测器：见 `onsetEnvelope`；返回 {times, env, globalThreshold, mean, std} */
export function detectOnsets({ samples, sampleRate, config = {} }) {
  const cfg = { ...DEFAULT_SCORE_CONFIG.onset, ...config };
  return legacyOnsets({ samples, sampleRate, config: cfg });
}

/**
 * 按 `config.detector` 分派检测器：
 *   · 'banded'（默认）：`analyze/onset-detect.mjs` 的分频带多分辨率谱通量（M1-3）
 *   · 'legacy'：M0 的单带实现（对照用，`--detector legacy`）
 * 两条路径都返回 `{times, env, detector, detail}`；env 供"力度 vs 起音强度"诊断用
 * （banded 路径下 env 是"各带归一化通量之和"的宽带包络，见 bandEnvelope）。
 */
export function detectOnsetsForScore({ samples, sampleRate, config = {} }) {
  const cfg = { ...DEFAULT_SCORE_CONFIG.onset, ...config };
  if (cfg.detector === 'legacy') {
    const r = legacyOnsets({ samples, sampleRate, config: cfg });
    return { ...r, detector: 'legacy', detail: null, onsets: null };
  }
  const r = detectBandOnsets({
    samples,
    sampleRate,
    config: { ...DEFAULT_ONSET_DETECT_CONFIG, ...(cfg.banded ?? {}) },
  });
  return { times: r.times, env: r.envelope, detector: 'banded', detail: r.meta, onsets: r.onsets };
}

/** 两个起音时刻表的最近邻匹配（贪心、距离 ≤ tolSec） */
export function matchOnsets(chartTimes, audioTimes, tolSec) {
  const chart = [...chartTimes].sort((a, b) => a - b);
  const audio = [...audioTimes].sort((a, b) => a - b);
  let i = 0;
  let j = 0;
  let matched = 0;
  while (i < chart.length && j < audio.length) {
    const d = audio[j] - chart[i];
    if (Math.abs(d) <= tolSec) {
      matched++;
      i++;
      j++;
    } else if (d < 0) {
      j++;
    } else {
      i++;
    }
  }
  return { matched, chartN: chart.length, audioN: audio.length };
}

/** 起音对齐 F1（precision 是下界，见文件头注释） */
export function onsetAlignmentF1({ chartTimes, audioTimes, tolSec = 0.05 }) {
  const m = matchOnsets(chartTimes, audioTimes, tolSec);
  const precision = m.audioN ? m.matched / m.audioN : 0;
  const recall = m.chartN ? m.matched / m.chartN : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return {
    value: Number(f1.toFixed(6)),
    f1,
    precision,
    recall,
    matched: m.matched,
    chartOnsets: m.chartN,
    audioOnsets: m.audioN,
    tolSec,
  };
}

/* ---------------------------------------------------------------- 八度判据 */

/**
 * 单音的独立八度估计（与 T2 分开实现：不做谱白化，只用 f0 与 2f0）。
 * 候选只取"该声部音域内"的同一个音级，最多 8 个。
 */
export function octaveEstimate({ samples, sampleRate, note, config = {} }) {
  const cfg = { ...DEFAULT_SCORE_CONFIG.octave, ...config };
  const voice = voiceOf(note.instrument);
  const [lo, hi] = cfg.registers[voice] ?? cfg.registers.melody;
  const pc = pcOf(note.midi);
  const candidates = [];
  for (let m = pc; m <= 127; m += 12) if (m >= lo && m <= hi) candidates.push(m);
  if (candidates.length === 0) return { bestMidi: null, candidates, energies: [], rms: 0, weak: true, voice };

  const measured = candidates.map((m) => narrowbandEnergy({
    samples,
    sampleRate,
    midi: m,
    timeSec: note.timeSec,
    a4: cfg.a4,
    windowSec: cfg.windowSec,
    harmonicWeights: cfg.harmonicWeights,
  }));
  let best = 0;
  for (let i = 1; i < measured.length; i++) if (measured[i].energy > measured[best].energy) best = i;
  return {
    bestMidi: candidates[best],
    candidates,
    energies: measured.map((e) => e.energy),
    rms: measured[0].rms,
    weak: measured[0].rms < cfg.minRms,
    voice,
  };
}

/* ------------------------------------------------------------ 基准 vs 结果 */

/** 按 (step,midi) 多重集合比较"基准谱面"与"结果谱面" */
export function expectedVsActual(expected, actual) {
  const key = (n) => `${n.step}|${n.midi}`;
  const pool = new Map();
  for (const n of actual) {
    const k = key(n);
    pool.set(k, (pool.get(k) ?? 0) + 1);
  }
  let matched = 0;
  for (const n of expected) {
    const k = key(n);
    const c = pool.get(k) ?? 0;
    if (c > 0) {
      pool.set(k, c - 1);
      matched++;
    }
  }
  const missing = expected.length - matched;
  const extra = actual.length - matched;
  return {
    expectedN: expected.length,
    actualN: actual.length,
    matched,
    missing,
    extra,
    missingRate: expected.length ? missing / expected.length : 0,
    extraRate: actual.length ? extra / actual.length : 0,
  };
}

/* --------------------------------------------------------------- 力度口径 */

/**
 * 谱面力度来源（按表头判断，绝不把两种口径混在一起）：
 *   · 显式给了 velocity 产物 → 'narrowband(velocity.csv)'
 *   · 谱面自带 velocity 列（>1 时按 0..127 归一）→ 'chart(velocity 列)'
 *   · 否则退回混音 RMS（v3 的 volume 列）→ 'mix-rms(volume)'
 *   · 两者都没有（例如 T3 的 notes_fixed_v3.csv 只改了 midi）→ 'unavailable'，
 *     这一项**不参与综合分**（权重在剩余指标间重新归一），并在报告里标注 skipped。
 */
export function resolveChartVelocity({ header, notes, velocityCsvText: vtext }) {
  if (vtext) {
    const { header: vh, notes: vnotes } = readNotesCsv(vtext);
    if (!vh.includes('velocity')) throw new Error('--velocity 文件里没有 velocity 列');
    const byKey = new Map();
    for (const n of vnotes) if (!byKey.has(`${n.step}|${n.midi}`)) byKey.set(`${n.step}|${n.midi}`, n.velocity);
    const exact = notes.length > 0 && notes.every((n) => byKey.has(`${n.step}|${n.midi}`));
    const values = exact
      ? notes.map((n) => byKey.get(`${n.step}|${n.midi}`))
      : (vnotes.length === notes.length ? vnotes.map((n) => n.velocity) : null);
    if (!values) throw new Error('--velocity 与谱面既无法按 (step,midi) 对齐、长度也不一致');
    return { source: 'narrowband(velocity.csv)', values, matchedBy: exact ? 'step+midi' : 'index', scale: 1 };
  }
  if (header.includes('velocity')) {
    const raw = notes.map((n) => n.velocity);
    const scale = Math.max(...raw) > 1 ? 127 : 1;
    return { source: 'chart(velocity 列)', values: raw.map((v) => v / scale), matchedBy: 'column', scale };
  }
  if (!header.includes('volume')) {
    return { source: 'unavailable', values: null, matchedBy: null, scale: null, reason: '谱面既无 velocity 列也无 volume 列' };
  }
  return { source: 'mix-rms(volume)', values: notes.map((n) => n.volume ?? 0), matchedBy: 'column', scale: 1 };
}

/* ------------------------------------------------------------------ 打分 */

/** 逐窗 chroma 相似度（只在音符数 ≥ minNotes 的窗里算，衡量局部和声色彩） */
export function localChromaCosine({ audioFrames, timeGroups, windowSec, minNotes }) {
  const audioByWindow = new Map();
  for (const f of audioFrames) {
    const w = Math.floor(f.timeSec / windowSec);
    if (!audioByWindow.has(w)) audioByWindow.set(w, new Float64Array(12));
    const acc = audioByWindow.get(w);
    for (let i = 0; i < 12; i++) acc[i] += f.chroma[i];
  }
  const sims = [];
  for (const [w, group] of timeGroups) {
    if (group.length < minNotes) continue;
    const acc = audioByWindow.get(w);
    if (!acc) continue;
    sims.push(chromaCos(
      normalizeChroma(acc, { norm: 'l1' }),
      normalizeChroma(notesChroma(group, { weighting: 'count' }), { norm: 'l1' }),
    ));
  }
  return {
    mean: sims.length ? Number((sims.reduce((x, y) => x + y, 0) / sims.length).toFixed(6)) : null,
    windows: sims.length,
  };
}

/**
 * 给一份谱面 + 音频打分。
 * @param {{csvText: string, samples: Float64Array, sampleRate: number, config?: object,
 *          weights?: object, human?: number|null, expected?: Array|null,
 *          velocityCsvText?: string|null, octaveEvidence?: object|null}} args
 */
export function scoreChart({
  csvText,
  samples,
  sampleRate,
  config = {},
  weights = {},
  human = null,
  expected = null,
  velocityCsvText = null,
  octaveEvidence = null,
}) {
  const cfg = {
    ...DEFAULT_SCORE_CONFIG,
    ...config,
    onset: { ...DEFAULT_SCORE_CONFIG.onset, ...(config.onset ?? {}) },
    chroma: { ...DEFAULT_SCORE_CONFIG.chroma, ...(config.chroma ?? {}) },
    octave: { ...DEFAULT_SCORE_CONFIG.octave, ...(config.octave ?? {}) },
    velocity: { ...DEFAULT_SCORE_CONFIG.velocity, ...(config.velocity ?? {}) },
    support: { ...DEFAULT_SCORE_CONFIG.support, ...(config.support ?? {}) },
    localChroma: { ...DEFAULT_SCORE_CONFIG.localChroma, ...(config.localChroma ?? {}) },
  };
  const { header, notes } = readNotesCsv(csvText);
  const seconds = samples.length / sampleRate;

  /* ① 起音对齐 */
  const chartOnsets = [...new Set(notes.map((n) => n.timeSec))].sort((a, b) => a - b);
  const detected = detectOnsetsForScore({ samples, sampleRate, config: cfg.onset });
  const { times: audioOnsets, env } = detected;
  const onsetF1 = onsetAlignmentF1({ chartTimes: chartOnsets, audioTimes: audioOnsets, tolSec: cfg.onset.tolSec });

  /* ② chroma 相似度 */
  const gram = chromagram({ samples, sampleRate, config: cfg.chroma });
  const audioChroma = normalizeChroma(gram.meanRaw, { norm: 'l1' });
  const chartChroma = normalizeChroma(notesChroma(notes, { weighting: 'count' }), { norm: 'l1' });
  const cosine = chromaCos(audioChroma, chartChroma);
  const best = chromaBestShift(audioChroma, chartChroma);
  const timeGroups = new Map();
  for (const n of notes) {
    const w = Math.floor(n.timeSec / cfg.localChroma.windowSec);
    if (!timeGroups.has(w)) timeGroups.set(w, []);
    timeGroups.get(w).push(n);
  }
  const local = localChromaCosine({
    audioFrames: gram.frames,
    timeGroups,
    windowSec: cfg.localChroma.windowSec,
    minNotes: cfg.localChroma.minNotes,
  });
  const maxAudio = Math.max(...audioChroma);
  const maxChart = Math.max(...chartChroma);
  const audioRel = [...audioChroma].map((v) => v / maxAudio);
  const chartRel = [...chartChroma].map((v) => v / maxChart);
  // 音级吸附诊断：音频里明显存在（>10% 最大音级）、谱面却压到不足其一半的音级
  const suppressedPcs = [...audioChroma.keys()].filter((pc) => audioRel[pc] > 0.1 && chartRel[pc] < 0.5 * audioRel[pc]);
  const chartMassOnSuppressed = Number(suppressedPcs.reduce((a, pc) => a + chartChroma[pc], 0).toFixed(6));

  /* ③ 八度命中率 + ⑤ 漏音率（共用一次逐音窄带测量） */
  const perNote = notes.map((n) => {
    const voice = voiceOf(n.instrument);
    const velWindowSec = cfg.velocity.windows[voice] ?? cfg.velocity.windowSec;
    return {
      note: n,
      voice,
      est: octaveEstimate({ samples, sampleRate, note: n, config: cfg.octave }),
      support: narrowbandEnergy({
        samples,
        sampleRate,
        midi: n.midi,
        timeSec: n.timeSec,
        a4: cfg.support.a4,
        windowSec: velWindowSec,
        harmonicWeights: [1],
      }),
      velm: narrowbandEnergy({
        samples,
        sampleRate,
        midi: n.midi,
        timeSec: n.timeSec,
        a4: cfg.velocity.a4,
        windowSec: velWindowSec,
        harmonicWeights: cfg.velocity.harmonicWeights,
      }),
    };
  });

  const byVoice = {};
  let hit = 0;
  let within1 = 0;
  let measurable = 0;
  let weak = 0;
  for (const r of perNote) {
    byVoice[r.voice] ??= { n: 0, hit: 0, within1: 0, weak: 0 };
    const b = byVoice[r.voice];
    b.n++;
    if (r.est.weak || r.est.bestMidi === null) {
      b.weak++;
      weak++;
      continue;
    }
    measurable++;
    if (r.est.bestMidi === r.note.midi) {
      hit++;
      b.hit++;
    }
    if (Math.abs(r.est.bestMidi - r.note.midi) === 12) {
      within1++;
      b.within1++;
    }
  }
  const rate = (k, n) => (n ? Number((k / n).toFixed(6)) : 0);
  for (const b of Object.values(byVoice)) b.rate = rate(b.hit, b.n - b.weak);

  let agreementWithT2 = null;
  if (octaveEvidence?.notes) {
    // 对齐方式：优先按 (step,timeSec,instrument,midi) 键——T2 的产物是用 v1 CSV 算的，
    // v1 与 v3 音符集合相同但**行序不同**，只按 noteId 对会整体错位（M0-2 §0 的表可以对照）。
    const keyOf = (n) => `${n.step}|${Number(n.timeSec).toFixed(3)}|${n.instrument}|${n.midi}`;
    const byKey = new Map();
    const byId = new Map();
    for (const e of octaveEvidence.notes) {
      byKey.set(keyOf(e), e);
      byId.set(e.noteId, e);
    }
    const alignedByKey = perNote.every((r) => byKey.has(keyOf(r.note)));
    const lookup = alignedByKey ? (r) => byKey.get(keyOf(r.note)) : (r) => byId.get(r.note.noteId);
    let agree = 0;
    let count = 0;
    for (const r of perNote) {
      const ev = lookup(r);
      if (!ev || ev.weak || r.est.bestMidi === null) continue;
      count++;
      if (ev.bestOctave === r.est.bestMidi) agree++;
    }
    let t2Hit = 0;
    let t2Count = 0;
    for (const r of perNote) {
      const ev = lookup(r);
      if (!ev || ev.weak) continue;
      t2Count++;
      if (ev.bestOctave === r.note.midi) t2Hit++;
    }
    agreementWithT2 = {
      alignedBy: alignedByKey ? 'step+time+instrument+midi' : 'noteId',
      n: count,
      agree,
      rate: rate(agree, count),
      evidenceHitRate: rate(t2Hit, t2Count),
    };
  }

  const supportEnergies = perNote.filter((r) => !r.support.weak).map((r) => r.support.energy).sort((a, b) => a - b);
  const supportFloor = cfg.support.floorFraction * percentile(supportEnergies, 0.5);
  let supported = 0;
  for (const r of perNote) if (!r.support.weak && r.support.energy >= supportFloor) supported++;
  const missingRate = notes.length ? 1 - supported / notes.length : 0;
  const expectedReport = expected
    ? expectedVsActual(
      expected.map((n) => ({ step: n.step, midi: n.midi })),
      notes.map((n) => ({ step: n.step, midi: n.midi })),
    )
    : null;

  /* ④ 力度包络相关 */
  const vel = resolveChartVelocity({ header, notes, velocityCsvText });
  const rawDesc = perNote.map((r) => (r.velm.rms < cfg.support.minRms ? null : r.velm.energy));
  const present = rawDesc.filter((e) => e !== null).sort((a, b) => a - b);
  const dLo = percentile(present, 0.1);
  const dHi = percentile(present, 0.9);
  const dSpan = dHi - dLo;
  const desc01 = rawDesc.map((e) => {
    if (e === null) return null;
    if (!(dSpan > 0)) return 0;
    return Math.min(1, Math.max(0, (e - dLo) / dSpan));
  });
  const pairs = [];
  for (let i = 0; i < notes.length; i++) {
    if (!vel.values) break;
    if (desc01[i] === null || !Number.isFinite(vel.values[i])) continue;
    pairs.push({ i, chart: vel.values[i], desc: desc01[i] });
  }
  const chartVels = pairs.map((p) => p.chart);
  const rVel = pairs.length ? pearson(chartVels, pairs.map((p) => p.desc)) : 0;
  const rhoVel = pairs.length ? spearman(chartVels, pairs.map((p) => p.desc)) : 0;
  const win = Math.max(16, Math.round(sampleRate * cfg.velocity.windowSec));
  const mixRms = pairs.map((p) => rmsOf(sliceWindow(samples, Math.round(notes[p.i].timeSec * sampleRate), win)));
  const rVsMix = pairs.length ? pearson(chartVels, mixRms) : 0;
  const onsetStrength = pairs.map((p) => {
    const fi = Math.min(env.frames - 1, Math.max(0, Math.round(notes[p.i].timeSec / env.hopSec)));
    return env.flux[fi] ?? 0;
  });
  const rVsOnset = pairs.length ? pearson(chartVels, onsetStrength) : 0;

  const metrics = {
    onsetF1: {
      value: onsetF1.value,
      detector: detected.detector,
      precision: Number(onsetF1.precision.toFixed(6)),
      recall: Number(onsetF1.recall.toFixed(6)),
      matched: onsetF1.matched,
      chartOnsets: onsetF1.chartOnsets,
      audioOnsets: onsetF1.audioOnsets,
      tolSec: onsetF1.tolSec,
      detectorDetail: detected.detail
        ? {
          bands: detected.detail.onsetBands,
          bandProfile: detected.detail.config.bands,
          mergeSec: detected.detail.config.mergeSec,
          minBands: detected.detail.config.minBands,
          minPeakProminence: detected.detail.config.minPeakProminence,
          minStrength: detected.detail.config.minStrength,
          minRms: detected.detail.config.minRms,
          rejected: detected.detail.rejected,
        }
        : null,
      caveat: 'precision 是下界：原曲里有谱面没有的乐器（鼓/人声），它们的起音会被算成误报',
    },
    chromaCos: {
      value: Number(cosine.toFixed(6)),
      bestShift: best.shift,
      cosAtBestShift: Number(best.cos.toFixed(6)),
      localMean: local.mean,
      localWindows: local.windows,
      suppressedPcs: suppressedPcs.map((pc) => midiName(pc + 60)),
      chartMassOnSuppressed,
      chartChroma: [...chartChroma].map((v) => Number(v.toFixed(6))),
      audioChroma: [...audioChroma].map((v) => Number(v.toFixed(6))),
      method: gram.meta.method,
      frameSec: gram.meta.frameSec,
    },
    octaveHit: {
      value: rate(hit, measurable),
      hit,
      measurable,
      weak,
      within1Rate: rate(within1, measurable),
      byVoice,
      agreementWithT2,
      estimator: '|X(f0)|²+½|X(2f0)|²，声部音域内候选，独立于 T2（不做谱白化）',
    },
    velocityCorr: vel.values === null ? {
      value: null,
      skipped: true,
      source: vel.source,
      reason: vel.reason,
      n: 0,
      caveat: '谱面没有力度列（既无 velocity 也无 volume），这一项不参与综合分',
    } : {
      // 负相关对"对齐"没有价值，打分用 max(0, r)；原始 r 照实记录
      value: Number(Math.max(0, rVel).toFixed(6)),
      pearson: Number(rVel.toFixed(6)),
      spearman: Number(rhoVel.toFixed(6)),
      vsMixRms: Number(rVsMix.toFixed(6)),
      vsOnsetStrength: Number(rVsOnset.toFixed(6)),
      source: vel.source,
      matchedBy: vel.matchedBy,
      n: pairs.length,
      caveat: '谱面力度若由同一能量口径生成，这项验证的是"链路没接错"，不是独立证据；'
        + '与音频起音强度的相关（vsOnsetStrength）才是非循环的那一面',
    },
    noteSupport: {
      value: Number((1 - missingRate).toFixed(6)),
      missingRate: Number(missingRate.toFixed(6)),
      supported,
      notes: notes.length,
      floor: supportFloor,
      floorFraction: cfg.support.floorFraction,
      expectedVsActual: expectedReport,
    },
  };

  const values = Object.fromEntries(Object.entries(metrics).map(([k, v]) => [k, v.value]));
  return {
    meta: {
      seconds: Number(seconds.toFixed(3)),
      sampleRate,
      notes: notes.length,
      voices: Object.keys(byVoice),
      onsetFrameSec: env.frameSec,
      onsetDetector: detected.detector,
      velocitySource: vel.source,
    },
    metrics,
    score: compositeScore(values, { weights, human, humanWeight: cfg.humanWeight }),
    perNote: perNote.map((r) => ({
      noteId: r.note.noteId,
      step: r.note.step,
      timeSec: r.note.timeSec,
      instrument: r.note.instrument,
      voice: r.voice,
      midi: r.note.midi,
      midiName: midiName(r.note.midi),
      estOctave: r.est.bestMidi,
      estOctaveName: r.est.bestMidi === null ? null : midiName(r.est.bestMidi),
      hit: r.est.bestMidi === r.note.midi,
      supportEnergy: r.support.energy,
      supported: !r.support.weak && r.support.energy >= supportFloor,
      rms: Number(r.support.rms.toFixed(6)),
      velocity: Number.isFinite(vel.values[r.note.noteId]) ? vel.values[r.note.noteId] : null,
    })),
  };
}

/** 加权综合分：权重按比例归一，值夹到 0..1；人耳分（30%）缺失时 overall = null */
export function compositeScore(values, { weights = {}, human = null, humanWeight = DEFAULT_SCORE_CONFIG.humanWeight } = {}) {
  // 显式给了权重时只认给的键（归一化后相加），没给则用默认权重表
  const keys = Object.keys(weights).length > 0 ? Object.keys(weights) : Object.keys(DEFAULT_SCORE_WEIGHTS);
  // value === null 表示"这一项没测到"（例如谱面没有力度列）→ 不参与加权，权重在剩余项间重新归一；
  // value === undefined 表示调用方没给这一项 → 当作 0 分但保留原权重（便于只算其中几项做对照）
  const merged = Object.fromEntries(
    keys.filter((k) => values[k] !== null).map((k) => [k, weights[k] ?? DEFAULT_SCORE_WEIGHTS[k] ?? 0]),
  );
  const skipped = keys.filter((k) => values[k] === null);
  const total = Object.values(merged).reduce((a, b) => a + b, 0);
  const components = Object.entries(merged).map(([key, w]) => {
    const raw = Number.isFinite(values[key]) ? values[key] : 0;
    const value = Math.min(1, Math.max(0, raw));
    const weight = total > 0 ? w / total : 0;
    return { key, weight: Number(weight.toFixed(6)), value, contribution: Number((weight * value).toFixed(6)) };
  });
  const objective = Number(components.reduce((a, c) => a + c.contribution, 0).toFixed(6));
  const overall = Number.isFinite(human)
    ? Number(((1 - humanWeight) * objective + humanWeight * Math.min(1, Math.max(0, human))).toFixed(6))
    : null;
  return {
    objective,
    human: Number.isFinite(human) ? human : null,
    humanWeight,
    overall,
    weightsRequested: weights,
    skipped,
    weightsNormalized: total > 0
      ? Object.fromEntries(Object.entries(merged).map(([k, w]) => [k, Number((w / total).toFixed(6))]))
      : merged,
    components,
  };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/verify/score.mjs');

if (invokedDirectly) {
  const P = resolvePaths();
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  // 口径修正（M2-3）：默认评分对象 = arrange-all 的最终机器谱面（过去默认 v3，评的不是真正会响的那份）
  const notesPath = args.notes ?? P.machineScore;
  const wavPath = args.audio ?? P.audio;
  const outPath = args.out ?? P.file('score_report.json');
  const velPath = typeof args.velocity === 'string' ? args.velocity : null;
  const expectedPath = typeof args.expected === 'string' ? args.expected : null;
  const evPath = typeof args['octave-evidence'] === 'string' ? args['octave-evidence'] : null;
  const weights = typeof args.weights === 'string' ? JSON.parse(args.weights) : {};
  const human = args.human !== undefined ? Number(args.human) : null;
  const detector = typeof args.detector === 'string' ? args.detector : DEFAULT_SCORE_CONFIG.onset.detector;
  const config = { onset: { detector } };

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(wavPath);
  const csvText = fs.readFileSync(notesPath, 'utf8');
  const expected = expectedPath ? readNotesCsv(fs.readFileSync(expectedPath, 'utf8')).notes : null;
  const velocityCsvText = velPath ? fs.readFileSync(velPath, 'utf8') : null;
  const octaveEvidence = evPath && fs.existsSync(evPath) ? JSON.parse(fs.readFileSync(evPath, 'utf8')) : null;

  const result = scoreChart({
    csvText,
    samples,
    sampleRate,
    config,
    weights,
    human,
    expected,
    velocityCsvText,
    octaveEvidence,
  });
  const report = {
    $schema: 'nbforge.score-report/v0',
    meta: {
      notesPath,
      wavPath,
      velocityPath: velPath,
      expectedPath,
      octaveEvidencePath: octaveEvidence ? evPath : null,
      detector,
      ...result.meta,
    },
    weights: result.score.weightsNormalized,
    metrics: result.metrics,
    score: result.score,
    command: `node src/verify/score.mjs --notes ${notesPath}`
      + `${velPath ? ` --velocity ${velPath}` : ''}${expectedPath ? ` --expected ${expectedPath}` : ''}`
      + `${evPath ? ` --octave-evidence ${evPath}` : ''}${detector === DEFAULT_SCORE_CONFIG.onset.detector ? '' : ` --detector ${detector}`}`,
    durationMs: Date.now() - t0,
  };
  fs.writeFileSync(outPath, JSON.stringify(report, null, 1) + '\n', 'utf8');

  const m = result.metrics;
  const pct = (x) => `${(100 * x).toFixed(1)}%`;
  console.log(`综合评分：${notesPath}（${result.meta.notes} 颗音 vs ${seconds.toFixed(1)}s 音频）`);
  console.log(`  ① 起音对齐 F1 ${m.onsetF1.value.toFixed(3)}（P ${m.onsetF1.precision.toFixed(3)} / R ${m.onsetF1.recall.toFixed(3)}`
    + `，谱面 ${m.onsetF1.chartOnsets} / 音频 ${m.onsetF1.audioOnsets} 个起音，容差 ${m.onsetF1.tolSec * 1000}ms，`
    + `检测器 ${m.onsetF1.detector}${m.onsetF1.detectorDetail ? `（${m.onsetF1.detectorDetail.bands} 带）` : ''}）`);
  console.log(`  ② chroma 相似度 ${m.chromaCos.value.toFixed(3)}（局部窗均值 ${m.chromaCos.localMean}，最佳移调 +${m.chromaCos.bestShift}）`
    + `｜被压制音级 ${m.chromaCos.suppressedPcs.join('/') || '无'} 占谱面 ${pct(m.chromaCos.chartMassOnSuppressed)}`);
  console.log(`  ③ 八度命中率 ${m.octaveHit.value.toFixed(3)}（可测 ${m.octaveHit.measurable}/${result.meta.notes}`
    + `；旋律 ${m.octaveHit.byVoice.melody?.rate?.toFixed(3) ?? 'n/a'} / 贝斯 ${m.octaveHit.byVoice.bass?.rate?.toFixed(3) ?? 'n/a'}）`);
  if (m.octaveHit.agreementWithT2) {
    console.log(`     与 T2 独立证据一致 ${pct(m.octaveHit.agreementWithT2.rate)}（${m.octaveHit.agreementWithT2.n} 颗音）`);
  }
  console.log(`  ④ 力度包络相关 r=${m.velocityCorr.pearson.toFixed(3)}（ρ=${m.velocityCorr.spearman.toFixed(3)}，`
    + `来源 ${m.velocityCorr.source}，n=${m.velocityCorr.n}）`);
  console.log(`     诊断：与混音 RMS r=${m.velocityCorr.vsMixRms.toFixed(3)}、与起音强度 r=${m.velocityCorr.vsOnsetStrength.toFixed(3)}`);
  console.log(`  ⑤ 有支撑率 ${m.noteSupport.value.toFixed(3)}（漏音率 ${pct(m.noteSupport.missingRate)}，`
    + `阈值 = ${m.noteSupport.floorFraction} × 能量中位数）`);
  if (m.noteSupport.expectedVsActual) {
    const e = m.noteSupport.expectedVsActual;
    console.log(`     基准对比：漏音 ${pct(e.missingRate)}（${e.missing} 颗）／多音 ${pct(e.extraRate)}（${e.extra} 颗）`);
  }
  console.log(`  综合分：客观 ${result.score.objective.toFixed(4)}（`
    + result.score.components.map((c) => `${c.key} ${c.value.toFixed(3)}×${c.weight.toFixed(2)}`).join(' + ')
    + `）${result.score.overall === null ? '｜overall 待补人耳清单（30%）' : `｜overall ${result.score.overall}`}`);
  console.log(`  → ${outPath}`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
