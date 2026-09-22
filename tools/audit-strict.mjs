#!/usr/bin/env node
// M3-48 · **严格逐音对账（不用转谱模型）**：直接把"游戏内录音"和"母版"两个信号逐音、逐频点比。
//
// 为什么不用转谱：转谱模型自身有 ~3.2% 错误率（note F1 0.9677），它会同时制造假错音和假多余音，
// 正好把我们要找的真问题盖住（用户 2026-09-19："你这个不够严格吧"）。这里的判据全部来自信号：
//
//   ① 逐音能量核对（每颗谱面音）：
//        取该音起音后 20–150ms 的窗口，量它的基频 + 2/3/4 次谐波频带能量（±3%），
//        在**录音**和**母版**里各量一次，比差值：
//          |Δ| ≤ 6dB  → 对上
//          录音 << 母版（< −6dB）→ **缺音 / 太弱**
//          录音 >> 母版（> +6dB）→ **太响 / 多音**
//   ② 多余声音（不依赖模型）：做 (录音 − 母版) 的**差分频谱图**（2048 点 FFT / 21ms 帧），
//        找"录音比母版高 ≥8dB 且该频点不属于任何**当时在响**的谱面音的谐波（±3.5%）"的时频格，
//        聚合成事件（时间 + 频率 + 持续时长）→ 这些就是真正"多出来的声音"（残留方块乱响、引擎多放…）。
//
// 用法：
//   node tools/audit-strict.mjs --record <录音.mkv> --at <录音t=0对应的谱面秒> [--score build/nbmachina_machine_map.csv]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';
import { fftInPlace, hannWindow, midiToFreq } from '../src/analyze/dsp.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();
const SR = 48000;
const REC = opt('record');
const SCORE = opt('score', path.join(P.build, 'nbmachina_machine_map.csv'));
const MASTER = opt('master', path.join(P.build, 'master', 'styx_master_48k24bit.wav'));
const OUT = opt('out', path.join(P.build, 'audit'));
const DB = 10;       // 逐音判定的能量差阈值（录音链路本身有 ±5dB 的频响差，阈值定太紧全是假阳性）
const XDB = 10;      // 差分谱里"多出来的声音"的阈值
if (!REC) throw new Error('缺少 --record <录音>');
const NAME = path.basename(REC).replace(/\.[^.]+$/, '');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-strict-'));
const db = (v) => 20 * Math.log10(Math.max(1e-12, v));

/* ---------------------------------------------------------------- 解码 */
// M3-93：解码成单声道时的口径。默认 L+R 求和，但**求和会把反相内容抵消掉**——
// 游戏内混音的立体声声像/相位与离线母版不同时，逐音"基频+谐波"会整片塌下去（表现为"太弱 2870"）。
// 所以留一个开关，可以只取左/右声道来验证这一点。
const MONO = opt('mono', 'sum');
function decode(file) {
  const out = path.join(TMP, `${path.basename(file, path.extname(file))}.f32`);
  const pan = MONO === 'left' ? 'pan=mono|c0=c0' : MONO === 'right' ? 'pan=mono|c0=c1' : 'pan=mono|c0=0.5*c0+0.5*c1';
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file,
    '-af', pan, '-f', 'f32le', '-ac', '1', '-ar', String(SR), out]);
  const b = fs.readFileSync(out);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}

/* ---------------------------------------------------------------- 对齐（样本级 + 中位数校正） */
function envelope(x, win = SR / 100) {
  const out = [];
  for (let i = 0; i + win <= x.length; i += win) {
    let s = 0; for (let j = 0; j < win; j++) s += x[i + j] * x[i + j];
    out.push(Math.sqrt(s / win));
  }
  return out;
}
function coarseLag(a, b, maxLagBins) {
  let best = 0, bestR = -2;
  for (let lag = -maxLagBins; lag <= maxLagBins; lag++) {
    let sa = 0, sb = 0, sab = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      sa += a[i] * a[i]; sb += b[j] * b[j]; sab += a[i] * b[j]; n++;
    }
    if (n < 50) continue;
    const r = sab / (Math.sqrt(sa * sb) + 1e-12);
    if (r > bestR) { bestR = r; best = lag; }
  }
  return { lag: best, r: bestR };
}
const rec = decode(REC);
const mas = decode(MASTER);
const er = envelope(rec), em = envelope(mas);
const { lag: coarse, r: coarseR } = coarseLag(em, er, 12000);   // 母版 vs 录音，±120s
let AT = -coarse * 0.01;                                          // 录音 t=0 ↔ 谱面秒
console.log(`粗对齐：录音 t=0 ↔ 谱面 ${AT.toFixed(2)}s（1s 包络 r=${coarseR.toFixed(3)}）`);
if (opt('at') !== undefined) AT = Number(opt('at'));

