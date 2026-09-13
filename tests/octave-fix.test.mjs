// T3 · 用八度证据修音高（先失败，后实现）
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeNotes, encodeWav, midiToFreq, voiceOfInstrument } from '../src/analyze/octave-evidence.mjs';
import {
  countIntegerOctavePairs,
  fixOctaves,
  notesFixedCsv,
  toV3Csv,
} from '../src/arrange/octave-fix.mjs';

const SR = 44100;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (midi) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

function synth({ seconds, events }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (const e of events) {
    const f0 = midiToFreq(e.midi, 440);
    const start = Math.round(e.atSec * SR);
    const dur = Math.round((e.durSec ?? 0.3) * SR);
    const harm = e.harmonics ?? [1, 0.5, 0.25];
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SR;
      const env = Math.min(1, i / (0.005 * SR)) * Math.exp(-t / 0.5);
      let v = 0;
      for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * t);
      out[idx] += v * env * (e.gain ?? 0.5);
    }
  }
  return out;
}

/** 造一段"转谱 CSV"（列与 build/styx_helix_notes.csv 一致） */
function notesCsv(rows) {
  return 'step,time_seconds,instrument,midi,note_block_pitch,octave_shift\n'
    + rows.map((r) => `${r.step},${r.timeSec},${r.instrument},${r.midi},${r.noteBlockPitch ?? 0},${r.octaveShift ?? 0}`).join('\n')
    + '\n';
}

/**
 * 用真实音频证据接口造证据。
 * @param audioNotes 音频里真实发声的音（决定合成信号）
 * @param identityNotes 证据表里的音符身份（决定 noteId/时间/原 midi），默认与音频相同。
 *        真实链路里 T2 是对**转谱 CSV** 逐音算证据的，所以身份就是输入自己的音高。
 */
function evidenceFor(audioNotes, identityNotes = audioNotes, seconds = 3) {
  const samples = synth({
    seconds,
    events: audioNotes.map((n) => ({ atSec: n.timeSec, midi: n.midi, durSec: 0.3 })),
  });
  return analyzeNotes({
    samples,
    sampleRate: SR,
    notes: identityNotes.map((n, i) => ({
      noteId: i,
      step: n.step,
      timeSec: n.timeSec,
      instrument: n.instrument,
      midi: n.midi,
      voice: voiceOfInstrument(n.instrument),
    })),
  });
}

test('相邻两音相差整数八度的错误输入：按证据修回后整数八度对数降为 0', () => {
  // 音频里是 A1 持续两拍 → C2 持续两拍（贝斯最常见的形态）
  const truth = [
    { step: 0, timeSec: 0.0, instrument: 'bass', midi: 33 },
    { step: 2, timeSec: 0.24, instrument: 'bass', midi: 33 },
    { step: 4, timeSec: 0.48, instrument: 'bass', midi: 36 },
    { step: 6, timeSec: 0.72, instrument: 'bass', midi: 36 },
  ];
  // 输入把这两颗音各又写低了一个八度（真实数据里就是这种"同一颗音多写一个低八度"）
  const input = truth.map((n, i) => ({ ...n, midi: i % 2 === 0 ? n.midi - 12 : n.midi }));
  const evidence = evidenceFor(truth, input);

  const before = countIntegerOctavePairs(input);
  assert.ok(before >= 1, '夹具必须真的含有整数八度错误');

  const { notes, degradations, stats } = fixOctaves({ csvText: notesCsv(input), evidence });
  assert.deepEqual(notes.map((n) => n.newMidi), truth.map((n) => n.midi));
  assert.equal(countIntegerOctavePairs(notes.map((n) => ({ ...n, midi: n.newMidi }))), 0);
  assert.equal(stats.integerOctavePairs.before.total, before);
  assert.equal(stats.integerOctavePairs.after.total, 0);
  assert.equal(stats.changed, 2);
  assert.equal(degradations.length, 0);
});

