// T5b · 力度换口径：该音级在该八度上的短时能量 → 0..1
//
// 要打掉的口径：v3 的 `volume` 是"起音后 0.12s **整段混音**的 RMS"，
// 量的是"那一瞬间整段编曲多响"（鼓、贝斯、弦乐、人声都在里面），不是"这颗音弹得多重"。
// M0-1 报告 §4.1 实测的直接后果：同一步上所有音的 volume **完全相同**
// （distinct volume > 1 的 step 数 = 0），因为取的是同一段音频的同一个窗。
//
// 新口径（一句能说清）：对每颗音，量**它自己的音级 + 它自己的八度**上的短时窄带能量，
// 即 f0 处加窗 DFT 的功率 |X(f0)|²（Hann 窗，默认 100ms，从音符起始对齐），
// 再按全曲能量的 p10/p90 线性映射到 0.35..1.0（映射上下限沿用现状，见 DISCUSSION-C §4.2）。
//
// 三个刻意的取值（都写进 M0-3 报告）：
//   ① 只用基频，不加 2f0/3f0。加谐波会让"相邻八度的同一个音级"互相污染：
//      C4 的 2 次谐波正好是 C5 的基频，于是只响了 C5 时 C4 也会拿到一半能量。
//      要对照可传 `voices: { melody: { harmonicWeights: [1, 0.5, 0.25] } }`（CLI 的 --comb）。
//   ② 低音声部的窗取 **120ms**（一个步进），旋律取 100ms。原因：44.1kHz 下 100ms 窗的频率
//      分辨率是 10Hz，而低音区一个半音只有 4.3–6.9Hz（E2=82.4Hz 的半音 = 4.9Hz）——相邻半音
//      完全落在主瓣里，前一颗音的衰减尾巴（0.12s 后仍有 71% 幅度）会把能量算到这颗音头上。
//      合成贝斯线（0.12s 步进）实测：100ms 窗 r=0.57、120ms 窗 r=0.85、300ms 窗 r=0.91；
//      再长就会把下一颗音的攻击算进来，所以取 120ms（= 正好到下一颗音的起始）。
//   ③ 无证据（窗内 RMS < minRms）→ 力度 0，而不是地板 0.35：这里不是"很轻地弹了一下"，
//      而是"音频里听不出这颗音"。地板 0.35 只留给"有能量但落在 p10 以下"的音。
//   ④ 分位数跨度为 0（全部能量相同，或只有一颗音）→ 统一退到地板，不凭空给天花板。
//
// 重要限制：这个口径量在**给定的八度**上。若输入的八度本身是错的（v3 的贝斯大面积如此），
// 力度也会跟着错。流水线顺序应是 T3 修八度 → T5 换力度（CLI 传 `--midi-column newMidi`）。
import fs from 'node:fs';
import { resolvePaths } from '../core/paths.mjs';

import {
  csvText,
  midiToFreq,
  midiName,
  narrowbandEnergy,
  pearson,
  percentile,
  readNotesCsv,
  readWav,
} from '../analyze/dsp.mjs';
import { bandEnvelope, bandFluxes } from '../analyze/onset-detect.mjs';

export { csvText, readNotesCsv, readWav };

/** 乐器 → SPEC 声部（与 dedupe.mjs / octave-evidence.mjs 同一张表） */
export const VOICE_OF_INSTRUMENT = {
  harp: 'melody',
  bell: 'melody',
  chime: 'melody',
  guitar: 'melody',
  flute: 'melody',
  xylophone: 'melody',
  iron_xylophone: 'melody',
  cow_bell: 'melody',
  bit: 'melody',
  banjo: 'melody',
  pling: 'melody',
  bass: 'bass',
  didgeridoo: 'bass',
  basedrum: 'perc',
  snare: 'perc',
  hat: 'perc',
  melody: 'melody',
  inner: 'inner',
  perc: 'perc',
};

export function voiceOfInstrument(instrument) {
  return VOICE_OF_INSTRUMENT[String(instrument ?? '').trim()] ?? 'inner';
}

export const EXTRA_CSV_COLUMNS = ['velocity', 'velocityRaw', 'velocityReason'];

