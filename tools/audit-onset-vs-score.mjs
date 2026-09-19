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

/* ②b 逐音"音频证据"检查（不依赖起音检测，也不依赖模型）
 * 起音检测在密集段落会漏（只检出 1574 个 vs 谱面 1768 个音组），于是"缺音"里混着大量
 * "检测器没抓到"。这里补一个**针对谱面每颗音**的证据检查：
 *   取该音自己的谐波梳（f0 的 1~4 次，±3%），比"起音后 20–170ms"与"起音前 150–10ms"的能量。
 *   有起音（after > before×1.5）或明显高于本地底噪（after > local×1.5）→ 判定"音频里有这颗音"。
 */
function combEnergy(x, tStart, tEnd, f0) {
  const a = Math.round(tStart * SR), len = Math.max(512, Math.min(4096, Math.round((tEnd - tStart) * SR)));
  if (a < 0 || a + len > x.length) return 0;
  const n = 1 << Math.floor(Math.log2(len));
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = x[a + i] * win[i];
  fftInPlace(re, im);
  let e = 0;
  for (const h of [1, 2, 3, 4]) {
    const f = f0 * h;
    if (f > SR * 0.45) break;
    const bin = Math.round(f / (SR / n));
    const half = Math.max(1, Math.round(bin * 0.03));
    for (let k = Math.max(1, bin - half); k <= Math.min(n / 2 - 1, bin + half); k++) e += re[k] * re[k] + im[k] * im[k];
  }
  return e;
}
const evidence = { ok: [], weak: [] };
for (const n of notes) {
  const f0 = 440 * 2 ** ((n.midi - 69) / 12);
  const tRec = n.t + AT;
  const after = combEnergy(rec, tRec + 0.02, tRec + 0.17, f0);
  const before = combEnergy(rec, Math.max(0, tRec - 0.15), Math.max(0.05, tRec - 0.01), f0);
  const far = combEnergy(rec, Math.max(0, tRec - 2.0), Math.max(0.05, tRec - 1.5), f0);
  const rise = before > 0 ? after / before : Infinity;
  const vsLocal = far > 0 ? after / far : Infinity;
  if (rise >= 1.5 || vsLocal >= 1.5) evidence.ok.push({ t: n.t, midi: n.midi });
  else evidence.weak.push({ t: n.t, midi: n.midi, rise: +rise.toFixed(2), vsLocal: +vsLocal.toFixed(2) });
}
console.log(`\n=== ② 逐音音频证据（谐波梳能量升起/高出本地）===`);
console.log(`有证据 ${evidence.ok.length}（${(100 * evidence.ok.length / notes.length).toFixed(2)}%）/ 证据不足 ${evidence.weak.length}`);
if (evidence.weak.length) console.log('证据不足（谱面秒 | midi | 升起比 | 相对本地）：\n  '
  + evidence.weak.slice(0, 12).map((x) => `${x.t.toFixed(2)}s | ${x.midi} | ×${x.rise} | ×${x.vsLocal}`).join('\n  '));

/* ③ 和弦感知的逐音判定
 * 之前的版本拿"最强 1~2 个音级"去比**每一颗音**，密集段落（同时刻 2~6 颗）必然误报 871 个"错音"。
 * 正确做法：把同时刻（±60ms）的谱面音**分组成和弦**，用整组音级去比 —— k 颗不同音级就允许前 k+2 名。
 */
const CLUSTER = 0.06;
const clusters = [];
for (const n of notes) {
  const last = clusters[clusters.length - 1];
  if (last && n.t - last.t0 <= CLUSTER) last.notes.push(n);
  else clusters.push({ t0: n.t, notes: [n] });
}
console.log(`谱面按同时刻（±${(CLUSTER * 1000).toFixed(0)}ms）分成 ${clusters.length} 个和弦/音组`);

const ok = [], wrong = [], missing = [];
const used = new Set();
let passK3 = 0;
for (const cl of clusters) {
  const pcs = [...new Set(cl.notes.map((n) => pcOf(n.midi)))];
  const target = cl.notes.reduce((a, n) => a + n.t, 0) / cl.notes.length + AT;
  let bi = -1, bd = Infinity;
  for (let i = 0; i < onsets.length; i++) {
    const d = Math.abs(onsets[i] - target);
    if (d <= TOL && d < bd) { bd = d; bi = i; }
  }
  if (bi < 0) { for (const n of cl.notes) missing.push({ t: n.t, midi: n.midi }); continue; }
  used.add(bi);
  const c = chromaAt(onsets[bi]);
  const rank = [...c.keys()].sort((x, y) => c[y] - c[x]);
  const need = Math.min(12, pcs.length + 2);
  const top = rank.slice(0, need);
  const lacked = pcs.filter((p) => !top.includes(p));
  if (pcs.filter((p) => rank.slice(0, Math.min(12, pcs.length + 3)).includes(p)).length === pcs.length) passK3++;
  for (const n of cl.notes) {
    if (!lacked.includes(pcOf(n.midi))) ok.push({ t: n.t, midi: n.midi, dtMs: onsets[bi] - target });
    else wrong.push({ t: n.t, midi: n.midi, wantPc: pcOf(n.midi), missed: lacked, dtMs: onsets[bi] - target });
  }
}
const extra = onsets.map((t, i) => ({ t, i })).filter(({ i }) => !used.has(i))
  .filter(({ t }) => !notes.some((n) => Math.abs(n.t + AT - t) <= TOL))
  .map(({ t }) => {
    const c = chromaAt(t);
    const rank = c ? [...c.keys()].sort((x, y) => c[y] - c[x]).slice(0, 3) : [];
    return { recT: t, scoreT: t - AT, topPc: rank.join('/') };
  });

