// M1-3 · 起音补漏：谱面在"音频明明有攻击"的位置上没有音 → 补候选音
//
// 定位（与 M1-1 同一套证据纪律）：M0 的结论是"检测器太保守（R 0.805）导致旋律缺音"。
// 换成 `analyze/onset-detect.mjs` 的分频带多分辨率检测器后，**音频检出 1829 个起音 ≈ 谱面
// 1821 个**（R 0.974）——也就是说"谱面起音数量不足"这个前提站不住：真正错的是**检测器**。
// 本模块处理的是剩下那一小块：音频有起音、而谱面在该时刻 50ms 内**一颗音都没有**的位置
// （实测 ~55 个），用该时刻的窄带能量判音级与八度，补出候选音。
//
// 口径（每条都写进 docs/M1-3-report.md）：
//   · 候选 = midi 21..102 全枚举（音级 × 八度一起判），逐条量 f0 与 f0±0.25 bin 三探针的
//     加窗 DFT 功率（复用 pitch-fix 的 candidatePeak，抵掉扇形损失），只用基频 `[1]`
//     （加 2f0 会让"高一个八度的同一音级"互相污染，见 M1-1 §1）。
//   · 音级判定：同一音级的各八度取最强 → 最强音级 / 次强音级 ≥ 1.6 才动，否则 `below-margin`。
//   · 八度判定：同一音级的各八度之间也要求 ≥ `octaveMargin`，否则 `octave-ambiguous`。
//   · 证据门槛（沿用 M1-1）：窗内 RMS ≥ 0.01，最强峰基频振幅 ≥ 0.02 且 ≥ 0.1×窗内 RMS。
//   · 音区 → 乐器：midi ≤ 55 → `bass`，其余 → `harp`（与 machine_p1 的实测音域一致：
//     贝斯 21–61 / 竖琴 56–102）。
//   · 时间对齐：补出的音落在谱面的 0.12s 步网格上（`step = round(t/0.12)`，
//     `tick = step×12`，`time_seconds = step×0.12`），与流水线其余部分同一套坐标。
//     代价写进报告：贴网格会吃掉一部分"对齐"余量（实测 recall 0.974 → 0.972）。
//   · 力度：用 `velocity.mjs` 的 T5 口径（该音级该八度的窄带能量 → p10/p90 → 0.35..1.0），
//     和原谱面同一把尺子；原有行**逐字符保留**，只追加 origin/recoverReason/recoverMargin 三列。
import fs from 'node:fs';

import {
  midiName,
  narrowbandEnergy,
  pcOf,
  readNotesCsv,
  readWav,
} from '../analyze/dsp.mjs';
import { DEFAULT_ONSET_DETECT_CONFIG, detectBandOnsets, legacyOnsets } from '../analyze/onset-detect.mjs';
import { DEFAULT_CURSORS, foldOne } from './fold.mjs';
import { candidatePeak, energyToAmplitude } from './pitch-fix.mjs';
import { measureVelocity, velocityConfig } from './velocity.mjs';
import { resolvePaths } from '../core/paths.mjs';

export { readNotesCsv, readWav };

export const EXTRA_CSV_COLUMNS = ['origin', 'recoverReason', 'recoverMargin'];

