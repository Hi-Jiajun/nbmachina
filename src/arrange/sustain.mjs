// M1-2 · 长音/延音：从音频估每颗音的持续长度 → 同音高重复触发
//
// 要解决的问题：输入的 MIDI 里每颗音的时值都是 0.05 拍（触发脉冲），**数据层面不存在长音**；
// 而原版音符盒响约 1 拍就衰减完 → 听感全是断奏（DISCUSSION-C §2.4 排第 1 的"听得出错"）。
// 做法（DISCUSSION-C 规则 R1 的量化版）：
//   ① 对每颗音，从它的起音开始，沿"该音级在该八度上的窄带能量"（窗 50ms、步进 50ms）走，
//      找到**第一次跌破起音峰值 25%** 的时刻 = 结束；上限 1.0s（超过就按持续音处理）。
//   ② 持续 >0.36s 的音，在**同一 (row, instrument)** 上按 **2 步（0.24s）** 间隔追加触发，
//      力度按 0.85 逐次衰减（首触发的 0.85、0.7225…），并标 `sustainOf` / `sustainIndex`。
//   ③ 追加**不得改变原有音符**（原行逐字符保留、顺序不变），也**不得制造撞格**：
//      目标格已被占用就跳过该次触发（机器上一格只有一颗音符盒，撞格必然漏音 / 顶掉原音）。
//
// 重要边界（实测，见 `docs/M1-2-report.md` §3）：这份参考音频里 **harp 声部的逐音包络是固定形状**
// （归一化后 1.00/0.63/0.39/0.24/0.15…，即 τ≈0.11s 的指数衰减，跨音高、跨全曲一致），
// 所以"跌破 25%"在 50ms 窗下几乎等价于"参考音频的样本衰减到 −12dB"，而不是"这颗音在音乐上有多长"。
// 用与 velocity/score 一致的 100/120ms 窗时这个判据会宽松很多（被延长的音 71 → 319），
// 两个口径都能跑（`--window` / `--bass-window`），默认按任务书口径（50ms/50ms）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  csvText,
  narrowbandEnergy,
  pearson,
  percentile,
  readNotesCsv,
  readWav,
  rmsOf,
  sliceWindow,
  spearman,
} from '../analyze/dsp.mjs';
import { VOICE_OF_INSTRUMENT, voiceOfInstrument } from './velocity.mjs';

export { readNotesCsv, readWav };
export { VOICE_OF_INSTRUMENT, voiceOfInstrument };

/** 新增的两列（原列不动，追加在行尾） */
export const EXTRA_CSV_COLUMNS = ['sustainOf', 'sustainIndex'];

/**
 * 加窗 DFT 功率 → 基频振幅（Hann 窗下单频点在 N 点窗里的 |X| = A·N/4）。
 * 与 pitch-fix.mjs 同一换算（那里用它做"最强峰振幅"门槛）。
 */
export function energyToAmplitude(energy, windowSamples) {
  return (4 * Math.sqrt(Math.max(0, energy))) / windowSamples;
}