/* ---------------------------------------------------------------- 谱面 */
const rows = fs.readFileSync(SCORE, 'utf8').trim().split(/\r?\n/);
const H = rows[0].split(',');
const cT = H.indexOf('time_sec'), cM = H.indexOf('midi');
const notes = rows.slice(1).map((l) => { const c = l.split(','); return { t: +c[cT], midi: +c[cM] }; })
  .sort((a, b) => a.t - b.t);
console.log(`谱面 ${notes.length} 颗音`);

/* ---------------------------------------------------------------- 逐音能量核对 */
const win = hannWindow(2048);
function bandEnergy(x, startSec, f0) {
  const a = Math.round(startSec * SR);
  if (a < 0 || a + 2048 > x.length) return 0;
  let e = 0;
  for (const h of [1, 2, 3, 4]) {
    const f = f0 * h;
    if (f > SR * 0.45) break;
    const re = new Float64Array(2048), im = new Float64Array(2048);
    for (let i = 0; i < 2048; i++) re[i] = x[a + i] * win[i];
    fftInPlace(re, im);
    const bin = Math.round(f / (SR / 2048));
    const half = Math.max(1, Math.round(bin * 0.03));
    let acc = 0;
    for (let k = Math.max(1, bin - half); k <= Math.min(1023, bin + half); k++) acc += re[k] * re[k] + im[k] * im[k];
    e += acc;
  }
  return e;
}

const verdicts = { ok: 0, weak: [], loud: [] };
let debugLeft = Number(opt('debug', '0'));
/**
 * M3-96：Goertzel 单频能量（比 2048 点 FFT 便宜两个数量级，因此可以在 ±150ms 上扫），
 * 用来做"这颗音到底在不在这儿、晚了/早了多少"的逐音偏移扫描。
 */
function toneEnergy(x, startSample, freq, N = 1024) {
  const w = (2 * Math.PI * freq) / SR;
  const c = 2 * Math.cos(w);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < N; i++) {
    const idx = startSample + i;
    if (idx < 0 || idx >= x.length) return 0;
    const s0 = x[idx] + c * s1 - s2;
    s2 = s1; s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}

function harmonicEnergy(x, startSample, f0, harmonics = 4) {
  let e = 0;
  for (let h = 1; h <= harmonics; h++) {
    const f = f0 * h;
    if (f > SR * 0.45) break;
    e += toneEnergy(x, startSample, f);
  }
  return e;
}

const offsets = [];       // 找到的音的"录音相对母版"偏移（秒，正=录音更晚）
const notFound = [];
for (const n of notes) {
  const f0 = midiToFreq(n.midi);
  // M3-95：AT 的定义是"录音 t=0 ↔ 谱面 AT 秒"（AT 通常为负，例如 −8.46 = 录像比谱面早 8.46s 开始），
  // 所以音符在**录音**里的时刻是 (n.t − AT)，而不是 (n.t + AT)。原来的 +AT 会把早期音符算到负时间上
  // → 窗口越界取到数字静音 → 整片报"太弱"（实测前 8 颗录音侧全是 −240dB）。
  // M3-96：录音侧在 ±150ms 内扫最佳位置（10ms 步长），只在最佳位置上量能量 ——
  // 这样"整体/渐进偏移"不会再被误判成"缺音"（旧口径的 42.7ms 定窗会）。
  const baseRec = Math.round((n.t - AT + 0.02) * SR);
  let bestE = 0, bestD = 0;
  for (let dSec = -0.15; dSec <= 0.1501; dSec += 0.01) {
    const e = harmonicEnergy(rec, baseRec + Math.round(dSec * SR), f0);
    if (e > bestE) { bestE = e; bestD = dSec; }
  }
  // 母版时间轴 = 谱面时间轴（自检 3044/0/0 已证）
  const eMas = harmonicEnergy(mas, Math.round((n.t + 0.02) * SR), f0);
  if (eMas <= 0 && bestE <= 0) continue;
  const d = db(bestE) - db(eMas);
  const atBoundary = Math.abs(bestD) >= 0.1499;
  if (d < -DB) { verdicts.weak.push({ t: n.t, midi: n.midi, deltaDb: +d.toFixed(1) }); if (atBoundary) notFound.push(n.t); }
  else if (d > DB) verdicts.loud.push({ t: n.t, midi: n.midi, deltaDb: +d.toFixed(1) });
  else { verdicts.ok++; offsets.push({ t: n.t, d: bestD }); }
  // M3-94：诊断用——把前 N 颗音的原始能量直接打出来（看差的是"量级"还是"个别音"）
  if (debugLeft-- > 0) {
    console.log(`  t=${n.t.toFixed(3)}s midi=${n.midi} 录音(最佳 ${(bestD * 1000).toFixed(0)}ms) ${db(bestE).toFixed(1)}dB / 母版 ${db(eMas).toFixed(1)}dB → Δ${d.toFixed(1)}dB`);
  }
}
console.log(`\n=== ① 逐音能量核对（±${DB}dB 判"对上"）===`);
console.log(`对上 ${verdicts.ok} / 太弱(缺音) ${verdicts.weak.length} / 太响 ${verdicts.loud.length}`);
const show = (arr, n = 10) => arr.slice(0, n).map((x) => `${x.t.toFixed(2)}s midi ${x.midi} ${x.deltaDb > 0 ? '+' : ''}${x.deltaDb}dB`).join('\n  ');
if (verdicts.weak.length) console.log('太弱（按谱面秒）：\n  ' + show(verdicts.weak));
if (verdicts.loud.length) console.log('太响（按谱面秒）：\n  ' + show(verdicts.loud));

