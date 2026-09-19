#!/usr/bin/env node
// M3-49 · 严格逐音对账 v2：**不用转谱模型，也不拿录音去和"母带"逐格比电平**。
//
// 两条否定结论（2026-09-19 实测）：
//   1) 转谱模型（note F1 0.9677）自带 ~3.2% 错误，会把真问题盖住 —— 所以"对上率 95%"这种数字不严格。
//   2) 录音 vs **母版**逐音比电平也不行：母版是离线母带（42Hz 高通 + 归一化 −18dBFS RMS + 软限幅），
//      游戏内引擎是原始采样 + 逐音增益、没有总线处理 —— 两条链路每带差 ±5dB，±6dB 判定会造出
//      1216 个假"缺音"。
//
// 所以这里的判据全部落在"**音频里有/没有这颗音、音级对不对**"上：
//   ① 起音检测：谱通量（spectral flux）+ 自适应阈值（中位+MAD），约 21ms 精度；
//   ② 音级核对：起音后 40–200ms 的 12 音级 chroma，谱面那颗音的音级必须落在**前 2 强**里
//      （同音级不同八度算通过 —— 八度归属由谱面决定，听感上也要容忍泛音错配）；
//   ③ 判定：起音+音级都对 = 通过；起音对上但音级不对 = **错音**；谱面有音但没起音 = **缺音**；
//      有起音但 ±60ms 内没有谱面音 = **多余起音（多音/杂音）**。
//
// 用法：node tools/audit-onset-vs-score.mjs --record <录音.mkv> --at <录音t=0对应的谱面秒>
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';
import { fftInPlace, hannWindow } from '../src/analyze/dsp.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();
const SR = 48000;
const REC = opt('record');
const SCORE = opt('score', path.join(P.build, 'nbmachina_machine_map.csv'));
const OUT = opt('out', path.join(P.build, 'audit'));
const AT = Number(opt('at', '0'));
const TOL = Number(opt('tol-ms', '60')) / 1000;
if (!REC) throw new Error('缺少 --record <录音>');
const NAME = path.basename(REC).replace(/\.[^.]+$/, '');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-onset-'));

const wav = path.join(TMP, 'rec.f32');
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', REC, '-af', 'pan=mono|c0=0.5*c0+0.5*c1',
  '-f', 'f32le', '-ac', '1', '-ar', String(SR), wav]);
{
  const b = fs.readFileSync(wav);
  var rec = new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
}

/* 谱面 */
const rows = fs.readFileSync(SCORE, 'utf8').trim().split(/\r?\n/);
const H = rows[0].split(',');
const cT = H.indexOf('time_sec'), cM = H.indexOf('midi');
const notes = rows.slice(1).map((l) => { const c = l.split(','); return { t: +c[cT], midi: +c[cM] }; })
  .sort((a, b) => a.t - b.t);
console.log(`谱面 ${notes.length} 颗音；录音 ${(rec.length / SR).toFixed(1)}s；对齐 AT=${AT}s`);

/* ① 起音检测 */
const N = 2048, HOP = 1024;
const win = hannWindow(N);
const mags = [];
for (let a = 0; a + N <= rec.length; a += HOP) {
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = rec[a + i] * win[i];
  fftInPlace(re, im);
  const v = new Float64Array(1000);
  for (let b = 2; b < 1000; b++) v[b] = Math.sqrt(re[b] * re[b] + im[b] * im[b]);
  mags.push(v);
}
const flux = new Float64Array(mags.length);
for (let i = 1; i < mags.length; i++) {
  let s = 0;
  for (let b = 2; b < 1000; b++) s += Math.max(0, mags[i][b] - mags[i - 1][b]);
  flux[i] = s / 998;
}
const onsets = [];
const half = 8;
for (let i = 1; i < flux.length - 1; i++) {
  const from = Math.max(0, i - half), to = Math.min(flux.length - 1, i + half);
  const w = [];
  for (let k = from; k <= to; k++) w.push(flux[k]);
  const sorted = [...w].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const dev = w.map((x) => Math.abs(x - med)).sort((a, b) => a - b);
  const mad = dev[dev.length >> 1];
  const thr = med + Math.max(3 * mad, med * 0.5);
  if (flux[i] > thr && flux[i] >= flux[i - 1] && flux[i] >= flux[i + 1]) onsets.push((i * HOP) / SR);
}
console.log(`检出起音 ${onsets.length} 个`);

