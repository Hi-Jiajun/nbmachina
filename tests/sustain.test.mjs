// M1-2 · 长音/延音：从音频估每颗音的持续长度 → 同音高重复触发
//
// 任务书 `nbmachina-m1-2.md` 要求先用合成音验对（0.6s 长音 / 0.12s 短音），再上真实音频。
// 所以这个文件的结构是：① 合成音判据（长/短/上限/静音/音高隔离）② 追加触发的纯函数契约
// ③ CSV 契约（原行逐字符不变、不制造撞格）④ 真实数据（相关性、撞格、空隙占比）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import { dedupeCsvText, detectCollisions } from '../src/arrange/dedupe.mjs';
import { encodeWav, midiToFreq, pearson, readWav, spearman } from '../src/analyze/dsp.mjs';
import {
  DEFAULT_SUSTAIN_CONFIG,
  emptyGapRate,
  estimateSustain,
  planSustainRepeats,
  readNotesCsv,
  sustainCsvText,
} from '../src/arrange/sustain.mjs';

const BUILD = process.env.nbmachina_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const MACHINE = path.join(BUILD, 'styx_helix_machine.csv');
const SR = 44100;

/** 合成单声道音频：每颗音可指定时长、振幅包络（tau）与谐波 */
function synth({ seconds, events }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (const e of events) {
    const f0 = midiToFreq(e.midi ?? 69, 440);
    const start = Math.round((e.atSec ?? 0) * SR);
    const dur = Math.round((e.durSec ?? 0.3) * SR);
    const attack = Math.max(1, Math.round((e.attackSec ?? 0.005) * SR));
    const tau = e.tauSec ?? Infinity;
    const harm = e.harmonics ?? [[1, 1]];
    const gain = e.gain ?? 0.5;
    for (let i = 0; i < dur; i++) {
      const j = start + i;
      if (j >= n) break;
      const t = i / SR;
      const env = Math.min(1, i / attack) * (Number.isFinite(tau) ? Math.exp(-t / tau) : 1);
      let v = 0;
      for (const [h, w] of harm) {
        const f = f0 * h;
        if (f > SR * 0.45) break;
        v += w * Math.sin(2 * Math.PI * f * t);
      }
      out[j] += gain * env * v;
    }
  }
  return out;
}

const note = (o) => ({
  noteId: o.noteId ?? 0,
  step: o.step ?? 0,
  tick: (o.step ?? 0) * 12,
  timeSec: o.timeSec ?? (o.step ?? 0) * 0.12,
  instrument: o.instrument ?? 'harp',
  midi: o.midi ?? 69,
  row: o.row ?? 12,
  volume: o.volume ?? 0.8,
  ...o,
});

/* ------------------------------------------------------ ① 合成音判据 */

test('合成音：0.6s 长音估到 0.6s（±1 个步进窗），0.12s 短音估到 ≤0.36s 且不追加触发', () => {
  const samples = synth({
    seconds: 1.6,
    events: [
      { midi: 72, atSec: 0, durSec: 0.6, gain: 0.5 },
      { midi: 67, atSec: 1.0, durSec: 0.12, gain: 0.5 },
    ],
  });
  const long = estimateSustain({ samples, sampleRate: SR, note: note({ midi: 72, timeSec: 0 }) });
  const short = estimateSustain({ samples, sampleRate: SR, note: note({ midi: 67, timeSec: 1.0 }) });

  assert.ok(Math.abs(long.sustainSec - 0.6) <= DEFAULT_SUSTAIN_CONFIG.hopSec + 1e-9,
    `0.6s 长音应估到 0.6s（±1 窗），实测 ${long.sustainSec}`);
  assert.ok(short.sustainSec <= DEFAULT_SUSTAIN_CONFIG.minRepeatSustainSec,
    `0.12s 短音不该超过 ${DEFAULT_SUSTAIN_CONFIG.minRepeatSustainSec}s，实测 ${short.sustainSec}`);
  assert.equal(long.reason, 'measured');

  const csv = 'step,tick,time_seconds,instrument,midi,row,volume\n'
    + '0,0,0.000,harp,72,12,0.800\n'
    + '8,96,0.960,harp,67,7,0.800\n';
  const { report } = sustainCsvText({ csvText: csv, samples, sampleRate: SR });
  assert.equal(report.summary.appendedTriggers, 2, '长音（0.6s → 2 步间隔）追加 2 次，短音 0 次');
  assert.equal(report.summary.lengthenedNotes, 1);
  assert.deepEqual(report.repeats.filter((r) => r.sustainOf === 8), [], '短音不得被追加');
});

