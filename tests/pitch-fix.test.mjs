// M1-1 · 音级恢复（把被吸附到 C# 自然小调的 5 个调外音级找回来）
//
// 要打掉的现象（M0-3 §3.1 实测）：调外 5 个音级（C/D/F/G/A#）在音频里占最大音级的
// 0.16–0.57，v3 谱面只有 0.01–0.06（差 3–11 倍），合计仅占谱面质量 3.4%。
// 修法（任务书）：对每颗音，在**它自己的八度**上量 12 个音级的窄带能量，取最强音级；
// 只有"最强/次强 ≥ 1.6 且与原音级不同"才改；证据不足保持原值并写 degradations。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_PITCH_FIX_CONFIG,
  candidateMidis,
  candidatePeak,
  energyToAmplitude,
  neighborSupport,
  pcDistance,
  pcOf,
  pitchFix,
  pitchFixedCsv,
} from '../src/arrange/pitch-fix.mjs';
import { midiToFreq, narrowbandEnergy, readNotesCsv, readWav } from '../src/analyze/dsp.mjs';
import { voiceOfInstrument } from '../src/arrange/velocity.mjs';

const BUILD = process.env.nbmachina_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const V3FIXED = path.join(BUILD, 'notes_fixed_v3.csv');
const SR = 44100;

/** 调外 5 个音级（C# 自然小调之外的音级，M0-3 §2.2 的被压制清单） */
export const SUPPRESSED_PCS = [0, 2, 5, 7, 10]; // C / D / F / G / A#

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** 合成单声道音频（平坦包络：窗内能量只由 gain 决定） */
function synth({ seconds, events, noise = 0, seed = 7, sampleRate = SR }) {
  const n = Math.round(seconds * sampleRate);
  const out = new Float64Array(n);
  for (const e of events) {
    const f0 = midiToFreq(e.midi, e.a4 ?? 440);
    const start = Math.round((e.atSec ?? 0) * sampleRate);
    const dur = Math.round((e.durSec ?? seconds) * sampleRate);
    const harm = e.harmonics ?? [1];
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / sampleRate;
      let v = 0;
      for (let h = 0; h < harm.length; h++) {
        const f = f0 * (h + 1);
        if (f > sampleRate * 0.45) break;
        v += harm[h] * Math.sin(2 * Math.PI * f * t + h * 0.3);
      }
      out[idx] += v * (e.gain ?? 1);
    }
  }
  if (noise > 0) {
    const rng = makeRng(seed);
    for (let i = 0; i < n; i++) out[i] += rng() * noise;
  }
  return out;
}

const V3_HEADER = 'step,time_seconds,instrument,midi,note_block_pitch,octave_shift';

/** 造一份"列与 notes_fixed_v3.csv 完全一致"的输入谱面 */
function csvOf(rows) {
  return [
    V3_HEADER,
    ...rows.map((r) => `${r.step},${r.time_seconds},${r.instrument},${r.midi},${r.note_block_pitch ?? 0},${r.octave_shift ?? 0}`),
    '',
  ].join('\n');
}

const one = (midi, extra = {}) => csvOf([{
  step: 0, time_seconds: '0.000', instrument: 'harp', midi, note_block_pitch: 0, octave_shift: 0, ...extra,
}]);

test('candidateMidis：12 个音级齐全，且与原音同在一个八度（floor(midi/12) 不变）', () => {
  for (const midi of [21, 40, 60, 61, 72, 84, 102]) {
    const cands = candidateMidis(midi);
    assert.equal(cands.length, 12);
    assert.deepEqual([...new Set(cands.map((m) => pcOf(m)))].sort((a, b) => a - b), [...Array(12).keys()]);
    assert.ok(cands.includes(midi), `候选里必须包含原音高 ${midi}`);
    assert.ok(cands.every((m) => Math.floor(m / 12) === Math.floor(midi / 12)), '候选必须与原音同八度');
    assert.ok(cands.every((m) => Math.abs(m - midi) <= 11), '候选与原音的差 ≤ 11 个半音');
  }
});

test('energyToAmplitude：窄带能量 → 基频振幅（候选峰门槛就是按它定的）', () => {
  const A = 0.25;
  // 440Hz 在 100ms 窗（4410 点）里正好落在 bin 中心，反推应几乎精确
  const samples = synth({ seconds: 0.4, events: [{ midi: 69, gain: A, harmonics: [1] }] });
  const m = narrowbandEnergy({ samples, sampleRate: SR, midi: 69, timeSec: 0.05, windowSec: 0.1 });
  const amp = energyToAmplitude(m.energy, m.windowSamples);
  assert.ok(Math.abs(amp - A) / A < 0.05, `反推振幅应接近 ${A}，实测 ${amp}`);
  // 静音 → 0，不产生 NaN
  assert.equal(energyToAmplitude(0, 4410), 0);
  assert.ok(Number.isFinite(energyToAmplitude(1, 0)));
});

