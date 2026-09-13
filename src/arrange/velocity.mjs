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
//   ② 无证据（窗内 RMS < minRms）→ 力度 0，而不是地板 0.35：这里不是"很轻地弹了一下"，
//      而是"音频里听不出这颗音"。地板 0.35 只留给"有能量但落在 p10 以下"的音。
//   ③ 分位数跨度为 0（全部能量相同，或只有一颗音）→ 统一退到地板，不凭空给天花板。
//
// 重要限制：这个口径量在**给定的八度**上。若输入的八度本身是错的（v3 的贝斯大面积如此），
// 力度也会跟着错。流水线顺序应是 T3 修八度 → T5 换力度（CLI 传 `--midi-column newMidi`）。
import fs from 'node:fs';

import {
  csvText,
  midiName,
  narrowbandEnergy,
  pearson,
  percentile,
  readNotesCsv,
  readWav,
} from '../analyze/dsp.mjs';

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
    melody: { harmonicWeights: [1] },
    inner: { harmonicWeights: [1] },
    bass: { harmonicWeights: [1] },
    perc: { harmonicWeights: [1] },
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
      windowSec: cfg.windowSec,
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

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/arrange/velocity.mjs');

if (invokedDirectly) {
  const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const inPath = args.in ?? `${BUILD}/styx_helix_notes_v3.csv`;
  const outPath = args.out ?? `${BUILD}/velocity_fixed.csv`;
  const reportPath = typeof args.report === 'string' ? args.report : null;
  const wavPath = args.audio ?? `${BUILD}/styx_helix_full.wav`;
  const config = {
    ...(typeof args['midi-column'] === 'string' ? { midiColumn: args['midi-column'] } : {}),
    ...(args.comb ? { voices: { melody: { harmonicWeights: [1, 0.5, 0.25] } } } : {}),
  };

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(wavPath);
  const { header, notes } = readNotesCsv(fs.readFileSync(inPath, 'utf8'));
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
  console.log(`  口径：${(meta.windowSec * 1000).toFixed(0)}ms Hann 窗 / 基频 |X(f0)|² / 音高取 ${meta.midiColumn} 列`
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
