// M1-4 · 打击乐层：把检测到的打击乐事件映射成**机器已有的**打击乐格，并对齐到 0.12s 谱面网格
//
// 机器上只有两组打击乐方块（`docs/DISCUSSION-C-music.md` §3.3、§5.1）：
//   `minecraft:stone` 甲板 → 音符盒 instrument=basedrum（底鼓）
//   `minecraft:glass` 甲板 → 音符盒 instrument=hat（踩镲）
// 行号固定：底鼓 row 0、踩镲 row 24（两个不同的 row = 同一个 step 上可以同时响，
// 不互相撞格；row 对打击乐只表示"哪一个音符盒"，音高无意义——basedrum/hat 的音色与 note 无关）。
//
// 军鼓（snare）在这台机器上**没有对应格**（stone/glass 是本机仅有的两组打击乐方块）：
// 降级成 basedrum（与底鼓同格），并显式记进 `degradations[]` 与 `stats.mergedSameCell`——
// 保真契约要求降级不能是静默的（`docs/DISCUSSION-C-music.md` §3.3 与 M0-1 报告同一口径）。
// 想要"真军鼓"需要换方块/加一行，属于机器改造，不在本任务范围（见报告 §5 的接线清单）。
//
// 网格口径（与流水线其余部分同一套坐标，见 docs/BASELINE.md §5）：
//   `step = round(t / 0.12)`（取最近的 step）、`tick = step × 12`（100 tps 下 0.12s = 12 刻，精确）、
//   `time_seconds = step × 0.12`。离网超过 `maxOffsetSec`（默认半个 step）的事件丢弃并计数，
//   默认值下不可能丢弃——任务的验收写的是"对齐到网格（取最近的 step）"，所以默认不丢。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { detectPercussion } from '../analyze/drums.mjs';
import { readWav } from '../analyze/dsp.mjs';

export const CSV_COLUMNS = ['step', 'tick', 'time_seconds', 'instrument', 'midi', 'row', 'volume'];

/** 打击乐格（每类事件落在哪一行、用什么甲板方块） */
export const PERCUSSION_CELLS = {
  kick: { instrument: 'basedrum', row: 0, block: 'minecraft:stone' },
  snare: { instrument: 'basedrum', row: 0, block: 'minecraft:stone', degraded: 'no-snare-cell' },
  hat: { instrument: 'hat', row: 24, block: 'minecraft:glass' },
};

export const DEFAULT_PERCUSSION_CONFIG = {
  stepSec: 0.12,          // 谱面步长（♩=125 的 16 分格）
  ticksPerStep: 12,       // 100 tps 下每步 12 刻
  maxOffsetSec: 0.06,     // 离网容差 = 半个 step（严格大于才丢）
};

/** 事件时刻 → 最近的 step 与偏移（正数 = 事件比网格晚） */
export function snapToGrid(timeSec, config = {}) {
  const cfg = { ...DEFAULT_PERCUSSION_CONFIG, ...config };
  const step = Math.round(timeSec / cfg.stepSec);
  const offsetSec = Number((timeSec - step * cfg.stepSec).toFixed(6));
  return { step, offsetSec };
}

/**
 * 事件序列 → 打击乐谱面行（含同 step 去重与降级记录）。
 *
 * 处理顺序（每一步都计数，报告里能看到"合并掉多少"）：
 *   ① 对齐网格（离网超过容差 → offGrid）
 *   ② 同一 step 上的**同类**只保留最强的一次（mergedSameKind）
 *   ③ 映射到格；同一 step 同一格（军鼓与底鼓撞格）只保留最强的一次（mergedSameCell）
 *
 * @returns {{rows: Array, stats: object, degradations: Array}}
 */