test('合成音：谱面音级被吸附时改回真实音级，八度不变', () => {
  // 音频里只有 C4（midi 60），谱面写的是被吸附后的 C#4（midi 61）
  const samples = synth({ seconds: 0.5, events: [{ midi: 60, gain: 0.8, harmonics: [1, 0.6, 0.3] }], noise: 0.001, seed: 3 });
  const { notes, stats, degradations } = pitchFix({ csvText: one(61), samples, sampleRate: SR });
  assert.equal(notes[0].newMidi, 60);
  assert.equal(notes[0].reason, 'evidence');
  assert.equal(notes[0].bestPc, 0);
  assert.ok(notes[0].margin >= DEFAULT_PITCH_FIX_CONFIG.margin, `边距应 ≥ ${DEFAULT_PITCH_FIX_CONFIG.margin}，实测 ${notes[0].margin}`);
  assert.equal(stats.changed, 1);
  assert.equal(stats.kept, 0);
  assert.equal(degradations.length, 0);
  assert.equal(notes[0].voice, 'melody');
});

test('证据不足（静音窗）：保持原值并记 degradations（弱证据不能静默改音）', () => {
  const { notes, degradations, stats } = pitchFix({
    csvText: one(61), samples: new Float64Array(SR), sampleRate: SR,
  });
  assert.equal(notes[0].newMidi, 61);
  assert.equal(notes[0].reason, 'weak-evidence');
  assert.equal(stats.changed, 0);
  assert.equal(degradations.length, 1);
  assert.equal(degradations[0].reason, 'weak-evidence');
  assert.ok(notes[0].rms < DEFAULT_PITCH_FIX_CONFIG.minRms);
});

test('最强/次强 < 1.6：不动它，记 below-margin（并留下能量值）', () => {
  // C4 与 C#4 同时响、幅度接近 → 最强音级虽然是 C（≠ 原音级 C#），但边距不足 1.6
  const samples = synth({
    seconds: 0.5,
    events: [{ midi: 60, gain: 1.0, harmonics: [1] }, { midi: 61, gain: 0.9, harmonics: [1] }],
    noise: 0.0005, seed: 4,
  });
  const { notes, degradations } = pitchFix({ csvText: one(61), samples, sampleRate: SR });
  assert.equal(notes[0].newMidi, 61, '边距不足时必须保持原值');
  assert.equal(notes[0].reason, 'below-margin');
  assert.ok(notes[0].margin < DEFAULT_PITCH_FIX_CONFIG.margin, `实测边距 ${notes[0].margin} 应 < 1.6`);
  assert.ok(notes[0].bestEnergy > 0 && Number.isFinite(notes[0].secondEnergy));
  assert.equal(degradations[0].reason, 'below-margin');
  assert.ok(Number.isFinite(degradations[0].margin));
});

test('八度不变：能量在别的八度（哪怕很强）也不能把音级判定带走', () => {
  // 音频只有 C5（midi 72），谱面写的是 C#4（midi 61）——候选八度里没有真实峰
  const samples = synth({ seconds: 0.6, events: [{ midi: 72, gain: 0.9, harmonics: [1] }], noise: 0.001, seed: 6 });
  const { notes } = pitchFix({ csvText: one(61), samples, sampleRate: SR });
  assert.equal(notes[0].newMidi, 61);
  assert.equal(notes[0].reason, 'no-peak');
  assert.equal(Math.floor(notes[0].newMidi / 12), Math.floor(notes[0].midi / 12));
});