export const DEFAULT_SUSTAIN_CONFIG = {
  windowSec: 0.05,          // 任务书：窗 50ms
  hopSec: 0.05,             // 任务书：步进 50ms
  peakWindowSec: 0.2,       // "起音峰值" = 起音后 0.2s 内的最大带内能量
  attackFraction: 0.5,      // 攻击帧 = 峰值窗内第一个达到 起音峰值×0.5 的帧（抵消单点 Goertzel 的扇形损失）
  dropFraction: 0.25,       // 跌破起音峰值 25% 即结束
  maxSustainSec: 1.0,       // 上限：超过按持续音处理
  minRepeatSustainSec: 0.36,// 持续 >0.36s 才拆重复触发
  repeatStepInterval: 2,    // 每 2 步（0.24s）一次
  volumeDecay: 0.85,        // 追加音力度逐次 ×0.85
  stepSec: 0.12,            // 0.12s/步（M0-1 §4.1 已验：2320 步 = 278.4s）
  ticksPerStep: 12,         // 100 tps 下 0.12s = 12 刻
  a4: 440,
  harmonicWeights: [1],     // 只用基频（与 T5b 力度、T6 评分同一口径；加谐波会串八度）
  minRms: 0.01,             // 窗内 RMS 低于此值 = 无证据（不猜、不改）
  minPeakAmplitude: 0.02,   // "起音峰值"的等效基频振幅下限（与 pitch-fix.mjs 的 no-peak 同口径）
  minPeakOverRms: 0.1,      // 且峰值振幅 ≥ 0.1 × 窗内 RMS（挡"窗口里有别的乐器、这颗音其实没响"）
  // 追加门槛（与 score.mjs 的"有支撑率"同口径）：要追加的那个时刻，音频里必须还有这颗音的证据
  // （该音级该八度的窄带能量 ≥ minRepeatEnergyFraction × 全曲 onset 能量中位数），否则放弃追加。
  // 理由：在那之后音频自己就衰减到听不见了，再补触发是"加原曲没有的声音"，只会让客观分变差。
  // 默认 0 = 关（严格按任务书：只看"跌破起音峰值 25%"，不额外加证据门槛）。
  // 设成 0.1~0.5 更保守：只在音频里"还听得见这颗音"的位置追加，客观分损失更小（见报告 §5 敏感性表）。
  minRepeatEnergyFraction: 0,
  // 可选（默认关）：只在"该时刻这颗音自己的八度在同一音级的候选里最响"时才追加。
  // 这是最严的证据口径（等价于要求音频独立支持这颗音在该八度上仍然在响），见报告 §5。
  requireOwnOctaveDominant: false,
  // 声部音域（与 score.mjs / octave-evidence.mjs 的先验同一张表，用于上一条的候选八度）
  registers: { melody: [47, 102], inner: [47, 102], bass: [21, 63], perc: [0, 127] },
  midiColumn: 'midi',       // 'midi' | 'newMidi'
  voices: {},               // 逐声部覆盖：{ bass: { windowSec: 0.12 } }
  gap: {                    // 空隙占比口径（"音频有能量但谱面 2 步内无触发"）
    floorFraction: 0.1,     // 阈值 = 0.1 × 逐 step 窗 RMS 中位数（与 score.mjs 的漏音口径一致）
    neighborSteps: 2,
    // 'neighbor'：该 step 前后各 2 步内都没有触发（任务书字面口径）
    // 'preceding'：该 step 之前 2 步内没有触发（= 机器的音已经衰减完还没被重新触发，更贴近"断奏"）
    direction: 'neighbor',
  },
};

export function sustainConfig(config = {}) {
  const voices = { ...DEFAULT_SUSTAIN_CONFIG.voices };
  for (const [k, v] of Object.entries(config.voices ?? {})) voices[k] = { ...(voices[k] ?? {}), ...v };
  return { ...DEFAULT_SUSTAIN_CONFIG, ...config, voices, gap: { ...DEFAULT_SUSTAIN_CONFIG.gap, ...(config.gap ?? {}) } };
}

/* ------------------------------------------------------------------ 判据 */

/**
 * 一颗音的持续长度。
 * 从起音开始沿该音（自己的音级 + 八度）的窄带能量走，第一次跌破"起音峰值 × dropFraction"
 * 的时刻即为结束；走满 maxSustainSec 都没跌破 → 按持续音处理（= maxSustainSec）。
 *
 * @returns {{sustainSec: number, reason: 'measured'|'at-cap'|'weak-evidence',
 *            peakEnergy: number, onsetRms: number, frames: number, hopSec: number,
 *            windowSec: number, voice: string, energies: number[]}}
 */
