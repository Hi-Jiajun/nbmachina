// M1-4 · 打击乐起音检测（底鼓 / 军鼓 / 踩镲）—— 合成样本分类准确率 + 契约 + 真实数据
//
// 为什么用"自己合成的三类样本"当尺子：本项目手里只有**整段混音**，没有分轨、没有鼓的
// 标注（`docs/DISCUSSION-C-music.md` §1 已审计：输入是单轨脉冲谱）。所以打击乐检测的
// 正确性只能靠"已知类别、已知时刻"的合成信号量出来，真实数据只报告**检出数量**与
// **与音频起音的对齐误差**，不谎称准确率。
//
// 三类样本按物理机制合成（不是三根正弦，否则"噪声性"这个判别特征根本不存在）：
//   · 底鼓：45–115Hz 指数扫频 + 2ms 宽带拍击，0.11s 指数衰减
//   · 军鼓：190Hz 鼓皮音 + 300–8000Hz 带通噪声（噪声性）+ 1.5ms 拍击
//   · 踩镲：6000–16000Hz 带通噪声，0.03s 极短衰减
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_DRUM_BANDS,
  DEFAULT_DRUM_CONFIG,
  classifyPercussion,
  detectPercussion,
  measureDrumFeatures,
} from '../src/analyze/drums.mjs';
import { readWav } from '../src/analyze/dsp.mjs';

const BUILD = process.env.nbmachina_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const ONSETS = path.join(BUILD, 'onsets_banded.json');
const SR = 44100;

/* ------------------------------------------------------- 合成（测试用信号） */

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** RBJ 带通（常数裙边），把白噪声整成"某个频带的噪声" */
function biquadBandpass(lowHz, highHz, sr = SR) {
  const f0 = Math.sqrt(lowHz * highHz);
  const q = Math.max(0.3, f0 / (highHz - lowHz));
  const w0 = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w0) / (2 * q);
  const a0 = 1 + alpha;
  return {
    b0: alpha / a0, b1: 0, b2: -alpha / a0,
    a1: (-2 * Math.cos(w0)) / a0, a2: (1 - alpha) / a0,
  };
}

function applyBiquad(x, c) {
  const y = new Float64Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = c.b0 * x[i] + c.b1 * x1 + c.b2 * x2 - c.a1 * y1 - c.a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
    y[i] = v;
  }
  return y;
}

/** 归一化到 RMS=1 的带通噪声，方便按固定增益叠加 */
function bandNoise({ seconds, lowHz, highHz, seed }) {
  const n = Math.max(1, Math.round(seconds * SR));
  const rnd = makeRng(seed);
  const raw = new Float64Array(n);
  for (let i = 0; i < n; i++) raw[i] = rnd();
  const filtered = applyBiquad(raw, biquadBandpass(lowHz, highHz));
  let sum = 0;
  for (const v of filtered) sum += v * v;
  const rms = Math.sqrt(sum / n) || 1;
  for (let i = 0; i < n; i++) filtered[i] /= rms;
  return filtered;
}

function addKick(out, start, gain, seed) {
  const rnd = makeRng(seed);
  const n = Math.round(0.35 * SR);
  const sweep = 70 * 0.025;
  for (let k = 0; k < n; k++) {
    const idx = start + k;
    if (idx >= out.length) break;
    const t = k / SR;
    const env = Math.exp(-t / 0.11) * Math.min(1, k / Math.max(1, 0.002 * SR));
    const phase = 2 * Math.PI * (45 * t + sweep * (1 - Math.exp(-t / 0.025)));
    out[idx] += gain * 0.9 * Math.sin(phase) * env;
  }
  for (let k = 0; k < Math.round(0.002 * SR); k++) {
    const idx = start + k;
    if (idx >= out.length) break;
    out[idx] += gain * 0.28 * rnd() * (1 - k / Math.round(0.002 * SR));
  }
}

function addSnare(out, start, gain, seed) {
  const rnd = makeRng(seed);
  const body = Math.round(0.3 * SR);
  for (let k = 0; k < body; k++) {
    const idx = start + k;
    if (idx >= out.length) break;
    const t = k / SR;
    const env = Math.exp(-t / 0.05) * Math.min(1, k / Math.max(1, 0.001 * SR));
    out[idx] += gain * 0.35 * Math.sin(2 * Math.PI * 190 * t) * env;
  }
  const noise = bandNoise({ seconds: 0.3, lowHz: 300, highHz: 8000, seed: seed + 17 });
  for (let k = 0; k < noise.length; k++) {
    const idx = start + k;
    if (idx >= out.length) break;
    out[idx] += gain * 0.9 * noise[k] * Math.exp(-(k / SR) / 0.09);
  }
  for (let k = 0; k < Math.round(0.0015 * SR); k++) {
    const idx = start + k;
    if (idx >= out.length) break;
    out[idx] += gain * 0.3 * rnd();
  }
}