export const DEFAULT_VELOCITY_CONFIG = {
  windowSec: 0.1,        // 100ms，从音符起始对齐（与 T2 八度证据同窗）
  a4: 440,
  minRms: 0.01,          // 窗内 RMS 低于此值 → 无证据
  floor: 0.35,           // 力度地板：有能量但落在 p10 以下
  ceiling: 1.0,          // 力度天花板：能量到 p90
  percentileLow: 0.1,
  percentileHigh: 0.9,
  midiColumn: 'midi',    // 'midi' 用输入音高；'newMidi' 用 T3 修复后的音高
  voices: {
    melody: { harmonicWeights: [1], windowSec: 0.1 },
    inner: { harmonicWeights: [1], windowSec: 0.1 },
    bass: { harmonicWeights: [1], windowSec: 0.12 },
    perc: { harmonicWeights: [1], windowSec: 0.1 },
  },
};

/** 合并配置（voices 逐声部合并，便于只覆盖 melody 的梳状口径做对照） */
export function velocityConfig(config = {}) {
  const voices = { ...DEFAULT_VELOCITY_CONFIG.voices };
  for (const [k, v] of Object.entries(config.voices ?? {})) voices[k] = { ...(voices[k] ?? {}), ...v };
  return { ...DEFAULT_VELOCITY_CONFIG, ...config, voices };
}

/**
 * 能量序列 → 0..1 力度（分位数映射，单调不减）。
 * 能量 ≤ 0 一律给 0（"没有证据"，不做地板处理）；分位数跨度为 0 时全部退到地板。
 */
export function mapEnergiesToVelocity(energies, options = {}) {
  const {
    percentileLow = DEFAULT_VELOCITY_CONFIG.percentileLow,
    percentileHigh = DEFAULT_VELOCITY_CONFIG.percentileHigh,
    floor = DEFAULT_VELOCITY_CONFIG.floor,
    ceiling = DEFAULT_VELOCITY_CONFIG.ceiling,
  } = options;
  const positive = [...energies].filter((e) => e > 0).sort((a, b) => a - b);
  const pLow = percentile(positive, percentileLow);
  const pHigh = percentile(positive, percentileHigh);
  const span = pHigh - pLow;
  return Float64Array.from(energies, (e) => {
    if (!(e > 0)) return 0;
    if (!(span > 0)) return floor;
    const t = Math.min(1, Math.max(0, (e - pLow) / span));
    return floor + (ceiling - floor) * t;
  });
}

/**
 * 逐音测力度。
 * @returns {{results: Array, meta: object}}
 */
export function measureVelocity({ samples, sampleRate, notes, config = {} }) {
  const cfg = velocityConfig(config);
  const rows = [];
  const energies = [];

  for (const n of notes) {
    const voice = voiceOfInstrument(n.instrument);
    const vcfg = cfg.voices[voice] ?? cfg.voices.melody;
    const windowSec = vcfg.windowSec ?? cfg.windowSec;
    let midiUsed = n[cfg.midiColumn];
    let reason = 'measured';
    if (!Number.isFinite(midiUsed)) {
      midiUsed = n.midi;
      reason = 'fallback-midi';
    }
    const m = narrowbandEnergy({
      samples,
      sampleRate,
      midi: midiUsed,
      timeSec: n.timeSec,
      a4: cfg.a4,
      windowSec,
      harmonicWeights: vcfg.harmonicWeights,
    });
    const weak = m.rms < cfg.minRms;
    energies.push(weak ? 0 : m.energy);
    rows.push({
      noteId: n.noteId,
      step: n.step,
      timeSec: n.timeSec,
      instrument: n.instrument,
      voice,
      midiUsed,
      midiName: midiName(midiUsed),
      f0Hz: Number(m.f0.toFixed(3)),
      energy: m.energy,
      rms: m.rms,
      windowSec,
      weak,
      reason,
    });
  }

  const velocities = mapEnergiesToVelocity(energies, cfg);
  const sorted = energies.filter((e) => e > 0).sort((a, b) => a - b);
  const results = rows.map((r, i) => ({
    ...r,
    velocity: r.weak ? 0 : Number(velocities[i].toFixed(6)),
    reason: r.weak ? 'weak' : r.reason,
  }));

  const measured = results.filter((r) => r.reason !== 'weak');
  const reasons = {};
  for (const r of results) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  const meta = {
    notes: notes.length,
    midiColumn: cfg.midiColumn,
    windowSec: cfg.windowSec,
    a4: cfg.a4,
    minRms: cfg.minRms,
    floor: cfg.floor,
    ceiling: cfg.ceiling,
    percentileLow: cfg.percentileLow,
    percentileHigh: cfg.percentileHigh,
    harmonicWeights: Object.fromEntries(Object.entries(cfg.voices).map(([v, c]) => [v, c.harmonicWeights])),
    windows: Object.fromEntries(Object.entries(cfg.voices).map(([v, c]) => [v, c.windowSec ?? cfg.windowSec])),
    energyP10: percentile(sorted, cfg.percentileLow),
    energyP90: percentile(sorted, cfg.percentileHigh),
    reasons,
    summary: {
      measured: measured.length,
      atFloor: measured.filter((r) => Math.abs(r.velocity - cfg.floor) < 1e-9).length,
      atCeiling: measured.filter((r) => Math.abs(r.velocity - cfg.ceiling) < 1e-9).length,
      mean: measured.length
        ? Number((measured.reduce((a, r) => a + r.velocity, 0) / measured.length).toFixed(4))
        : 0,
    },
  };
  return { results, meta };
}

