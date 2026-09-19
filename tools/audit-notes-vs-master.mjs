#!/usr/bin/env node
// M3-47 · 逐音严格对账：把**游戏内录音**转谱后与谱面**一颗一颗**比。
//
// 用户要求（2026-09-19）："对比音频时和母版要一一对应，每个音节音高都要对应，多音/杂音/缺音/错音都要找到，
// 速度节奏也要同步，要求严苛一些"。所以这里不做"听感差不多"，而是：
//   ① 用同一个转谱模型（piano_transcription_inference，note F1 0.9677）把录音听成音符表；
//   ② 拿谱面（machine_map.csv：time_sec + midi）当标准，逐音配对（默认 ±120ms）：
//        · 同音高命中 = 对上；记录**每颗音的时间偏差**（节奏/速度）
//        · 时间对得上但音高不同 = **错音**（列出"应有 vs 实际"）
//        · 谱面有、录音里找不到 = **缺音**
//        · 录音里有、谱面没有 = **多余音**
//   ③ 同时给削顶样本数、逐 10 秒的缺/多分布（定位问题段落）。
//
// 用法：
//   node tools/audit-notes-vs-master.mjs --record <录音.mkv|wav> --at <录音t=0对应的谱面秒> \
//        [--score build/nbmachina_machine_map.csv] [--tol 120] [--out build/audit]
//   `--at` 省略时用 1 秒包络互相关自动对齐。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();
const SR = 48000;
const REC = opt('record');
const SCORE = opt('score', path.join(P.build, 'nbmachina_machine_map.csv'));
const OUT = opt('out', path.join(P.build, 'audit'));
const TOL_MS = Number(opt('tol', '120'));
const TOL = TOL_MS / 1000;
const PY = 'C:/Users/hiliang/Documents/minecraft/_toolchain/py312/python.exe';
const CKPT = 'C:/Users/hiliang/Documents/minecraft/_toolchain/piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth';
if (!REC) throw new Error('缺少 --record <录音>');
const NAME = path.basename(REC).replace(/\.[^.]+$/, '');

fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-audit-'));

/* ---------------------------------------------------------------- 解码 */
const decode = (file, ss = 0, sec = 0) => {
  const out = path.join(TMP, `${path.basename(file, path.extname(file))}_${ss}.f32`);
  const args = ['-y', '-v', 'error'];
  if (ss) args.push('-ss', String(ss));
  args.push('-i', file);
  if (sec) args.push('-t', String(sec));
  args.push('-af', 'pan=mono|c0=0.5*c0+0.5*c1', '-f', 'f32le', '-ac', '1', '-ar', String(SR), out);
  execFileSync('ffmpeg', args);
  const b = fs.readFileSync(out);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
};

/* ---------------------------------------------------------------- 谱面 */
const lines = fs.readFileSync(SCORE, 'utf8').trim().split(/\r?\n/);
const H = lines[0].split(',');
const cT = H.indexOf('time_sec'), cM = H.indexOf('midi');
if (cT < 0 || cM < 0) throw new Error(`谱面缺 time_sec/midi 列：${H.join(',')}`);
const score = lines.slice(1).map((l) => {
  const c = l.split(',');
  return { t: Number(c[cT]), midi: Number(c[cM]) };
}).sort((a, b) => a.t - b.t);
console.log(`谱面：${score.length} 颗音（${SCORE}）`);

/* ---------------------------------------------------------------- 录音转谱 */
const cache = path.join(OUT, `${NAME}_transcription.json`);
if (!fs.existsSync(cache)) {
  console.log('正在转谱（CPU，约 1~2 分钟）…');
  const wav = path.join(TMP, `${NAME}.wav`);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', REC, '-ac', '1', '-ar', '16000', wav]);
  execFileSync(PY, [path.join(P.self ? P.self : import.meta.dirname, 'transcribe-reference.py'),
    '--in', wav, '--out', cache, '--checkpoint', CKPT], { stdio: 'inherit' });
}
const trans = JSON.parse(fs.readFileSync(cache, 'utf8'));
const detected = (trans.note_events ?? trans.notes ?? []).map((n) => ({ t: n.onset, midi: n.midi }))
  .sort((a, b) => a.t - b.t);
console.log(`转谱：录音里听出 ${detected.length} 颗音`);