test('上限 1.0s：能量始终不跌破 25% → 按持续音处理（4 次重复，不再延长）', () => {
  const samples = synth({ seconds: 2.4, events: [{ midi: 60, atSec: 0, durSec: 2.2, gain: 0.5 }] });
  const r = estimateSustain({ samples, sampleRate: SR, note: note({ midi: 60, timeSec: 0 }) });
  assert.equal(r.sustainSec, DEFAULT_SUSTAIN_CONFIG.maxSustainSec);
  assert.equal(r.reason, 'at-cap');
  const { appended } = planSustainRepeats({ notes: [note({ midi: 60, step: 0, row: 12 })], sustains: [1.0] });
  assert.equal(appended.length, 4, '1.0s / 0.24s = 4 次');
  assert.deepEqual(appended.map((a) => a.step), [2, 4, 6, 8]);
  assert.deepEqual(appended.map((a) => a.sustainIndex), [1, 2, 3, 4]);
  appended.forEach((a, i) => {
    assert.ok(Math.abs(a.volume - 0.8 * Math.pow(0.85, i + 1)) < 1e-3, `第 ${i + 1} 次力度应 ×0.85`);
  });
  assert.equal(r.sustainSec, 1.0, '超过 1.0s 一律按 1.0s（持续音）处理，不做更长估计');
});

test('判据只量"这颗音自己的音级 + 八度"：同一段音频里，对得上音高的那颗长、错八度的那颗无证据', () => {
  const samples = synth({ seconds: 1.2, events: [{ midi: 72, atSec: 0, durSec: 0.8, gain: 0.5 }] });
  const right = estimateSustain({ samples, sampleRate: SR, note: note({ midi: 72, timeSec: 0 }) });
  const wrong = estimateSustain({ samples, sampleRate: SR, note: note({ midi: 60, timeSec: 0 }) });
  assert.ok(right.sustainSec > 0.36, `音高对得上应估到长音，实测 ${right.sustainSec}`);
  assert.ok(wrong.sustainSec <= 0.36, `错八度不该被判成长音，实测 ${wrong.sustainSec}`);
  assert.equal(wrong.reason, 'weak-evidence', '窗口里有别的音在响、但该音高没能量 → 记无证据，不猜长度');
});

test('静音窗 = 无证据：reason=weak-evidence、持续 0，且不追加触发（降级必须显式记录）', () => {
  const samples = new Float64Array(SR);
  const r = estimateSustain({ samples, sampleRate: SR, note: note({ midi: 60, timeSec: 0 }) });
  assert.equal(r.reason, 'weak-evidence');
  assert.equal(r.sustainSec, 0);
  const { appended } = planSustainRepeats({ notes: [note({ midi: 60, step: 0 })], sustains: [0] });
  assert.equal(appended.length, 0);
});

test('可选证据门槛（minRepeatEnergyFraction>0）：只在音频里确实还听得见这颗音的位置追加', () => {
  // 响的那颗（gain 0.5）与轻的那颗（gain 0.08，仍高于 minRms 所以不是"无证据"）都持续 0.9s；
  // 门槛 = 0.1 × 起音峰值中位数 ≈ 0.051 × 响音峰值 → 轻的那颗（能量比 0.026）整条被挡下
  const samples = synth({
    seconds: 2.0,
    events: [
      { midi: 72, atSec: 0, durSec: 0.9, gain: 0.5 },
      { midi: 60, atSec: 1.0, durSec: 0.9, gain: 0.08 },
    ],
  });
  const csv = 'step,tick,time_seconds,instrument,midi,row,volume\n'
    + '0,0,0.000,harp,72,12,0.900\n'
    + '8,96,0.960,harp,60,0,0.900\n';
  const off = sustainCsvText({ csvText: csv, samples, sampleRate: SR });
  const on = sustainCsvText({ csvText: csv, samples, sampleRate: SR, config: { minRepeatEnergyFraction: 0.1 } });
  assert.ok(off.report.summary.appendedTriggers > 4, '关闭门槛时两颗音都要追加');
  assert.equal(on.report.summary.skippedWeakEvidence > 0, true, '门槛要挡下轻的那颗');
  assert.ok(on.report.summary.appendedTriggers <= off.report.summary.appendedTriggers);
  assert.equal(on.report.summary.appendedTriggers, 3, '响的那颗仍然要被延长（0.9s → 3 次）');
  assert.equal(on.report.repeats.every((r) => r.midi === 72), true, '被挡下的都是轻的那颗（midi 60）');
});