const dt = ok.map((x) => x.dtMs * 1000).sort((a, b) => a - b);
console.log(`\n=== 逐音对账（和弦感知：起音 ±${(TOL * 1000).toFixed(0)}ms + 组内音级必须在前 k+2 强）===`);
console.log(`（敏感性：若放宽到 k+3，可再多通过 ${passK3 - clusters.filter((cl) => cl.notes.every((n) => ok.some((o) => o.t === n.t && o.midi === n.midi))).length} 组）`);
console.log(`✔ 通过 ${ok.length} / ${notes.length}（${(100 * ok.length / notes.length).toFixed(2)}%）`);
console.log(`✘ 错音 ${wrong.length} / 缺音 ${missing.length} / 多余起音 ${extra.length}`);
if (dt.length) console.log(`节奏：中位 ${dt[dt.length >> 1].toFixed(1)}ms / p90 ${dt[Math.floor(dt.length * 0.9)].toFixed(1)}ms / 最大 ${dt[dt.length - 1].toFixed(1)}ms`);
const show = (a, f, n = 12) => a.slice(0, n).map(f).join('\n  ');
if (wrong.length) console.log('错音（谱面秒 | 应有音级 | 该组缺的音级 | ms）：\n  ' + show(wrong, (x) => `${x.t.toFixed(2)}s | ${x.wantPc} | 缺 ${x.missed.join(',')} | ${(x.dtMs * 1000).toFixed(0)}ms`));
if (missing.length) console.log('缺音（谱面秒 | midi）：\n  ' + show(missing, (x) => `${x.t.toFixed(2)}s | ${x.midi}`));
if (extra.length) console.log('多余起音（谱面秒 | 录音秒 | 该处最强音级）：\n  ' + show(extra, (x) => `${x.scoreT.toFixed(2)}s | ${x.recT.toFixed(2)}s | ${x.topPc}`, 20));

/* ================================================================ ④ 解决方案（不是只给判定）
 * 用户要求："而且不能只给判定，要有解决方案"。这里把每一类问题翻译成**可执行的动作**：
 *   · 证据不足的音 → 按 x 区间聚合（机器是按 x 顺序演奏的）→ 给出要重铺的区间；
 *     若该音的触发位不是"严格位"（tx,ty,tz 里 ty≠y+1），额外提示"这颗音走的是引擎兜底"；
 *   · 多余起音 → 用最近的谱面音定位到机器 x 区间 → 给出要清理的区间（wipe 或 mod 清方块）；
 *   · 错音 → 若听到的音级与**邻近谱面音**一致，提示"疑似被邻近音符盒顶替"（触发位/邻居问题）；
 *   · 节奏 → 超阈值时直接给 `/nbm machine start 0 <offsetMs> <rate>` 的补偿数值。
 */
const X_BUCKET = 200;
const xOfNote = (n) => 480 + n.step;                       // 机器 x ≈ 480 + step（见 layout-pos.mjs）
const stepOf = new Map();                                  // 用 time_sec 找最近的谱面音（含 step/x）
const mapRows = fs.readFileSync(SCORE, 'utf8').trim().split(/\r?\n/);
const MH = mapRows[0].split(',');
const cS = MH.indexOf('time_sec'), cX = MH.indexOf('x'), cY = MH.indexOf('y'), cZ = MH.indexOf('z');
const cTx = MH.indexOf('tx'), cTy = MH.indexOf('ty');
const map = mapRows.slice(1).map((l) => {
  const c = l.split(',');
  return { t: +c[cS], x: +c[cX], y: +c[cY], z: +c[cZ], strict: cTy >= 0 ? +c[cTy] === +c[cY] + 1 : true };
}).sort((a, b) => a.t - b.t);
const atTime = (t) => {
  let lo = 0, hi = map.length - 1;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (map[mid].t < t) lo = mid + 1; else hi = mid; }
  const cands = [map[lo], map[Math.max(0, lo - 1)]];
  cands.sort((a, b) => Math.abs(a.t - t) - Math.abs(b.t - t));
  return cands[0];
};
const bucketOf = (x) => `${Math.floor(x / X_BUCKET) * X_BUCKET}–${Math.floor(x / X_BUCKET) * X_BUCKET + X_BUCKET - 1}`;
const groupBy = (arr, keyFn) => {
  const m = new Map();
  for (const v of arr) { const k = keyFn(v); if (!m.has(k)) m.set(k, []); m.get(k).push(v); }
  return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
};