test('CSV 契约：原 6 列逐字符保留，只改 midi 并追加 reason', () => {
  const csv = csvOf([
    { step: 0, time_seconds: '0.000', instrument: 'harp', midi: 61, note_block_pitch: 13, octave_shift: 0 },
    { step: 1, time_seconds: '0.120', instrument: 'bass', midi: 40, note_block_pitch: 16, octave_shift: 3 },
  ]);
  // 音频：第一颗真音 C4（harp），第二颗真音 E2（bass，midi 40 已是真音级）
  const samples = synth({
    seconds: 0.6,
    events: [
      { midi: 60, gain: 0.8, harmonics: [1, 0.5] },
      { midi: 40, gain: 0.7, atSec: 0.12, harmonics: [1, 0.5] },
    ],
    noise: 0.0005, seed: 9,
  });
  const { notes, header } = pitchFix({ csvText: csv, samples, sampleRate: SR });
  const out = pitchFixedCsv(notes);
  const lines = out.trim().split('\n');

  assert.deepEqual(header, ['step', 'time_seconds', 'instrument', 'midi', 'note_block_pitch', 'octave_shift']);
  assert.equal(lines[0], `${V3_HEADER},reason`);
  assert.equal(lines.length, 3);
  // 第 1 列..第 6 列：除 midi 外逐字符不变
  for (const [i, line] of lines.slice(1).entries()) {
    const src = csv.trim().split('\n')[i + 1].split(',');
    const got = line.split(',');
    assert.equal(got.length, 7, `应只有 7 列（原 6 列 + reason）：${line}`);
    assert.equal(got[0], src[0]);
    assert.equal(got[1], src[1]);
    assert.equal(got[2], src[2]);
    assert.equal(got[4], src[4], 'note_block_pitch 原样保留（折叠在流水线里重算）');
    assert.equal(got[5], src[5], 'octave_shift 原样保留');
    assert.equal(Number(got[3]), notes[i].newMidi);
    assert.equal(got[6], notes[i].reason);
  }
  // 八度不变式（对全部输出）
  assert.ok(notes.every((n) => Math.abs(n.newMidi - n.midi) <= 11));
  assert.ok(notes.every((n) => Math.floor(n.newMidi / 12) === Math.floor(n.midi / 12)));
  // 第二颗是贝斯声部：一个半音 < 1 个 bin，音级不可判 → 一律原值 + register-ambiguous
  assert.equal(notes[1].newMidi, 40);
  assert.equal(notes[1].reason, 'register-ambiguous');
});

test('邻居支持：音频里是 C4 时，谱面写 C4 → 自身赢；谱面写 C#4 → 下邻赢（1 个半音的吸附）', () => {
  const samples = synth({ seconds: 0.5, events: [{ midi: 60, gain: 0.8, harmonics: [1, 0.5] }], noise: 0.0005, seed: 11 });
  const correct = neighborSupport({ csvText: one(60), samples, sampleRate: SR }).summary.melody;
  assert.equal(correct.n, 1);
  assert.equal(correct.own, 1, '谱面正确时自身音级应该赢');
  assert.equal(correct.ownRate, 1);
  const snapped = neighborSupport({ csvText: one(61), samples, sampleRate: SR }).summary.melody;
  assert.equal(snapped.own, 0, '被吸附 1 个半音时自身不该赢');
  assert.equal(snapped.down, 1, '应该是下邻半音（C）赢');
  assert.equal(snapped.up, 0);
});

test('真实数据：音频证据不支持大规模音级改写（只 ±1 解吸附，且贝斯不判）', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(V3FIXED)) return t.skip(`缺少 ${WAV} 或 ${V3FIXED}`);
  const { samples, sampleRate } = readWav(WAV);
  const csvText = fs.readFileSync(V3FIXED, 'utf8');
  const before = readNotesCsv(csvText).notes;
  const { notes, stats, degradations } = pitchFix({ csvText, samples, sampleRate });

  const share = (list) => list.filter((n) => SUPPRESSED_PCS.includes(pcOf(n.midi))).length / list.length;
  const sBefore = share(before);
  const sAfter = share(notes.map((n) => ({ midi: n.newMidi })));
  console.log(
    `    v3 ${notes.length} 颗音：改了 ${stats.changed}（${Object.entries(stats.byVoice)
      .map(([v, b]) => `${v} ${b.changed}/${b.n}`).join('，')}）｜`
    + `降级 ${degradations.length} ${JSON.stringify(stats.degradationsByReason)}｜`
    + `12 音级全局最强 = 谱面 ${stats.gates.pcAllAgrees}/${stats.notes}｜`
    + `调外音级质量 ${(100 * sBefore).toFixed(1)}% → ${(100 * sAfter).toFixed(1)}%`,
  );

  assert.ok(stats.changed > 0, '应当至少有音被改回来');
  assert.ok(stats.changed / notes.length < 0.05, `改动必须少而准：实测 ${stats.changed}/${notes.length}`);
  assert.ok(notes.every((n) => Math.abs(n.newMidi - n.midi) <= 11), '只许改音级，不许改八度');
  assert.ok(notes.every((n) => Math.floor(n.newMidi / 12) === Math.floor(n.midi / 12)), '八度必须完全不动');
  assert.ok(notes.every((n) => (n.reason === 'evidence') === (n.newMidi !== n.midi)), '只有 evidence 才允许改 midi');
  assert.ok(notes.every((n) => n.reason !== 'evidence' || pcOf(n.newMidi) !== pcOf(n.midi)), 'evidence 必须真的换了音级');
  assert.ok(notes.every((n) => n.reason !== 'evidence' || pcDistance(n.newMidi, n.midi) === 1), '只允许 ±1 的"解吸附"');
  assert.ok(notes.filter((n) => n.reason === 'evidence').every((n) => n.margin >= DEFAULT_PITCH_FIX_CONFIG.margin));
  assert.ok(notes.filter((n) => n.voice === 'bass').every((n) => n.newMidi === n.midi), '贝斯音级不可判，一律原值');
  assert.equal(stats.degradationsByReason['register-ambiguous'], notes.filter((n) => n.voice === 'bass').length);
  // 任务书的"调外质量 ≥8%"这条不成立：见 docs/M1-1-report.md §3（混音级 chroma 是泛音折叠 + 别的乐器）
  assert.ok(sAfter >= sBefore - 0.005, '改动不该把调外质量改坏');
});

