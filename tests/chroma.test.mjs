// T5a · chroma（12 音级能量分布）测试：合成信号上峰位必须落在正确的音级
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_CHROMA_CONFIG,
  chromaBestShift,
  chromaCos,
  chromaFrameAt,
  chromagram,
  encodeWav,
  midiToFreq,
  normalizeChroma,
  notesChroma,
  readNotesCsv,
  readWav,
} from '../src/analyze/chroma.mjs';

const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const V3 = path.join(BUILD, 'styx_helix_notes_v3.csv');
const SR = 44100;

/** 确定性伪随机（LCG），保证测试可复现 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** 合成单声道音频：每颗音按 gain 与谐波表叠加（sustain=true 时包络平坦） */
function synth({ seconds, events, noise = 0, seed = 7 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (const e of events) {
    const f0 = midiToFreq(e.midi, 440);
    const start = Math.round((e.atSec ?? 0) * SR);
    const dur = Math.round((e.durSec ?? 0.4) * SR);
    const harm = e.harmonics ?? [1, 0.5, 0.25, 0.12];
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SR;
      const env = e.sustain ? 1 : Math.min(1, i / (0.01 * SR)) * Math.exp(-t / 0.6);
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

/** 向量里能量最大的前 k 个音级（按能量降序） */
const topPcs = (v, k) => [...v.keys()].sort((a, b) => v[b] - v[a] || a - b).slice(0, k);

/** 能量最大的前 k 个音级（升序集合，用于"峰位是这几个音级"这类断言） */
const topPcsSet = (v, k) => topPcs(v, k).sort((a, b) => a - b);

const PC_NAME = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const pcName = (pc) => PC_NAME[((pc % 12) + 12) % 12];

test('WAV 编解码往返无损（16bit PCM 单声道）', () => {
  const n = 4410;
  const samples = new Float64Array(n);
  for (let i = 0; i < n; i++) samples[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / SR);
  const back = readWav(encodeWav({ samples, sampleRate: SR }));
  assert.equal(back.sampleRate, SR);
  assert.equal(back.channels, 1);
  assert.equal(back.bits, 16);
  assert.equal(back.samples.length, samples.length);
  for (let i = 0; i < samples.length; i += 97) {
    assert.ok(Math.abs(back.samples[i] - samples[i]) <= 2 / 32768);
  }
});

test('归一化：l1 和为 1、l2 模为 1、max 最大值为 1；全零向量原样返回', () => {
  const v = Float64Array.from([1, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const l1 = normalizeChroma(v, { norm: 'l1' });
  assert.ok(Math.abs([...l1].reduce((a, b) => a + b, 0) - 1) < 1e-12);
  const l2 = normalizeChroma(v, { norm: 'l2' });
  assert.ok(Math.abs(Math.hypot(...l2) - 1) < 1e-12);
  const mx = normalizeChroma(v, { norm: 'max' });
  assert.equal(Math.max(...mx), 1);
  assert.deepEqual([...normalizeChroma(new Float64Array(12), { norm: 'l1' })], new Array(12).fill(0));
});

test('纯正弦单音：峰位就是那颗音的音级（跨八度都对）', () => {
  const cases = [40, 47, 55, 60, 64, 69, 76, 84, 91]; // E2..G6
  const fails = [];
  for (const midi of cases) {
    const samples = synth({
      seconds: 0.5,
      events: [{ midi, harmonics: [1], sustain: true }],
      noise: 0.01,
      seed: midi,
    });
    const chroma = chromaFrameAt({ samples, sampleRate: SR, startSample: Math.round(0.1 * SR) });
    const top = topPcs(chroma, 1)[0];
    if (top !== ((midi % 12) + 12) % 12) fails.push(`${pcName(midi)}→${pcName(top)}`);
  }
  assert.deepEqual(fails, [], `误判: ${fails.join(' ')}`);
});

test('合成和弦：C 大三和弦（C4+E4+G4）前三峰 = C/E/G', () => {
  const samples = synth({
    seconds: 1,
    events: [60, 64, 67].map((midi) => ({ midi, gain: 0.6, sustain: true })),
    noise: 0.005,
    seed: 3,
  });
  const chroma = chromaFrameAt({ samples, sampleRate: SR, startSample: Math.round(0.2 * SR) });
  assert.deepEqual(topPcsSet(chroma, 3), [0, 4, 7]);
  const e = [0, 4, 7].map((pc) => chroma[pc]);
  assert.ok(Math.min(...e) / Math.max(...e) > 0.75, `三音能量 ${e.map((x) => x.toExponential(2)).join(' ')}`);
});

test('合成和弦：C# 小三和弦（C#4+E4+G#4）前三峰 = C#/E/G#', () => {
  const samples = synth({
    seconds: 1,
    events: [61, 64, 68].map((midi) => ({ midi, gain: 0.6, sustain: true })),
    noise: 0.005,
    seed: 4,
  });
  const chroma = chromaFrameAt({ samples, sampleRate: SR, startSample: Math.round(0.2 * SR) });
  assert.deepEqual(topPcsSet(chroma, 3), [1, 4, 8]);
});

test('复音 + 白噪（SNR 不友好）：峰位仍然正确', () => {
  const pcs = [2, 5, 7]; // D / F / G
  const samples = synth({
    seconds: 1,
    events: pcs.map((pc) => ({ midi: pc + 60, gain: 0.5, sustain: true })),
    noise: 0.05,
    seed: 11,
  });
  const chroma = chromaFrameAt({ samples, sampleRate: SR, startSample: Math.round(0.2 * SR) });
  assert.deepEqual(topPcsSet(chroma, 3), [...pcs].sort((a, b) => a - b));
});

test('含 4 次谐波的拨弦音：基频音级仍是最大峰（泛音不夺主）', () => {
  for (const midi of [45, 57, 69]) {
    const samples = synth({
      seconds: 0.6,
      events: [{ midi, harmonics: [1, 0.6, 0.4, 0.25], durSec: 0.5 }],
      noise: 0.005,
      seed: midi,
    });
    const chroma = chromaFrameAt({ samples, sampleRate: SR, startSample: Math.round(0.05 * SR) });
    assert.equal(topPcs(chroma, 1)[0], ((midi % 12) + 12) % 12, `${pcName(midi)} 峰位错`);
  }
});

test('chromagram：逐帧 chroma 已归一化，meanRaw 累积原能量，帧数与窗参数一致', () => {
  const seconds = 1;
  const samples = synth({ seconds, events: [{ midi: 69, sustain: true }] });
  const cfg = { frameSize: 2048, hop: 1024 };
  const g = chromagram({ samples, sampleRate: SR, config: cfg });
  const expectedFrames = Math.floor((samples.length - cfg.frameSize) / cfg.hop) + 1;
  assert.equal(g.frames.length, expectedFrames);
  assert.equal(g.meta.frameSize, cfg.frameSize);
  assert.ok(Math.abs(g.meta.frameSec - cfg.frameSize / SR) < 1e-12);
  for (const f of g.frames.slice(0, 5)) {
    assert.ok(Math.abs([...f.chroma].reduce((a, b) => a + b, 0) - 1) < 1e-9);
  }
  assert.equal(topPcs(normalizeChroma(g.meanRaw, { norm: 'l1' }), 1)[0], 9); // A
  assert.ok(g.meanRaw[9] > g.meanRaw[0] * 5, 'A 的能量应远高于 C');
});

test('chromaCos：自比 =1、正交 =0、全零 =0；chromaBestShift 能找到 12 音级循环移调', () => {
  const a = Float64Array.from([1, 2, 3, 0, 0, 0, 1, 0, 0, 4, 0, 1]);
  assert.ok(Math.abs(chromaCos(a, a) - 1) < 1e-12);
  const c = Float64Array.from([1, 0, 0, 0, 0, 0, 0, 0, 0, 50, 0, 0]);
  const shifted = Float64Array.from(c, (_, i) => c[(i + 5) % 12]);
  const best = chromaBestShift(c, shifted);
  assert.equal(best.shift, 5, `应找到 5 半音：实测 ${best.shift}`);
  assert.ok(best.cos > 0.999, `移调对齐后相似度应≈1（实测 ${best.cos}）`);
  assert.ok(chromaCos(a, shifted) < 0.5);
  assert.equal(chromaCos(new Float64Array(12), a), 0);
});

test('notesChroma：按 count 权重就是音级直方图，按 velocity 权重可用', () => {
  const notes = [
    { midi: 60, velocity: 100 },
    { midi: 72, velocity: 50 },
    { midi: 64, velocity: 100 },
  ];
  const byCount = notesChroma(notes, { weighting: 'count' });
  assert.equal(byCount[0], 2); // C4 + C5
  assert.equal(byCount[4], 1);
  assert.equal([...byCount].reduce((a, b) => a + b, 0), 3);
  const byVel = notesChroma(notes, { weighting: 'velocity' });
  assert.equal(byVel[0], 150);
  assert.equal(byVel[4], 100);
});

test('真实数据：v3 谱面把调外 5 个音级压到音频占比的 1/2.5 以下（音级吸附的直接证据）', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(V3)) return t.skip(`缺少 ${WAV} 或 ${V3}`);
  const { samples, sampleRate } = readWav(WAV);
  const audio = normalizeChroma(chromagram({ samples, sampleRate }).meanRaw, { norm: 'l1' });
  const chartRaw = notesChroma(readNotesCsv(fs.readFileSync(V3, 'utf8')).notes);
  const chart = normalizeChroma(chartRaw, { norm: 'l1' });
  const audioMax = Math.max(...audio);
  const audioRatios = [...audio].map((v) => v / audioMax);
  const chartMax = Math.max(...chart);
  const chartRatios = [...chart].map((v) => v / chartMax);
  assert.equal(audio.length, 12);
  assert.ok(
    Math.min(...audioRatios) > 0.02,
    `音频里 12 个音级都该有能量，实测最小占比 ${Math.min(...audioRatios).toFixed(3)}`,
  );
  // C# 自然小调之外的 5 个音级（C D F G A#）：谱面占比远低于音频占比
  const OUT_OF_SCALE = [0, 2, 5, 7, 10];
  const chartMass = OUT_OF_SCALE.reduce((a, pc) => a + chart[pc], 0);
  assert.ok(chartMass < 0.05, `v3 谱面在调外 5 个音级上只占 ${(100 * chartMass).toFixed(1)}%`);
  // 实测倍数 3.0x（G）~ 11x（A#）之间，取 2.5 倍作断言下限
  assert.ok(
    OUT_OF_SCALE.every((pc) => audioRatios[pc] > 2.5 * chartRatios[pc]),
    '调外音级的音频占比应至少是谱面占比的 2.5 倍：'
      + OUT_OF_SCALE.map((pc) => `${pcName(pc)} 音频${audioRatios[pc].toFixed(2)}/谱面${chartRatios[pc].toFixed(2)}`).join(' '),
  );
  const sim = chromaCos(audio, chart);
  assert.ok(sim > 0.5 && sim < 1, `音频/谱面 chroma 余弦应在 (0.5,1)，实测 ${sim.toFixed(3)}`);
  const best = chromaBestShift(audio, chart);
  assert.equal(best.shift, 0, `最佳移调应为 0（差异主因不是移调）实测 ${best.shift}`);
  console.log(
    `    调外 5 音级（音频/谱面，各自 ÷ 最大音级）：`
    + `${OUT_OF_SCALE.map((pc) => `${pcName(pc)} ${audioRatios[pc].toFixed(2)}/${chartRatios[pc].toFixed(2)}`).join(' ')}`
    + `｜余弦 ${sim.toFixed(3)}｜最佳移调 +${best.shift}`,
  );
});

test('真实数据：默认配置能真的跑完整首曲子（帧数 > 1000，meanRaw 非空）', (t) => {
  if (!fs.existsSync(WAV)) return t.skip(`缺少 ${WAV}`);
  const { samples, sampleRate, seconds } = readWav(WAV);
  assert.ok(seconds > 200, `音频时长异常：${seconds}s`);
  const g = chromagram({ samples, sampleRate, config: { ...DEFAULT_CHROMA_CONFIG, maxFrames: 0 } });
  assert.ok(g.frames.length > 1000, `帧数 ${g.frames.length}`);
  assert.ok([...g.meanRaw].reduce((a, b) => a + b, 0) > 0);
});