console.log('\n=== ④ 解决方案 ===');
// 1) 证据不足
if (evidence.weak.length) {
  const nonStrict = evidence.weak.filter((w) => { const m = atTime(w.t); return m && !m.strict; });
  const regions = groupBy(evidence.weak.map((w) => ({ ...w, x: atTime(w.t)?.x ?? 0 })), (w) => bucketOf(w.x)).slice(0, 5);
  console.log(`① 证据不足 ${evidence.weak.length} 颗（${nonStrict.length} 颗本来就无"严格触发位"、走引擎兜底）：`);
  for (const [b, list] of regions) console.log(`   · x ${b}：${list.length} 颗（例 ${list[0].t.toFixed(2)}s midi ${list[0].midi}）→ 先跑 /function styx:wipe 再 styx:redo 重铺这一段`);
  console.log('   核对采样是否缺文件：node tools/install-samples.mjs --check');
}
// 2) 多余起音
if (extra.length) {
  const regions = groupBy(extra.map((e) => ({ ...e, x: atTime(e.scoreT)?.x ?? 0 })), (e) => bucketOf(e.x)).slice(0, 5);
  console.log(`② 多余起音 ${extra.length} 处：`);
  for (const [b, list] of regions) console.log(`   · x ${b}：${list.length} 处（例 谱面 ${list[0].scoreT.toFixed(2)}s，最强音级 ${list[0].topPc}）→ 这段有残留方块/双触发，跑 /function styx:wipe 或 /nbm cleanstrays`);
}
// 3) 错音
if (wrong.length) {
  const ghost = wrong.filter((w) => {
    const near = notes.filter((n) => Math.abs(n.t - w.t) <= 0.3 && n.midi !== w.midi)
      .some((n) => n.midi % 12 === (w.missed.length ? w.missed[0] : -1));
    return near;
  });
  console.log(`③ 错音 ${wrong.length} 处（其中 ${ghost.length} 处"听到的音级 = 邻近谱面音的音级" → 疑似被邻居音符盒顶替）：`);
  console.log('   动作：跑 node tools/verify-trigger-map.mjs 看触发位是否有重复/越界；再 /function styx:wipe 后 redo');
}
// 4) 节奏
const p90 = dt.length ? dt[Math.floor(dt.length * 0.9)] : 0;
// 阈值：客户端精确音轨路径（--hires）要 p90 ≤ 10ms；音符盒发声受服务器刻量化，放宽到 30ms
if (p90 > (argv.includes('--hires') ? 10 : 30)) {
  console.log(`④ 节奏 p90 = ${p90.toFixed(1)}ms 超过 30ms → 用偏移/速率补偿：/nbm machine start 0 ${(-p90 / 2).toFixed(0)} ${(1 + p90 / 1e5).toFixed(5)}`);
} else {
  console.log(`④ 节奏 p90 = ${p90.toFixed(1)}ms 在阈值内 → 不需要补偿`);
}

const report = { record: REC, score: SCORE, offsetSec: AT, toleranceMs: TOL * 1000,
  notes: notes.length, onsets: onsets.length, ok: ok.length, wrong, missing, extra,
  evidence: { ok: evidence.ok.length, weak: evidence.weak },
  solutions: {
    weakRegions: evidence.weak.length ? groupBy(evidence.weak.map((w) => ({ ...w, x: atTime(w.t)?.x ?? 0 })), (w) => bucketOf(w.x)).map(([b, l]) => ({ xRange: b, count: l.length })) : [],
    extraRegions: extra.length ? groupBy(extra.map((e) => ({ ...e, x: atTime(e.scoreT)?.x ?? 0 })), (e) => bucketOf(e.x)).map(([b, l]) => ({ xRange: b, count: l.length })) : [],
    timing: { p90Ms: +p90.toFixed(1), needCompensation: p90 > 30 },
  } };
fs.writeFileSync(path.join(OUT, `${NAME}_onset_audit.json`), JSON.stringify(report, null, 1), 'utf8');
console.log(`\n报告 → ${path.join(OUT, `${NAME}_onset_audit.json`).replace(/\\/g, '/')}`);
fs.rmSync(TMP, { recursive: true, force: true });
