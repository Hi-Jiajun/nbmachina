// T5c · 力度对齐"重音"：acc = level（该音自己的响度）+ k·z(该音带 ±r 的起音谱通量)
//
// 要打掉的现状（M0-3 §3.2 / BASELINE §3.2）：`volume`/`velocity` 量的是"这音有多响"，
// 与音频**起音强度**的相关只有 r≈0（banded 口径）到 −0.53（M0 legacy 口径）——
// 用户抱怨的"没有强弱之分"就是这个。
//
// 本口径的两个分量（都从同一段音频、同一颗音的起音时刻量）：
//   ① level：该音"音级 + 八度"上的 100/120ms 窄带能量（= T5b 旧口径，p10/p90 → 0..1）
//   ② attack：该音所在频带 ±r 的**归一化对数谱通量**（6 带检测器的同一套带，取该音起音那一帧）
//
// 为什么必须两项都有（实测，见 docs/M1-5-report.md §2）：只用 ② 时"同一步内"的音会几乎相同、
// 且与旧力度相关性掉到 0.36（④ 口径崩）；只用 ① 时与起音强度无关（0.11）。权重 k 把两者
// 在"④ ≥0.85 / vsOnsetStrength >0.5"两条验收之间定位。
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_ACCENT_CONFIG,
  accentConfig,
  accentCsv,
  accentCsvText,
  measureAccent,
  measureVelocity,
  readNotesCsv,
  readWav,
} from '../src/arrange/velocity.mjs';
import { encodeWav, midiToFreq } from '../src/analyze/chroma.mjs';
import { bandEnvelope, bandFluxes } from '../src/analyze/onset-detect.mjs';

const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');
const MACHINE = path.join(BUILD, 'styx_helix_machine.csv');
const SR = 44100;

function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s / 4294967296) * 2 - 1;
  };
}