test('弱证据（静音窗）：保留原值并写入 degradations', () => {
  const input = [{ step: 0, timeSec: 0, instrument: 'harp', midi: 72, noteBlockPitch: 12, octaveShift: -1 }];
  const evidence = analyzeNotes({
    samples: new Float64Array(SR),
    sampleRate: SR,
    notes: [{ noteId: 0, step: 0, timeSec: 0, instrument: 'harp', midi: 72 }],
  });
  assert.equal(evidence.notes[0].weak, true, '夹具必须是弱证据');

  const { notes, degradations } = fixOctaves({ csvText: notesCsv(input), evidence });
  assert.equal(notes[0].newMidi, 72, '弱证据时必须保留原值');
  assert.equal(notes[0].fixReason, 'weak-evidence');
  assert.equal(degradations.length, 1);
  assert.equal(degradations[0].noteId, 0);
  assert.equal(degradations[0].reason, 'weak-evidence');
  assert.ok(typeof degradations[0].rms === 'number');
});

test('缺证据：保留原值并记录 missing-evidence', () => {
  const input = [
    { step: 0, timeSec: 0, instrument: 'harp', midi: 72 },
    { step: 2, timeSec: 0.24, instrument: 'harp', midi: 74 },
  ];
  const evidence = evidenceFor([{ step: 0, timeSec: 0, instrument: 'harp', midi: 72 }]);
  const { notes, degradations, stats } = fixOctaves({ csvText: notesCsv(input), evidence });
  assert.equal(notes[1].newMidi, 74);
  assert.equal(notes[1].fixReason, 'missing-evidence');
  assert.equal(degradations.length, 1);
  assert.equal(stats.kept, 2);
});

test('音域先验：写在音域外的贝斯音被拉回实测音域', () => {
  const truth = [{ step: 0, timeSec: 0, instrument: 'bass', midi: 33 }];
  const input = [{ step: 0, timeSec: 0, instrument: 'bass', midi: 9 }];   // 写在 midi 9（≈12Hz，物理上不可能）
  const evidence = evidenceFor(truth, input);
  const { notes } = fixOctaves({ csvText: notesCsv(input), evidence });
  assert.ok(notes[0].newMidi >= 21 && notes[0].newMidi <= 63, `newMidi=${notes[0].newMidi} 不在贝斯音域`);
  assert.equal(notes[0].newMidi, 33);
});

test('CSV 输出：原列原样保留，新列追加在末尾', () => {
  const input = [
    { step: 0, timeSec: 0.0, instrument: 'bass', midi: 21, noteBlockPitch: 9, octaveShift: 3 },
    { step: 2, timeSec: 0.24, instrument: 'harp', midi: 85, noteBlockPitch: 13, octaveShift: 0 },
  ];
  const evidence = evidenceFor([
    { step: 0, timeSec: 0, instrument: 'bass', midi: 33 },
    { step: 2, timeSec: 0.24, instrument: 'harp', midi: 85 },
  ], input);
  const { notes } = fixOctaves({ csvText: notesCsv(input), evidence });
  const csv = notesFixedCsv(notes);
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'step,time_seconds,instrument,midi,note_block_pitch,octave_shift,newMidi,octaveEvidence,fixReason');
  assert.equal(lines[1].split(',')[0], '0');
  assert.equal(lines[1].split(',')[1], '0');
  assert.equal(lines[1].split(',')[3], '21', '原 midi 列必须保留');
  assert.equal(lines[1].split(',')[4], '9', '原 note_block_pitch 必须保留');
  assert.equal(lines[1].split(',')[5], '3', '原 octave_shift 必须保留');
  assert.equal(lines[1].split(',')[6], '33', 'newMidi 是新八度');
  assert.match(lines[1].split(',')[7], /^[A-G]#?-?\d@[\d.]+$/, 'octaveEvidence 形如 A1@2.03');
  assert.equal(lines[1].split(',')[8], 'evidence');
});

test('toV3Csv：把修复后的音高写回 v3 列，供下游去撞格/布局直接消费', () => {
  const v3 = 'step,tick,time_seconds,instrument,midi,row,volume\n'
    + '0,0,0.000,bass,21,9,0.350\n'
    + '2,24,0.240,harp,85,13,0.610\n';
  const inputIdentities = [
    { step: 0, timeSec: 0, instrument: 'bass', midi: 21 },
    { step: 2, timeSec: 0.24, instrument: 'harp', midi: 85 },
  ];
  const evidence = evidenceFor([
    { step: 0, timeSec: 0, instrument: 'bass', midi: 33 },
    { step: 2, timeSec: 0.24, instrument: 'harp', midi: 85 },
  ], inputIdentities);
  const { notes } = fixOctaves({ csvText: v3, evidence });
  const out = toV3Csv(notes);
  const lines = out.trim().split('\n');
  assert.deepEqual(lines[0].split(','), ['step', 'tick', 'time_seconds', 'instrument', 'midi', 'row', 'volume']);
  assert.deepEqual(lines[1].split(','), ['0', '0', '0.000', 'bass', '33', '9', '0.350']);
  assert.deepEqual(lines[2].split(','), ['2', '24', '0.240', 'harp', '85', '13', '0.610']);
});