/* ---------------------------------------------------------------- 对齐（--at 或自动） */
let AT = opt('at') !== undefined ? Number(opt('at')) : null;
if (AT === null) {
  const rec = decode(REC);
  const env = (x) => { const n = SR; const o = []; for (let i = 0; i + n <= x.length; i += n) { let s = 0; for (let j = 0; j < n; j++) s += x[i + j] * x[i + j]; o.push(Math.sqrt(s / n)); } return o; };
  const er = env(rec);
  const em = env(decode(path.join(P.build, 'master', 'styx_master_48k24bit.wav')));
  let best = { lag: 0, r: -2 };
  for (let lag = -Math.min(er.length, 120); lag < er.length; lag++) {
    let sa = 0, sb = 0, sab = 0, n = 0;
    for (let i = 0; i < em.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= er.length) continue;
      sa += em[i] * em[i]; sb += er[j] * er[j]; sab += em[i] * er[j]; n++;
    }
    if (n < 20) continue;
    const r = sab / (Math.sqrt(sa * sb) + 1e-12);
    if (r > best.r) best = { lag, r };
  }
  AT = -best.lag;   // 录音 t=0 ↔ 谱面 AT 秒
  console.log(`自动对齐：录音 t=0 ↔ 谱面 ${AT.toFixed(2)}s（1s 包络 r=${best.r.toFixed(3)}）`);
} else {
  console.log(`使用 --at ${AT}s（录音 t=0 ↔ 谱面秒数）`);
}

/* ---------------------------------------------------------------- 用"逐音命中数"精调对齐
 * 包络自动对齐只能到 1 秒级，`--at` 又是手填的 —— 这里直接在 ±1.5s 内搜"能让最多音符同音高命中"
 * 的偏移。这一步不做，后面统计出来的"错音/多余音"大半都是对齐误差造成的假阳性。
 */
{
  const byMidi = new Map();
  for (const d of detected) {
    if (!byMidi.has(d.midi)) byMidi.set(d.midi, []);
    byMidi.get(d.midi).push(d.t);
  }
  for (const arr of byMidi.values()) arr.sort((a, b) => a - b);
  const hitsAt = (off) => {
    let hit = 0;
    for (const s of score) {
      const arr = byMidi.get(s.midi);
      if (!arr) continue;
      const target = s.t + off;
      // 二分找最近的
      let lo = 0, hi = arr.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; }
      const cand = [arr[lo], arr[Math.max(0, lo - 1)]];
      if (cand.some((x) => Math.abs(x - target) <= TOL)) hit++;
    }
    return hit;
  };
  let bestOff = AT, bestHit = -1;
  for (let off = AT - 1.5; off <= AT + 1.5; off += 0.005) {
    const hit = hitsAt(off);
    if (hit > bestHit) { bestHit = hit; bestOff = off; }
  }
  const before = hitsAt(AT);
  console.log(`逐音对齐精调：${AT.toFixed(3)}s（命中 ${before}）→ **${bestOff.toFixed(3)}s（命中 ${bestHit}）**`);
  AT = bestOff;

  // 再用"时间偏差的中位数"把系统性偏移抹平：命中数在 ±120ms 容差内是平的，
  // 所以它只能定到"哪一簇"，定不到"簇中心"。这一步之后时间偏差中位数应≈0。
  for (let round = 0; round < 3; round++) {
    const ds = [];
    for (const s of score) {
      const arr = byMidi.get(s.midi);
      if (!arr) continue;
      const target = s.t + AT;
      let lo = 0, hi = arr.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid] < target) lo = mid + 1; else hi = mid; }
      let best = Infinity;
      for (const cand of [arr[lo], arr[Math.max(0, lo - 1)]]) if (Math.abs(cand - target) <= TOL) best = Math.min(best, cand - target);
      if (Number.isFinite(best)) ds.push(best);
    }
    if (ds.length < 50) break;
    ds.sort((a, b) => a - b);
    const med = ds[ds.length >> 1];
    if (Math.abs(med) < 0.002) break;
    AT += med;
    console.log(`  中位数校正：偏差中位 ${(med * 1000).toFixed(1)}ms → 对齐修正为 ${AT.toFixed(3)}s`);
  }
}

