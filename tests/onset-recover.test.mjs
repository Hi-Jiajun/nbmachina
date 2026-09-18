// M1-3 · 起音补漏：对"音频有起音、谱面 50ms 内没有音"的位置补候选音
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ONSET_RECOVER_CONFIG,
  onsetRecover,
  pickMissingNote,
  recoverCsvText,
  uncoveredOnsets,
} from '../src/arrange/onset-recover.mjs';
import { midiToFreq, readNotesCsv, readWav } from '../src/analyze/dsp.mjs';

const BUILD = process.env.nbmachina_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const MACHINE = path.join(BUILD, 'machine_p1.csv');
const SR = 44100;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** 与 onset-detect 测试同一套"真实钢琴"合成（击槌噪声 + 失谐 + 非谐性） */
function synthPiano({ notes, seconds, noise = 0.003, seed = 11 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  const rnd = makeRng(seed);
  for (let i = 0; i < n; i++) out[i] = rnd() * noise;
  const noteRng = makeRng(seed + 991);
  notes.forEach((nt, ni) => {
    const f0 = midiToFreq(nt.midi, 440) * 2 ** (((ni * 37) % 11 - 5) / 1200);
    const start = Math.round(nt.timeSec * SR);
    const nd = Math.round(0.006 * SR);
    for (let k = 0; k < nd; k++) {
      if (start + k >= n) break;
      out[start + k] += noteRng() * nt.gain * 0.9 * (1 - k / nd);
    }
    for (let k = 0; k < Math.round(0.45 * SR); k++) {
      const idx = start + k;
      if (idx >= n) break;
      const t = k / SR;
      const env = Math.min(1, k / (0.01 * SR)) * Math.exp(-t / 0.28);
      let v = 0;
      for (let h = 1; h <= 3; h++) v += (0.6 / h) * Math.sin(2 * Math.PI * f0 * h * Math.sqrt(1 + 0.0004 * h * h) * t);
      out[idx] += v * env * nt.gain;
    }
  });
  return out;
}

const stepSec = 0.12;
const STEP0 = 4;                                   // 前 4 步留白（给检测器一点上下文）
const tOf = (step) => Number(((STEP0 + step) * stepSec).toFixed(3));
const stepOf = (step) => STEP0 + step;

/**
 * 造一个"谱面漏音"的用例：音频里 16 分格都在响，谱面只写了偶数步（8 分格）。
 * 漏掉的偶数/奇数步就是 recover 该补出来的音。
 */
function missingNotesCase() {
  const scale = [0, 2, 4, 5, 7, 9, 11];
  const all = [];
  for (let s = 0; s < 24; s++) {
    all.push({ step: stepOf(s), timeSec: tOf(s), instrument: 'harp', midi: 67 + scale[s % 7] + (s % 4 === 0 ? 12 : 0), gain: 0.3 });
    if (s % 4 === 0) all.push({ step: stepOf(s), timeSec: tOf(s), instrument: 'bass', midi: 36 + scale[s % 7], gain: 0.35 });
  }
  const chart = all.filter((n) => n.instrument === 'bass' || n.step % 2 === 0);
  const missing = all.filter((n) => n.instrument !== 'bass' && n.step % 2 === 1);
  return { all, chart, missing, seconds: tOf(24) + 0.6 };
}

const toCsv = (notes) => ['step,tick,time_seconds,instrument,midi,row,volume',
  ...notes.map((n) => [n.step, n.step * 12, n.timeSec.toFixed(3), n.instrument, n.midi, 0, (n.gain ?? 0.4).toFixed(3)].join(','))].join('\n') + '\n';

test('uncoveredOnsets：只挑出"50ms 内没有谱面音"的音频起音', () => {
  const chart = [1.0, 2.0, 3.0];
  const onsets = [{ time: 1.01 }, { time: 1.2 }, { time: 2.0 }, { time: 3.049 }, { time: 3.2 }];
  const un = uncoveredOnsets({ chartTimes: chart, onsets, tolSec: 0.05 });
  assert.deepEqual(un.map((o) => o.time), [1.2, 3.2]);
  // 边界：恰好等于容差算"覆盖"
  assert.equal(uncoveredOnsets({ chartTimes: [5], onsets: [{ time: 5.05 }], tolSec: 0.05 }).length, 0);
  assert.equal(uncoveredOnsets({ chartTimes: [5], onsets: [{ time: 5.051 }], tolSec: 0.05 }).length, 1);
});

test('pickMissingNote：合成音上判对音级与八度（旋律高音区 + 可判的低音区）', () => {
  const { all, seconds } = missingNotesCase();
  const samples = synthPiano({ notes: all, seconds });
  const fails = [];
  const checks = [
    { t: tOf(1), midi: 67 + 2, instrument: 'harp' },          // 奇数步旋律
    { t: tOf(5), midi: 67 + 9, instrument: 'harp' },
  ];
  for (const c of checks) {
    const r = pickMissingNote({ samples, sampleRate: SR, timeSec: c.t });
    if (r.midi !== c.midi || r.instrument !== c.instrument) fails.push(`${c.t}s 期望 ${c.midi}/${c.instrument}，得到 ${r.midi}/${r.instrument}（reason ${r.reason}）`);
    assert.ok(r.margin >= DEFAULT_ONSET_RECOVER_CONFIG.margin - 1e-9 || r.midi === c.midi, `margin=${r.margin}`);
    assert.equal(r.reason, 'recovered');
  }
  assert.deepEqual(fails, [], fails.join('；'));

  // 低音区可判的那一段（midi ≥ 52，仍落在"bass"音区）→ instrument 必须按音区给 bass
  const low = synthPiano({ notes: [{ timeSec: 0.6, midi: 52, gain: 0.35 }], seconds: 1.8 });
  const r52 = pickMissingNote({ samples: low, sampleRate: SR, timeSec: 0.6 });
  assert.equal(r52.midi, 52);
  assert.equal(r52.instrument, 'bass');
});

test('pickMissingNote：低音区（一个半音 < 1 个 bin）不硬猜 —— 与 M1-1 的贝斯结论一致', () => {
  // 单独一颗低音（没有别的音同时在响）也判不出音级：44.1kHz / 100ms 窗的主瓣 ≈ 20Hz，
  // 而 D2 与 D#2 只差 4.4Hz。这条边界是物理的，不是阈值调得保守。
  const fails = [];
  for (const midi of [36, 41, 45]) {
    const samples = synthPiano({ notes: [{ timeSec: 0.6, midi, gain: 0.35 }], seconds: 1.8 });
    const r = pickMissingNote({ samples, sampleRate: SR, timeSec: 0.6 });
    if (r.reason !== 'below-margin' || r.midi !== null) fails.push(`midi ${midi} → ${r.midi}/${r.reason}（margin ${r.margin}）`);
  }
  assert.deepEqual(fails, [], fails.join('；'));
});

test('pickMissingNote：静音段不补（weak-evidence），两音级势均力敌时也不补（below-margin）', () => {
  const silence = new Float64Array(Math.round(1.0 * SR));
  const s = pickMissingNote({ samples: silence, sampleRate: SR, timeSec: 0.3 });
  assert.equal(s.midi, null);
  assert.equal(s.reason, 'weak-evidence');

  // 同时响两个半音（差 1 个半音、等能量）→ 最强/次强 ≈ 1，应记 below-margin 而不是硬猜
  const seconds = 1.2;
  const tie = synthPiano({ notes: [
    { timeSec: 0.2, midi: 70, gain: 0.3 },
    { timeSec: 0.2, midi: 71, gain: 0.3 },
  ], seconds });
  const r = pickMissingNote({ samples: tie, sampleRate: SR, timeSec: 0.2 });
  assert.equal(r.midi, null, `不该硬猜：${r.midi}`);
  assert.equal(r.reason, 'below-margin');
  assert.ok(r.margin < DEFAULT_ONSET_RECOVER_CONFIG.margin, `margin=${r.margin}`);
});

test('onsetRecover：谱面漏的 16 分格旋律被补回来，原有行逐字符保留', () => {
  const { all, chart, missing, seconds } = missingNotesCase();
  const samples = synthPiano({ notes: all, seconds });
  const csv = toCsv(chart);
  const out = onsetRecover({ csvText: csv, samples, sampleRate: SR, stepSec });
  const hit = [];
  for (const m of missing) {
    const got = out.recovered.find((r) => Math.abs(r.timeSec - m.timeSec) <= 0.06);
    hit.push({ m, got });
    if (got) {
      // 补出来的音必须音级 + 八度都对（判错音级比不补更糟）
      assert.equal(got.midi, m.midi, `${m.timeSec}s 期望 midi ${m.midi}，补成 ${got.midi}（${got.midiName}）`);
      assert.equal(got.step, m.step, `${m.timeSec}s 应落在 step ${m.step}，实际 ${got.step}`);
    }
  }
  const missed = hit.filter((h) => !h.got);
  assert.ok(hit.length - missed.length >= missing.length - 2,
    `补出的音太少：${hit.length - missed.length}/${missing.length}（未补 ${missed.map((h) => h.m.timeSec).join(' ')}）`);
  console.log(`    合成漏音 ${missing.length} 个 → 补出 ${hit.length - missed.length} 个（全部音级/八度正确）`
    + `，未补 ${missed.length} 个：${out.degradations.map((d) => `${d.timeSec}s/${d.reason}`).join(' ')}`);
  // 原有行逐字符保留
  const inRows = csv.trim().split(/\r?\n/).slice(1);
  for (const l of inRows) assert.ok(out.csv.includes(l.trim()), '原有行必须逐字符保留');
  // 新行的 step/tick/time 自洽（对齐 0.12s 网格）
  for (const r of out.recovered) {
    assert.equal(r.tick, r.step * 12);
    assert.ok(Math.abs(r.stepTimeSec - r.step * stepSec) < 1e-6, `写入谱面的时刻应对齐 0.12s 网格：${r.stepTimeSec}`);
    assert.ok(Math.abs(r.timeSec - r.stepTimeSec) <= 0.06, `吸附不该超过半步（检测 ${r.timeSec} → 写 ${r.stepTimeSec}）`);
  }
  assert.ok(out.report.meta.uncovered > 0);
  assert.equal(out.report.meta.recovered, out.recovered.length);
});

test('recoverCsvText：追加 origin/recoverReason/recoverMargin 列，且不会在同一格重复补音', () => {
  const { all, chart, seconds } = missingNotesCase();
  const samples = synthPiano({ notes: all, seconds });
  const csv = toCsv(chart);
  const out = recoverCsvText({ csvText: csv, samples, sampleRate: SR, stepSec });
  const { header, notes } = readNotesCsv(out.csv);
  assert.deepEqual(header.slice(0, 7), ['step', 'tick', 'time_seconds', 'instrument', 'midi', 'row', 'volume']);
  assert.deepEqual(header.slice(7), ['origin', 'recoverReason', 'recoverMargin']);
  const keys = notes.map((n) => `${n.step}|${n.midi}`);
  assert.equal(new Set(keys).size, keys.length, '同一 (step,midi) 不能重复');
  const recovered = notes.filter((n) => n.fields[7] === 'recovered');
  assert.ok(recovered.length > 0, '应当有 recovered 行');
  for (const r of recovered) assert.ok(Number(r.fields[9]) >= DEFAULT_ONSET_RECOVER_CONFIG.margin, 'recovered 行必须带 ≥门槛的边距');
});

test('真实数据：machine_p1 的未覆盖起音上补候选音；不覆盖的位置一条不改', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(MACHINE)) return t.skip(`缺少 ${WAV} 或 ${MACHINE}`);
  const { samples, sampleRate } = readWav(WAV);
  const csvText = fs.readFileSync(MACHINE, 'utf8');
  const out = onsetRecover({ csvText, samples, sampleRate, stepSec: 0.12 });
  const m = out.report.meta;
  assert.ok(m.uncovered > 10, `未覆盖起音太少（${m.uncovered}）；检测器或谱面有问题`);
  assert.ok(m.recovered <= m.uncovered, '补出的音不能多于未覆盖起音');
  // 保真契约：每一个未覆盖起音都必须有交代（补出来 或 记一条降级），不许静默丢
  const degraded = Object.values(m.degradations).reduce((a, b) => a + b, 0);
  assert.equal(m.recovered + degraded, m.uncovered,
    `未覆盖 ${m.uncovered} 个，但只有 ${m.recovered} 补出 + ${degraded} 降级`);
  for (const d of out.degradations) assert.ok(d.reason && Number.isFinite(d.timeSec), `降级项必须带原因与时刻：${JSON.stringify(d)}`);
  for (const r of out.recovered) {
    assert.ok(r.margin >= DEFAULT_ONSET_RECOVER_CONFIG.margin, `recovered 必须过硬门槛：${JSON.stringify(r)}`);
    assert.ok(r.rms >= DEFAULT_ONSET_RECOVER_CONFIG.minRms);
  }
  console.log(`    真实数据：未覆盖起音 ${m.uncovered}，补出 ${m.recovered}`
    + `（harp ${m.byInstrument.harp ?? 0} / bass ${m.byInstrument.bass ?? 0}）`
    + `，降级 ${JSON.stringify(m.degradations)}`);
});