export const DEFAULT_ONSET_RECOVER_CONFIG = {
  STEP_SEC: 0.12,          // 谱面步长（♩=125 的 16 分格；machine_p1 实测严格落在 0.12s 网格）
  tolSec: 0.05,            // "50ms 内没有音"才算未覆盖（与 score.mjs 的起音容差同口径）
  minMidi: 21,
  maxMidi: 102,
  bassMaxMidi: 55,         // midi ≤ 55 → bass，其余 harp（按 machine_p1 的实测音域切）
  windowSec: 0.1,          // 第一遍（判音级）统一窗长
  windows: { bass: 0.12, harp: 0.1 },   // 第二遍（复测/力度）按音区
  a4: 440,
  harmonicWeights: [1],    // 只用基频（M1-1 §1：加谐波会破坏八度隔离）
  probeFrac: 0.25,         // 三探针：f0 与 f0 ± 0.25 bin 取最大
  margin: 1.6,             // 最强音级 / 次强音级
  octaveMargin: 1.2,       // 同一音级内最强八度 / 次强八度
  minRms: 0.01,
  minAmplitude: 0.02,
  minAmpOverRms: 0.1,
  maxRecover: 2000,        // 安全阀：异常情况下不至于补出成千上万颗
  attackCheckSec: 0.12,    // "这是新攻击"的对照窗：候选音在 t 与 t−0.12s 的能量比
  minAttackRatio: 1.25,    // 能量比 < 此值 → 不是新攻击（前音的衰减尾巴/拍频），记 decaying-tail
  samePitchTolSec: 0.12,   // 谱面 0.12s 内已有同音高 → 同一次攻击的量化差，不重复补
  detector: 'banded',
  banded: {},
};

export function recoverConfig(config = {}) {
  const cfg = { ...DEFAULT_ONSET_RECOVER_CONFIG, ...config };
  return {
    ...cfg,
    windows: { ...DEFAULT_ONSET_RECOVER_CONFIG.windows, ...(config.windows ?? {}) },
    banded: { ...DEFAULT_ONSET_DETECT_CONFIG, ...(config.banded ?? {}) },
  };
}

/** 谱面起音时刻（去重升序） */
export const chartOnsetTimes = (notes) => [...new Set(notes.map((n) => n.timeSec))].sort((a, b) => a - b);

/**
 * "音频有起音、谱面 50ms 内没有音"的位置。
 * 口径与 score.mjs 的起音对齐完全一致（容差 tolSec，边界算覆盖）。
 */
export function uncoveredOnsets({ chartTimes, onsets, tolSec = DEFAULT_ONSET_RECOVER_CONFIG.tolSec }) {
  const chart = [...chartTimes].sort((a, b) => a - b);
  const out = [];
  let i = 0;
  for (const o of [...onsets].sort((a, b) => a.time - b.time)) {
    while (i < chart.length && chart[i] < o.time - tolSec) i++;
    const covered = i < chart.length && Math.abs(chart[i] - o.time) <= tolSec;
    if (!covered) out.push(o);
  }
  return out;
}

/**
 * 单个时刻的"漏音"判定：音级 + 八度 + 音区。
 * @returns {{midi: number|null, reason: string, ...证据}}
 */