function addHat(out, start, gain, seed) {
  const rnd = makeRng(seed);
  const noise = bandNoise({ seconds: 0.15, lowHz: 6000, highHz: 16000, seed: seed + 31 });
  for (let k = 0; k < noise.length; k++) {
    const idx = start + k;
    if (idx >= out.length) break;
    out[idx] += gain * 0.8 * noise[k] * Math.exp(-(k / SR) / 0.03);
  }
  for (let k = 0; k < Math.round(0.0005 * SR); k++) {
    const idx = start + k;
    if (idx >= out.length) break;
    out[idx] += gain * 0.25 * rnd();
  }
}

const ADD = { kick: addKick, snare: addSnare, hat: addHat };

/**
 * 合成一段"鼓点轨"：pattern = [{timeSec, kind, gain}]，外加固定底噪。
 * @returns {{samples: Float64Array, sampleRate: number, truth: Array}}
 */
function synthDrums(pattern, { seconds, noise = 0.0015, seed = 7 } = {}) {
  const n = Math.round(seconds * SR);
  const samples = new Float64Array(n);
  const rnd = makeRng(seed);
  for (let i = 0; i < n; i++) samples[i] = rnd() * noise;
  const truth = [];
  pattern.forEach((p, i) => {
    ADD[p.kind](samples, Math.round(p.timeSec * SR), p.gain ?? 0.8, seed + 100 + i * 13);
    truth.push({ time: p.timeSec, kind: p.kind });
  });
  return { samples, sampleRate: SR, truth };
}

/** 轮转的三类鼓点：每 0.5s 一次，不重叠（保证"哪一下是什么"没有歧义） */
function roundRobin(count = 30, spacingSec = 0.5, startSec = 0.25) {
  const kinds = ['kick', 'snare', 'hat'];
  return Array.from({ length: count }, (_, i) => ({
    timeSec: startSec + i * spacingSec,
    kind: kinds[i % 3],
  }));
}

const nearest = (arr, t) => arr.reduce((best, v) => (Math.abs(v - t) < Math.abs(best - t) ? v : best), Infinity);
const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? NaN : s[s.length >> 1];
};

/* ------------------------------------------------------------------ 契约 */

test('契约：三类频带就位，输出 {time, kind, strength}，时间升序且类别合法', () => {
  assert.equal(DEFAULT_DRUM_BANDS.length, 3);
  const byName = Object.fromEntries(DEFAULT_DRUM_BANDS.map((b) => [b.name, b]));
  assert.deepEqual(Object.keys(byName).sort(), ['hat', 'kick', 'snare']);
  assert.equal(byName.kick.loHz, 40);
  assert.equal(byName.kick.hiHz, 120);
  assert.equal(byName.snare.loHz, 150);
  assert.equal(byName.snare.hiHz, 400);
  assert.equal(byName.hat.loHz, 6000);
  assert.ok(byName.hat.hiHz > 6000);

  const { samples, sampleRate } = synthDrums(roundRobin(9), { seconds: 5 });
  const res = detectPercussion({ samples, sampleRate });
  assert.equal(res.bands.length, 3);
  assert.ok(res.events.length > 0, '合成鼓点轨必须检出事件');
  let prev = -Infinity;
  for (const e of res.events) {
    assert.ok(['kick', 'snare', 'hat'].includes(e.kind), `非法类别 ${e.kind}`);
    assert.ok(e.time > prev, '事件时刻必须严格升序');
    assert.ok(e.strength > 0 && e.strength <= 1, `strength 必须在 (0,1]：${e.strength}`);
    assert.ok(Number.isFinite(e.time) && e.time >= 0);
    assert.ok(e.features && typeof e.features.flatness === 'number', '事件要带判别特征');
    prev = e.time;
  }
});

/* ------------------------------------------- 合成样本：检出 + 分类准确率 */

