// T6 · 综合评分器：起音对齐 F1 / chroma 相似度 / 八度命中率 / 力度包络相关 / 漏音率 → 加权综合分
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_SCORE_WEIGHTS,
  compositeScore,
  detectOnsets,
  expectedVsActual,
  matchOnsets,
  octaveEstimate,
  onsetAlignmentF1,
  scoreChart,
} from '../src/verify/score.mjs';
import { readNotesCsv, readWav } from '../src/analyze/chroma.mjs';
import { midiToFreq } from '../src/analyze/dsp.mjs';
import { mapEnergiesToVelocity, velocityCsvText } from '../src/arrange/velocity.mjs';

const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const V3 = path.join(BUILD, 'styx_helix_notes_v3.csv');
const MACHINE = path.join(BUILD, 'machine_p1.csv');
const SR = 44100;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** 合成一段"由谱面生成"的音频：每颗音按 gain 叠 f0/2f0/3f0，0.25s 指数衰减 */
function synthFromNotes({ notes, seconds, noise = 0.004, seed = 17 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  const harm = [1, 0.5, 0.25];
  for (const nt of notes) {
    const f0 = midiToFreq(nt.midi, 440);
    const start = Math.round(nt.timeSec * SR);
    const dur = Math.round(0.25 * SR);
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SR;
      const env = Math.min(1, i / (0.005 * SR)) * Math.exp(-t / 0.35);
      let v = 0;
      for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * f0 * (h + 1) * t);
      out[idx] += v * env * nt.gain;
    }
  }
  if (noise > 0) {
    const rng = makeRng(seed);
    for (let i = 0; i < n; i++) out[i] += rng() * noise;
  }
  return out;
}

/**
 * 造一份"正常"的合成用例：0.12s 网格上的旋律 + 低音。
 * dropFraction 按**整步**丢（一步的旋律+低音一起丢），这样漏音率与"起音数下降"同步。
 */
function makeCase({ steps = 40, dropFraction = 0 } = {}) {
  const notes = [];
  const scale = [0, 2, 3, 5, 7, 8, 10]; // 自然小调（含调外音的变体由 seed 决定）
  const dropEvery = dropFraction > 0 ? Math.round(1 / dropFraction) : 0;
  for (let s = 0; s < steps; s++) {
    if (dropEvery && s % dropEvery === 0) continue;
    const t = Number((s * 0.12).toFixed(3));
    const pc = scale[(s * 5 + 2) % scale.length];
    const mel = { step: s, timeSec: t, instrument: 'harp', midi: 62 + pc + (s % 3 === 0 ? 12 : 0), row: 12 + (s % 10) };
    const bass = { step: s, timeSec: t, instrument: 'bass', midi: 38 + scale[s % scale.length], row: 4 + (s % 6) };
    notes.push(mel, bass);
  }
  const withGain = notes.map((n, i) => ({ ...n, gain: 0.3 + (0.7 * ((i * 37) % 100)) / 100 }));
  return { notes: withGain, seconds: steps * 0.12 + 0.4 };
}

/** 谱面力度按生产口径生成（velocity.mjs 的 p10/p90 → 0.35..1.0 映射），而不是"喂一个理想值" */
function velocitiesFromGain(notes) {
  const vels = mapEnergiesToVelocity(notes.map((n) => n.gain ** 2));
  return notes.map((n, i) => ({ ...n, mappedVelocity: Number(vels[i].toFixed(4)) }));
}

const toCsv = (notes, { velocityFromGain = false } = {}) => {
  const rows = notes.map((n) => {
    const volume = n.gain ?? 0.6;
    const vel = velocityFromGain ? (n.mappedVelocity ?? Number((n.gain ** 2).toFixed(4))) : Number((volume * 127).toFixed(0));
    return [n.step, n.step * 12, n.timeSec.toFixed(3), n.instrument, n.midi, n.row, volume.toFixed(3), vel].join(',');
  });
  return ['step,tick,time_seconds,instrument,midi,row,volume,velocity', ...rows].join('\n') + '\n';
};

