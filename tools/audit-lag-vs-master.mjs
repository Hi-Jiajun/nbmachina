#!/usr/bin/env node
// M3-60 · 更硬的一把尺：**逐音互相关**测"这颗音在录音里比母版晚了多少毫秒"。
//
// 为什么需要它：起音检测（audit-onset-vs-score）在密集和弦里精度只有 ±20~25ms，
// 分不清"机器晚了半拍"和"检测器自己没抓住"。这里换个不依赖检测器的办法：
//   录音与母版是**同一份谱面、同一套采样**，理想情况下逐音几乎重合 ——
//   对每颗音取母版 [t+20ms, t+220ms] 的波形，在录音里 ±80ms 内滑动求归一化互相关，
//   峰值位置 = 这颗音的游戏内延迟（ms），峰值高度 r = "确实是同一颗音"的置信度。
//
// 输出：延迟分布（中位/p90/p95/最大）、r 分布、以及"孤立音"（前后 150ms 内没有别的音，
// 不受邻居串音影响）子集上的同一套统计 —— 后者才是真正干净的判定。
//
// 用法：node tools/audit-lag-vs-master.mjs --record <录音.mkv> [--master build/master_v2/styx_master_v2_48k24bit.wav] [--at <录音t=0对应谱面秒>]
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
const MASTER = opt('master', path.join(P.build, 'master_v2', 'styx_master_v2_48k24bit.wav'));
const SCORE = opt('score', path.join(P.build, 'machine_from_reference_shift.csv'));
const OUT = opt('out', path.join(P.build, 'audit'));
const MAXLAG = Number(opt('max-lag-ms', '80')) / 1000;
const WIN = Number(opt('win-ms', '200')) / 1000;
if (!REC) throw new Error('缺少 --record');
const NAME = path.basename(REC).replace(/\.[^.]+$/, '');
fs.mkdirSync(OUT, { recursive: true });
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-lag-'));
const decode = (f) => {
  const out = path.join(TMP, path.basename(f, path.extname(f)) + '.f32');
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', f, '-af', 'pan=mono|c0=0.5*c0+0.5*c1',
    '-f', 'f32le', '-ac', '1', '-ar', String(SR), out]);
  const b = fs.readFileSync(out);
  return new Float32Array(b.buffer, b.byteOffset, Math.floor(b.length / 4));
};
const rec = decode(REC);
const mas = decode(MASTER);

// 谱面（已 +3.917 的版本）取 time/midi
const rows = fs.readFileSync(SCORE, 'utf8').trim().split(/\r?\n/);
const H = rows[0].split(',');
const iT = H.indexOf('time_seconds') >= 0 ? H.indexOf('time_seconds') : H.indexOf('time_sec');
const iM = H.indexOf('midi');
const notes = rows.slice(1).map((l) => { const c = l.split(','); return { t: +c[iT], midi: +c[iM] }; })
  .sort((a, b) => a.t - b.t);

// 全局粗对齐：1 秒包络互相关（±30s）
const env = (x) => { const w = SR, o = []; for (let i = 0; i + w <= x.length; i += w) { let s = 0; for (let j = 0; j < w; j++) s += x[i + j] * x[i + j]; o.push(Math.sqrt(s / w)); } return o; };
const em = env(mas), er = env(rec);
let best = { lag: 0, r: -2 };
for (let lag = -60; lag <= 60; lag++) {
  let sa = 0, sb = 0, sab = 0, n = 0;
  for (let i = 0; i < em.length; i++) {
    const j = i + lag;
    if (j < 0 || j >= er.length) continue;
    sa += em[i] * em[i]; sb += er[j] * er[j]; sab += em[i] * er[j]; n++;
  }
  if (n < 30) continue;
  const r = sab / (Math.sqrt(sa * sb) + 1e-12);
  if (r > best.r) best = { lag, r };
}
let AT = -best.lag;   // 录音 t=0 ↔ 谱面 AT 秒（负=录制早于音乐）
if (opt('at') !== undefined) AT = Number(opt('at'));
console.log(`母版：${MASTER}`);
console.log(`粗对齐：录音 t=0 ↔ 谱面 ${AT.toFixed(2)}s（1s 包络 r=${best.r.toFixed(3)}）`);