export function percussionRowsFromEvents(events, config = {}) {
  const cfg = { ...DEFAULT_PERCUSSION_CONFIG, ...config };
  const degradations = [];
  const stats = {
    events: events.length,
    kept: 0,
    offGrid: 0,
    offGridDropped: [],
    mergedSameKind: 0,
    mergedSameCell: 0,
    gridSec: cfg.stepSec,
    ticksPerStep: cfg.ticksPerStep,
    maxOffsetSec: cfg.maxOffsetSec,
    snapOffsetMs: null,
    byKind: { kick: 0, snare: 0, hat: 0 },
    byInstrument: {},
  };

  // ① 对齐网格
  const snapped = [];
  for (const e of events) {
    const { step, offsetSec } = snapToGrid(e.time, cfg);
    if (Math.abs(offsetSec) > cfg.maxOffsetSec + 1e-9) {
      stats.offGrid++;
      stats.offGridDropped.push({ time: e.time, kind: e.kind, step, offsetSec });
      degradations.push({ reason: 'off-grid', time: e.time, kind: e.kind, offsetSec });
      continue;
    }
    snapped.push({ ...e, step, offsetSec });
  }

  // ② 同 step 同类去重（保留最强；强度相同按 kind 名序，保证决定论）
  const byStepKind = new Map();
  for (const s of snapped) {
    const key = `${s.step}|${s.kind}`;
    const prev = byStepKind.get(key);
    if (!prev || s.strength > prev.strength) {
      if (prev) stats.mergedSameKind++;
      byStepKind.set(key, s);
    } else {
      stats.mergedSameKind++;
    }
  }

  // ③ 映射到格 + 同格去重
  const byStepCell = new Map();
  for (const s of [...byStepKind.values()].sort((a, b) => a.step - b.step || a.kind.localeCompare(b.kind))) {
    const cell = PERCUSSION_CELLS[s.kind];
    if (!cell) throw new Error(`未登记的打击乐类别：${s.kind}`);
    if (cell.degraded) {
      degradations.push({
        reason: cell.degraded,
        time: s.time,
        step: s.step,
        kind: s.kind,
        note: `机器上没有 ${s.kind} 的对应格（本机只有 stone→basedrum / glass→hat），降级为 ${cell.instrument}（row ${cell.row}）`,
      });
    }
    const key = `${s.step}|${cell.row}`;
    const prev = byStepCell.get(key);
    if (!prev) {
      byStepCell.set(key, { ...s, cell });
      continue;
    }
    const winner = s.strength > prev.strength ? s : prev;
    const loser = winner === s ? prev : s;
    stats.mergedSameCell++;
    degradations.push({
      reason: 'same-cell-merge',
      step: s.step,
      row: cell.row,
      kept: { kind: winner.kind, strength: winner.strength },
      dropped: { kind: loser.kind, strength: loser.strength },
      note: `step ${s.step} 的 row ${cell.row} 只有一格：保留更强的那次`,
    });
    byStepCell.set(key, { ...winner, cell });
  }

  const rows = [...byStepCell.values()]
    .map((s) => ({
      step: s.step,
      tick: s.step * cfg.ticksPerStep,
      time_seconds: Number((s.step * cfg.stepSec).toFixed(3)),
      instrument: s.cell.instrument,
      midi: s.cell.row,                 // 打击乐音高无意义：midi 列填 row，只为满足 7 列契约
      row: s.cell.row,
      volume: Number(s.strength.toFixed(3)),  // volume = 起音强度（0..1），接线时可直接当力度用
      kind: s.kind,
      strength: s.strength,
      offsetSec: s.offsetSec,
    }))
    .sort((a, b) => a.step - b.step || a.row - b.row || a.kind.localeCompare(b.kind));

  stats.kept = rows.length;
  for (const r of rows) {
    stats.byKind[r.kind]++;
    stats.byInstrument[r.instrument] = (stats.byInstrument[r.instrument] ?? 0) + 1;
  }
  const offsets = rows.map((r) => 1000 * r.offsetSec).sort((a, b) => a - b);
  const pick = (p) => (offsets.length ? Number(offsets[Math.min(offsets.length - 1, Math.floor(p * offsets.length))].toFixed(1)) : null);
  stats.snapOffsetMs = offsets.length
    ? { median: pick(0.5), p90: pick(0.9), maxAbs: Number(Math.max(...offsets.map(Math.abs)).toFixed(1)) }
    : { median: null, p90: null, maxAbs: null };
  stats.keptByKindNote = 'kept 按格去重后的行数；mergedSameKind / mergedSameCell 是两张去重表各合并掉多少条';
  return { rows, stats, degradations };
}