/** 输出 CSV：原列逐字符保留 + 追加 velocity / velocityRaw / velocityReason */
export function velocityCsv({ header, notes, results }) {
  const lines = [[...header, ...EXTRA_CSV_COLUMNS].join(',')];
  notes.forEach((n, i) => {
    const r = results[i];
    lines.push([...n.fields, r.velocity.toFixed(3), r.energy.toFixed(6), r.reason].join(','));
  });
  return lines.join('\n') + '\n';
}

/** 文本入口：CSV 文本 + 音频 → CSV 文本（CLI 与测试共用） */
export function velocityCsvText({ csvText: text, samples, sampleRate, config = {} }) {
  const { header, notes } = readNotesCsv(text);
  const { results, meta } = measureVelocity({ samples, sampleRate, notes, config });
  return { csv: velocityCsv({ header, notes, results }), results, meta };
}

/* ------------------------------------------------- accent 口径（M1-5） */

// 要打掉的现状（M0-3 §3.2 / BASELINE §3.2）：T5b 的 velocity 量的是"这音有多响"（该音该八度的
// 100/120ms 窄带能量），与音频**起音强度**的相关只有 r=0.11（banded 口径）/ −0.53（legacy 口径）——
// 所以机器上"没有强弱之分"这条抱怨没有被修掉。
//
// accent 口径 = **两个分量相加**，都从同一段音频、同一颗音的起音时刻量：
//   ① level：T5b 旧口径本身（该音该八度的 100/120ms 窄带能量，p10/p90 截断到 0..1）
//      —— 量"这音弹得有多响"，是 ④（力度包络相关）与机器"同一步内不再全相同"的支柱。
//   ② attack：该音所在**检测器频带** ±r 的归一化对数谱通量，取该音起音那一帧
//      —— 量"这个瞬间这条带跳了多高"，即起音攻击强度；r 默认 2（该音带 ±2，共 5 个带）。
//    accent = level + attackWeight · z(attack)（z 分数，默认权重 0.225）
//    末段映射：min/max → 0.35..1.0（线性、不截断；任务书字面的 p10/p90 截断可用 mapLow/mapHigh 切回）
//
// 两个分量都不可省（实测，见 docs/M1-5-report.md §2）：
//   · 只用 attack：与 ④ 的相关掉到 0.36（= 与"该音自己的能量"脱钩，同一步内也几乎全相同）。
//   · 只用 level：与起音强度只有 0.11 —— 就是现状。
//   · 两个量在数据上几乎不相关（r=0.11），所以"同时抬高两者"有硬上限：用相关矩阵的正定性可证，
//     要让 ④ ≥0.85（客观分 ≥0.9417），vsOnsetStrength 最高只能到 ≈0.55；反之要到 0.62 就得让 ④ 掉到 0.36。
//     默认权重就落在这条前沿上（④ 0.86 / vsOnsetStrength 0.54，见报告 §4 的前沿表）。
export const DEFAULT_ACCENT_CONFIG = {
  ...DEFAULT_VELOCITY_CONFIG,
  levelWeight: 1,         // level 项权重（= 旧口径本身；0 表示"只要攻击项"，见报告 §2 的端点对照）
  attackRadiusBands: 2,   // 该音所在带 ±2（含自身共 5 个带）；1 = 只取该音带与两侧邻带
  attackWeight: 0.225,    // 攻击项权重（对 z 分数）
  attackPower: 1,         // 攻击项的符号幂变换（>1 放大尖峰；默认 1 = 不变换）
  mapLow: 0,              // 末段映射的下分位（0 = 最小值，即不截断）
  mapHigh: 1,             // 任务书字面的口径是 mapLow / mapHigh = 0.1 / 0.9（见报告 §4 的代价）
};