/* 逐音互相关 */
const nth = Math.round(WIN * SR);
const maxLagS = Math.round(MAXLAG * SR);
function corr(mOff, rOff) {
  let sm = 0, sr2 = 0, s = 0;
  for (let i = 0; i < nth; i++) {
    const a = mas[mOff + i], b = rec[rOff + i];
    sm += a * a; sr2 += b * b; s += a * b;
  }
  return s / (Math.sqrt(sm * sr2) + 1e-12);
}
const res = [];
for (const n of notes) {
  const mOff = Math.round((n.t + 0.02) * SR);
  if (mOff < 0 || mOff + nth > mas.length) continue;
  let bl = null, br = -2;
  for (let lag = -maxLagS; lag <= maxLagS; lag += 4) {
    const rOff = Math.round((n.t + AT + 0.02) * SR) + lag;
    if (rOff < 0 || rOff + nth > rec.length) continue;
    const r = corr(mOff, rOff);
    if (r > br) { br = r; bl = lag; }
  }
  if (bl === null) continue;
  for (let lag = bl - 4; lag <= bl + 4; lag++) {
    const rOff = Math.round((n.t + AT + 0.02) * SR) + lag;
    if (rOff < 0 || rOff + nth > rec.length) continue;
    const r = corr(mOff, rOff);
    if (r > br) { br = r; bl = lag; }
  }
  // 孤立音：前后 150ms 内没有别的谱面音
  const solo = !notes.some((o) => o !== n && Math.abs(o.t - n.t) < 0.15);
  res.push({ t: n.t, midi: n.midi, lagMs: bl / SR * 1000, r: br, solo });
}
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };
const report = (label, arr) => {
  if (!arr.length) return console.log(`${label}：无样本`);
  const lags = arr.map((x) => x.lagMs), rs = arr.map((x) => x.r);
  console.log(`\n${label}（${arr.length} 颗）`);
  console.log(`  延迟：中位 ${q(lags, 0.5).toFixed(1)}ms / p90 ${q(lags, 0.9).toFixed(1)}ms / p95 ${q(lags, 0.95).toFixed(1)}ms / 最大 ${q(lags, 1).toFixed(1)}ms / 最小 ${q(lags, 0).toFixed(1)}ms`);
  console.log(`  相关：中位 r=${q(rs, 0.5).toFixed(3)}；r≥0.5 的占 ${(100 * rs.filter((x) => x >= 0.5).length / rs.length).toFixed(1)}%；r≥0.3 占 ${(100 * rs.filter((x) => x >= 0.3).length / rs.length).toFixed(1)}%`);
  console.log(`  |延迟|>25ms 的占 ${(100 * lags.filter((x) => Math.abs(x) > 25).length / lags.length).toFixed(1)}%；>40ms 占 ${(100 * lags.filter((x) => Math.abs(x) > 40).length / lags.length).toFixed(1)}%`);
};
report('全部音', res);
const strong = res.filter((x) => x.r >= 0.4);
report('仅高置信（r≥0.4，即确实是同一颗音）', strong);
report('孤立音（前后 150ms 无邻居）', res.filter((x) => x.solo));
report('孤立音 ∩ 高置信', res.filter((x) => x.solo && x.r >= 0.4));

fs.writeFileSync(path.join(OUT, `${NAME}_lag.json`), JSON.stringify({ record: REC, master: MASTER, offsetSec: AT, notes: res.length, res }, null, 1), 'utf8');
console.log(`\n报告 → ${path.join(OUT, `${NAME}_lag.json`).replace(/\\/g, '/')}`);
fs.rmSync(TMP, { recursive: true, force: true });