export function pickMissingNote({ samples, sampleRate, timeSec, config = {} }) {
  const cfg = recoverConfig(config);
  const probe = (midi, windowSec) => candidatePeak({
    samples,
    sampleRate,
    midi,
    timeSec,
    a4: cfg.a4,
    windowSec,
    harmonicWeights: cfg.harmonicWeights,
    probeFrac: cfg.probeFrac,
  });

  // 第一遍：全音域枚举（统一窗长），同一音级的各八度取最强
  const measured = [];
  for (let m = Math.max(0, cfg.minMidi); m <= Math.min(127, cfg.maxMidi); m++) measured.push({ midi: m, ...probe(m, cfg.windowSec) });
  const rms = measured.length ? measured[0].rms : 0;
  const byPc = new Map();
  for (const it of measured) {
    const pc = pcOf(it.midi);
    const cur = byPc.get(pc);
    if (!cur || it.energy > cur.energy) byPc.set(pc, it);
  }
  const byPcOctaves = new Map();
  for (const it of measured) {
    const pc = pcOf(it.midi);
    if (!byPcOctaves.has(pc)) byPcOctaves.set(pc, []);
    byPcOctaves.get(pc).push(it);
  }
  const ranked = [...byPc.values()].sort((a, b) => b.energy - a.energy);
  const best = ranked[0] ?? { midi: null, energy: 0, windowSamples: 1 };
  const second = ranked[1] ?? null;
  const margin = second && second.energy > 0 ? best.energy / second.energy : Infinity;
  const amplitude = energyToAmplitude(best.energy, best.windowSamples);
  const base = {
    timeSec,
    midi: null,
    pc: best.midi === null ? null : pcOf(best.midi),
    pcName: best.midi === null ? null : midiName(best.midi),
    instrument: null,
    energy: best.energy,
    margin: Number.isFinite(margin) ? Number(margin.toFixed(4)) : null,
    octaveMargin: null,
    rms,
    amplitude,
    windowSec: cfg.windowSec,
    runnerUpPc: second ? pcOf(second.midi) : null,
    runnerUpName: second ? midiName(second.midi) : null,
  };
  if (rms < cfg.minRms) return { ...base, reason: 'weak-evidence' };
  if (!(best.energy > 0) || amplitude < cfg.minAmplitude || amplitude < cfg.minAmpOverRms * rms) {
    return { ...base, reason: 'no-peak' };
  }
  if (margin < cfg.margin) return { ...base, reason: 'below-margin' };

  // 八度确认：同一音级的各八度之间也要拉开距离
  const samePc = (byPcOctaves.get(pcOf(best.midi)) ?? []).slice().sort((a, b) => b.energy - a.energy);
  const secondOctave = samePc.find((it) => it.midi !== best.midi) ?? null;
  const octaveMargin = secondOctave && secondOctave.energy > 0 ? best.energy / secondOctave.energy : Infinity;
  const instrument = best.midi <= cfg.bassMaxMidi ? 'bass' : 'harp';
  const windowSec = cfg.windows[instrument] ?? cfg.windowSec;
  // 第二遍：按该音区的窗长复测（低音 120ms，一个半音才够一个 bin）
  const confirmed = probe(best.midi, windowSec);
  const confirmedAmp = energyToAmplitude(confirmed.energy, confirmed.windowSamples);
  const out = {
    ...base,
    midi: best.midi,
    instrument,
    energy: confirmed.energy,
    amplitude: confirmedAmp,
    rms: confirmed.rms,
    windowSec,
    octaveMargin: Number.isFinite(octaveMargin) ? Number(octaveMargin.toFixed(4)) : null,
    candidates: samePc.slice(0, 3).map((it) => ({ midi: it.midi, name: midiName(it.midi), energy: it.energy })),
  };
  if (octaveMargin < cfg.octaveMargin) return { ...out, reason: 'octave-ambiguous' };
  if (confirmed.rms < cfg.minRms) return { ...out, reason: 'weak-evidence' };
  if (!(confirmed.energy > 0) || confirmedAmp < cfg.minAmplitude || confirmedAmp < cfg.minAmpOverRms * confirmed.rms) {
    return { ...out, reason: 'no-peak' };
  }
  // "这是新攻击还是前音的衰减/拍频？"：同一音高在 t−0.12s 的能量若不低于此刻，就不是新攻击。
  // 实测依据（docs/M1-3-report.md §4.3）：真实数据上 4 个"最强音级"候选里 3 个在检测时刻
  // 的自身能量比 120ms 前低 8%–72%（衰减中的音在谱上互相拍频也会造出通量峰）。
  const prev = narrowbandEnergy({
    samples,
    sampleRate,
    midi: best.midi,
    timeSec: timeSec - cfg.attackCheckSec,
    a4: cfg.a4,
    windowSec,
    harmonicWeights: cfg.harmonicWeights,
  });
  const attackRatio = prev.energy > 0 ? confirmed.energy / prev.energy : Infinity;
  const withRatio = { ...out, attackRatio: Number.isFinite(attackRatio) ? Number(attackRatio.toFixed(4)) : null };
  if (attackRatio < cfg.minAttackRatio) return { ...withRatio, reason: 'decaying-tail' };
  return { ...withRatio, reason: 'recovered' };
}