export function estimateSustain({ samples, sampleRate, note, config = {} }) {
  const cfg = sustainConfig(config);
  const voice = voiceOfInstrument(note.instrument);
  const vcfg = { ...cfg, ...(cfg.voices[voice] ?? {}) };
  const windowSec = vcfg.windowSec;
  const hopSec = vcfg.hopSec;
  const midi = Number.isFinite(note[vcfg.midiColumn]) ? note[vcfg.midiColumn] : note.midi;
  const frames = Math.max(1, Math.round(cfg.maxSustainSec / hopSec));

  const energies = [];
  let onsetRms = 0;
  for (let k = 0; k <= frames; k++) {
    const m = narrowbandEnergy({
      samples,
      sampleRate,
      midi,
      timeSec: note.timeSec + k * hopSec,
      a4: cfg.a4,
      windowSec,
      harmonicWeights: vcfg.harmonicWeights,
    });
    energies.push(m.energy);
    if (k === 0) onsetRms = m.rms;
  }

  const peakFrames = Math.max(0, Math.round(cfg.peakWindowSec / hopSec));
  // 攻击帧 = 起音后 0.2s 内**第一个**达到"起音峰值 × attackFraction"的帧。
  // 为什么不用"能量最大的那一帧"：单点 Goertzel 有扇形损失（频率不落在 bin 上时，功率随相位起伏），
  // 最大帧可能晚 1–3 帧，会把持续长度系统性地少算。用"第一个达到半峰"的帧既抵消了图表/音频
  // 之间 ≤1 帧的对齐误差（不这么做会有 389/2802 颗被测成"持续 0"），又不会被扇形损失往后拖。
  let peakEnergy = 0;
  for (let k = 0; k <= peakFrames && k < energies.length; k++) peakEnergy = Math.max(peakEnergy, energies[k]);
  let attackFrame = 0;
  for (let k = 0; k <= peakFrames && k < energies.length; k++) {
    if (energies[k] >= cfg.attackFraction * peakEnergy) { attackFrame = k; break; }
  }

  const base = {
    peakEnergy, onsetRms, frames, hopSec, windowSec, voice, energies, midi,
    attackOffsetSec: Number((attackFrame * hopSec).toFixed(6)),
  };
  const peakAmplitude = energyToAmplitude(peakEnergy, Math.max(16, Math.round(sampleRate * windowSec)));
  const weakPeak = !(peakEnergy > 0)
    || peakAmplitude < cfg.minPeakAmplitude
    || peakAmplitude < cfg.minPeakOverRms * onsetRms;
  if (onsetRms < cfg.minRms || weakPeak) {
    // 无证据：音频里听不出这颗音（静音段 / 八度写错 / 被盖住）→ 不猜长度、不追加
    return { ...base, sustainSec: 0, reason: 'weak-evidence' };
  }
  const floor = cfg.dropFraction * peakEnergy;
  for (let k = attackFrame; k < energies.length; k++) {
    if (energies[k] < floor) {
      return { ...base, sustainSec: Number(((k - attackFrame) * hopSec).toFixed(6)), reason: 'measured' };
    }
  }
  return { ...base, sustainSec: cfg.maxSustainSec, reason: 'at-cap' };
}

/* -------------------------------------------------------- 追加触发的规划 */

const cellKey = (n) => `${n.step}|${n.row ?? n.midi}`;

/**
 * 把"每颗音的持续长度"拆成"首触发 + 每 N 步一次重复触发"。纯函数，不读文件。
 *
 * @param {{notes: Array<object>, sustains: number[], config?: object}} args
 *   notes 需含 step、row、instrument、midi、timeSec、volume；sustains[i] = 第 i 颗音的持续秒数
 * @param {number[][]} [args.evidence] 可选：evidence[i][k] = 第 i 颗音第 k 次重复时刻的带内能量
 * @param {number} [args.evidenceFloor] 可选：与 evidence 配套的门槛（低于它就不追加）
 * @returns {{appended: Array<object>, perNote: Array<object>, stats: object}}
 */