test('起音匹配：完全相同 = 1；位移 ≤ 容差 = 1；完全不相交 = 0；部分命中按 F1 计', () => {
  const chart = [0, 0.12, 0.24, 0.36, 0.48];
  assert.equal(onsetAlignmentF1({ chartTimes: chart, audioTimes: chart, tolSec: 0.05 }).f1, 1);
  const shifted = chart.map((t) => t + 0.03);
  assert.equal(onsetAlignmentF1({ chartTimes: chart, audioTimes: shifted, tolSec: 0.05 }).f1, 1);
  const far = chart.map((t) => t + 1);
  assert.equal(onsetAlignmentF1({ chartTimes: chart, audioTimes: far, tolSec: 0.05 }).f1, 0);
  // 谱面 5 个、音频 3 个（其中 3 个对上）：P=1, R=0.6 → F1=0.75
  const m = onsetAlignmentF1({ chartTimes: chart, audioTimes: [0, 0.12, 0.24], tolSec: 0.05 });
  assert.equal(m.matched, 3);
  assert.ok(Math.abs(m.precision - 1) < 1e-12);
  assert.ok(Math.abs(m.recall - 0.6) < 1e-12);
  assert.ok(Math.abs(m.f1 - 0.75) < 1e-12, `F1=${m.f1}`);
  // matchOnsets 不会把同一颗音频起音配给两颗谱面音
  const dup = matchOnsets([0, 0.01, 0.02], [0.005], 0.05);
  assert.equal(dup.matched, 1);
});

test('起音检测：0.12s 网格的脉冲串每个脉冲都检到（≤50ms）', () => {
  const clicks = 20;
  const seconds = clicks * 0.12 + 0.3;
  const n = Math.round(seconds * SR);
  const samples = new Float64Array(n);
  for (let i = 0; i < clicks; i++) {
    const start = Math.round(i * 0.12 * SR);
    for (let k = 0; k < 400; k++) samples[start + k] += Math.exp(-k / 60) * 0.8;
    for (let k = 0; k < 400; k++) samples[start + k] += 0.3 * Math.sin((2 * Math.PI * 1200 * k) / SR) * Math.exp(-k / 80);
  }
  const { times } = detectOnsets({ samples, sampleRate: SR });
  assert.ok(times.length >= clicks - 1, `检到 ${times.length} 个起音（应 ≈ ${clicks}）`);
  const truth = Array.from({ length: clicks }, (_, i) => i * 0.12);
  const hit = truth.filter((t) => times.some((x) => Math.abs(x - t) <= 0.05)).length;
  // t=0 的那一颗由第 0 帧代表，而第 0 帧没有"前一帧"可比（检测从第 1 帧起），允许漏它
  assert.ok(hit >= clicks - 1, `只对上 ${hit}/${clicks}`);
});

test('八度判据：合成音上 bestMidi 等于真实音高（含调外音级）', () => {
  const midis = [40, 45, 52, 57, 62, 66, 69, 73, 77, 81];
  const fails = [];
  for (const midi of midis) {
    const instrument = midi < 47 ? 'bass' : 'harp';
    const samples = synthFromNotes({ notes: [{ timeSec: 0, midi, gain: 0.8 }], seconds: 0.8 });
    const est = octaveEstimate({ samples, sampleRate: SR, note: { midi, instrument, timeSec: 0 } });
    if (est.bestMidi !== midi) fails.push(`${midi}→${est.bestMidi}`);
  }
  assert.deepEqual(fails, [], `误判: ${fails.join(' ')}`);
});

test('expectedVsActual：按 (step,midi) 多重集合匹配，漏音/多音都算得出来', () => {
  const full = [{ step: 0, midi: 60 }, { step: 0, midi: 64 }, { step: 1, midi: 62 }, { step: 2, midi: 65 }];
  const actual = [{ step: 0, midi: 60 }, { step: 1, midi: 62 }, { step: 3, midi: 70 }];
  const r = expectedVsActual(full, actual);
  assert.equal(r.matched, 2);
  assert.equal(r.missing, 2);
  assert.equal(r.extra, 1);
  assert.ok(Math.abs(r.missingRate - 0.5) < 1e-12);
  assert.ok(Math.abs(r.extraRate - 1 / 3) < 1e-12);
});