/** 谱面行 → CSV 文本（固定 7 列，与 v3 谱面同一份契约） */
export function percussionCsv(rows) {
  const lines = [CSV_COLUMNS.join(',')];
  for (const r of rows) {
    lines.push([
      r.step, r.tick, r.time_seconds.toFixed(3), r.instrument, r.midi, r.row, r.volume.toFixed(3),
    ].join(','));
  }
  return lines.join('\n') + '\n';
}

/** 音频 → 打击乐谱面（检测 + 映射一条链，CLI 与测试共用） */
export function percussionFromAudio({ samples, sampleRate, config = {}, detectorConfig = {} }) {
  const detect = detectPercussion({ samples, sampleRate, config: detectorConfig });
  const { rows, stats, degradations } = percussionRowsFromEvents(detect.events, config);
  return { rows, stats, degradations, detect, csv: percussionCsv(rows) };
}

/* ------------------------------------------------------------------- CLI */

/** `build/` 在上层目录（仓库只跟踪 nbforge/）：给定的路径不存在时自动退到 `../<路径>` */
function resolveExisting(p, label) {
  if (fs.existsSync(p)) return p;
  const alt = path.join('..', p);
  if (fs.existsSync(alt)) {
    console.log(`  （${label} 的 build/ 在上层目录：${p} → ${alt}）`);
    return alt;
  }
  return p;
}