export function planSustainRepeats({
  notes, sustains, config = {}, evidence = null, evidenceFloor = 0, evidenceOk = null,
}) {
  const cfg = sustainConfig(config);
  const intervalSec = cfg.repeatStepInterval * cfg.stepSec;
  const gate = evidence && cfg.minRepeatEnergyFraction > 0 && evidenceFloor > 0;
  // 原有音符按格索引：目标格被占时要分清"本来就有同音高触发"（无需追加）与"被别的音高占用"（只能放弃）
  const originalByCell = new Map(notes.map((n) => [cellKey(n), n]));
  const takenByAppend = new Set(); // 本次已追加出去的格（两个原音想追加到同一格时，后者让位）
  const appended = [];
  const perNote = [];
  const stats = {
    notes: notes.length,
    appendedTriggers: 0,
    lengthenedNotes: 0,
    lengthenedByVoice: {},
    plannedRepeats: 0,
    alreadyRetriggeredInInput: 0, // 目标格在输入谱面里本来就有同音高（同乐器）触发
    blockedByOtherPitch: 0,       // 目标格被别的音高占用（含被别的原音的追加占用）
    skippedWeakEvidence: 0,       // 该时刻音频里已经没有这颗音的证据（放弃追加）
    effectiveRepeats: 0,          // = 追加 + 输入里已有的同音高重触发（"该音被重新触发的次数"）
    appendedCounts: {},
    effectiveCounts: {},
    sustainHistogram: {},
  };

  notes.forEach((n, i) => {
    const sustainSec = Number(sustains[i]) || 0;
    const voice = voiceOfInstrument(n.instrument);
    const repeats = [];
    let planned = 0;
    let alreadyPresent = 0;
    let blocked = 0;
    let weak = 0;
    if (sustainSec > cfg.minRepeatSustainSec) {
      const maxK = Math.floor(sustainSec / intervalSec + 1e-9);
      for (let k = 1; k <= maxK; k++) {
        if (evidenceOk && evidenceOk[i]?.[k] === false) { weak += 1; planned += 1; continue; }
        if (gate) {
          const e = evidence[i]?.[k] ?? 0;
          if (e < evidenceFloor) { weak += 1; planned += 1; continue; }
        }
        const step = n.step + cfg.repeatStepInterval * k;
        const key = `${step}|${n.row ?? n.midi}`;
        planned += 1;
        const orig = originalByCell.get(key);
        if (orig) {
          // 同一个 (step,row) 上已经是同一乐器 + 同一音高 → 输入谱面本来就在这个时刻重触发了这颗音
          if (orig.midi === n.midi && orig.instrument === n.instrument) alreadyPresent += 1;
          else blocked += 1;
          continue;
        }
        if (takenByAppend.has(key)) { blocked += 1; continue; }
        takenByAppend.add(key);
        const tick = step * cfg.ticksPerStep;
        const timeSec = Number((n.timeSec + intervalSec * k).toFixed(3));
        const volume = Number((n.volume * Math.pow(cfg.volumeDecay, k)).toFixed(3));
        const row = {
          step,
          tick,
          timeSec,
          instrument: n.instrument,
          midi: n.midi,           // 同音高：不换音级、不换八度
          row: n.row,
          volume,
          sustainOf: n.step,      // 原音在输入里的 step（与 row+instrument 一起唯一确定原音）
          sustainIndex: k,        // 第几次重复（1 起）
          originNoteId: n.noteId ?? i,
        };
        appended.push(row);
        repeats.push(row);
      }
    }
    stats.appendedTriggers += repeats.length;
    stats.plannedRepeats += planned;
    stats.alreadyRetriggeredInInput += alreadyPresent;
    stats.blockedByOtherPitch += blocked;
    stats.skippedWeakEvidence += weak;
    stats.effectiveRepeats += repeats.length + alreadyPresent;
    if (repeats.length > 0) {
      stats.lengthenedNotes += 1;
      stats.lengthenedByVoice[voice] = (stats.lengthenedByVoice[voice] ?? 0) + 1;
    }
    stats.appendedCounts[repeats.length] = (stats.appendedCounts[repeats.length] ?? 0) + 1;
    const eff = repeats.length + alreadyPresent;
    stats.effectiveCounts[eff] = (stats.effectiveCounts[eff] ?? 0) + 1;
    stats.sustainHistogram[Number(sustainSec.toFixed(2))] = (stats.sustainHistogram[Number(sustainSec.toFixed(2))] ?? 0) + 1;
    perNote.push({
      noteId: n.noteId ?? i,
      step: n.step,
      timeSec: n.timeSec,
      instrument: n.instrument,
      voice,
      midi: n.midi,
      row: n.row,
      volume: n.volume,
      sustainSec,
      repeats: repeats.length,
      plannedRepeats: planned,
      alreadyRetriggeredInInput: alreadyPresent,
      blockedByOtherPitch: blocked,
      skippedWeakEvidence: weak,
      effectiveRepeats: eff,
      reason: sustainSec <= cfg.minRepeatSustainSec ? 'below-threshold' : repeats.length > 0 ? 'sustained' : 'all-cells-occupied',
    });
  });

  appended.sort((a, b) => a.step - b.step || a.row - b.row || a.sustainOf - b.sustainOf);
  return { appended, perNote, stats };
}