test('加权综合分：全 1 = 1、全 0 = 0、权重按比例归一、人耳分只占 30%', () => {
  const ones = Object.fromEntries(Object.keys(DEFAULT_SCORE_WEIGHTS).map((k) => [k, 1]));
  const zeros = Object.fromEntries(Object.keys(DEFAULT_SCORE_WEIGHTS).map((k) => [k, 0]));
  assert.equal(compositeScore(ones, {}).objective, 1);
  assert.equal(compositeScore(zeros, {}).objective, 0);
  assert.equal(compositeScore(ones, {}).overall, null, '没有人耳分时不编造 overall');
  const half = compositeScore(ones, { human: 0 });
  assert.ok(Math.abs(half.overall - 0.7) < 1e-9, `overall=${half.overall}`);
  const custom = compositeScore({ onsetF1: 1, chromaCos: 0 }, { weights: { onsetF1: 3, chromaCos: 1 } });
  assert.ok(Math.abs(custom.objective - 0.75) < 1e-12, `权重应归一：${custom.objective}`);
  assert.ok(Math.abs(compositeScore({ onsetF1: -5, chromaCos: 2 }, {}).objective - DEFAULT_SCORE_WEIGHTS.chromaCos) < 1e-9,
    '越界值应被夹到 0..1');
});

test('完全相同 → 高分（合成音频由谱面生成，五项指标都应接近满分）', () => {
  const { notes, seconds } = makeCase({ steps: 40 });
  const samples = synthFromNotes({ notes, seconds });
  const csv = toCsv(velocitiesFromGain(notes), { velocityFromGain: true });
  const scored = scoreChart({ csvText: csv, samples, sampleRate: SR });
  const m = scored.metrics;
  assert.ok(m.onsetF1.value >= 0.9, `起音 F1=${m.onsetF1.value}`);
  assert.ok(m.chromaCos.value >= 0.9, `chroma 余弦=${m.chromaCos.value}`);
  assert.ok(m.octaveHit.value >= 0.9, `八度命中率=${m.octaveHit.value}`);
  // 上限不是 1：低音区相邻半音的泄漏会给力度描述子带来噪声（见 M0-3 报告 §3.3 的窗长扫描）
  assert.ok(m.velocityCorr.value >= 0.8, `力度相关=${m.velocityCorr.value}`);
  assert.ok(m.noteSupport.value >= 0.98, `有支撑率=${m.noteSupport.value}`);
  assert.ok(scored.score.objective >= 0.88, `综合分=${scored.score.objective}`);
  assert.equal(scored.score.overall, null);
  // 同一份输入跑两遍必须逐字节一样（决定论）
  const again = scoreChart({ csvText: csv, samples, sampleRate: SR });
  assert.equal(JSON.stringify(again.metrics), JSON.stringify(m));
});

test('故意漏 10% 音 → 漏音率≈10%，综合分明显掉下来', () => {
  const full = makeCase({ steps: 40 });
  const samples = synthFromNotes(full);
  const fullCsv = toCsv(velocitiesFromGain(full.notes), { velocityFromGain: true });
  const dropped = makeCase({ steps: 40, dropFraction: 0.1 });
  const dropCsv = toCsv(velocitiesFromGain(dropped.notes), { velocityFromGain: true });
  const expected = readNotesCsv(fullCsv).notes;
  const base = scoreChart({ csvText: fullCsv, samples, sampleRate: SR, expected });
  const broken = scoreChart({ csvText: dropCsv, samples, sampleRate: SR, expected });
  assert.ok(base.metrics.noteSupport.expectedVsActual, '给了 --expected 就该有 expectedVsActual');
  assert.ok(Math.abs(base.metrics.noteSupport.expectedVsActual.missingRate) < 1e-12, '基准自身不该有漏音');
  const mr = broken.metrics.noteSupport.expectedVsActual.missingRate;
  assert.ok(Math.abs(mr - 0.1) < 0.03, `漏音率应≈10%，实测 ${(100 * mr).toFixed(1)}%`);
  assert.ok(
    broken.score.objective < base.score.objective - 0.03,
    `综合分应明显下降：${base.score.objective} → ${broken.score.objective}`,
  );
  assert.ok(broken.metrics.onsetF1.value < base.metrics.onsetF1.value, '漏音会同时打掉起音对齐');
});