function resolveOut(p) {
  const dir = path.dirname(p);
  if (fs.existsSync(dir)) return p;
  const alt = path.join('..', p);
  if (fs.existsSync(path.dirname(alt))) {
    console.log(`  （输出的 build/ 在上层目录：${p} → ${alt}）`);
    return alt;
  }
  fs.mkdirSync(dir, { recursive: true });
  return p;
}

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
  const audioPath = resolveExisting(args.audio ?? `${BUILD}/styx_helix_full.wav`, '音频');
  const outPath = resolveOut(args.out ?? `${BUILD}/percussion.csv`);
  const eventsPath = resolveOut(args.events ?? path.join(path.dirname(outPath), 'percussion_events.json'));
  const onsetsPath = typeof args.onsets === 'string' ? resolveExisting(args.onsets, '起音表') : `${BUILD}/onsets_banded.json`;
  const chartPath = typeof args.chart === 'string'
    ? resolveExisting(args.chart, '谱面')
    : resolveExisting(`${BUILD}/notes_recovered.csv`, '谱面');

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(audioPath);
  const config = {
    ...(args.step ? { stepSec: Number(args.step) } : {}),
    ...(args.tps ? { ticksPerStep: Math.round(Number(args.tps) * Number(args.step ?? 0.12)) } : {}),
  };
  // --min-excess 是**工作点**旋钮（默认 0.35 = 合成样本标定的保守口径，见 docs/M1-4-report.md §3.4）：
  // 调小 → 打击乐层更密（含更多别的乐器的攻击），调大 → 只留最重的几下。
  const detectorConfig = args['min-excess'] ? { minExcess: Number(args['min-excess']) } : {};
  const result = percussionFromAudio({ samples, sampleRate, config, detectorConfig });
  const { rows, stats, degradations, detect } = result;

  console.log(`打击乐层：${audioPath}（${seconds.toFixed(1)}s，${sampleRate}Hz）`);
  console.log(`  ① 检测：带 ${detect.bands.map((b) => `${b.name} ${b.loHz}-${b.hiHz}Hz`).join('｜')}`);
  console.log(`     峰 ${detect.meta.peaks} → 簇 ${detect.meta.clusters} → 事件 ${detect.meta.events}`
    + `（超额不足 ${detect.meta.rejected.weakAttack} / 太弱 ${detect.meta.rejected.faint} / 太静 ${detect.meta.rejected.quiet}）`
    + `｜底鼓 ${detect.meta.counts.kick} 军鼓 ${detect.meta.counts.snare} 踩镲 ${detect.meta.counts.hat}`
    + `｜绝对超额门槛 ${detect.meta.config.minExcess}`);
  console.log(`  ② 网格：${stats.gridSec}s/step（${stats.ticksPerStep} 刻/step）｜事件 ${stats.events}`
    + ` → 离网丢弃 ${stats.offGrid}｜同类同 step 合并 ${stats.mergedSameKind}｜同格（军鼓↔底鼓）合并 ${stats.mergedSameCell}`
    + ` → 谱面 ${stats.kept} 行`);
  console.log(`     吸附偏移（事件 − 网格）中位 ${stats.snapOffsetMs.median}ms / p90 ${stats.snapOffsetMs.p90}ms / |最大| ${stats.snapOffsetMs.maxAbs}ms`);
  console.log(`  ③ 输出：${JSON.stringify(stats.byKind)} → ${JSON.stringify(stats.byInstrument)}`
    + `（basedrum = row 0 / hat = row 24）`);

  if (fs.existsSync(onsetsPath)) {
    const ref = JSON.parse(fs.readFileSync(onsetsPath, 'utf8')).times.slice().sort((a, b) => a - b);
    const nearest = (t) => {
      let lo = 0;
      let hi = ref.length - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (ref[mid] < t) lo = mid;
        else hi = mid;
      }
      return Math.abs(ref[lo] - t) <= Math.abs(ref[hi] - t) ? ref[lo] : ref[hi];
    };
    const per = {};
    for (const e of detect.events) (per[e.kind] ??= []).push(Math.abs(e.time - nearest(e.time)));
    const parts = ['kick', 'snare', 'hat'].filter((k) => per[k]?.length).map((k) => {
      const a = per[k].map((v) => v * 1000).sort((x, y) => x - y);
      return `${k} n=${a.length} 中位 ${a[a.length >> 1].toFixed(1)}ms p90 ${a[Math.floor(0.9 * a.length)].toFixed(1)}ms`;
    });
    console.log(`  ④ 与音频起音表（${path.basename(onsetsPath)}，${ref.length} 个起音）的对齐：${parts.join('｜')}`);
  }

  if (fs.existsSync(chartPath)) {
    const lines = fs.readFileSync(chartPath, 'utf8').trim().split(/\r?\n/).slice(1);
    const occupied = new Set(lines.map((l) => {
      const c = l.split(',');
      return `${c[0]}|${c[5]}`;
    }));
    const clashes = rows.filter((r) => occupied.has(`${r.step}|${r.row}`));
    console.log(`  ⑤ 与现有谱面（${path.basename(chartPath)}，${lines.length} 颗音）的撞格检查：`
      + `打击乐 ${rows.length} 行中有 ${clashes.length} 行落在"已被旋律/贝斯占用的格"`
      + `（底鼓 row 0 ${clashes.filter((r) => r.row === 0).length} / 踩镲 row 24 ${clashes.filter((r) => r.row === 24).length}）`);
    if (clashes.length) {
      console.log(`     注意：接线时这几个格要么让打击乐优先，要么按 dedupe.mjs 的声部优先级（perc 最低）丢打击乐——`
        + `后者会静默丢掉这些打击乐事件，属于接线阶段要显式决策的项（见 docs/M1-4-report.md §5）`);
    }
  }

  fs.writeFileSync(outPath, result.csv, 'utf8');
  fs.writeFileSync(eventsPath, JSON.stringify({
    meta: {
      audioPath, outPath, stepSec: stats.gridSec, ticksPerStep: stats.ticksPerStep,
      ...detect.meta, percussion: stats,
    },
    bands: detect.bands,
    events: detect.events,
    degradations,
  }, null, 1) + '\n', 'utf8');
  console.log(`  → ${outPath}`);
  console.log(`  → ${eventsPath}（${degradations.length} 条降级明细）`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