/* -------------------------------------------------------- 空隙占比（诊断） */

/**
 * "音频有能量但谱面 2 步内无触发"的空隙占比。
 * 口径：逐 step 取 0.12s 窗的 RMS，> floorFraction × 中位数 记为"音频有能量"；
 * 该 step 的 ±neighborSteps 步内没有任何触发记为"空隙"。maxStep 显式传入，保证前后可比。
 */
export function emptyGapRate({ samples, sampleRate, steps, maxStep, config = {} }) {
  const cfg = sustainConfig(config);
  const { floorFraction, neighborSteps, direction } = cfg.gap;
  const stepSamples = Math.max(1, Math.round(cfg.stepSec * sampleRate));
  const rms = [];
  for (let k = 0; k <= maxStep; k++) {
    rms.push(rmsOf(sliceWindow(samples, Math.round(k * cfg.stepSec * sampleRate), stepSamples)));
  }
  const threshold = floorFraction * percentile([...rms].sort((a, b) => a - b), 0.5);
  const has = new Array(maxStep + 1).fill(false);
  const dFrom = -neighborSteps;
  const dTo = direction === 'preceding' ? 0 : neighborSteps;
  for (const s of steps) {
    for (let d = dFrom; d <= dTo; d++) {
      const k = s + d;
      if (k >= 0 && k <= maxStep) has[k] = true;
    }
  }
  let energySteps = 0;
  const gaps = [];
  for (let k = 0; k <= maxStep; k++) {
    if (!(rms[k] > threshold)) continue;
    energySteps += 1;
    if (!has[k]) gaps.push(k);
  }
  return {
    rate: energySteps ? gaps.length / energySteps : 0,
    gapSteps: gaps.length,
    energySteps,
    maxStep,
    threshold,
    gapStepList: gaps,
  };
}

/* ---------------------------------------------------------- CSV 文本入口 */

/**
 * CSV 文本 + 音频 → 延音后的 CSV 文本 + 报告。
 * 原行**逐字符保留**（只多接两列：sustainOf 空 / sustainIndex 0），新行统一追加在文件末尾。
 */