/* ------------------------------------------- ② 追加触发的纯函数契约 */

test('追加触发：同一 row/同一 instrument、2 步间隔、力度 ×0.85 逐次衰减、sustainOf/sustainIndex 正确', () => {
  const notes = [
    note({ noteId: 0, step: 10, row: 3, instrument: 'bass', midi: 45, volume: 0.6 }),
  ];
  const { appended, perNote, stats } = planSustainRepeats({ notes, sustains: [0.72] });
  assert.equal(appended.length, 3, '0.72s / 0.24s = 3 次');
  assert.deepEqual(appended.map((a) => a.step), [12, 14, 16]);
  assert.deepEqual(appended.map((a) => a.tick), [144, 168, 192]);
  appended.forEach((a, i) => {
    assert.equal(a.instrument, 'bass');
    assert.equal(a.midi, 45, '同音高（不换音级、不换八度）');
    assert.equal(a.row, 3, '同一 row');
    assert.equal(a.sustainOf, 10, 'sustainOf = 原音所在 step');
    assert.equal(a.sustainIndex, i + 1);
    assert.ok(Math.abs(a.timeSec - (1.2 + 0.24 * (i + 1))) < 1e-9, '时间 = 原音 + 0.24s × 第几次');
  });
  assert.ok(Math.abs(appended[0].volume - 0.51) < 1e-9 && Math.abs(appended[2].volume - 0.368) < 1e-9);
  assert.deepEqual(perNote.map((p) => p.repeats), [3]);
  assert.equal(stats.lengthenedNotes, 1);
  assert.equal(stats.appendedTriggers, 3);
  assert.equal(stats.lengthenedByVoice.bass, 1);
});

test('占格保护：目标格已被原有音符占用 → 跳过该次触发（绝不制造撞格、绝不顶掉原音）', () => {
  const notes = [
    note({ noteId: 0, step: 0, row: 5, instrument: 'harp', midi: 72, volume: 0.9 }),
    note({ noteId: 1, step: 2, row: 5, instrument: 'harp', midi: 74, volume: 0.9 }),
    note({ noteId: 2, step: 4, row: 5, instrument: 'harp', midi: 76, volume: 0.9 }),
  ];
  const { appended, stats } = planSustainRepeats({ notes, sustains: [0.72, 0, 0] });
  assert.equal(appended.length, 1, 'step 2/4 被占格跳过，只剩 step 6');
  assert.equal(appended[0].step, 6);
  assert.equal(stats.blockedByOtherPitch, 2, '被别的音高占用 → 放弃该次触发（不顶掉原音）');
  assert.equal(stats.effectiveRepeats, 1);
});

test('目标格本来就有同音高触发 → 不算"需要追加"，但计入该音的有效重复次数', () => {
  const notes = [
    note({ noteId: 0, step: 0, row: 5, instrument: 'harp', midi: 72, volume: 0.9 }),
    note({ noteId: 1, step: 2, row: 5, instrument: 'harp', midi: 72, volume: 0.9 }),
    note({ noteId: 2, step: 4, row: 5, instrument: 'harp', midi: 74, volume: 0.9 }),
  ];
  const { appended, stats, perNote } = planSustainRepeats({ notes, sustains: [0.72, 0, 0] });
  assert.equal(stats.alreadyRetriggeredInInput, 1, 'step 2 上输入本来就有同音高重触发');
  assert.equal(stats.blockedByOtherPitch, 1, 'step 4 被别的音高占用');
  assert.equal(appended.filter((a) => a.sustainOf === 0 && a.sustainIndex === 3).length, 1, 'step 6 仍要追加');
  assert.equal(perNote[0].effectiveRepeats, 2, '有效重复次数 = 追加 1 + 输入已有 1');
});

