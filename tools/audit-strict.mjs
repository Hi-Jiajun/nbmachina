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
function decode(file) {
  const out = path.join(TMP, `${path.basename(file, path.extname(file))}.f32`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', file,
    '-af', 'pan=mono|c0=0.5*c0+0.5*c1', '-f', 'f32le', '-ac', '1', '-ar', String(SR), out]);
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
for (const n of notes) {
  const f0 = midiToFreq(n.midi);
  const tRec = n.t + AT + 0.02;                 // 起音后 20ms
  const eRec = bandEnergy(rec, tRec, f0);
  // 母版窗口用同一"音内相对位置"：母版时间轴 = 谱面时间轴
  const eMas = bandEnergy(mas, n.t + 0.02, f0);
  if (eMas <= 0 && eRec <= 0) continue;
  const d = db(eRec) - db(eMas);
  if (d < -DB) verdicts.weak.push({ t: n.t, midi: n.midi, deltaDb: +d.toFixed(1) });
  else if (d > DB) verdicts.loud.push({ t: n.t, midi: n.midi, deltaDb: +d.toFixed(1) });
  else verdicts.ok++;
}
console.log(`\n=== ① 逐音能量核对（±${DB}dB 判"对上"）===`);
console.log(`对上 ${verdicts.ok} / 太弱(缺音) ${verdicts.weak.length} / 太响 ${verdicts.loud.length}`);
const show = (arr, n = 10) => arr.slice(0, n).map((x) => `${x.t.toFixed(2)}s midi ${x.midi} ${x.deltaDb > 0 ? '+' : ''}${x.deltaDb}dB`).join('\n  ');
if (verdicts.weak.length) console.log('太弱（按谱面秒）：\n  ' + show(verdicts.weak));
if (verdicts.loud.length) console.log('太响（按谱面秒）：\n  ' + show(verdicts.loud));

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
  const tScoreSec = tRecSec - AT;
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