test('真实数据 · 邻居支持：旋律自身音级 98%+ 赢（谱面没被吸附）；贝斯邻居/自身 ≈1（不可判）', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(V3FIXED)) return t.skip(`缺少 ${WAV} 或 ${V3FIXED}`);
  const { samples, sampleRate } = readWav(WAV);
  const { summary } = neighborSupport({ csvText: fs.readFileSync(V3FIXED, 'utf8'), samples, sampleRate });
  for (const [v, s] of Object.entries(summary)) {
    console.log(
      `    ${v}: n=${s.n}｜自身赢 ${s.own}（${(100 * s.ownRate).toFixed(1)}%）、上邻 ${s.up}、下邻 ${s.down}`
      + `｜中位能量比 上邻/自身 ${s.medianUpOverOwn}、下邻/自身 ${s.medianDownOverOwn}`,
    );
  }
  assert.ok(summary.melody.ownRate >= 0.9, `旋律自身音级应压倒性胜出，实测 ${summary.melody.ownRate}`);
  assert.ok(summary.bass.medianUpOverOwn > 0.5 && summary.bass.medianDownOverOwn > 0.5,
    '贝斯上/下邻半音与自身同量级 → 这个窗长下音级不可判');
});

test('真实数据 · 贝斯音级：120ms 不可判，稀疏段 + 300ms 窗可判且支持谱面', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(V3FIXED)) return t.skip(`缺少 ${WAV} 或 ${V3FIXED}`);
  const { samples, sampleRate } = readWav(WAV);
  const bass = readNotesCsv(fs.readFileSync(V3FIXED, 'utf8')).notes.filter((n) => voiceOfInstrument(n.instrument) === 'bass');
  const peak = (midi, timeSec, windowSec) => candidatePeak({
    samples, sampleRate, midi, timeSec, a4: 440, windowSec, harmonicWeights: [1], probeFrac: 0.25,
  });
  const rms = bass.map((n) => peak(n.midi, n.timeSec, 0.12).rms);
  const cut = [...rms].sort((a, b) => a - b)[Math.floor(0.1 * rms.length)];
  const rateAt = (windowSec) => {
    let own = 0;
    let n = 0;
    const ratios = [];
    bass.forEach((nt, i) => {
      if (rms[i] > cut) return;
      const e0 = peak(nt.midi, nt.timeSec, windowSec).energy;
      const eU = peak(nt.midi + 1, nt.timeSec, windowSec).energy;
      const eD = peak(nt.midi - 1, nt.timeSec, windowSec).energy;
      n++;
      if (e0 >= eU && e0 >= eD) own++;
      if (e0 > 0) ratios.push(Math.max(eU, eD) / e0);
    });
    ratios.sort((a, b) => a - b);
    return { n, own, rate: own / n, medianNeighbor: ratios[ratios.length >> 1] };
  };
  const short = rateAt(0.12);
  const long = rateAt(0.3);
  console.log(
    `    贝斯最稀疏 10%（n=${short.n}，阈值 RMS ${cut.toFixed(3)}）：`
    + `120ms 自身赢 ${(100 * short.rate).toFixed(1)}%（邻居/自身 ${short.medianNeighbor.toFixed(3)}）→ `
    + `300ms 自身赢 ${(100 * long.rate).toFixed(1)}%（邻居/自身 ${long.medianNeighbor.toFixed(3)}）`,
  );
  assert.ok(short.rate < 0.7, '120ms 窗下贝斯音级应不可判（自身赢接近掷硬币）');
  assert.ok(long.rate >= 0.75, `300ms 窗 + 稀疏段应可判且支持谱面，实测 ${long.rate}`);
});