/* ② 音级 chroma */
function chromaAt(tSec) {
  const a = Math.round((tSec + 0.04) * SR);
  if (a < 0 || a + N > rec.length) return null;
  const re = new Float64Array(N), im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = rec[a + i] * win[i];
  fftInPlace(re, im);
  const c = new Float64Array(12);
  for (let b = 3; b < 900; b++) {
    const f = (b * SR) / N;
    if (f < 80 || f > 5000) continue;
    const midiF = 69 + 12 * Math.log2(f / 440);
    const pc = ((Math.round(midiF) % 12) + 12) % 12;
    c[pc] += re[b] * re[b] + im[b] * im[b];
  }
  return c;
}
const pcOf = (m) => ((m % 12) + 12) % 12;

/* ③ 逐音判定 */
const ok = [], wrong = [], missing = [];
const used = new Set();
for (const n of notes) {
  const target = n.t + AT;
  let bi = -1, bd = Infinity;
  for (let i = 0; i < onsets.length; i++) {
    const d = Math.abs(onsets[i] - target);
    if (d <= TOL && d < bd) { bd = d; bi = i; }
  }
  if (bi < 0) { missing.push({ t: n.t, midi: n.midi }); continue; }
  used.add(bi);
  const c = chromaAt(onsets[bi]);
  const want = pcOf(n.midi);
  const rank = [...c.keys()].sort((x, y) => c[y] - c[x]);
  if (rank.slice(0, 2).includes(want)) ok.push({ t: n.t, midi: n.midi, dtMs: onsets[bi] - target });
  else wrong.push({ t: n.t, midi: n.midi, gotPc: rank[0], wantPc: want, dtMs: onsets[bi] - target });
}
const extra = onsets.map((t, i) => ({ t, i })).filter(({ i }) => !used.has(i))
  .filter(({ t }) => !notes.some((n) => Math.abs(n.t + AT - t) <= TOL))
  .map(({ t }) => ({ recT: t, scoreT: t - AT }));

const dt = ok.map((x) => x.dtMs * 1000).sort((a, b) => a - b);
console.log(`\n=== 逐音对账（起音 ±${(TOL * 1000).toFixed(0)}ms + 音级必须在前 2 强）===`);
console.log(`✔ 通过 ${ok.length} / ${notes.length}（${(100 * ok.length / notes.length).toFixed(2)}%）`);
console.log(`✘ 错音 ${wrong.length} / 缺音 ${missing.length} / 多余起音 ${extra.length}`);
if (dt.length) console.log(`节奏：中位 ${dt[dt.length >> 1].toFixed(1)}ms / p90 ${dt[Math.floor(dt.length * 0.9)].toFixed(1)}ms / 最大 ${dt[dt.length - 1].toFixed(1)}ms`);
const show = (a, f, n = 12) => a.slice(0, n).map(f).join('\n  ');
if (wrong.length) console.log('错音（谱面秒 | 应有音级→实测最强 | ms）：\n  ' + show(wrong, (x) => `${x.t.toFixed(2)}s | ${x.wantPc}→${x.gotPc} | ${(x.dtMs * 1000).toFixed(0)}ms`));
if (missing.length) console.log('缺音（谱面秒 | midi）：\n  ' + show(missing, (x) => `${x.t.toFixed(2)}s | ${x.midi}`));
if (extra.length) console.log('多余起音（谱面秒 | 录音秒）：\n  ' + show(extra, (x) => `${x.scoreT.toFixed(2)}s | ${x.recT.toFixed(2)}s`));

const report = { record: REC, score: SCORE, offsetSec: AT, toleranceMs: TOL * 1000,
  notes: notes.length, onsets: onsets.length, ok: ok.length, wrong, missing, extra };
fs.writeFileSync(path.join(OUT, `${NAME}_onset_audit.json`), JSON.stringify(report, null, 1), 'utf8');
console.log(`\n报告 → ${path.join(OUT, `${NAME}_onset_audit.json`).replace(/\\/g, '/')}`);
fs.rmSync(TMP, { recursive: true, force: true });