test('合成三类样本：全部检出，且分类准确率 ≥90%', () => {
  const pattern = roundRobin(30);
  const truth = pattern.map((p) => ({ time: p.timeSec, kind: p.kind }));
  const times = truth.map((t) => t.time);
  const { samples, sampleRate } = synthDrums(pattern, { seconds: 16 });
  const { events } = detectPercussion({ samples, sampleRate });

  // 检出：每个真值都要有 ≤60ms 的事件（容差按任务书"对齐中位 ≤60ms"的同一把尺子）
  const detected = events.filter((e) => Math.abs(nearest(times, e.time) - e.time) <= 0.06);
  assert.equal(detected.length, truth.length, `检出 ${detected.length}/${truth.length}`);

  let correct = 0;
  const wrong = [];
  for (const t of truth) {
    const hit = detected.filter((e) => Math.abs(e.time - t.time) <= 0.06);
    const best = hit.reduce((a, b) => (Math.abs(a.time - t.time) <= Math.abs(b.time - t.time) ? a : b), hit[0]);
    if (best.kind === t.kind) correct++;
    else wrong.push(`${t.time.toFixed(3)}s 真值 ${t.kind} → 判成 ${best.kind}（margin ${best.margin.toFixed(3)}）`);
  }
  const accuracy = correct / truth.length;
  assert.ok(accuracy >= 0.9, `分类准确率 ${(accuracy * 100).toFixed(1)}% < 90%：${wrong.join('；')}`);
});

test('合成三类样本：检出时刻与真值的对齐误差 |中位数| ≤ 60ms', () => {
  const pattern = roundRobin(30);
  const times = pattern.map((p) => p.timeSec);
  const { samples, sampleRate } = synthDrums(pattern, { seconds: 16 });
  const { events } = detectPercussion({ samples, sampleRate });
  const offsets = events
    .filter((e) => Math.abs(nearest(times, e.time) - e.time) <= 0.06)
    .map((e) => e.time - nearest(times, e.time));
  assert.ok(offsets.length >= 24, `对齐样本太少：${offsets.length}`);
  const med = median(offsets);
  assert.ok(Math.abs(med) <= 0.06, `中位对齐误差 ${(med * 1000).toFixed(1)}ms > 60ms`);
});

test('合成三类样本：每类都能被认出来（不是靠"全判成一类"混过准确率）', () => {
  const pattern = roundRobin(30);
  const times = pattern.map((p) => p.timeSec);
  const { samples, sampleRate } = synthDrums(pattern, { seconds: 16 });
  const { events } = detectPercussion({ samples, sampleRate });
  const counts = { kick: 0, snare: 0, hat: 0 };
  for (const e of events) counts[e.kind]++;
  for (const k of ['kick', 'snare', 'hat']) {
    assert.ok(counts[k] >= 8, `类别 ${k} 只检出 ${counts[k]} 次（合成 10 次）`);
  }
  void times;
});

test('静音 / 低电平噪声：不产生打击乐事件（噪声底不能刷出候选）', () => {
  const quiet = new Float64Array(SR * 3);
  const rnd = makeRng(3);
  for (let i = 0; i < quiet.length; i++) quiet[i] = rnd() * 0.0015;
  assert.equal(detectPercussion({ samples: quiet, sampleRate: SR }).events.length, 0);
  assert.equal(detectPercussion({ samples: new Float64Array(SR * 2), sampleRate: SR }).events.length, 0);
});

test('确定性：同一段音频两次检测逐字段相同', () => {
  const { samples, sampleRate } = synthDrums(roundRobin(9), { seconds: 5 });
  const a = detectPercussion({ samples, sampleRate });
  const b = detectPercussion({ samples, sampleRate });
  assert.deepEqual(a.events, b.events);
});

test('连续 16 分格（0.12s 一个踩镲）不能被并成一个峰：16 下至少认出 13 下', () => {
  // 谱面网格就是 0.12s/step，所以"相邻两下 0.12s"是这一层必须能吃下的最密情形
  const pattern = Array.from({ length: 16 }, (_, i) => ({ timeSec: 0.3 + i * 0.12, kind: 'hat' }));
  const { samples, sampleRate } = synthDrums(pattern, { seconds: 4 });
  const { events } = detectPercussion({ samples, sampleRate });
  const times = pattern.map((p) => p.timeSec);
  const hit = events.filter((e) => times.some((t) => Math.abs(t - e.time) <= 0.06));
  assert.ok(hit.length >= 13, `16 分格只认出 ${hit.length}/16 下`);
  const wrong = hit.filter((e) => e.kind !== 'hat');
  assert.equal(wrong.length, 0, `踩镲被误判成：${wrong.map((e) => e.kind).join(',')}`);
});

test('同时刻的底鼓+军鼓只出一个事件（本机两种本来就占同一格 row 0，不丢信息）', () => {
  const pattern = [{ timeSec: 0.5, kind: 'kick' }, { timeSec: 0.5, kind: 'snare' }];
  const { samples, sampleRate } = synthDrums(pattern, { seconds: 2 });
  const { events } = detectPercussion({ samples, sampleRate });
  assert.equal(events.length, 1, `同时刻的底鼓+军鼓应合成一个事件，实得 ${events.length}`);
  assert.ok(['kick', 'snare'].includes(events[0].kind), `不许判成 ${events[0].kind}`);
});

