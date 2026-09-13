// T5b · 力度换口径：该音级在该八度上的短时窄带能量 → 0..1
//
// 现状（要被打掉的）：v3 的 "volume" 是每颗音起音后 0.12s **整段混音 RMS**，
// 所以同一 step 上所有音的 volume 完全相同（M0-1 报告 §4.1 实测：distinct volume > 1 的 step 数 = 0）。
// 新口径：在"这颗音自己的音级 + 八度"上量窄带能量（f0 + 2f0 + 3f0 的加窗 DFT 功率）。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_VELOCITY_CONFIG,
  VOICE_OF_INSTRUMENT,
  measureVelocity,
  mapEnergiesToVelocity,
  readNotesCsv,
  velocityCsv,
  velocityCsvText,
  voiceOfInstrument,
} from '../src/arrange/velocity.mjs';
import { encodeWav, midiToFreq, readWav } from '../src/analyze/chroma.mjs';

const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const V3 = path.join(BUILD, 'styx_helix_notes_v3.csv');
const SR = 44100;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** 合成单声道音频（平坦包络：窗内能量只由 gain 决定） */
function synth({ seconds, events, noise = 0, seed = 7 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (const e of events) {
    const f0 = midiToFreq(e.midi, 440);
    const start = Math.round((e.atSec ?? 0) * SR);
    const dur = Math.round((e.durSec ?? 0.3) * SR);
    const harm = e.harmonics ?? [1, 0.5, 0.25];
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SR;
      const env = e.sustain === false ? Math.min(1, i / (0.01 * SR)) * Math.exp(-t / 0.6) : 1;
      let v = 0;
      for (let h = 0; h < harm.length; h++) {
        const f = f0 * (h + 1);
        if (f > SR * 0.45) break;
        v += harm[h] * Math.sin(2 * Math.PI * f * t + h * 0.3);
      }
      out[idx] += v * env * (e.gain ?? 1);
    }
  }
  if (noise > 0) {
    const rng = makeRng(seed);
    for (let i = 0; i < n; i++) out[i] += rng() * noise;
  }
  return out;
}

const note = (o) => ({ noteId: o.noteId ?? 0, step: o.step ?? 0, timeSec: o.timeSec ?? 0, instrument: 'harp', ...o });

test('力度映射：单调不减、端点 = 地板/天花板、超过 p90 截到天花板、零能量 = 0', () => {
  const energies = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 1000];
  const vs = mapEnergiesToVelocity(energies, { percentileLow: 0.1, percentileHigh: 0.9, floor: 0.35, ceiling: 1 });
  assert.equal(vs[0], 0, '零能量（没有证据）应为 0，而不是地板');
  for (let i = 1; i < vs.length; i++) assert.ok(vs[i] >= vs[i - 1], `第 ${i} 项破坏单调性：${vs[i - 1]} → ${vs[i]}`);
  const positive = vs.slice(1);
  assert.ok(Math.abs(Math.min(...positive) - 0.35) < 1e-9, `最小值应为地板 0.35，实测 ${Math.min(...positive)}`);
  assert.ok(Math.abs(Math.max(...positive) - 1) < 1e-9, `最大值应为天花板 1.0，实测 ${Math.max(...positive)}`);
  assert.ok(vs.every((v) => v >= 0 && v <= 1));
  // p90 以上全部截到天花板（最后两个都顶到 1.0）
  assert.equal(vs[vs.length - 1], vs[vs.length - 2]);
});

test('映射：能量完全无差别（分位数跨度为 0）时退化到地板，不产生 NaN、也不凭空给天花板', () => {
  const vs = mapEnergiesToVelocity([5, 5, 5], {});
  assert.deepEqual([...vs], [0.35, 0.35, 0.35]);
});

test('合成音：同一颗音的力度随振幅严格单调（淡入淡出可判）', () => {
  const gains = [0.1, 0.25, 0.5, 1.0];
  const samples = [];
  const notes = [];
  gains.forEach((gain, i) => {
    const atSec = i * 0.5;
    samples.push(synth({ seconds: 0.5, events: [{ midi: 69, gain, atSec: 0 }] }));
    notes.push(note({ noteId: i, step: i, timeSec: atSec, midi: 69 }));
  });
  // 拼成一段（每颗音在自己的 0.5s 段里）
  const total = samples.reduce((a, s) => a + s.length, 0);
  const buf = new Float64Array(total);
  let off = 0;
  for (const s of samples) {
    buf.set(s, off);
    off += s.length;
  }
  const { results } = measureVelocity({ samples: buf, sampleRate: SR, notes });
  const vs = results.map((r) => r.velocity);
  assert.equal(vs.length, gains.length);
  for (let i = 1; i < vs.length; i++) {
    assert.ok(vs[i] > vs[i - 1], `力度未随振幅单调上升：gain ${gains[i - 1]}→${vs[i - 1]}, gain ${gains[i]}→${vs[i]}`);
  }
  assert.ok(vs[0] >= 0.35 && vs[vs.length - 1] <= 1);
  assert.ok(results.every((r) => r.reason === 'measured'));
});