/**
 * 起音补漏主流程。
 * @returns {{header: string[], notes: Array, csv: string, recovered: Array, degradations: Array, report: object}}
 */
export function onsetRecover({ csvText: text, samples, sampleRate, config = {} }) {
  const cfg = recoverConfig(config);
  const stepSec = cfg.stepSec ?? cfg.STEP_SEC;
  const { header, notes } = readNotesCsv(text);
  const chartTimes = chartOnsetTimes(notes);

  const detected = cfg.detector === 'legacy'
    ? { times: legacyOnsets({ samples, sampleRate }).times.map((t) => ({ time: t })), detail: null, detector: 'legacy' }
    : { ...detectBandOnsets({ samples, sampleRate, config: cfg.banded }), detector: 'banded' };
  const audioOnsets = detected.onsets ?? detected.times;

  const uncovered = uncoveredOnsets({ chartTimes, onsets: audioOnsets, tolSec: cfg.tolSec });
  const occupied = new Set(notes.map((n) => `${n.step}|${n.midi}`));
  const byMidiTimes = new Map();
  for (const n of notes) {
    if (!byMidiTimes.has(n.midi)) byMidiTimes.set(n.midi, []);
    byMidiTimes.get(n.midi).push(n.timeSec);
  }
  for (const arr of byMidiTimes.values()) arr.sort((a, b) => a - b);
  const sameAttackAsChart = (midi, t) => (byMidiTimes.get(midi) ?? []).some((x) => Math.abs(x - t) <= cfg.samePitchTolSec);
  const recovered = [];
  const degradations = [];
  for (const o of uncovered) {
    if (recovered.length >= cfg.maxRecover) break;
    const step = Math.round(o.time / stepSec);
    const r = pickMissingNote({ samples, sampleRate, timeSec: o.time, config: cfg });
    if (r.reason !== 'recovered') {
      degradations.push({
        timeSec: o.time, step, reason: r.reason, pcName: r.pcName, margin: r.margin,
        attackRatio: r.attackRatio ?? null, rms: r.rms, amplitude: r.amplitude,
      });
      continue;
    }
    if (sameAttackAsChart(r.midi, o.time)) {
      degradations.push({
        timeSec: o.time, step, reason: 'same-attack-as-chart', midi: r.midi, pcName: r.pcName,
        margin: r.margin, rms: r.rms, amplitude: r.amplitude, attackRatio: r.attackRatio,
      });
      continue;
    }
    if (occupied.has(`${step}|${r.midi}`)) {
      degradations.push({
        timeSec: o.time, step, reason: 'duplicate-cell', midi: r.midi, pcName: r.pcName,
        margin: r.margin, rms: r.rms, amplitude: r.amplitude, attackRatio: r.attackRatio,
      });
      continue;
    }
    occupied.add(`${step}|${r.midi}`);
    recovered.push({
      timeSec: o.time,                       // 检测到的起音时刻
      stepTimeSec: Number((step * stepSec).toFixed(3)),   // 写进谱面的时刻（吸附到 0.12s 网格）
      step,
      tick: step * 12,
      midi: r.midi,
      midiName: midiName(r.midi),
      pc: r.pc,
      instrument: r.instrument,
      reason: 'recovered',
      margin: r.margin,
      octaveMargin: r.octaveMargin,
      attackRatio: r.attackRatio,
      energy: r.energy,
      amplitude: r.amplitude,
      rms: r.rms,
      windowSec: r.windowSec,
      onsetBands: o.bands ?? null,
      onsetProminence: o.prominence ?? null,
      onsetRms: o.rms ?? null,
      runnerUpName: r.runnerUpName,
    });
  }

  /* 行折叠：按 (step,midi) 走一遍游标，只为新音算 row（原有行的 row 保持原样） */
  const union = [
    ...notes.map((n) => ({ kind: 'original', step: n.step, midi: n.midi, instrument: n.instrument, row: n.row, fields: n.fields })),
    ...recovered.map((r) => ({ kind: 'recovered', step: r.step, midi: r.midi, instrument: r.instrument })),
  ].sort((a, b) => a.step - b.step || a.midi - b.midi || (a.kind === 'original' ? -1 : 1));
  const cursor = { ...DEFAULT_CURSORS };
  for (const row of union) {
    const voice = row.instrument === 'bass' ? 'bass' : 'harp';
    if (row.kind === 'original') {
      if (Number.isFinite(row.row)) cursor[voice] = row.row;
      continue;
    }
    row.row = foldOne(row.midi, cursor[voice]);
    cursor[voice] = row.row;
  }
  const rowOf = new Map(recovered.map((r) => [`${r.step}|${r.midi}`, null]));
  for (const row of union) if (row.kind === 'recovered') rowOf.set(`${row.step}|${row.midi}`, row.row);

  /* 力度：T5 口径（先量全部音的能量 → p10/p90 映射），新音取映射值，原有行保留原值 */
  const unionNotes = [
    ...notes.map((n) => ({ noteId: `orig-${n.noteId}`, step: n.step, timeSec: n.timeSec, instrument: n.instrument, midi: n.midi, volume: n.volume })),
    ...recovered.map((r) => ({ noteId: `new-${r.step}-${r.midi}`, step: r.step, timeSec: r.step * stepSec, instrument: r.instrument, midi: r.midi })),
  ];
  const vel = measureVelocity({ samples, sampleRate, notes: unionNotes, config: velocityConfig(cfg.velocity ?? {}) });
  const velOf = new Map(vel.results.map((v) => [v.noteId, v]));

  const lines = [[...header, ...EXTRA_CSV_COLUMNS].join(',')];
  for (const n of notes) lines.push([...n.fields, 'original', '', ''].join(','));
  for (const r of recovered) {
    const step = r.step;
    const velocity = velOf.get(`new-${r.step}-${r.midi}`);
    const volume = Number.isFinite(velocity?.velocity) ? velocity.velocity : 0.35;
    lines.push([
      step,
      step * 12,
      (step * stepSec).toFixed(3),
      r.instrument,
      r.midi,
      rowOf.get(`${r.step}|${r.midi}`),
      volume.toFixed(3),
      'recovered',
      r.reason,
      r.margin.toFixed(3),
    ].join(','));
  }

  const byInstrument = {};
  const byRegister = {};
  const byReason = {};
  for (const r of recovered) {
    byInstrument[r.instrument] = (byInstrument[r.instrument] ?? 0) + 1;
    const reg = `${Math.floor(r.midi / 12) * 12}–${Math.floor(r.midi / 12) * 12 + 11}`;
    byRegister[reg] = (byRegister[reg] ?? 0) + 1;
  }
  for (const d of degradations) byReason[d.reason] = (byReason[d.reason] ?? 0) + 1;

  const report = {
    meta: {
      chartNotes: notes.length,
      chartOnsets: chartTimes.length,
      audioOnsets: audioOnsets.length,
      detector: detected.detector,
      detectorDetail: detected.detail,
      tolSec: cfg.tolSec,
      stepSec,
      uncovered: uncovered.length,
      recovered: recovered.length,
      byInstrument,
      byRegister,
      degradations: byReason,
      gates: {
        margin: cfg.margin,
        octaveMargin: cfg.octaveMargin,
        minRms: cfg.minRms,
        minAmplitude: cfg.minAmplitude,
        minAmpOverRms: cfg.minAmpOverRms,
        bassMaxMidi: cfg.bassMaxMidi,
        harmonicWeights: cfg.harmonicWeights,
        probeFrac: cfg.probeFrac,
        windows: cfg.windows,
      },
      velocityEnergyP10: vel.meta.energyP10,
      velocityEnergyP90: vel.meta.energyP90,
    },
    recovered,
    degradations,
  };
  return { header: [...header, ...EXTRA_CSV_COLUMNS], notes, csv: lines.join('\n') + '\n', recovered, degradations, report };
}