test('真实数据：v3 基线分（五项指标都给出，且旋律八度明显好于贝斯）', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(V3)) return t.skip(`缺少 ${WAV} 或 ${V3}`);
  const { samples, sampleRate } = readWav(WAV);
  const csvText = fs.readFileSync(V3, 'utf8');
  const evPath = path.join(BUILD, 'analysis_octave.json');
  const octaveEvidence = fs.existsSync(evPath) ? JSON.parse(fs.readFileSync(evPath, 'utf8')) : null;
  const scored = scoreChart({ csvText, samples, sampleRate, octaveEvidence });
  const m = scored.metrics;
  assert.ok(scored.score.objective > 0 && scored.score.objective < 1);
  assert.ok(m.chromaCos.bestShift === 0, `差异主因不该是移调（bestShift=${m.chromaCos.bestShift}）`);
  assert.ok(
    m.octaveHit.byVoice.melody.rate > m.octaveHit.byVoice.bass.rate + 0.05,
    `旋律八度 ${m.octaveHit.byVoice.melody.rate} 应明显好于贝斯 ${m.octaveHit.byVoice.bass.rate}`,
  );
  // 默认检测器 = M1-3 的分频带多分辨率（`--detector legacy` 是 M0 的单带实现，recall≈0.805）
  assert.equal(m.onsetF1.detector, 'banded');
  assert.ok(m.onsetF1.recall > 0.9, `谱面起音大多应落在音频起音上，实测 recall=${m.onsetF1.recall}`);
  assert.ok(m.onsetF1.precision > 0.95, `检出的音频起音几乎都该对到谱面上，实测 precision=${m.onsetF1.precision}`);
  if (octaveEvidence) {
    assert.equal(m.octaveHit.agreementWithT2.alignedBy, 'step+time+instrument+midi');
    assert.ok(m.octaveHit.agreementWithT2.rate > 0.8, `与 T2 证据的一致率应 >80%：${m.octaveHit.agreementWithT2.rate}`);
    assert.ok(Math.abs(m.octaveHit.agreementWithT2.evidenceHitRate - 0.834) < 0.02,
      `T2 证据自身的命中率应 ≈0.834，实测 ${m.octaveHit.agreementWithT2.evidenceHitRate}`);
  }
  console.log(
    `    v3 基线：onsetF1 ${m.onsetF1.value.toFixed(3)}（P ${m.onsetF1.precision.toFixed(3)}/R ${m.onsetF1.recall.toFixed(3)}）`
    + `｜chroma ${m.chromaCos.value.toFixed(3)}｜八度 ${m.octaveHit.value.toFixed(3)}`
    + `（旋律 ${m.octaveHit.byVoice.melody.rate.toFixed(3)} / 贝斯 ${m.octaveHit.byVoice.bass.rate.toFixed(3)}）`
    + `｜力度 r ${m.velocityCorr.pearson.toFixed(3)}｜漏音 ${(100 * m.noteSupport.missingRate).toFixed(1)}%`
    + `｜综合分 ${scored.score.objective.toFixed(3)}`
    + (m.octaveHit.agreementWithT2 ? `｜与 T2 证据一致 ${(100 * m.octaveHit.agreementWithT2.rate).toFixed(1)}%` : ''),
  );
});

test('真实数据：用 T3 修完八度的谱面打分，八度命中率与综合分都应明显提升', (t) => {
  const FIXED = path.join(BUILD, 'notes_fixed_v3.csv');
  if (!fs.existsSync(WAV) || !fs.existsSync(V3) || !fs.existsSync(FIXED)) return t.skip('缺少 WAV / v3 / notes_fixed_v3.csv');
  const { samples, sampleRate } = readWav(WAV);
  const before = scoreChart({ csvText: fs.readFileSync(V3, 'utf8'), samples, sampleRate });
  // 修完八度后要按同一套流水线重算力度（T3 → T5 的顺序，M0-1 §4.3 的建议）
  const fixedCsv = fs.readFileSync(FIXED, 'utf8');
  const fixedVel = velocityCsvText({ csvText: fixedCsv, samples, sampleRate }).csv;
  const after = scoreChart({ csvText: fixedCsv, samples, sampleRate, velocityCsvText: fixedVel });
  const b = before.metrics.octaveHit.value;
  const a = after.metrics.octaveHit.value;
  assert.ok(a > b + 0.05, `八度命中率应明显提升：${b.toFixed(3)} → ${a.toFixed(3)}`);
  assert.ok(after.metrics.octaveHit.byVoice.bass.rate > before.metrics.octaveHit.byVoice.bass.rate + 0.05,
    `贝斯最该变好：${before.metrics.octaveHit.byVoice.bass.rate} → ${after.metrics.octaveHit.byVoice.bass.rate}`);
  assert.ok(after.score.objective > before.score.objective,
    `综合分应提升：${before.score.objective} → ${after.score.objective}`);
  assert.ok(after.metrics.velocityCorr.pearson > 0.8, `重算后的力度相关应很高：${after.metrics.velocityCorr.pearson}`);
  console.log(
    `    T3 修复前后：八度 ${b.toFixed(3)} → ${a.toFixed(3)}`
    + `（旋律 ${before.metrics.octaveHit.byVoice.melody.rate.toFixed(3)} → ${after.metrics.octaveHit.byVoice.melody.rate.toFixed(3)}`
    + ` / 贝斯 ${before.metrics.octaveHit.byVoice.bass.rate.toFixed(3)} → ${after.metrics.octaveHit.byVoice.bass.rate.toFixed(3)}）`
    + `｜综合分 ${before.score.objective.toFixed(3)} → ${after.score.objective.toFixed(3)}`
    + `｜重算力度 r=${after.metrics.velocityCorr.pearson.toFixed(3)}`,
  );
});