export function sustainCsvText({ csvText: text, samples, sampleRate, config = {} }) {
  const cfg = sustainConfig(config);
  const { header, notes } = readNotesCsv(text);
  const estimates = notes.map((n) => estimateSustain({ samples, sampleRate, note: n, config: cfg }));
  const intervalSec = cfg.repeatStepInterval * cfg.stepSec;
  // 追加门槛：该时刻的带内能量（直接从上面的逐帧测量里取样）≥ 0.1 × 全曲逐音起音峰值中位数
  const peaks = estimates.map((e) => e.peakEnergy).filter((e) => e > 0).sort((a, b) => a - b);
  const evidenceFloor = cfg.minRepeatEnergyFraction > 0 ? cfg.minRepeatEnergyFraction * percentile(peaks, 0.5) : 0;
  const plannedMaxK = (s) => Math.floor(s / intervalSec + 1e-9);
  const evidence = estimates.map((e) => {
    const arr = [0];
    for (let k = 1; k <= plannedMaxK(e.sustainSec); k++) {
      const idx = Math.min(e.energies.length - 1, Math.round((k * intervalSec) / e.hopSec));
      arr.push(e.energies[idx] ?? 0);
    }
    return arr;
  });
  // 可选的最严口径：该时刻"这颗音自己的八度"在同一音级的候选八度里最响
  const evidenceOk = cfg.requireOwnOctaveDominant
    ? notes.map((n, i) => {
      const voice = voiceOfInstrument(n.instrument);
      const vcfg = { ...cfg, ...(cfg.voices[voice] ?? {}) };
      const [lo, hi] = cfg.registers[voice] ?? cfg.registers.melody;
      const pc = ((Math.round(n.midi) % 12) + 12) % 12;
      const candidates = [];
      for (let m = pc; m <= 127; m += 12) if (m >= lo && m <= hi) candidates.push(m);
      const own = n.midi;
      const arr = [true];
      for (let k = 1; k <= plannedMaxK(estimates[i].sustainSec); k++) {
        const t = n.timeSec + intervalSec * k;
        let ownE = 0;
        let maxOther = 0;
        for (const m of candidates) {
          const e = narrowbandEnergy({
            samples, sampleRate, midi: m, timeSec: t, a4: cfg.a4,
            windowSec: vcfg.windowSec, harmonicWeights: vcfg.harmonicWeights,
          }).energy;
          if (m === own) ownE = Math.max(ownE, e);
          else maxOther = Math.max(maxOther, e);
        }
        arr.push(ownE >= maxOther && (evidenceFloor <= 0 || ownE >= evidenceFloor));
      }
      return arr;
    })
    : null;
  const { appended, perNote, stats } = planSustainRepeats({
    notes,
    sustains: estimates.map((e) => e.sustainSec),
    config: cfg,
    evidence,
    evidenceFloor,
    evidenceOk,
  });

  const rows = notes.map((n) => [...n.fields, '', '0']);
  for (const a of appended) {
    rows.push([a.step, a.tick, a.timeSec.toFixed(3), a.instrument, a.midi, a.row, a.volume.toFixed(3), a.sustainOf, a.sustainIndex]);
  }
  const csv = csvText([...header, ...EXTRA_CSV_COLUMNS], rows);

  const maxStep = notes.reduce((m, n) => Math.max(m, n.step), 0);
  const stepsBefore = notes.map((n) => n.step);
  const stepsAfter = [...stepsBefore, ...appended.map((a) => a.step)];
  const gapRates = (direction) => ({
    before: emptyGapRate({ samples, sampleRate, steps: stepsBefore, maxStep, config: { ...cfg, gap: { ...cfg.gap, direction } } }),
    after: emptyGapRate({ samples, sampleRate, steps: stepsAfter, maxStep, config: { ...cfg, gap: { ...cfg.gap, direction } } }),
  });
  const neighbor = gapRates('neighbor');
  const preceding = gapRates('preceding');

  const reasons = {};
  for (const e of estimates) reasons[e.reason] = (reasons[e.reason] ?? 0) + 1;
  const perNoteSustain = estimates.map((e) => e.sustainSec);
  const perNoteRepeats = perNote.map((p) => p.repeats);
  const perNoteEffective = perNote.map((p) => p.effectiveRepeats);
  const perNotePlanned = perNote.map((p) => p.plannedRepeats);
  const longIdx = perNoteSustain.map((s, i) => [s, i]).filter(([s]) => s > cfg.minRepeatSustainSec);
  // 输入谱面里本来就有多少处"同一 (step+2,row) 上的同音高重触发"（说明长音在输入里已被部分编码）
  const byCell = new Map(notes.map((n) => [cellKey(n), n]));
  const inputRearticulationAt2Steps = notes.filter((n) => {
    const next = byCell.get(`${n.step + cfg.repeatStepInterval}|${n.row ?? n.midi}`);
    return next && next.midi === n.midi && next.instrument === n.instrument;
  }).length;

  const report = {
    $schema: 'nbforge.sustain-report/v0',
    config: {
      windowSec: cfg.windowSec,
      hopSec: cfg.hopSec,
      peakWindowSec: cfg.peakWindowSec,
      dropFraction: cfg.dropFraction,
      maxSustainSec: cfg.maxSustainSec,
      minRepeatSustainSec: cfg.minRepeatSustainSec,
      repeatStepInterval: cfg.repeatStepInterval,
      volumeDecay: cfg.volumeDecay,
      stepSec: cfg.stepSec,
      midiColumn: cfg.midiColumn,
      harmonicWeights: cfg.harmonicWeights,
      voices: cfg.voices,
      gap: cfg.gap,
      minRepeatEnergyFraction: cfg.minRepeatEnergyFraction,
    },
    summary: {
      notesIn: notes.length,
      notesOut: notes.length + appended.length,
      ...stats,
      evidenceFloor,
      reasons,
      perNoteSustain,
      perNoteRepeats,
      perNoteEffectiveRepeats: perNoteEffective,
      perNotePlannedRepeats: perNotePlanned,
      inputRearticulationAt2Steps,
      correlation: {
        // 验收口径 = 有效重复触发次数（本次追加 + 输入里已有的同音高重触发）vs 音频估出的持续时长
        effective: {
          pearson: Number(pearson(perNoteEffective, perNoteSustain).toFixed(6)),
          spearman: Number(spearman(perNoteEffective, perNoteSustain).toFixed(6)),
          n: perNoteEffective.length,
        },
        // 规则计划次数（floor(持续/0.24)，与持续时长单调）
        planned: {
          pearson: Number(pearson(perNotePlanned, perNoteSustain).toFixed(6)),
          n: perNotePlanned.length,
        },
        // 实际写进 CSV 的次数（少了"该格已被别的音高占用"的那部分）
        appended: {
          pearson: Number(pearson(perNoteRepeats, perNoteSustain).toFixed(6)),
          n: perNoteRepeats.length,
        },
        // 只看"真的被判成长音"的那一批（有效次数）：若接近 0，说明这一批内部被"占格"主导
        aboveThreshold: {
          pearson: longIdx.length > 2
            ? Number(pearson(longIdx.map(([, i]) => perNoteEffective[i]), longIdx.map(([s]) => s)).toFixed(6))
            : null,
          n: longIdx.length,
        },
      },
    },
    gap: {
      definition: '逐 step 的 0.12s 窗 RMS > 0.1×中位数 = 音频有能量；再按两种"无触发"读法数空隙',
      definitionNeighbor: '±2 步内没有任何触发（任务书字面口径）',
      definitionPreceding: '之前 2 步内没有触发（机器的音已衰减完还没被重新触发，更贴近"断奏"）',
      maxStep,
      neighbor,
      preceding,
      before: neighbor.before,
      after: neighbor.after,
    },
    notes: notes.map((n, i) => ({
      ...perNote[i],
      sustainReason: estimates[i].reason,
      peakEnergy: estimates[i].peakEnergy,
      onsetRms: estimates[i].onsetRms,
      attackOffsetSec: estimates[i].attackOffsetSec,
    })),
    repeats: appended,
    degradations: estimates
      .map((e, i) => ({ noteId: i, step: notes[i].step, reason: e.reason }))
      .filter((d) => d.reason !== 'measured'),
  };
  return { csv, report, notes, appended, estimates, perNote, stats };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const num = (v) => (typeof v === 'string' ? Number(v) : undefined);
  const voices = {};
  if (num(args['melody-window']) !== undefined) voices.melody = { windowSec: num(args['melody-window']) };
  if (num(args['inner-window']) !== undefined) voices.inner = { windowSec: num(args['inner-window']) };
  if (num(args['bass-window']) !== undefined) voices.bass = { windowSec: num(args['bass-window']) };
  const inPath = args.in ?? `${BUILD}/styx_helix_machine.csv`;
  const outPath = args.out ?? `${BUILD}/machine_sustain.csv`;
  const reportPath = typeof args.report === 'string' ? args.report : `${BUILD}/sustain-report.json`;
  const wavPath = args.audio ?? `${BUILD}/styx_helix_full.wav`;
  const config = {
    ...(num(args.window) !== undefined ? { windowSec: num(args.window) } : {}),
    ...(num(args.hop) !== undefined ? { hopSec: num(args.hop) } : {}),
    ...(num(args['peak-window']) !== undefined ? { peakWindowSec: num(args['peak-window']) } : {}),
    ...(num(args.drop) !== undefined ? { dropFraction: num(args.drop) } : {}),
    ...(num(args.cap) !== undefined ? { maxSustainSec: num(args.cap) } : {}),
    ...(num(args['min-sustain']) !== undefined ? { minRepeatSustainSec: num(args['min-sustain']) } : {}),
    ...(num(args.decay) !== undefined ? { volumeDecay: num(args.decay) } : {}),
    ...(num(args.interval) !== undefined ? { repeatStepInterval: num(args.interval) } : {}),
    ...(num(args['evidence-fraction']) !== undefined ? { minRepeatEnergyFraction: num(args['evidence-fraction']) } : {}),
    ...(args['own-octave'] ? { requireOwnOctaveDominant: true } : {}),
    ...(typeof args['midi-column'] === 'string' ? { midiColumn: args['midi-column'] } : {}),
    ...(Object.keys(voices).length > 0 ? { voices } : {}),
  };

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(wavPath);
  const { csv, report } = sustainCsvText({ csvText: fs.readFileSync(inPath, 'utf8'), samples, sampleRate, config });
  fs.writeFileSync(outPath, csv, 'utf8');
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({
      ...report,
      meta: { inPath, wavPath, outPath, audioSeconds: Number(seconds.toFixed(3)), sampleRate },
    }, null, 1) + '\n', 'utf8');
  }

  const s = report.summary;
  const pct = (x) => `${(100 * x).toFixed(2)}%`;
  console.log(`长音/延音：${inPath}（${s.notesIn} 颗音，${seconds.toFixed(1)}s 音频）`);
  console.log(`  口径：窗 ${(report.config.windowSec * 1000).toFixed(0)}ms / 步进 ${(report.config.hopSec * 1000).toFixed(0)}ms`
    + `${report.config.voices.melody || report.config.voices.bass ? `（逐声部覆盖 ${JSON.stringify(report.config.voices)}）` : ''}`
    + ` / 起音峰值窗 ${(report.config.peakWindowSec * 1000).toFixed(0)}ms / 跌破 ${report.config.dropFraction * 100}% 即结束 / 上限 ${report.config.maxSustainSec}s`);
  console.log(`  拆重复触发：持续 >${report.config.minRepeatSustainSec}s 的音 → 每 ${report.config.repeatStepInterval} 步（${(report.config.repeatStepInterval * report.config.stepSec).toFixed(2)}s）一次，力度 ×${report.config.volumeDecay} 递减`);
  console.log(`  持续估计：measured ${s.reasons.measured ?? 0}｜at-cap ${s.reasons['at-cap'] ?? 0}｜weak-evidence ${s.reasons['weak-evidence'] ?? 0}`);
  console.log(`  计划重复触发 ${s.plannedRepeats} 次 → 新增写入 ${s.appendedTriggers} 次`
    + `（输入里本来就有同音高重触发 ${s.alreadyRetriggeredInInput} 次、被别的音高占用 ${s.blockedByOtherPitch} 次、`
    + `音频已衰减到门槛下 ${s.skippedWeakEvidence} 次，均放弃）`);
  if (s.evidenceFloor > 0) {
    console.log(`  追加门槛：该时刻带内能量 ≥ ${report.config.minRepeatEnergyFraction} × 起音峰值中位数 = ${s.evidenceFloor.toExponential(3)}`
      + `（与 score 的漏音阈值同口径；门槛以下不追加，避免"加原曲没有的声音"）`);
  }
  console.log(`  被延长的音 ${s.lengthenedNotes} 颗（${JSON.stringify(s.lengthenedByVoice)}）｜有效重复次数分布 ${JSON.stringify(s.effectiveCounts)}`
    + `｜输入里 (step+2,row) 同音高重触发共 ${s.inputRearticulationAt2Steps} 处`);
  console.log(`  相关：有效重复次数 ${s.correlation.effective.pearson.toFixed(4)}（ρ=${s.correlation.effective.spearman.toFixed(4)}，n=${s.correlation.effective.n}）`
    + `｜计划次数 ${s.correlation.planned.pearson.toFixed(4)}｜实际写入 ${s.correlation.appended.pearson.toFixed(4)}`
    + `｜>${report.config.minRepeatSustainSec}s 组内 ${s.correlation.aboveThreshold.pearson}`);
  console.log(`  空隙占比（音频有能量但谱面 2 步内无触发）：${pct(report.gap.before.rate)}（${report.gap.before.gapSteps}/${report.gap.before.energySteps}）`
    + ` → ${pct(report.gap.after.rate)}（${report.gap.after.gapSteps}/${report.gap.after.energySteps}）`);
  console.log(`    另读法（之前 2 步内无触发 = 机器已衰减完还没被重触发）：${pct(report.gap.preceding.before.rate)}`
    + ` → ${pct(report.gap.preceding.after.rate)}（${report.gap.preceding.before.gapSteps} → ${report.gap.preceding.after.gapSteps} 步）`);
  console.log(`  → ${outPath}`);
  if (reportPath) console.log(`  → ${reportPath}`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