export function recoverCsvText(args) {
  return onsetRecover(args);
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/arrange/onset-recover.mjs');

if (invokedDirectly) {
  const argv = process.argv.slice(2);
  const P = resolvePaths({ argv });
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const inPath = args.in ?? P.file('machine_p1.csv');
  const outPath = args.out ?? P.file('notes_recovered.csv');
  const reportPath = typeof args.report === 'string' ? args.report : P.file('onset_recover_report.json');
  const wavPath = args.audio ?? P.audio;
  const config = {
    ...(args.tol !== undefined ? { tolSec: Number(args.tol) } : {}),
    ...(args.margin !== undefined ? { margin: Number(args.margin) } : {}),
    ...(args.step !== undefined ? { stepSec: Number(args.step) } : {}),
    ...(args['max-recover'] !== undefined ? { maxRecover: Number(args['max-recover']) } : {}),
    ...(args.comb ? { harmonicWeights: [1, 0.5, 0.25] } : {}),
    ...(typeof args.detector === 'string' ? { detector: args.detector } : {}),
  };

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(wavPath);
  const { csv, report } = onsetRecover({ csvText: fs.readFileSync(inPath, 'utf8'), samples, sampleRate, config });
  fs.writeFileSync(outPath, csv, 'utf8');
  fs.writeFileSync(reportPath, JSON.stringify({
    $schema: 'nbforge.onset-recover-report/v0',
    inPath,
    audioPath: wavPath,
    outPath,
    command: `node src/arrange/onset-recover.mjs --in ${inPath} --out ${outPath}`,
    ...report,
  }, null, 1) + '\n', 'utf8');

  const m = report.meta;
  const pct = (x, n) => (n ? `${((100 * x) / n).toFixed(1)}%` : 'n/a');
  console.log(`起音补漏：${inPath}（${m.chartNotes} 颗音 / ${m.chartOnsets} 个起音；${seconds.toFixed(1)}s 音频）`);
  console.log(`  检测器 ${m.detector}：音频起音 ${m.audioOnsets} 个`);
  console.log(`  未覆盖（音频有起音、谱面 ${m.tolSec * 1000}ms 内没有音）：${m.uncovered} 个`);
  console.log(`  补出候选音 ${m.recovered} 个（${pct(m.recovered, m.uncovered)}）`
    + `：${Object.entries(m.byInstrument).map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}`);
  console.log(`  按音区：${Object.entries(m.byRegister).sort().map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}`);
  console.log(`  未补（降级，绝不静默）：${Object.entries(m.degradations).map(([k, v]) => `${k} ${v}`).join(' / ') || '无'}`);
  console.log(`  判定：最强/次强音级 ≥ ${m.gates.margin}、八度 ≥ ${m.gates.octaveMargin}、`
    + `RMS ≥ ${m.gates.minRms}、振幅 ≥ ${m.gates.minAmplitude} 且 ≥ ${m.gates.minAmpOverRms}×RMS`
    + `（midi ≤ ${m.gates.bassMaxMidi} → bass，其余 harp）`);
  for (const r of report.recovered.slice(0, 10)) {
    console.log(`    ${r.timeSec.toFixed(3)}s → step ${r.step} ${r.instrument} ${r.midiName}（midi ${r.midi}）`
      + ` 边距 ${r.margin} 八度边距 ${r.octaveMargin} 振幅 ${r.amplitude.toFixed(3)}`
      + ` 带 ${r.onsetBands ? r.onsetBands.length : 0} 突出度 ${r.onsetProminence ?? 'n/a'}`);
  }
  if (report.recovered.length > 10) console.log(`    …（其余 ${report.recovered.length - 10} 条见 ${reportPath}）`);
  console.log(`  → ${outPath}`);
  console.log(`  → ${reportPath}`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