test('八度隔离：只有 C5 在响时，C5 那颗音拿到高力度，C4 那颗（同音级低八度）掉到地板', () => {
  const samples = synth({ seconds: 0.6, events: [{ midi: 72, gain: 0.8 }], noise: 0.002, seed: 5 });
  const notes = [note({ noteId: 0, midi: 72, step: 0 }), note({ noteId: 1, midi: 60, step: 0, timeSec: 0 })];
  const { results } = measureVelocity({ samples, sampleRate: SR, notes });
  const [hi, lo] = results;
  assert.ok(hi.velocity > lo.velocity + 0.3, `C5=${hi.velocity} 应远高于 C4=${lo.velocity}`);
  assert.ok(Math.abs(lo.velocity - 0.35) < 1e-9, `C4 应落到地板，实测 ${lo.velocity}`);
  assert.ok(hi.energy > lo.energy * 20, `能量应差 20 倍以上：${hi.energy} vs ${lo.energy}`);
});

test('静音窗：力度 = 0 且 reason=weak（不当成"很轻地弹了一下"）', () => {
  const { results } = measureVelocity({ samples: new Float64Array(SR), sampleRate: SR, notes: [note({ midi: 60 })] });
  assert.equal(results[0].velocity, 0);
  assert.equal(results[0].reason, 'weak');
  assert.ok(results[0].rms < DEFAULT_VELOCITY_CONFIG.minRms);
});

test('默认只用基频（避免相邻八度的同音级互相污染）；梳状口径可配置且能量更高', () => {
  assert.equal(voiceOfInstrument('harp'), 'melody');
  assert.equal(voiceOfInstrument('bass'), 'bass');
  assert.equal(voiceOfInstrument('basedrum'), 'perc');
  assert.equal(VOICE_OF_INSTRUMENT.harp, 'melody');
  assert.deepEqual(DEFAULT_VELOCITY_CONFIG.voices.melody.harmonicWeights, [1]);
  assert.deepEqual(DEFAULT_VELOCITY_CONFIG.voices.bass.harmonicWeights, [1]);
  // 低音区一个半音 < 1 个 bin，窗必须比旋律长（实测 100ms→r 0.57、120ms→0.85）
  assert.ok(DEFAULT_VELOCITY_CONFIG.voices.bass.windowSec > DEFAULT_VELOCITY_CONFIG.voices.melody.windowSec);
  const samples = synth({ seconds: 0.5, events: [{ midi: 45, gain: 0.8, harmonics: [1, 0.7, 0.5, 0.3] }] });
  const notes = [note({ noteId: 0, midi: 45, instrument: 'bass' }), note({ noteId: 1, midi: 45, instrument: 'harp' })];
  const fundamental = measureVelocity({ samples, sampleRate: SR, notes }).results;
  const comb = measureVelocity({
    samples,
    sampleRate: SR,
    notes,
    config: { voices: { melody: { harmonicWeights: [1, 0.5, 0.25] } } },
  }).results;
  assert.ok(fundamental.every((r) => r.energy > 0));
  assert.ok(comb[1].energy > fundamental[1].energy * 1.2, '梳状口径应把 2/3 次谐波算进来');
  assert.equal(fundamental[0].voice, 'bass');
  assert.equal(fundamental[1].voice, 'melody');
});

test('CSV：前 7 列逐字符不变（可直接给 layout），只追加 velocity/velocityRaw/velocityReason', () => {
  const csv = [
    'step,tick,time_seconds,instrument,midi,row,volume',
    '0,0,0.000,bass,33,9,0.900',
    '2,24,0.240,harp,80,20,0.500',
    '',
  ].join('\n');
  const { header, notes } = readNotesCsv(csv);
  const { results } = measureVelocity({ samples: new Float64Array(SR), sampleRate: SR, notes });
  const out = velocityCsv({ header, notes, results });
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'step,tick,time_seconds,instrument,midi,row,volume,velocity,velocityRaw,velocityReason');
  assert.ok(lines[1].startsWith('0,0,0.000,bass,33,9,0.900,'), lines[1]);
  assert.ok(lines[2].startsWith('2,24,0.240,harp,80,20,0.500,'), lines[2]);
  assert.equal(lines[1].split(',').length, 10);
  assert.equal(lines[1].split(',').length - 7, 3);
  // 静音输入 → velocity 0 / reason weak
  assert.ok(lines[1].endsWith(',0.000,0.000000,weak'), lines[1]);
});