/** 合并 accent 配置（level 部分沿用 velocityConfig，accent 部分单独取） */
export function accentConfig(config = {}) {
  const base = velocityConfig(config);
  const pick = (key) => (Number.isFinite(config[key]) ? config[key] : DEFAULT_ACCENT_CONFIG[key]);
  return {
    ...base,
    levelWeight: pick('levelWeight'),
    attackRadiusBands: pick('attackRadiusBands'),
    attackWeight: pick('attackWeight'),
    attackPower: pick('attackPower'),
    mapLow: pick('mapLow'),
    mapHigh: pick('mapHigh'),
  };
}

/**
 * 该音带的起音攻击强度：6 带检测器的归一化对数谱通量，取该音所在带 ±r、该音起音那一帧。
 * 带编号取"基频落在哪个带"（f0 < 最低带则取最低带，> 最高带则取最高带）。
 * @returns {{rows: Array, bands: Array, envelope: object}}
 */
export function measureBandAttack({ samples, sampleRate, notes, config = {} }) {
  const cfg = accentConfig(config);
  const bands = bandFluxes({ samples, sampleRate });
  const radius = Math.max(0, Math.round(cfg.attackRadiusBands));
  const rows = notes.map((n) => {
    const midiUsed = Number.isFinite(n[cfg.midiColumn]) ? n[cfg.midiColumn] : n.midi;
    const f0 = midiToFreq(midiUsed, cfg.a4);
    let bandIndex = bands.findIndex((b) => f0 >= b.loHz && f0 < b.hiHz);
    let bandReason = 'own-band';
    if (bandIndex < 0) {
      bandIndex = f0 < bands[0].loHz ? 0 : bands.length - 1;
      bandReason = 'nearest-band';
    }
    let attack = 0;
    const bandsUsed = [];
    for (let k = bandIndex - radius; k <= bandIndex + radius; k++) {
      const b = bands[k];
      if (!b) continue;
      const fi = Math.min(b.frames - 1, Math.max(0, Math.round(n.timeSec / b.hopSec)));
      attack += b.flux[fi] ?? 0;
      bandsUsed.push(b.name);
    }
    return {
      noteId: n.noteId,
      step: n.step,
      timeSec: n.timeSec,
      midiUsed,
      bandIndex,
      band: bands[bandIndex].name,
      bandHz: `${bands[bandIndex].loHz}-${bands[bandIndex].hiHz}`,
      bandsUsed,
      bandReason,
      attack,
    };
  });
  // 宽带起音包络：与 score.mjs 的"力度 vs 起音强度"诊断同一份（bandEnvelope 的 10ms 栅格）
  return { rows, bands, envelope: bandEnvelope({ bands, hopSec: 0.01 }) };
}

/**
 * accent 口径逐音测力度。
 * @returns {{results: Array, meta: object}}
 */