/* ---------------------------------------------------------------- 逐音配对 */
const used = new Array(detected.length).fill(false);
const matched = [], wrong = [], missing = [];
const deltas = [];
for (const s of score) {
  const target = s.t + AT;                      // 该音在录音时间轴上的位置
  let bestSame = -1, bestSameD = Infinity, bestAny = -1, bestAnyD = Infinity;
  for (let i = 0; i < detected.length; i++) {
    if (used[i]) continue;
    const d = detected[i].t - target;
    if (Math.abs(d) > TOL) continue;
    if (detected[i].midi === s.midi && Math.abs(d) < bestSameD) { bestSame = i; bestSameD = Math.abs(d); }
    if (Math.abs(d) < bestAnyD) { bestAny = i; bestAnyD = Math.abs(d); }
  }
  if (bestSame >= 0) {
    used[bestSame] = true;
    matched.push(s);
    deltas.push(detected[bestSame].t - target);
  } else if (bestAny >= 0) {
    used[bestAny] = true;
    const d = detected[bestAny].midi - s.midi;
    wrong.push({
      t: s.t, want: s.midi, got: detected[bestAny].midi, dtMs: (detected[bestAny].t - target) * 1000,
      kind: d % 12 === 0 ? `八度差 ${d / 12}×12` : '音级不同',
    });
  } else {
    missing.push(s);
  }
}
const extra = detected.filter((_, i) => !used[i]);

const q = (arr, p) => { if (!arr.length) return NaN; const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))]; };
const ms = (v) => (v * 1000).toFixed(1);

console.log('\n=== 逐音对账（容差 ±' + TOL_MS + 'ms，音高必须完全相同）===');
console.log(`谱面 ${score.length} 颗 / 录音听出 ${detected.length} 颗`);
console.log(`✔ 对上 ${matched.length}（${(100 * matched.length / score.length).toFixed(2)}%）`);
console.log(`✘ 错音 ${wrong.length} / 缺音 ${missing.length} / 多余音 ${extra.length}`);
console.log(`节奏：每颗音时间偏差 中位 ${ms(q(deltas, 0.5))}ms / p90 ${ms(q(deltas, 0.9))}ms / 最大 ${ms(q(deltas, 1))}ms`);

const shown = (arr, f) => arr.slice(0, 12).map(f).join('\n  ');
if (wrong.length) console.log('错音（谱面秒 | 应有 MIDI → 实际 MIDI | 偏差ms）：\n  ' + shown(wrong, (w) => `${w.t.toFixed(2)}s | ${w.want} → ${w.got} | ${w.dtMs.toFixed(0)}ms`));
if (missing.length) console.log('缺音（谱面秒 | MIDI | 该时刻录音里没有同音高）：\n  ' + shown(missing, (m) => `${m.t.toFixed(2)}s | ${m.midi}`));
if (extra.length) console.log('多余音（录音秒 | MIDI；换算成谱面秒）：\n  ' + shown(extra, (e) => `${e.t.toFixed(2)}s | ${e.midi}（谱面 ${(e.t - AT).toFixed(2)}s）`));

// 逐 10 秒分布：定位问题段落
const bucket = (t) => Math.floor(t / 10) * 10;
const map10 = new Map();
for (const m of missing) map10.set(bucket(m.t), (map10.get(bucket(m.t)) ?? 0) + 1);
const map10x = new Map();
for (const e of extra) map10x.set(bucket(e.t - AT), (map10x.get(bucket(e.t - AT)) ?? 0) + 1);
const buckets = [...new Set([...map10.keys(), ...map10x.keys()])].sort((a, b) => a - b);
if (buckets.length) {
  console.log('逐 10 秒：谱面秒 -> 缺/多');
  for (const b of buckets) console.log(`  ${b}s: 缺 ${map10.get(b) ?? 0} / 多 ${map10x.get(b) ?? 0}`);
}

/* ---------------------------------------------------------------- 削顶/异常 */
const rec = decode(REC);
let clip = 0, peak = 0;
for (let i = 0; i < rec.length; i++) { const a = Math.abs(rec[i]); if (a > peak) peak = a; if (a >= 0.995) clip++; }
console.log(`\n录音峰值 ${peak.toFixed(3)}，≥0.995 的样本 ${clip} 个${clip ? '（有削顶）' : '（无削顶）'}`);

const report = {
  record: REC, score: SCORE, offsetSec: AT, toleranceMs: TOL_MS,
  scoreNotes: score.length, detectedNotes: detected.length,
  matched: matched.length, wrongPitch: wrong, missing, extra,
  timing: { medianMs: +(q(deltas, 0.5) * 1000).toFixed(1), p90Ms: +(q(deltas, 0.9) * 1000).toFixed(1), maxMs: +(q(deltas, 1) * 1000).toFixed(1) },
  clipping: { peak, samples: clip },
};
fs.writeFileSync(path.join(OUT, `${NAME}_audit.json`), JSON.stringify(report, null, 1), 'utf8');
console.log(`报告 → ${path.join(OUT, `${NAME}_audit.json`).replace(/\\/g, '/')}`);
fs.rmSync(TMP, { recursive: true, force: true });