test('真实数据：换成 velocity_fixed.csv 的力度后，力度包络相关明显变高（指标真的能动）', (t) => {
  const VEL = path.join(BUILD, 'velocity_fixed.csv');
  if (!fs.existsSync(WAV) || !fs.existsSync(V3) || !fs.existsSync(VEL)) return t.skip('缺少输入或 velocity_fixed.csv');
  const { samples, sampleRate } = readWav(WAV);
  const csvText = fs.readFileSync(V3, 'utf8');
  const oldOne = scoreChart({ csvText, samples, sampleRate });
  const newOne = scoreChart({ csvText, samples, sampleRate, velocityCsvText: fs.readFileSync(VEL, 'utf8') });
  const rOld = oldOne.metrics.velocityCorr.pearson;
  const rNew = newOne.metrics.velocityCorr.pearson;
  assert.equal(oldOne.metrics.velocityCorr.source, 'mix-rms(volume)');
  assert.equal(newOne.metrics.velocityCorr.source, 'narrowband(velocity.csv)');
  assert.ok(rNew > rOld + 0.2, `新口径相关应明显更高：${rOld.toFixed(3)} → ${rNew.toFixed(3)}`);
});

test('真实数据：M1-3 检测器口径（默认 banded vs --detector legacy）——R 0.805 → 0.974', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(MACHINE)) return t.skip(`缺少 ${WAV} 或 ${MACHINE}`);
  const { samples, sampleRate } = readWav(WAV);
  const csvText = fs.readFileSync(MACHINE, 'utf8');
  const banded = scoreChart({ csvText, samples, sampleRate });
  const legacy = scoreChart({ csvText, samples, sampleRate, config: { onset: { detector: 'legacy' } } });
  assert.equal(banded.metrics.onsetF1.detector, 'banded');
  assert.equal(legacy.metrics.onsetF1.detector, 'legacy');
  assert.ok(Math.abs(legacy.metrics.onsetF1.recall - 0.805) < 0.01, `legacy recall=${legacy.metrics.onsetF1.recall} 应复现 M0 的 0.805`);
  assert.ok(Math.abs(legacy.metrics.onsetF1.value - 0.888) < 0.01, `legacy F1=${legacy.metrics.onsetF1.value} 应复现 M0 的 0.888`);
  assert.ok(banded.metrics.onsetF1.recall > legacy.metrics.onsetF1.recall + 0.1, '分频带应明显提高 recall');
  assert.ok(banded.metrics.onsetF1.precision >= 0.95, `precision=${banded.metrics.onsetF1.precision} 应 ≥0.95`);
  assert.ok(banded.score.objective > legacy.score.objective,
    `客观分应提高：${legacy.score.objective} → ${banded.score.objective}`);
  console.log(
    `    M1-3：legacy R ${legacy.metrics.onsetF1.recall.toFixed(3)}/F1 ${legacy.metrics.onsetF1.value.toFixed(3)}`
    + `（客观 ${legacy.score.objective.toFixed(4)}）→ banded R ${banded.metrics.onsetF1.recall.toFixed(3)}`
    + `/F1 ${banded.metrics.onsetF1.value.toFixed(3)}（客观 ${banded.score.objective.toFixed(4)}）`,
  );
});