test('门槛：持续 ≤0.36s 的音一律不追加（哪怕刚好 0.36）', () => {
  const { appended } = planSustainRepeats({ notes: [note({ step: 0 })], sustains: [0.36] });
  assert.equal(appended.length, 0);
  const { appended: a2 } = planSustainRepeats({ notes: [note({ step: 0 })], sustains: [0.48] });
  assert.equal(a2.length, 2, '0.48/0.24 = 2 次（含 0.48 这一次）');
});

/* ---------------------------------------------------- ③ CSV 契约 */

test('CSV 契约：原行逐字符保留且顺序不变；新行只追加在末尾；新增两列 sustainOf/sustainIndex', () => {
  const samples = synth({
    seconds: 1.2,
    events: [{ midi: 72, atSec: 0, durSec: 0.6, gain: 0.5 }, { midi: 72, atSec: 0.9, durSec: 0.12, gain: 0.5 }],
  });
  const csv = [
    'step,tick,time_seconds,instrument,midi,row,volume',
    '0,0,0.000,harp,72,12,0.900',
    '7,84,0.840,harp,72,12,0.700',
    '',
  ].join('\n');
  const { csv: out, report } = sustainCsvText({ csvText: csv, samples, sampleRate: SR });
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'step,tick,time_seconds,instrument,midi,row,volume,sustainOf,sustainIndex');
  assert.equal(lines[1], '0,0,0.000,harp,72,12,0.900,,0', '原行逐字符不变（只接两列空/0）');
  assert.equal(lines[2], '7,84,0.840,harp,72,12,0.700,,0');
  const appendedLines = lines.slice(3);
  assert.equal(appendedLines.length, report.summary.appendedTriggers);
  for (const l of appendedLines) {
    const c = l.split(',');
    assert.equal(c.length, 9);
    assert.equal(c[7], '0', 'sustainOf = 原音 step（0）');
    assert.ok(['1', '2'].includes(c[8]));
  }
  // 原行前缀（含逗号）与输入完全一致
  const inLines = csv.trim().split('\n');
  lines.slice(1, 1 + inLines.length - 1).forEach((l, i) => {
    assert.ok(l.startsWith(`${inLines[i + 1]},`), `第 ${i + 1} 行原内容被改动：${l}`);
  });
});

test('撞格：延音后的谱面过一遍 dedupe.mjs 必须是 0 格（且一颗音都没被合并掉）', () => {
  const samples = synth({
    seconds: 1.2,
    events: [{ midi: 60, atSec: 0, durSec: 0.72, gain: 0.5 }],
  });
  const csv = [
    'step,tick,time_seconds,instrument,midi,row,volume',
    '0,0,0.000,bass,60,12,0.900',
    '2,24,0.240,bass,60,12,0.800',
    '',
  ].join('\n');
  const { csv: out } = sustainCsvText({ csvText: csv, samples, sampleRate: SR });
  const { report } = dedupeCsvText(out);
  assert.equal(report.summary.notesOut, report.summary.notesIn, '不许有音被合并掉（原音必须原样保留）');
  assert.equal(report.summary.collisionCells, 0);
  assert.equal(detectCollisions(readNotesCsv(out).notes).length, 0);
});

/* --------------------------------------------------------- ④ 真实数据 */