/** 合成单声道音频（默认"拨弦"包络：10ms 起振 + 指数衰减，攻击强度由 gain 决定） */
function synth({ seconds, events, noise = 0, seed = 7 }) {
  const n = Math.round(seconds * SR);
  const out = new Float64Array(n);
  for (const e of events) {
    const f0 = midiToFreq(e.midi, 440);
    const start = Math.round((e.atSec ?? 0) * SR);
    const dur = Math.round((e.durSec ?? 0.4) * SR);
    const harm = e.harmonics ?? [1, 0.5, 0.25];
    for (let i = 0; i < dur; i++) {
      const idx = start + i;
      if (idx >= n) break;
      const t = i / SR;
      const env = e.sustain === true ? 1 : Math.min(1, i / (0.01 * SR)) * Math.exp(-t / 0.35);
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

/** 测试内的独立 Pearson（不与生产代码共用实现） */
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

test('accent：同一颗音的力度随起音强度严格单调（强起音 > 弱起音）', () => {
  const gains = [1, 0.75, 0.55, 0.4, 0.25, 0.12];
  const gap = 1.2;   // 间隔要远大于衰减时间常数（0.35s）：否则"通量"量的是相对上一帧的跳升，会被前音尾巴干扰
  const events = gains.map((gain, i) => ({ midi: 69, gain, atSec: i * gap, durSec: 0.5 }));
  const samples = synth({ seconds: gains.length * gap + 0.2, events });
  const notes = gains.map((_, i) => note({ noteId: i, step: i * 5, timeSec: i * gap, midi: 69 }));
  const { results } = measureAccent({ samples, sampleRate: SR, notes });
  const vs = results.map((r) => r.velocity);
  assert.deepEqual(results.map((r) => r.reason), gains.map(() => 'measured'));
  for (let i = 1; i < vs.length; i++) {
    assert.ok(vs[i] < vs[i - 1],
      `力度未随起音强度单调下降：gain ${gains[i - 1]}→${vs[i - 1]}，gain ${gains[i]}→${vs[i]}`);
  }
  assert.ok(vs[0] - vs[vs.length - 1] > 0.3, `最强与最弱应拉开 >0.3，实测 ${(vs[0] - vs[vs.length - 1]).toFixed(3)}`);
  // 攻击项本身也必须随 gain 单调（否则是 level 项一肩挑，口径没换）
  const atk = results.map((r) => r.attack);
  for (let i = 1; i < atk.length; i++) assert.ok(atk[i] < atk[i - 1], `攻击强度未单调：${atk[i - 1]} → ${atk[i]}`);
  console.log(`    合成 6 档 gain：accent ${vs.map((v) => v.toFixed(3)).join(' ')}｜attack ${atk.map((a) => a.toFixed(4)).join(' ')}`);
});

test('accent：静音 = 0（weak），不当地板；值域 0.35..1.0，端点都用满', () => {
  const silent = measureAccent({ samples: new Float64Array(SR), sampleRate: SR, notes: [note({ midi: 60 })] });
  assert.equal(silent.results[0].velocity, 0);
  assert.equal(silent.results[0].reason, 'weak');
  assert.equal(silent.results[0].attack, 0);

  const gains = [1, 0.5, 0.25, 0.1];
  const gap = 1.2;
  const samples = synth({ seconds: gains.length * gap, events: gains.map((gain, i) => ({ midi: 69, gain, atSec: i * gap })) });
  const notes = gains.map((_, i) => note({ noteId: i, step: i * 5, timeSec: i * gap, midi: 69 }));
  const { results, meta } = measureAccent({ samples, sampleRate: SR, notes });
  assert.ok(results.every((r) => r.velocity >= 0.35 && r.velocity <= 1));
  assert.ok(Math.abs(Math.max(...results.map((r) => r.velocity)) - 1) < 1e-9, '最强音应到天花板');
  assert.ok(Math.abs(Math.min(...results.map((r) => r.velocity)) - 0.35) < 1e-9, '最弱音应到地板');
  assert.equal(meta.notes, gains.length);
  assert.equal(meta.reasons.measured, gains.length);
  assert.ok(meta.attack.bandsUsed.length >= 1);
  assert.equal(meta.attack.radiusBands, DEFAULT_ACCENT_CONFIG.attackRadiusBands);
});

test('accent：同一步上不同音高不再"全相同"（level 项按音高分开）+ 攻击项按带分开', () => {
  // 同一时刻两个音高：C4（响）与 G4（轻）；两者落在同一个检测器带（b3 260–540Hz）
  const samples = synth({
    seconds: 0.6,
    events: [{ midi: 60, gain: 0.9, harmonics: [1] }, { midi: 67, gain: 0.3, harmonics: [1] }],
    noise: 0.001,
  });
  const notes = [note({ noteId: 0, step: 0, midi: 60 }), note({ noteId: 1, step: 0, midi: 67 })];
  const { results } = measureAccent({ samples, sampleRate: SR, notes });
  assert.ok(Math.abs(results[0].velocity - results[1].velocity) > 0.05,
    `同一步内应因音高/能量不同而力度不同：${results[0].velocity} vs ${results[1].velocity}`);
  assert.ok(results[0].velocity > results[1].velocity, '响的那颗应更高');
  // 同一带内的两颗攻击项相同（口径诚实：攻击项只认"带"），差别来自 level 项
  assert.equal(results[0].bandIndex, results[1].bandIndex);
  assert.equal(results[0].attack, results[1].attack);
  assert.ok(results[0].level > results[1].level + 0.2, `level 项应拉开：${results[0].level} vs ${results[1].level}`);
});

test('accent：CSV 契约——原列逐字符保留、只追加三列、口径与旧口径不同', () => {
  const gains = [1, 0.7, 0.45, 0.25, 0.12];
  const gap = 1.2;
  const csv = [
    'step,tick,time_seconds,instrument,midi,row,volume',
    ...gains.map((_, i) => `${i * 10},${i * 120},${(i * gap).toFixed(3)},harp,69,12,0.${500 + i}`),
    '',
  ].join('\n');
  const samples = synth({
    seconds: gains.length * gap,
    events: gains.map((gain, i) => ({ midi: 69, gain, atSec: i * gap })),
  });
  const { header, notes } = readNotesCsv(csv);
  const { csv: out, results } = accentCsvText({ csvText: csv, samples, sampleRate: SR });
  const lines = out.trim().split('\n');
  assert.equal(lines[0], 'step,tick,time_seconds,instrument,midi,row,volume,velocity,velocityRaw,velocityReason');
  assert.ok(lines[1].startsWith('0,0,0.000,harp,69,12,0.500,'), lines[1]);
  assert.ok(lines[2].startsWith('10,120,1.200,harp,69,12,0.501,'), lines[2]);
  assert.equal(lines.length - 1, gains.length);
  assert.equal(lines[1].split(',').length, 10);
  const vel = results.map((r) => r.velocity);
  for (let i = 1; i < vel.length; i++) assert.ok(vel[i] < vel[i - 1], `力度应单调下降：${vel.join(' ')}`);
  // 与旧口径（只认窄带能量）不是同一组数：旧的只按能量排序，本口径还要看攻击
  const old = measureVelocity({ samples, sampleRate: SR, notes }).results.map((r) => r.velocity);
  assert.ok(vel.some((v, i) => Math.abs(v - old[i]) > 1e-6), `accent 与旧口径应有区别：${vel.join(' ')} vs ${old.join(' ')}`);
  // 逐字符保留 + 只追加三列
  const out2 = accentCsv({ header, notes, results });
  assert.equal(out, out2);
});

test('accent：attackRadiusBands 配置生效（半径越大，攻击项与"宽带起音"越接近）', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(MACHINE)) return t.skip('缺少真实数据');
  const { samples, sampleRate } = readWav(WAV);
  const { notes } = readNotesCsv(fs.readFileSync(MACHINE, 'utf8'));
  const bands = bandFluxes({ samples, sampleRate });
  const env = bandEnvelope({ bands, hopSec: 0.01 });
  const F = notes.map((n) => env.flux[Math.min(env.frames - 1, Math.max(0, Math.round(n.timeSec / env.hopSec)))] ?? 0);
  const r = (rad) => pearson(
    measureAccent({ samples, sampleRate, notes, config: { attackRadiusBands: rad } }).results.map((x) => x.attack),
    F,
  );
  const r1 = r(1);
  const r2 = r(2);
  assert.ok(r1 < r2, `半径 1 的攻击项应比半径 2 更"局部"（与宽带起音相关更低）：${r1.toFixed(3)} vs ${r2.toFixed(3)}`);
  assert.ok(r2 > 0.8, `半径 2 应接近宽带起音：${r2.toFixed(3)}`);
  assert.deepEqual(
    [accentConfig({}).attackRadiusBands, accentConfig({}).attackWeight, DEFAULT_ACCENT_CONFIG.attackRadiusBands],
    [2, 0.225, 2],
  );
});

test('真实数据：vsOnsetStrength > 0.5（现在是 0.11）且 ④ 口径 ≥ 0.85（客观分 ≥0.9417）', (t) => {
  if (!fs.existsSync(WAV) || !fs.existsSync(MACHINE)) return t.skip('缺少真实数据');
  const { samples, sampleRate } = readWav(WAV);
  const { header, notes } = readNotesCsv(fs.readFileSync(MACHINE, 'utf8'));
  assert.ok(header.includes('volume'));
  const { results, meta } = measureAccent({ samples, sampleRate, notes });
  const vel = results.map((r) => r.velocity);

  // ④ 口径（score.mjs 的 desc01）：同一音同一八度的 100/120ms 窄带能量，p10/p90 截断
  const level = measureVelocity({ samples, sampleRate, notes });
  const D = level.results.map((r) => (r.reason === 'weak' ? null : (r.velocity - 0.35) / 0.65));
  const kept = notes.map((_, i) => i).filter((i) => D[i] !== null);

  // 起音强度（score.mjs 的诊断）：banded 6 带包络在该音起音帧的归一化通量
  const env = bandEnvelope({ bands: bandFluxes({ samples, sampleRate }), hopSec: 0.01 });
  const F = notes.map((n) => env.flux[Math.min(env.frames - 1, Math.max(0, Math.round(n.timeSec / env.hopSec)))] ?? 0);

  const rOnset = pearson(kept.map((i) => vel[i]), kept.map((i) => F[i]));
  const rLevel = pearson(kept.map((i) => vel[i]), kept.map((i) => D[i]));
  const objective = 0.965 * 0.25 + 0.972 * 0.25 + 0.936 * 0.2 + rLevel * 0.15 + 0.985 * 0.15;
  console.log(`    真实数据 ${notes.length} 颗音：vsOnsetStrength=${rOnset.toFixed(3)}｜④=${rLevel.toFixed(3)}｜客观≈${objective.toFixed(4)}`);
  console.log(`    合成权重 k=${meta.attack.weight}｜带半径 ${meta.attack.radiusBands}（${meta.attack.bandsUsed.join('+')}）`
    + `｜attack p10/p90=${meta.attack.p10.toFixed(4)}/${meta.attack.p90.toFixed(4)}`
    + `｜末段映射 p${meta.map.lowPercentile * 100}–p${meta.map.highPercentile * 100} → ${meta.map.floor}..${meta.map.ceiling}`);

  assert.ok(rOnset > 0.5, `vsOnsetStrength 应 >0.5，实测 ${rOnset.toFixed(3)}`);
  assert.ok(rLevel >= 0.85, `④ 口径应 ≥0.85（客观分 ≥0.9417），实测 ${rLevel.toFixed(3)}`);

  // 前沿的两个端点（用同一次测量的逐音数据算，不需要再跑一遍）：
  //   只要 level（= 旧口径）：④ 几乎满分，但与起音强度无关
  //   只要 attack：与起音强度高，但与"这音自己的能量"脱钩（④ 崩）→ 两者不可兼得
  const lvl = results.map((r) => r.level);
  const atk = results.map((r) => r.attack);
  const rLvlFlux = pearson(kept.map((i) => lvl[i]), kept.map((i) => F[i]));
  const rAtkLevel = pearson(kept.map((i) => atk[i]), kept.map((i) => D[i]));
  const rAtkFlux = pearson(kept.map((i) => atk[i]), kept.map((i) => F[i]));
  console.log(`    端点：只要 level → ④≈1、vsOnsetStrength=${rLvlFlux.toFixed(3)}；`
    + `只要 attack → ④=${rAtkLevel.toFixed(3)}、vsOnsetStrength=${rAtkFlux.toFixed(3)}`);
  assert.ok(rLvlFlux < 0.35, `level 自己与起音强度应几乎无关，实测 ${rLvlFlux.toFixed(3)}`);
  assert.ok(rAtkFlux > 0.55, `attack 自己应与起音强度强相关，实测 ${rAtkFlux.toFixed(3)}`);
  assert.ok(rAtkLevel < 0.45, `attack 自己与"该音自己的能量"应弱相关（否则 ④ 白掉），实测 ${rAtkLevel.toFixed(3)}`);
});