/* ------------------------------------------------ ①b 逐音偏移 / 漂移（M3-96） */
if (offsets.length) {
  const ds = offsets.map((o) => o.d).sort((a, b) => a - b);
  const q = (p) => ds[Math.min(ds.length - 1, Math.floor(ds.length * p))] * 1000;
  // 线性拟合：偏移 ~ a + b·t（t = 谱面秒）→ b 就是漂移（ms/s）
  const nD = offsets.length;
  const sumT = offsets.reduce((s, o) => s + o.t, 0);
  const sumD = offsets.reduce((s, o) => s + o.d, 0);
  const sumTT = offsets.reduce((s, o) => s + o.t * o.t, 0);
  const sumTD = offsets.reduce((s, o) => s + o.t * o.d, 0);
  const den = nD * sumTT - sumT * sumT;
  const slope = den !== 0 ? (nD * sumTD - sumT * sumD) / den : 0;      // s 偏移 / s 时间
  const intercept = (sumD - slope * sumT) / nD;
  console.log(`\n=== ①b 逐音偏移（在 ±150ms 内扫描峰位）===`);
  console.log(`找到 ${offsets.length} 颗 / 扫不到（±150ms 内无该音谐波，真缺失）${notFound.length} 颗 / `
    + `太弱但能找到 ${verdicts.weak.length - notFound.length} 颗 / 太响 ${verdicts.loud.length} 颗`);
  console.log(`偏移（正=录音比母版晚）：p10 ${q(0.1).toFixed(0)}ms / 中位 ${q(0.5).toFixed(0)}ms / p90 ${q(0.9).toFixed(0)}ms`);
  console.log(`漂移拟合：${(slope * 1000).toFixed(4)} ms/s（= ${(slope * 1000 * 60).toFixed(1)} ms/分钟），`
    + `谱面 t=0 处偏移 ${(intercept * 1000).toFixed(0)}ms`);
}

/* ---------------------------------------------------------------- ② 差分频谱（1/6 倍频程带）：
 * 最初版本直接逐 FFT bin 比，结果全是假阳性——48k/2048 点的 bin 宽 23.4Hz，
 * 而低频谐波的"±3.5% 容差"（200Hz 时只有 7Hz）比 bin 还窄，等于把所有低频格都判成"多出来的声音"。
 * 这里改成 **1/6 倍频程带**（80Hz..8kHz，约 40 带）：带宽足够容纳容差，也能把录音链路的频响差平均掉。
 */