export function measureAccent({ samples, sampleRate, notes, config = {} }) {
  const cfg = accentConfig(config);
  const { results: levelResults, meta: levelMeta } = measureVelocity({ samples, sampleRate, notes, config });
  const { rows: attackRows, envelope } = measureBandAttack({ samples, sampleRate, notes, config });

  const attacks = attackRows.map((a) => a.attack);
  const sortedAtk = [...attacks].sort((a, b) => a - b);
  const meanAtk = attacks.length ? attacks.reduce((a, b) => a + b, 0) / attacks.length : 0;
  const sdAtk = attacks.length
    ? Math.sqrt(attacks.reduce((a, b) => a + (b - meanAtk) ** 2, 0) / attacks.length)
    : 0;
  const zAttack = attacks.map((a) => (sdAtk > 0 ? (a - meanAtk) / sdAtk : 0));
  const powered = zAttack.map((z) => (cfg.attackPower === 1 ? z : Math.sign(z) * Math.abs(z) ** cfg.attackPower));
  const level01 = levelResults.map((r, i) => (
    r.reason === 'weak' ? 0 : (r.velocity - cfg.floor) / (cfg.ceiling - cfg.floor)
  ));
  const accentRaw = level01.map((L, i) => cfg.levelWeight * L + cfg.attackWeight * powered[i]);
  const flux = notes.map((n) => {
    const fi = Math.min(envelope.frames - 1, Math.max(0, Math.round(n.timeSec / envelope.hopSec)));
    return envelope.flux[fi] ?? 0;
  });

  // 末段映射：只用"有证据"的音定上下限（无证据的音直接 0，不当成"很轻地弹了一下"）
  const measuredIdx = accentRaw.map((_, i) => i).filter((i) => levelResults[i].reason !== 'weak');
  const sortedAcc = measuredIdx.map((i) => accentRaw[i]).sort((a, b) => a - b);
  const lo = percentile(sortedAcc, cfg.mapLow);
  const hi = percentile(sortedAcc, cfg.mapHigh);
  const span = hi - lo;
  const toVelocity = (a) => {
    if (!(span > 0)) return cfg.floor;
    const t = Math.min(1, Math.max(0, (a - lo) / span));
    return cfg.floor + (cfg.ceiling - cfg.floor) * t;
  };
  const results = notes.map((n, i) => {
    const weak = levelResults[i].reason === 'weak';
    const r = {
      noteId: n.noteId,
      step: n.step,
      timeSec: n.timeSec,
      instrument: n.instrument,
      voice: levelResults[i].voice,
      midiUsed: levelResults[i].midiUsed,
      midiName: levelResults[i].midiName,
      bandIndex: attackRows[i].bandIndex,
      band: attackRows[i].band,
      bandsUsed: attackRows[i].bandsUsed,
      level: Number(level01[i].toFixed(6)),
      attack: Number(attacks[i].toFixed(6)),
      attackZ: Number(zAttack[i].toFixed(6)),
      accentRaw: Number(accentRaw[i].toFixed(6)),
      energy: levelResults[i].energy,
      rms: levelResults[i].rms,
      onsetFlux: Number(flux[i].toFixed(6)),
      reason: weak ? 'weak' : (attackRows[i].bandReason === 'nearest-band' ? 'measured-nearest-band' : 'measured'),
    };
    r.velocity = weak ? 0 : Number(toVelocity(accentRaw[i]).toFixed(6));
    return r;
  });

  const measured = results.filter((r) => r.reason !== 'weak');
  const reasons = {};
  for (const r of results) reasons[r.reason] = (reasons[r.reason] ?? 0) + 1;
  // "同一步内不再全相同"（M0-1 §4.1 的旧口径病）：多音 step 里力度是否真的分开了
  const byStep = new Map();
  for (const r of results) {
    if (!byStep.has(r.step)) byStep.set(r.step, []);
    byStep.get(r.step).push(r.velocity);
  }
  const multi = [...byStep.values()].filter((vs) => vs.length > 1);
  const stepStats = {
    stepsMulti: multi.length,
    stepsDistinct: multi.filter((vs) => new Set(vs).size > 1).length,
    stepsSpread: multi.filter((vs) => Math.max(...vs) - Math.min(...vs) > 0.01).length,
  };
  const measuredRows = results.filter((r) => r.reason !== 'weak');
  const rOf = (field, ref) => (measuredRows.length > 1
    ? pearson(measuredRows.map((r) => r[field]), measuredRows.map((r) => r[ref]))
    : 0);
  const bandReason = {};
  for (const r of attackRows) bandReason[r.bandReason] = (bandReason[r.bandReason] ?? 0) + 1;
  const bandsUsed = [...new Set(attackRows.flatMap((r) => r.bandsUsed))].sort();
  const meta = {
    mode: 'accent',
    notes: notes.length,
    midiColumn: cfg.midiColumn,
    level: {
      windowSec: cfg.windowSec,
      windows: levelMeta.windows,
      percentileLow: cfg.percentileLow,
      percentileHigh: cfg.percentileHigh,
      energyP10: levelMeta.energyP10,
      energyP90: levelMeta.energyP90,
      reasons: levelMeta.reasons,
    },
    attack: {
      radiusBands: cfg.attackRadiusBands,
      weight: cfg.attackWeight,
      power: cfg.attackPower,
      bandsUsed,
      mean: Number(meanAtk.toFixed(6)),
      sd: Number(sdAtk.toFixed(6)),
      p10: percentile(sortedAtk, 0.1),
      p90: percentile(sortedAtk, 0.9),
      min: sortedAtk[0] ?? 0,
      max: sortedAtk[sortedAtk.length - 1] ?? 0,
      bandReason,
    },
    levelWeight: cfg.levelWeight,
    map: {
      lowPercentile: cfg.mapLow,
      highPercentile: cfg.mapHigh,
      floor: cfg.floor,
      ceiling: cfg.ceiling,
      accentLow: Number(lo.toFixed(6)),
      accentHigh: Number(hi.toFixed(6)),
    },
    reasons,
    summary: {
      measured: measured.length,
      atFloor: measured.filter((r) => Math.abs(r.velocity - cfg.floor) < 1e-9).length,
      atCeiling: measured.filter((r) => Math.abs(r.velocity - cfg.ceiling) < 1e-9).length,
      mean: measured.length
        ? Number((measured.reduce((a, r) => a + r.velocity, 0) / measured.length).toFixed(4))
        : 0,
      ...stepStats,
    },
    // 自检（与 score.mjs 的 ④ 口径 / vsOnsetStrength 诊断同一算法；报告里的验收数由 score.mjs 给出）
    corr: {
      vsLevel: Number(rOf('velocity', 'level').toFixed(6)),
      vsOnsetStrength: Number(rOf('velocity', 'onsetFlux').toFixed(6)),
    },
  };
  return { results, meta };
}

