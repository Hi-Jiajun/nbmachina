// M1-3 · 分频带多分辨率谱通量起音检测器 + 对照（现有单带检测器）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  DEFAULT_ONSET_BANDS,
  DEFAULT_ONSET_DETECT_CONFIG,
  bandFluxes,
  calibrateLatency,
  detectBandOnsets,
  legacyOnsets,
  mergeBandPeaks,
  normalizeBands,
} from '../src/analyze/onset-detect.mjs';
import { detectOnsets, onsetAlignmentF1 } from '../src/verify/score.mjs';
import { midiToFreq, readWav } from '../src/analyze/dsp.mjs';

const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
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

/**
 * 钢琴式合成：基频 + 2/3 次谐波，10ms 起振、~0.28s 指数衰减。
 * 刻意带三样真实钢琴都有、而"纯正弦叠加"没有的东西：**击槌噪声**（宽带瞬态，~6ms）、
 * **轻微失谐**（±5 音分）、**非谐性**。第一版没这三样时，相邻音的谐波在谱上完全同相，
 * 相加时互相抵消（对数幅度会**下降**），通量因此变得不可用——那不是"检测器漏检"，
 * 是合成信号本身不成立（见 docs/M1-3-report.md §3.4）。
 */
function synthPiano({ notes, seconds, noise = 0.003, seed = 11 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  const rnd = makeRng(seed);
  for (let i = 0; i < n; i++) out[i] = rnd() * noise;
  const noteRng = makeRng(seed + 991);
  notes.forEach((nt, ni) => {
    const cents = (ni * 37) % 11 - 5;
    const f0 = midiToFreq(nt.midi, 440) * 2 ** (cents / 1200);
    const start = Math.round(nt.timeSec * SR);
    const noiseDur = Math.round(0.006 * SR);
    for (let k = 0; k < noiseDur; k++) {
      const idx = start + k;
      if (idx >= n) break;
      out[idx] += noteRng() * nt.gain * 0.9 * (1 - k / noiseDur);
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

/** 旧版（不真实的）合成：没有击槌噪声/失谐，用来演示"合成信号本身会互相抵消" */
function synthPureTones({ notes, seconds, noise = 0.003, seed = 11 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  const rnd = makeRng(seed);
  for (let i = 0; i < n; i++) out[i] = rnd() * noise;
  for (const nt of notes) {
    const f0 = midiToFreq(nt.midi, 440);
    const start = Math.round(nt.timeSec * SR);
    for (let k = 0; k < Math.round(0.45 * SR); k++) {
      const idx = start + k;
      if (idx >= n) break;
      const t = k / SR;
      const env = Math.min(1, k / (0.01 * SR)) * Math.exp(-t / 0.28);
      let v = 0;
      for (let h = 1; h <= 3; h++) v += (0.6 / h) * Math.sin(2 * Math.PI * f0 * h * t);
      out[idx] += v * env * nt.gain;
    }
  }
  return out;
}

/**
 * 连续 16 分格：旋律 + 低音都踩在 0.12s 网格的每一步上（最坏情况——相邻攻击之间没有空隙）。
 * 第一个音放在 0.2s：第 0 帧没有"前一帧"可比，任何**通量**检测器都测不到 t=0（现有检测器同理）。
 */
function denseSixteenths({ steps = 32, stepSec = 0.12, startSec = 0.2, melGain = 0.22, bassGain = 0.3, bass = true }) {
  const notes = [];
  const scale = [0, 2, 3, 5, 7, 8, 10];
  for (let s = 0; s < steps; s++) {
    const t = Number((startSec + s * stepSec).toFixed(3));
    notes.push({ step: s, timeSec: t, instrument: 'harp', midi: 62 + scale[(s * 5 + 2) % scale.length] + (s % 3 === 0 ? 12 : 0), gain: melGain });
    if (bass) notes.push({ step: s, timeSec: t, instrument: 'bass', midi: 38 + scale[s % scale.length], gain: bassGain });
  }
  const seconds = startSec + steps * stepSec + 0.5;
  return { notes, times: [...new Set(notes.map((n) => n.timeSec))], seconds };
}

const cover = (times, truth, tolSec = 0.05) => {
  const missed = truth.filter((t) => !times.some((x) => Math.abs(x - t) <= tolSec));
  return { missed, hit: truth.length - missed.length, detected: times.length };
};

test('契约：默认 ≥4 个频带，峰输出 {time, band, strength}，起音时刻升序且不重复', () => {
  assert.ok(DEFAULT_ONSET_BANDS.length >= 4, `默认频带数 ${DEFAULT_ONSET_BANDS.length}`);
  const bands = new Set(DEFAULT_ONSET_BANDS.map((b) => b.name));
  assert.equal(bands.size, DEFAULT_ONSET_BANDS.length, '频带名不能重复（合并时要按名字去重）');
  for (const b of DEFAULT_ONSET_BANDS) {
    assert.ok(b.hiHz > b.loHz, `${b.name} 频带上下限应为 hiHz > loHz`);
    assert.ok(Number.isFinite(b.hopSec) && b.hopSec > 0, `${b.name} 需要逐带帧率 hopSec`);
  }
  const normalized = normalizeBands({ bands: DEFAULT_ONSET_BANDS, sampleRate: SR, ...DEFAULT_ONSET_DETECT_CONFIG });
  for (const b of normalized) assert.ok(Number.isInteger(Math.log2(b.frameSize)), `${b.name} 窗长必须是 2 的幂（FFT 要求）`);
  // 多分辨率：默认 profile 里不同带用不同的帧率（低频 20ms / 中频 10ms / 高频 5ms）
  assert.ok(new Set(DEFAULT_ONSET_BANDS.map((b) => b.hopSec)).size >= 2, '默认 profile 应当是"多分辨率"（逐带帧率不同）');

  const { notes, seconds } = denseSixteenths({ steps: 8 });
  const samples = synthPiano({ notes, seconds });
  const out = detectBandOnsets({ samples, sampleRate: SR });
  assert.ok(out.peaks.length > 0, '应当检出起音峰');
  for (const p of out.peaks) {
    assert.equal(typeof p.band, 'string');
    assert.ok(Number.isFinite(p.time) && Number.isFinite(p.strength), `峰的 time/strength 必须是有限数：${JSON.stringify(p)}`);
    assert.ok(p.strength >= 0 && p.strength <= 1, `归一化强度应落在 0..1：${p.strength}`);
  }
  assert.ok(out.onsets.length > 0);
  for (let i = 1; i < out.times.length; i++) assert.ok(out.times[i] > out.times[i - 1], '起音时刻必须严格升序');
  const names = new Set(out.bands.map((b) => b.name));
  assert.deepEqual([...names].sort(), [...bands].sort(), '输出里的带名应与配置一致');
  assert.ok(out.meta.onsetBands >= 4, `meta.onsetBands=${out.meta.onsetBands}`);
});

test('合成连续 16 分格：漏检 0（现有单带检测器同场对照）', () => {
  const { notes, times, seconds } = denseSixteenths({ steps: 32 });
  const samples = synthPiano({ notes, seconds });
  const banded = detectBandOnsets({ samples, sampleRate: SR });
  const c = cover(banded.times, times);
  assert.equal(c.missed.length, 0, `分频带检测器漏了 ${c.missed.length} 个：${c.missed.slice(0, 8).join(' ')}`);

  // 对照：现有检测器（单带 1024 点 / 全局+局部阈值）。
  // 注意口径：只要合成音带**击槌噪声**（真实钢琴都有），现有检测器在这段合成上其实不漏——
  // 它漏的是真实混音里的密集段（见下一个"真实数据"用例：R 0.805 vs 0.974）。
  // 所以这里只对照"检出数/漏检数"，不写"现有检测器必漏"这种会被模型选择左右的断言。
  const legacy = legacyOnsets({ samples, sampleRate: SR });
  const l = cover(legacy.times, times);
  assert.ok(l.missed.length <= 1, `现有检测器在这段合成上不该大面积漏（漏 ${l.missed.length}）`);
  assert.ok(l.detected <= times.length + 8, `现有检测器检出 ${l.detected} 个，异常`);
  assert.ok(c.detected <= times.length + 12, `分频带检出 ${c.detected} 个，不该靠狂撒峰凑 recall`);
  console.log(`    合成 16 分格（32 步，击槌噪声）：现有 检出 ${l.detected} 漏 ${l.missed.length}`
    + `｜分频带 检出 ${c.detected} 漏 ${c.missed.length}`);
  const api = detectOnsets({ samples, sampleRate: SR }); // 向后兼容入口 == 现有实现
  assert.deepEqual(api.times, legacy.times);
});

test('延迟补偿：峰值时刻对真实起音的偏差 |中位数| ≤ 15ms（窗长决定通量峰提前量）', () => {
  const { notes, times, seconds } = denseSixteenths({ steps: 16 });
  const samples = synthPiano({ notes, seconds });
  const { times: detected } = detectBandOnsets({ samples, sampleRate: SR });
  const offs = [];
  for (const t of times) {
    let best = null;
    for (const x of detected) if (best === null || Math.abs(x - t) < Math.abs(best - t)) best = x;
    if (best !== null && Math.abs(best - t) <= 0.05) offs.push((best - t) * 1000);
  }
  offs.sort((a, b) => a - b);
  assert.ok(offs.length >= times.length - 1, `对上的起音太少：${offs.length}/${times.length}`);
  const median = offs[Math.floor(offs.length / 2)];
  assert.ok(Math.abs(median) <= 15, `峰值偏移中位数 ${median.toFixed(1)}ms 超过 15ms（补偿没生效？）`);
});

test('标定 CLI：提前量随窗长单调增大，46ms 窗的提前量 ≈ 0.5–0.7×窗长', () => {
  const cal = calibrateLatency({ frameSizes: [512, 1024, 2048, 4096] });
  assert.equal(cal.rows.length, 4);
  for (let i = 1; i < cal.rows.length; i++) {
    // 窗越长，提前量越大（越负）
    assert.ok(cal.rows[i].medianMs < cal.rows[i - 1].medianMs,
      `提前量应随窗长增大：${cal.rows[i - 1].frameSize}${cal.rows[i - 1].medianMs}ms → ${cal.rows[i].frameSize}${cal.rows[i].medianMs}ms`);
  }
  const r2048 = cal.rows.find((r) => r.frameSize === 2048);
  assert.ok(r2048.medianMs < 0, `46ms 窗的通量峰应当偏早，实测 ${r2048.medianMs}ms`);
  assert.ok(r2048.ratioToWindow >= 0.4 && r2048.ratioToWindow <= 0.8,
    `46ms 窗的提前量/窗长 = ${r2048.ratioToWindow}，应落在 0.4–0.8（默认 latencyFactor 0.5 的依据）`);
  // 1024（M0 单带用的窗）也偏早，但幅度小一个量级
  const r1024 = cal.rows.find((r) => r.frameSize === 1024);
  assert.ok(r1024.medianMs < 0 && Math.abs(r1024.medianMs) < Math.abs(r2048.medianMs));
  console.log(`    标定：${cal.rows.map((r) => `${(1000 * r.frameSec).toFixed(0)}ms→${r.medianMs}ms（${r.ratioToWindow}×窗）`).join('｜')}`);
});

test('静音 / 低电平噪声：不产生起音（噪声底不能刷出候选）', () => {
  const silence = new Float64Array(Math.round(3 * SR));
  const s = detectBandOnsets({ samples: silence, sampleRate: SR });
  assert.equal(s.times.length, 0, `静音检出了 ${s.times.length} 个起音`);
  // 3e-3 振幅的白噪声（低于默认 RMS 地板 0.02）不应产生起音
  const rnd = makeRng(7);
  const noise = new Float64Array(Math.round(3 * SR));
  for (let i = 0; i < noise.length; i++) noise[i] = rnd() * 0.003;
  const nz = detectBandOnsets({ samples: noise, sampleRate: SR });
  assert.ok(nz.times.length <= 2, `低电平噪声检出了 ${nz.times.length} 个起音`);
});

test('多分辨率 profile（逐带不同窗长与帧率）可用；默认 profile 用共享窗长（见报告 §3.5）', () => {
  const bands = [
    { name: 'low', loHz: 60, hiHz: 260, frameSize: 4096, hopSec: 0.02, latencyFactor: 0.65 },
    { name: 'mid1', loHz: 260, hiHz: 700, frameSize: 2048, hopSec: 0.01, latencyFactor: 0.5 },
    { name: 'mid2', loHz: 700, hiHz: 1600, frameSize: 2048, hopSec: 0.01, latencyFactor: 0.5 },
    { name: 'high1', loHz: 1600, hiHz: 3200, frameSize: 1024, hopSec: 0.005, latencyFactor: 0.35 },
    { name: 'high2', loHz: 3200, hiHz: 6000, frameSize: 1024, hopSec: 0.005, latencyFactor: 0.35 },
  ];
  const { notes, times, seconds } = denseSixteenths({ steps: 16 });
  const samples = synthPiano({ notes, seconds });
  const out = detectBandOnsets({ samples, sampleRate: SR, config: { bands, minBands: 3, minPeakProminence: 3.5, minRms: 0.01 } });
  assert.equal(out.bands.length, 5);
  assert.deepEqual(out.bands.map((b) => b.frameSize), [4096, 2048, 2048, 1024, 1024], '逐带窗长应各按配置生效');
  const c = cover(out.times, times);
  // 异窗 profile 能跑通，但实测比"共享窗长 + 逐带帧率"差（真实数据 recall 0.945 vs 0.974）：
  // 不同窗长的通量峰提前量不同，混合后各带在 50ms 容差里互相错位。默认 profile 因此统一窗长。
  assert.ok(c.missed.length <= 2, `异窗多分辨率漏检 ${c.missed.length}/16，超出已知边界`);
});

test('合成信号要有击槌噪声：纯谐波叠加会让相邻音的谱通量互相抵消（模型对照）', () => {
  const { notes, seconds, times } = denseSixteenths({ steps: 16 });
  const realistic = synthPiano({ notes, seconds });
  const pureTones = synthPureTones({ notes, seconds });
  const real = cover(detectBandOnsets({ samples: realistic, sampleRate: SR }).times, times);
  const pure = cover(detectBandOnsets({ samples: pureTones, sampleRate: SR }).times, times);
  const legacyReal = cover(legacyOnsets({ samples: realistic, sampleRate: SR }).times, times);
  const legacyPure = cover(legacyOnsets({ samples: pureTones, sampleRate: SR }).times, times);
  console.log(`    合成模型对照（16 步）：带击槌噪声 现有漏 ${legacyReal.missed.length} / 分频带漏 ${real.missed.length}`
    + `｜纯谐波叠加 现有漏 ${legacyPure.missed.length} / 分频带漏 ${pure.missed.length}`);
  assert.equal(real.missed.length, 0, `带击槌噪声的合成不该漏：${real.missed.join(' ')}`);
  assert.ok(pure.missed.length > real.missed.length,
    `纯谐波合成应当更难（实测带噪声漏 ${real.missed.length}、纯谐波漏 ${pure.missed.length}）`);
});

test('合并：同一起音被多个带看到只输出一个起音（不重复计数）', () => {
  const bands = new Set(DEFAULT_ONSET_BANDS.map((b) => b.name));
  const peaks = [];
  let i = 0;
  for (const name of bands) peaks.push({ time: 1.0 + 0.005 * i++, band: name, strength: 0.8, prominence: 6 });
  peaks.push({ time: 2.0, band: [...bands][0], strength: 0.9, prominence: 7 });
  const merged = mergeBandPeaks(peaks, { mergeSec: 0.035 });
  assert.equal(merged.length, 2, `应合并成 2 个起音，实测 ${merged.length}`);
  assert.ok(merged[0].bands.length >= 4, '第一个起音应当记录多个提供证据的带');
  assert.ok(merged[0].members.length >= 4);
});

test('真实数据：recall ≥0.90 / precision ≥0.95，且 recall 明显高于现有检测器', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(MACHINE)) return t.skip(`缺少 ${WAV} 或 ${MACHINE}`);
  const { samples, sampleRate } = readWav(WAV);
  const chartTimes = [...new Set(fs.readFileSync(MACHINE, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => Number(l.split(',')[2])))].sort((a, b) => a - b);

  const banded = detectBandOnsets({ samples, sampleRate });
  const b = onsetAlignmentF1({ chartTimes, audioTimes: banded.times, tolSec: 0.05 });
  const legacy = legacyOnsets({ samples, sampleRate });
  const l = onsetAlignmentF1({ chartTimes, audioTimes: legacy.times, tolSec: 0.05 });

  assert.ok(b.precision >= 0.95, `precision=${b.precision.toFixed(4)} 应 ≥0.95`);
  assert.ok(b.recall >= 0.9, `recall=${b.recall.toFixed(4)} 应 ≥0.90（现有检测器 ${l.recall.toFixed(4)}）`);
  assert.ok(b.recall > l.recall + 0.10, `分频带应当明显提高 recall：${l.recall.toFixed(3)} → ${b.recall.toFixed(3)}`);
  assert.ok(b.value > l.value, `F1 不应下降：${l.value} → ${b.value}`);
  console.log(
    `    真实数据（${chartTimes.length} 个谱面起音）：现有 P ${l.precision.toFixed(3)}/R ${l.recall.toFixed(3)}`
    + `（音频 ${l.audioOnsets}）→ 分频带 P ${b.precision.toFixed(3)}/R ${b.recall.toFixed(3)}（音频 ${b.audioOnsets}）`,
  );
});

test('带内通量：逐带归一化到 0..1，且突出度序列对冲击有峰', () => {
  const { notes, seconds } = denseSixteenths({ steps: 6 });
  const samples = synthPiano({ notes, seconds });
  const bands = bandFluxes({ samples, sampleRate: SR, config: { bands: DEFAULT_ONSET_BANDS } });
  assert.equal(bands.length, DEFAULT_ONSET_BANDS.length);
  for (const b of bands) {
    const max = Math.max(...b.flux);
    assert.ok(max > 0.99 && max <= 1.0000001, `${b.name} 归一化最大通量 ${max}`);
    const maxProm = Math.max(...b.prom);
    assert.ok(maxProm > DEFAULT_ONSET_DETECT_CONFIG.minProminence, `${b.name} 冲击处突出度 ${maxProm} 应超过入选门槛`);
  }
});