test('真实数据：机器谱面跑一遍 → 追加触发 > 0、撞格 0、r ≥ 0.6、空隙占比下降', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(MACHINE)) return t.skip(`缺少 ${WAV} 或 ${MACHINE}`);
  const { samples, sampleRate } = readWav(WAV);
  const csvText = fs.readFileSync(MACHINE, 'utf8');
  const { csv: out, report, notes } = sustainCsvText({ csvText, samples, sampleRate });
  const s = report.summary;

  const rEff = s.correlation.effective.pearson;   // 验收口径：有效重复触发次数（追加 + 输入已有）
  const rApp = s.correlation.appended.pearson;    // 实际写入 CSV 的次数（被占格削掉一部分）
  assert.ok(s.appendedTriggers > 0, '必须在真实谱面上真的追加出触发');
  assert.ok(rEff >= 0.6, `重复触发次数与持续时长的相关必须 ≥0.6，实测 r=${rEff.toFixed(4)}`);
  assert.ok(Number.isFinite(rApp), '实际写入次数的相关也要记进报告（哪怕更低）');

  const deduped = dedupeCsvText(out);
  assert.equal(detectedCells(out), 0, '延音后必须无撞格');
  assert.equal(deduped.report.summary.notesOut, deduped.report.summary.notesIn, '去撞格不许丢音');

  const after = emptyGapRate({
    samples, sampleRate,
    steps: [...notes.map((n) => n.step), ...report.repeats.map((x) => x.step)],
    maxStep: report.gap.maxStep,
  });
  assert.ok(after.rate < report.gap.before.rate, `空隙占比必须下降：${report.gap.before.rate} → ${after.rate}`);
  console.log(`    机器谱面 ${notes.length} 颗音 → 追加 ${s.appendedTriggers} 次`
    + `｜被延长 ${s.lengthenedNotes} 颗 ${JSON.stringify(s.lengthenedByVoice)}`
    + `｜计划 ${s.plannedRepeats} / 输入已有 ${s.alreadyRetriggeredInInput} / 占用放弃 ${s.blockedByOtherPitch}`
    + `｜r 有效=${rEff.toFixed(4)} 计划=${s.correlation.planned.pearson.toFixed(4)} 写入=${rApp.toFixed(4)}`
    + ` ρ=${spearman(s.perNoteEffectiveRepeats, s.perNoteSustain).toFixed(4)}`
    + `｜空隙占比 ${(100 * report.gap.before.rate).toFixed(2)}% → ${(100 * after.rate).toFixed(2)}%`);
});

/** 独立实现：CSV 文本里的 (step,row) 撞格格数（不复用生产代码的判定） */
function detectedCells(csvText) {
  const lines = csvText.trim().split(/\r?\n/);
  const H = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
  const seen = new Set();
  let cells = 0;
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    const k = `${c[H.step]}|${c[H.row]}`;
    if (seen.has(k)) cells++;
    seen.add(k);
  }
  return cells;
}

test('真实数据 · 参考音频的逐音包络（写报告用）：同一 instrument 的归一化形状高度一致', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(MACHINE)) return t.skip(`缺少 ${WAV} 或 ${MACHINE}`);
  const { samples, sampleRate } = readWav(WAV);
  const { notes } = readNotesCsv(fs.readFileSync(MACHINE, 'utf8'));
  const harp = notes.filter((n) => n.instrument === 'harp').slice(0, 400);
  const shapes = harp.map((n) => {
    const r = estimateSustain({ samples, sampleRate, note: n });
    const peak = r.peakEnergy || 1;
    return r.energies.slice(0, 6).map((e) => e / peak);
  });
  // 第 2 帧（0.05s）的归一化能量：若是"固定衰减样本"，各音会挤在一个很窄的区间
  const second = shapes.map((s) => s[1]).sort((a, b) => a - b);
  const p10 = second[Math.floor(0.1 * second.length)];
  const p90 = second[Math.floor(0.9 * second.length)];
  assert.ok(Number.isFinite(p10) && Number.isFinite(p90));
  console.log(`    前 400 颗 harp 音的第 2 帧归一化能量：p10=${p10.toFixed(3)} p50=${second[Math.floor(0.5 * second.length)].toFixed(3)} p90=${p90.toFixed(3)}`
    + `｜能量跌破 25% 的帧分布（帧号:颗数）${JSON.stringify(histogram(harp.map((n) => Math.round(estimateSustain({ samples, sampleRate, note: n }).sustainSec / DEFAULT_SUSTAIN_CONFIG.hopSec))))}`);
});

function histogram(xs) {
  return xs.reduce((a, x) => (a[x] = (a[x] ?? 0) + 1, a), {});
}

test('WAV 往返：合成 buffer 编码后再读回，判据结果一致（端到端文本入口）', () => {
  const samples = synth({ seconds: 1.2, events: [{ midi: 64, atSec: 0, durSec: 0.6, gain: 0.5 }] });
  const buf = encodeWav({ samples, sampleRate: SR });
  const back = readWav(buf);
  const r = estimateSustain({ samples: back.samples, sampleRate: back.sampleRate, note: note({ midi: 64, timeSec: 0 }) });
  assert.ok(Math.abs(r.sustainSec - 0.6) <= 0.05 + 1e-9, `实测 ${r.sustainSec}`);
});
