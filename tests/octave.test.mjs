// T2 · 八度证据：合成音频上的判定正确率（先失败，后实现）
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_CONFIG,
  analyzeNotes,
  encodeWav,
  midiToFreq,
  octaveCandidates,
  readWav,
} from '../src/analyze/octave-evidence.mjs';

const SR = 44100;
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (midi) => `${NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;

/** 确定性伪随机（LCG），保证测试可复现 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296 * 2 - 1;
  };
}

/**
 * 合成一段单声道音频：
 *  - events: [{ atSec, midi, gain, harmonics: [相对幅度...], durSec }]
 *  - noise: 叠加白噪幅度（相对满幅）
 */
function synth({ seconds, events, noise = 0, seed = 7 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (const e of events) {
    const f0 = midiToFreq(e.midi, 440);
    const start = Math.round(e.atSec * SR);
    const dur = Math.round((e.durSec ?? 0.4) * SR);
    const harm = e.harmonics ?? [1, 0.5, 0.25, 0.12];
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SR;
      // 起音 + 指数衰减包络（像拨弦）
      const env = Math.min(1, i / (0.01 * SR)) * Math.exp(-t / 0.6);
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

function analyzeBuffer(samples, notes, config = {}) {
  return analyzeNotes({
    samples,
    sampleRate: SR,
    notes: notes.map((nt, i) => ({
      noteId: `n${i}`,
      step: nt.step ?? i,
      timeSec: nt.atSec,
      instrument: nt.voice,
      midi: nt.midi,
    })),
    config,
  });
}

test('候选八度：音级固定、8 个候选、从 C0 起', () => {
  const c = octaveCandidates(64); // E4 → E
  assert.equal(c.length, 8);
  assert.deepEqual(c, [16, 28, 40, 52, 64, 76, 88, 100]);
  assert.ok(c.every((m) => ((m % 12) + 12) % 12 === ((64 % 12) + 12) % 12));
  const d = octaveCandidates(61); // C#4
  assert.deepEqual(d, [13, 25, 37, 49, 61, 73, 85, 97]);
});

test('WAV 编解码往返无损（16bit PCM 单声道）', () => {
  // 幅度控制在 0.4，避免编码端的满幅削波（削波不属于编解码往返的问题）
  const n = 4410;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.4 * Math.sin(2 * Math.PI * 220 * i / SR);
  const buf = encodeWav({ samples, sampleRate: SR });
  const back = readWav(buf);
  assert.equal(back.sampleRate, SR);
  assert.equal(back.channels, 1);
  assert.equal(back.bits, 16);
  assert.equal(back.samples.length, samples.length);
  for (let i = 0; i < samples.length; i += 97) {
    assert.ok(Math.abs(back.samples[i] - samples[i]) <= 2 / 32768);
  }
});

test('纯正弦 + 白噪：12 个音级 × 3 个八度，无音域先验时判定 100% 正确', () => {
  const cases = [];
  for (let pc = 0; pc < 12; pc++) for (const oct of [3, 5, 7]) cases.push(pc + 12 * oct);
  let ok = 0;
  const fails = [];
  for (const midi of cases) {
    const samples = synth({
      seconds: 1.2,
      events: [{ atSec: 0, midi, durSec: 0.5, harmonics: [1] }],
      noise: 0.01,
      seed: midi,
    });
    const res = analyzeBuffer(samples, [{ atSec: 0, midi, voice: 'harp' }]);
    const got = res.notes[0].bestOctaveAny;
    if (got === midi) ok++;
    else fails.push(`${noteName(midi)}→${noteName(got)}`);
  }
  assert.equal(ok, cases.length, `误判: ${fails.join(' ')}`);
});

test('音域先验：真正落在声部音域内的音，bestOctave 与它一致', () => {
  const cases = [];
  for (let pc = 0; pc < 12; pc++) for (const oct of [4, 5, 6]) cases.push(pc + 12 * oct);       // 旋律音域
  for (let pc = 0; pc < 12; pc++) for (const oct of [2, 3]) cases.push(pc + 12 * oct + 2);      // 贝斯音域
  const fails = [];
  for (const midi of cases) {
    const voice = midi < 47 ? 'bass' : 'harp';
    const samples = synth({
      seconds: 1.2,
      events: [{ atSec: 0, midi, durSec: 0.5, harmonics: [1] }],
      noise: 0.01,
      seed: midi + 1,
    });
    const res = analyzeBuffer(samples, [{ atSec: 0, midi, voice }]);
    if (res.notes[0].bestOctave !== midi) fails.push(`${voice} ${noteName(midi)}→${noteName(res.notes[0].bestOctave)}`);
  }
  assert.equal(fails.length, 0, `误判: ${fails.join(' ')}`);
});

test('含泛音的合成音（拨弦包络）：判定 100% 正确', () => {
  const cases = [28, 33, 40, 47, 55, 61, 69, 76, 84, 91];
  const fails = [];
  for (const midi of cases) {
    const voice = midi < 50 ? 'bass' : 'harp';
    const samples = synth({
      seconds: 1.2,
      events: [{ atSec: 0, midi, durSec: 0.5, harmonics: [1, 0.6, 0.35, 0.2, 0.1] }],
      noise: 0.005,
      seed: midi * 3,
    });
    const res = analyzeBuffer(samples, [{ atSec: 0, midi, voice }]);
    if (res.notes[0].bestOctave !== midi) fails.push(`${voice} ${noteName(midi)}→${noteName(res.notes[0].bestOctave)}`);
  }
  assert.equal(fails.length, 0, `误判: ${fails.join(' ')}`);
});

test('同时发声的贝斯 + 旋律：两个声部各自判对自己的八度（抗串音）', () => {
  const bassMidi = 40;   // E2 = 82.4 Hz
  const harpMidi = 85;   // C#6 = 1108.7 Hz
  const samples = synth({
    seconds: 1.5,
    events: [
      { atSec: 0, midi: bassMidi, durSec: 0.9, gain: 1.0, harmonics: [1, 0.7, 0.4] },
      { atSec: 0, midi: harpMidi, durSec: 0.9, gain: 0.8, harmonics: [1, 0.4, 0.15] },
    ],
    noise: 0.004,
    seed: 11,
  });
  const res = analyzeBuffer(samples, [
    { atSec: 0, midi: bassMidi, voice: 'bass' },
    { atSec: 0, midi: harpMidi, voice: 'harp' },
  ]);
  assert.equal(res.notes[0].bestOctave, bassMidi, `贝斯判成 ${noteName(res.notes[0].bestOctave)}`);
  assert.equal(res.notes[1].bestOctave, harpMidi, `旋律判成 ${noteName(res.notes[1].bestOctave)}`);
});

test('输入八度写错时，证据仍指向音频的真实八度', () => {
  const truth = 45;                    // A2 = 110 Hz
  const samples = synth({
    seconds: 1.2,
    events: [{ atSec: 0, midi: truth, durSec: 0.5 }],
    noise: 0.004,
    seed: 5,
  });
  // 输入分别写成 +1 / -2 个八度
  for (const wrong of [truth + 12, truth - 24]) {
    const res = analyzeBuffer(samples, [{ atSec: 0, midi: wrong, voice: 'bass' }]);
    assert.equal(res.notes[0].bestOctave, truth, `输入 ${noteName(wrong)} 时判成 ${noteName(res.notes[0].bestOctave)}`);
  }
});

test('音域先验：贝斯候选被限制在音频实测音域内（A0..D#4）', () => {
  const samples = synth({
    seconds: 1.2,
    events: [{ atSec: 0, midi: 40, durSec: 0.5 }],
    noise: 0.004,
    seed: 9,
  });
  const res = analyzeBuffer(samples, [{ atSec: 0, midi: 1, voice: 'bass' }]);
  const n = res.notes[0];
  assert.ok(n.bestOctave >= DEFAULT_CONFIG.voices.bass.minMidi, `bestOctave=${n.bestOctave} 低于贝斯音域下限`);
  assert.ok(n.bestOctave <= DEFAULT_CONFIG.voices.bass.maxMidi, `bestOctave=${n.bestOctave} 高于贝斯音域上限`);
});

test('静音窗：标记为证据不足（rms 低于阈值）', () => {
  const res = analyzeBuffer(new Float64Array(SR), [{ atSec: 0, midi: 60, voice: 'harp' }]);
  const n = res.notes[0];
  assert.equal(n.weak, true);
  assert.ok(n.rms < DEFAULT_CONFIG.minRms);
  assert.deepEqual(n.scores, [0, 0, 0, 0, 0, 0, 0, 0]);
});