test('行序不同（v3 形态）也能对上证据：按 (时间,乐器,原 midi) 兜底匹配', () => {
  // 音频里是 A1 → C2 → A1；转谱把它们各写低了一个八度，且 v3 里的行序与 notes.csv 不同
  const truth = [
    { step: 0, timeSec: 0, instrument: 'bass', midi: 33 },
    { step: 2, timeSec: 0.24, instrument: 'bass', midi: 36 },
    { step: 4, timeSec: 0.48, instrument: 'bass', midi: 33 },
  ];
  const inputOrder = truth.map((n) => ({ ...n, midi: n.midi - 12 }));   // notes.csv 顺序（step 递增）
  const evidence = evidenceFor(truth, inputOrder);
  const v3 = 'step,tick,time_seconds,instrument,midi,row,volume\n'
    + '4,48,0.480,bass,21,9,0.400\n'      // 与 notes.csv 的第一行不同序
    + '0,0,0.000,bass,21,9,0.350\n'
    + '2,24,0.240,bass,24,16,0.500\n';
  const { notes } = fixOctaves({ csvText: v3, evidence });
  assert.deepEqual(notes.map((n) => n.newMidi), [33, 33, 36]);
  assert.deepEqual(notes.map((n) => n.fixReason), ['evidence', 'evidence', 'evidence']);
});

test('countIntegerOctavePairs 口径：同声部按时间排序，相邻两音差整数个八度', () => {
  const notes = [
    { timeSec: 0, instrument: 'bass', midi: 33 },
    { timeSec: 0.24, instrument: 'bass', midi: 45 },   // +12 → 计 1
    { timeSec: 0.48, instrument: 'bass', midi: 47 },   // +2 → 不计
    { timeSec: 0.72, instrument: 'harp', midi: 85 },   // 换声部 → 不计
    { timeSec: 0.96, instrument: 'harp', midi: 97 },   // +12 → 计 1
    { timeSec: 1.2, instrument: 'bass', midi: 59 },    // 同声部但跨声部断层后重排 → 与 47 比较：+12 → 计 1
  ];
  assert.equal(countIntegerOctavePairs(notes), 3);
});

test('音名格式：octaveEvidence 用音名而不是裸数字（便于人工核对）', () => {
  const input = [{ step: 0, timeSec: 0, instrument: 'bass', midi: 28 }];
  const evidence = evidenceFor([{ step: 0, timeSec: 0, instrument: 'bass', midi: 40 }], input);
  const { notes } = fixOctaves({
    csvText: notesCsv(input),
    evidence,
  });
  assert.equal(notes[0].newMidi, 40);
  assert.equal(notes[0].octaveEvidence.split('@')[0], noteName(40));
});

test('端到端：合成音频 → 证据 → 修复 CSV 可写出文件内容', () => {
  const truth = [
    { step: 0, timeSec: 0.0, instrument: 'harp', midi: 84 },
    { step: 2, timeSec: 0.24, instrument: 'harp', midi: 91 },
  ];
  const input = truth.map((n, i) => ({ ...n, midi: i === 0 ? n.midi - 24 : n.midi }));
  const evidence = evidenceFor(truth, input);
  const { notes } = fixOctaves({ csvText: notesCsv(input), evidence });
  assert.deepEqual(notes.map((n) => n.newMidi), [84, 91]);
  const csv = notesFixedCsv(notes);
  assert.equal(csv.trim().split('\n').length, 3);
  // 合成一段 wav 只用于保证 encodeWav 也在链路上（避免未使用导入）
  assert.ok(encodeWav({ samples: new Float64Array(16), sampleRate: SR }).length === 44 + 32);
});