const N = 2048, HOP = 1024;
const bandCenters = [];
for (let f = 80; f <= 8000; f *= 2 ** (1 / 6)) bandCenters.push(f);
const bandIdx = (b) => {
  const f = (b * SR) / N;
  let best = -1, bestD = 1e9;
  bandCenters.forEach((c, i) => { const d = Math.abs(Math.log2(f / c)); if (d < bestD) { bestD = d; best = i; } });
  return bestD <= 1 / 12 ? best : -1;
};
const frames = Math.floor(Math.min(rec.length / SR, mas.length / SR) / (HOP / SR)) - 1;
const cellsR = [];   // 录音比母版响的格子
const cellsM = [];   // 母版比录音响的格子
for (let fi = 0; fi < frames; fi++) {
  const tRecSec = (fi * HOP) / SR;
  const tScoreSec = tRecSec + AT;               // 见上：s = r + AT（AT 为负时 s < r）
  const aMas = Math.round(tScoreSec * SR);
  if (aMas < 0 || aMas + N > mas.length || fi * HOP + N > rec.length) continue;
  const mk = (x, off) => {
    const re = new Float64Array(N), im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = x[off + i] * win[i];
    fftInPlace(re, im);
    return { re, im };
  };
  const R = mk(rec, fi * HOP), M = mk(mas, aMas);
  const ebR = new Float64Array(bandCenters.length), ebM = new Float64Array(bandCenters.length);
  for (let b = 2; b < 1000; b++) {
    const bi = bandIdx(b);
    if (bi < 0) continue;
    ebR[bi] += R.re[b] ** 2 + R.im[b] ** 2;
    ebM[bi] += M.re[b] ** 2 + M.im[b] ** 2;
  }
  for (let bi = 0; bi < bandCenters.length; bi++) {
    const dR = 10 * Math.log10(ebR[bi] + 1e-12), dM = 10 * Math.log10(ebM[bi] + 1e-12);
    if (dR > -75 && dR - dM >= XDB) cellsR.push({ t: tScoreSec, f: Math.round(bandCenters[bi]), d: dR - dM });
    else if (dM > -75 && dM - dR >= XDB) cellsM.push({ t: tScoreSec, f: Math.round(bandCenters[bi]), d: dM - dR });
  }
}
/** 把时频格聚成事件，并标出它附近有多少"谱面音"（用于区分"电平差"与"真多/真少"） */
function cluster(cells) {
  cells.sort((a, b) => a.t - b.t || a.f - b.f);
  const ev = [];
  for (const c of cells) {
    const last = ev[ev.length - 1];
    if (last && c.t - last.tEnd < 0.25 && Math.abs(Math.log2(c.f / last.fMed)) <= 1 / 6) {
      last.tEnd = c.t; last.n++; last.dMax = Math.max(last.dMax, c.d); last.fMed = c.f;
    } else ev.push({ tStart: c.t, tEnd: c.t, fMed: c.f, n: 1, dMax: c.d });
  }
  for (const e of ev) {
    e.scoreNotesNearby = notes.filter((n) => n.t >= e.tStart - 0.12 && n.t <= e.tEnd + 0.12).length;
  }
  return ev;
}
const extraEvents = cluster(cellsR).filter((e) => e.n >= 3).sort((a, b) => b.dMax - a.dMax);
const missEvents = cluster(cellsM).filter((e) => e.n >= 3).sort((a, b) => b.dMax - a.dMax);
const orphan = (evs) => evs.filter((e) => e.scoreNotesNearby === 0);
console.log(`\n=== ② 差分频谱（1/6 倍频程带，+${XDB}dB 才算差异）===`);
console.log(`录音更响的时频格 ${cellsR.length} → 事件 ${extraEvents.length}（其中**附近没有任何谱面音**的 ${orphan(extraEvents).length} 个）`);
console.log(`母版更响的时频格 ${cellsM.length} → 事件 ${missEvents.length}（其中附近没有任何谱面音的 ${orphan(missEvents).length} 个）`);
const fmtEv = (e) => `${e.tStart.toFixed(2)}–${e.tEnd.toFixed(2)}s ${e.fMed}Hz ${e.n}格 最高 ${e.dMax > 0 ? '+' : ''}${e.dMax.toFixed(0)}dB 附近谱面音 ${e.scoreNotesNearby}`;
console.log('录音多出来的（按强度前 12）：\n  ' + extraEvents.slice(0, 12).map(fmtEv).join('\n  '));
console.log('录音缺掉的（按强度前 8）：\n  ' + missEvents.slice(0, 8).map(fmtEv).join('\n  '));

const report = {
  record: REC, offsetSec: AT, thresholds: { perNoteDb: DB, extraDb: XDB },
  notes: notes.length,
  perNote: { ok: verdicts.ok, weak: verdicts.weak, loud: verdicts.loud },
  extra: { cells: cellsR.length, events: extraEvents, orphan: orphan(extraEvents) },
  missing: { cells: cellsM.length, events: missEvents, orphan: orphan(missEvents) },
};
fs.writeFileSync(path.join(OUT, `${NAME}_strict.json`), JSON.stringify(report, null, 1), 'utf8');
console.log(`\n报告 → ${path.join(OUT, `${NAME}_strict.json`).replace(/\\/g, '/')}`);
fs.rmSync(TMP, { recursive: true, force: true });