/** 输出 CSV：原列逐字符保留 + 追加 velocity / velocityRaw / velocityReason（accent 口径） */
export function accentCsv({ header, notes, results }) {
  const lines = [[...header, ...EXTRA_CSV_COLUMNS].join(',')];
  notes.forEach((n, i) => {
    const r = results[i];
    lines.push([...n.fields, r.velocity.toFixed(3), r.accentRaw.toFixed(6), r.reason].join(','));
  });
  return lines.join('\n') + '\n';
}

/** 文本入口（accent 口径）：CSV 文本 + 音频 → CSV 文本 */
export function accentCsvText({ csvText: text, samples, sampleRate, config = {} }) {
  const { header, notes } = readNotesCsv(text);
  const { results, meta } = measureAccent({ samples, sampleRate, notes, config });
  return { csv: accentCsv({ header, notes, results }), results, meta };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/arrange/velocity.mjs');

if (invokedDirectly) {
  const P = resolvePaths();
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const inPath = args.in ?? P.notesV3;
  const outPath = args.out ?? P.file('velocity_fixed.csv');
  const reportPath = typeof args.report === 'string' ? args.report : null;
  const wavPath = args.audio ?? P.audio;
  const numArg = (name) => (args[name] === undefined || args[name] === true ? undefined : Number(args[name]));
  const config = {
    ...(typeof args['midi-column'] === 'string' ? { midiColumn: args['midi-column'] } : {}),
    ...(args.comb ? { voices: { melody: { harmonicWeights: [1, 0.5, 0.25] } } } : {}),
    ...(Number.isFinite(numArg('level-weight')) ? { levelWeight: numArg('level-weight') } : {}),
    ...(Number.isFinite(numArg('attack-radius')) ? { attackRadiusBands: numArg('attack-radius') } : {}),
    ...(Number.isFinite(numArg('attack-weight')) ? { attackWeight: numArg('attack-weight') } : {}),
    ...(Number.isFinite(numArg('attack-power')) ? { attackPower: numArg('attack-power') } : {}),
    ...(Number.isFinite(numArg('map-low')) ? { mapLow: numArg('map-low') } : {}),
    ...(Number.isFinite(numArg('map-high')) ? { mapHigh: numArg('map-high') } : {}),
  };

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(wavPath);
  const { header, notes } = readNotesCsv(fs.readFileSync(inPath, 'utf8'));
  if (args.accent) {
    const { csv, meta } = accentCsvText({ csvText: fs.readFileSync(inPath, 'utf8'), samples, sampleRate, config });
    fs.writeFileSync(outPath, csv, 'utf8');
    if (reportPath) {
      fs.writeFileSync(reportPath, JSON.stringify({ meta: { inPath, wavPath, outPath, ...meta } }, null, 1) + '\n', 'utf8');
    }
    const s = meta.summary;
    console.log(`力度对齐重音（accent）：${inPath}（${meta.notes} 颗音，${seconds.toFixed(1)}s 音频）`);
    console.log(`  口径：level = 该音该八度的窄带能量（旋律 ${(meta.level.windows.melody * 1000).toFixed(0)}ms`
      + ` / 贝斯 ${(meta.level.windows.bass * 1000).toFixed(0)}ms，p${meta.level.percentileLow * 100}–p${meta.level.percentileHigh * 100} → 0..1）`
      + `；attack = 该音所在带 ±${meta.attack.radiusBands}（最多 ${meta.attack.radiusBands * 2 + 1} 个带，`
      + `本谱面用到 ${meta.attack.bandsUsed.join('+')}）的归一化对数谱通量`);
    console.log(`  合成：accent = ${meta.levelWeight} × level + ${meta.attack.weight} × z(attack)（power ${meta.attack.power}）`
      + ` → 末段映射 p${meta.map.lowPercentile * 100}–p${meta.map.highPercentile * 100} → ${meta.map.floor}..${meta.map.ceiling}`);
    console.log(`  攻击项参考：p10=${meta.attack.p10.toFixed(4)} p90=${meta.attack.p90.toFixed(4)}`
      + `（均值 ${meta.attack.mean.toFixed(4)}，σ ${meta.attack.sd.toFixed(4)}）`);
    console.log(`  判定：measured ${s.measured}（地板 ${s.atFloor}、天花板 ${s.atCeiling}、均值 ${s.mean}）`
      + `｜weak ${meta.reasons.weak ?? 0}${meta.reasons['measured-nearest-band'] ? `｜越界带 ${meta.reasons['measured-nearest-band']}` : ''}`);
    console.log(`  同一步内：多音 step ${s.stepsMulti} 个，其中力度有区别的 ${s.stepsDistinct} 个、跨度 >0.01 的 ${s.stepsSpread} 个`
      + `（旧口径 mix-rms 时是 0 个，见 M0-1 §4.1）`);
    console.log(`  自检（与 score.mjs 同一算法）：与起音强度 r=${meta.corr.vsOnsetStrength.toFixed(3)}`
      + `（同一份谱面的旧口径：banded +0.105 / legacy −0.49）；与 ④ 描述子 r=${meta.corr.vsLevel.toFixed(3)}（旧口径 0.990）`);
    console.log(`  → ${outPath}`);
    if (reportPath) console.log(`  → ${reportPath}`);
    console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  } else {
  const { csv, results, meta } = velocityCsvText({ csvText: fs.readFileSync(inPath, 'utf8'), samples, sampleRate, config });
  fs.writeFileSync(outPath, csv, 'utf8');
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({ meta: { inPath, wavPath, outPath, ...meta } }, null, 1) + '\n', 'utf8');
  }

  const oldVolume = notes.map((n) => n.volume).filter((v) => Number.isFinite(v));
  const newVel = results.map((r) => r.velocity);
  const rOld = oldVolume.length === newVel.length ? pearson(newVel, oldVolume) : null;
  const s = meta.summary;
  console.log(`力度换口径：${inPath}（${meta.notes} 颗音，${seconds.toFixed(1)}s 音频）`);
  const windows = Object.entries(meta.windows).map(([v, w]) => `${v} ${(w * 1000).toFixed(0)}ms`).join(' / ');
  console.log(`  口径：Hann 窗（${windows}）/ 基频 |X(f0)|² / 音高取 ${meta.midiColumn} 列`
    + ` / 能量 p${meta.percentileLow * 100}-p${meta.percentileHigh * 100} → ${meta.floor}..${meta.ceiling}`);
  console.log(`  能量参考：p10=${meta.energyP10.toExponential(3)} p90=${meta.energyP90.toExponential(3)}`);
  console.log(`  判定：measured ${s.measured}（地板 ${s.atFloor}、天花板 ${s.atCeiling}、均值 ${s.mean}）`
    + `｜weak ${meta.reasons.weak ?? 0}${meta.reasons['fallback-midi'] ? `｜fallback-midi ${meta.reasons['fallback-midi']}` : ''}`);
  if (rOld !== null) console.log(`  与旧口径（混音 volume）的相关：r=${rOld.toFixed(3)}`);
  console.log(`  → ${outPath}`);
  if (reportPath) console.log(`  → ${reportPath}`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    void header;
  }
}