/* ------------------------------------------- 判别特征（可解释性）单测 */

test('三类判别特征在合成样本上方向正确：底鼓低share / 军鼓噪声性 / 踩镲高share', () => {
  const at = 1.0;
  const mk = (kind) => {
    const { samples, sampleRate } = synthDrums([{ timeSec: at, kind, gain: 0.8 }], { seconds: 2, noise: 0.0002 });
    return measureDrumFeatures({ samples, sampleRate, timeSec: at });
  };
  const kick = mk('kick');
  const snare = mk('snare');
  const hat = mk('hat');

  assert.ok(kick.shares.low > snare.shares.low && kick.shares.low > hat.shares.low,
    `底鼓低频占比应最大：kick ${kick.shares.low.toFixed(3)} snare ${snare.shares.low.toFixed(3)} hat ${hat.shares.low.toFixed(3)}`);
  assert.ok(hat.shares.high > kick.shares.high && hat.shares.high > snare.shares.high,
    `踩镲高频占比应最大：kick ${kick.shares.high.toFixed(3)} snare ${snare.shares.high.toFixed(3)} hat ${hat.shares.high.toFixed(3)}`);
  assert.ok(snare.flatness > kick.flatness, `军鼓的噪声性（谱平坦度）应高于底鼓：${snare.flatness.toFixed(3)} vs ${kick.flatness.toFixed(3)}`);
  assert.ok(snare.flatness > hat.flatness, `军鼓的噪声性应高于踩镲：${snare.flatness.toFixed(3)} vs ${hat.flatness.toFixed(3)}`);
});

test('classifyPercussion：特征向量可直接判类，且给出 margin 与依据', () => {
  const kick = classifyPercussion({
    flux: { kick: 0.9, snare: 0.1, hat: 0.02 },
    shares: { low: 0.62, mid: 0.12, body: 0.16, upper: 0.08, high: 0.02 },
    flatness: 0.03,
  });
  assert.equal(kick.kind, 'kick');
  assert.ok(kick.margin > 0);
  assert.equal(typeof kick.reason, 'string');

  const snare = classifyPercussion({
    flux: { kick: 0.05, snare: 0.88, hat: 0.12 },
    shares: { low: 0.05, mid: 0.22, body: 0.34, upper: 0.31, high: 0.08 },
    flatness: 0.21,
  });
  assert.equal(snare.kind, 'snare');

  const hat = classifyPercussion({
    flux: { kick: 0.02, snare: 0.08, hat: 0.95 },
    shares: { low: 0.01, mid: 0.03, body: 0.05, upper: 0.11, high: 0.8 },
    flatness: 0.06,
  });
  assert.equal(hat.kind, 'hat');
});

test('默认配置包含三类频带与三道闸门（门槛写在配置里，不是散在代码里）', () => {
  assert.equal(DEFAULT_DRUM_CONFIG.bands.length, 3);
  for (const k of ['minProminence', 'minStrength', 'minRms', 'mergeSec', 'frameSize']) {
    assert.ok(k in DEFAULT_DRUM_CONFIG, `配置缺 ${k}`);
  }
});

/* -------------------------------------------------------------- 真实数据 */

test('真实数据：整段混音上检出打击乐，且与音频起音的对齐中位数 ≤60ms', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(ONSETS)) {
    return t.skip(`缺少 ${WAV} 或 ${ONSETS}（先跑 M1-3 的 analyze:onsets）`);
  }
  const { samples, sampleRate } = readWav(WAV);
  const { events } = detectPercussion({ samples, sampleRate });
  const ref = JSON.parse(fs.readFileSync(ONSETS, 'utf8')).times;
  assert.ok(events.length >= 100, `真实数据只检出 ${events.length} 个打击乐事件`);
  const perKind = {};
  for (const e of events) {
    const off = Math.abs(nearest(ref, e.time) - e.time);
    (perKind[e.kind] ??= []).push(off);
  }
  const lines = [];
  for (const k of ['kick', 'snare', 'hat']) {
    const arr = perKind[k] ?? [];
    if (arr.length >= 10) {
      const med = median(arr);
      lines.push(`${k} n=${arr.length} 对齐中位 ${(med * 1000).toFixed(1)}ms`);
      assert.ok(med <= 0.06, `${k} 对齐中位 ${(med * 1000).toFixed(1)}ms > 60ms`);
    }
  }
  assert.ok(lines.length >= 2, `至少两类要有足够样本：${lines.join('｜')}`);
});