test('--midi-column newMidi：用修复后的八度量力度，数值与用错八度明显不同', () => {
  // 纯基频：这样"错一个八度"的差别只来自窄带隔离，而不是真音的 2 次谐波
  // （含谐波时，写在"高一个八度"的音会捡到真音的 2 次谐波，这是本口径的已知宽容面，报告里有说明）
  const samples = synth({ seconds: 0.5, events: [{ midi: 52, gain: 0.9, harmonics: [1] }], noise: 0.002, seed: 8 });
  const csv = [
    'step,time_seconds,instrument,midi,newMidi',
    '0,0.000,bass,64,52',
    '0,0.000,bass,64,52',
    '',
  ].join('\n');
  const { notes } = readNotesCsv(csv);
  const wrong = measureVelocity({ samples, sampleRate: SR, notes, config: { midiColumn: 'midi' } }).results;
  const right = measureVelocity({ samples, sampleRate: SR, notes, config: { midiColumn: 'newMidi' } }).results;
  assert.ok(right[0].energy > wrong[0].energy * 20, `newMidi 能量应远高于错八度：${right[0].energy} vs ${wrong[0].energy}`);
  assert.equal(right[0].midiUsed, 52);
  assert.equal(wrong[0].midiUsed, 64);
  assert.ok(right[0].rms > 0, '窗内确实有声音（说明能量差不是"静音"造成的）');
});

test('velocityCsvText：端到端文本入口（CSV 文本 + 音频 buffer → CSV 文本）', () => {
  const samples = synth({ seconds: 0.5, events: [{ midi: 69, gain: 0.7 }] });
  const wavBuf = encodeWav({ samples, sampleRate: SR });
  const { samples: back, sampleRate } = readWav(wavBuf);
  const csv = 'step,tick,time_seconds,instrument,midi,row,volume\n0,0,0.000,harp,69,12,0.500\n';
  const { csv: out, meta } = velocityCsvText({ csvText: csv, samples: back, sampleRate });
  const cols = out.trim().split('\n')[1].split(',');
  assert.equal(cols.length, 10);
  assert.ok(Number(cols[7]) >= 0.35 && Number(cols[7]) <= 1, `力度应在 0.35..1，实测 ${cols[7]}`);
  assert.ok(Number(cols[8]) > 0, `窄带能量应为正，实测 ${cols[8]}`);
  assert.equal(meta.notes, 1);
  assert.equal(meta.reasons.measured, 1);
});

test('真实数据：换口径后"同一步内力度全相同"的现象消失（新力度真的跟音高/能量走）', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(V3)) return t.skip(`缺少 ${WAV} 或 ${V3}`);
  const { samples, sampleRate } = readWav(WAV);
  const { header, notes } = readNotesCsv(fs.readFileSync(V3, 'utf8'));
  const { results, meta } = measureVelocity({ samples, sampleRate, notes });

  // ① 旧口径（volume）：同一步内所有音的 volume 完全相同
  const volByStep = new Map();
  for (const n of notes) {
    if (!volByStep.has(n.step)) volByStep.set(n.step, new Set());
    volByStep.get(n.step).add(n.volume);
  }
  const oldDistinct = [...volByStep.values()].filter((s) => s.size > 1).length;
  assert.equal(oldDistinct, 0, '旧口径同一步的 volume 应完全相同（M0-1 §4.1）');

  // ② 新口径：同一步上不同音高会有不同力度
  const velByStep = new Map();
  notes.forEach((n, i) => {
    if (!velByStep.has(n.step)) velByStep.set(n.step, []);
    velByStep.get(n.step).push(results[i].velocity);
  });
  const newDistinct = [...velByStep.values()].filter((vs) => vs.length > 1 && Math.max(...vs) - Math.min(...vs) > 0.01).length;
  assert.ok(newDistinct > 100, `新口径应有大量"同一步但力度不同"的 step，实测 ${newDistinct}`);

  // ③ 新力度与旧 volume 之间不再是一一对应（口径确实换了）
  const vels = results.map((r) => r.velocity);
  const vols = notes.map((n) => n.volume);
  const r = pearson(vels, vols);
  assert.ok(r < 0.99, `新力度与旧混音 volume 的相关应明显小于 1，实测 r=${r.toFixed(3)}`);
  assert.ok(meta.reasons.measured > 2900, `大多数音应有证据，实测 ${meta.reasons.measured}/${notes.length}`);
  console.log(
    `    v3 ${notes.length} 颗音：同一步力度不同的 step ${newDistinct}（旧口径 ${oldDistinct}）｜`
    + `与旧 volume 的 r=${r.toFixed(3)}｜地板 ${meta.summary.atFloor}、天花板 ${meta.summary.atCeiling}、`
    + `无证据 ${meta.reasons.weak ?? 0}`,
  );
});

/** Pearson 相关（测试内的独立实现，避免与生产代码共用同一段逻辑） */
function pearson(xs, ys) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx;
    const dy = ys[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxx <= 0 || syy <= 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}
