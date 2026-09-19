#!/usr/bin/env node
// M3-36 · 游戏内录音 vs 离线母版：一致性量化（M3 队列里的"4"）
//
// 为什么需要它：M3-29 只量了**时间抖动**（nanoTime 调度 0.18ms），没量"游戏里听到的和离线母版
// 是不是同一条声音"。这条工具做数字对齐 + 频带对比，回答三个问题：
//   ① 对齐误差多大（录音里音乐起点比母版偏了多少毫秒）；
//   ② 频谱像不像（1/3 倍频程逐带差值，找出"某段被削/被加料"）；
//   ③ 波形相关度 r（>0.95 基本就是同一条；<0.8 说明链路里有别的东西）。
//
// 录音要求（写进 docs/INSTALL.md 的"录制口径"）：
//   · OBS 用「桌面音频 / WASAPI 回环」采，**不要用麦克风**（数字采集，无房间染色）；
//   · 48kHz / 立体声 / 24bit 或 32bit float，游戏内音乐音量固定、系统音量固定；
//   · 录一段连续 40~60 秒，期间别切场景、别有别的程序出声；
//   · 记下开始录的那一刻游戏内是第几秒（`/nbmc play <秒>` 的秒数），传给 `--at`。
//
// 用法：
//   node tools/compare-ingame-vs-master.mjs --record build/capture.wav \
//        --master build/master/styx_master_48k24bit.wav --at 30 --len 40
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const SR = 48000;
const REC = opt('record');
const MASTER = opt('master', path.join(import.meta.dirname, '..', '..', 'build', 'master', 'styx_master_48k24bit.wav'));
const AT = Number(opt('at', '0'));            // 录音开始时对应的母版时间（秒）
const LEN = Number(opt('len', '40'));         // 参与对比的时长（秒）
const SEARCH = Number(opt('search', '3'));    // 对齐搜索范围 ±秒
if (!REC) throw new Error('缺少 --record <游戏内录音 wav>');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'nbm-cmp-'));
const db = (v) => 20 * Math.log10(Math.max(1e-12, v));

/** 用 ffmpeg 解成 48k 单声道 f32（跳过解码差异，只比内容） */
function decode(file, offsetSec, durSec) {
  const raw = path.join(TMP, `${path.basename(file, path.extname(file))}_${offsetSec}.f32`);
  const args = ['-v', 'error'];
  if (offsetSec > 0) args.push('-ss', String(offsetSec));
  args.push('-i', file);
  if (durSec > 0) args.push('-t', String(durSec));
  args.push('-af', 'pan=mono|c0=0.5*c0+0.5*c1', '-f', 'f32le', '-ac', '1', '-ar', String(SR), raw);
  execFileSync('ffmpeg', ['-y', ...args]);
  const buf = fs.readFileSync(raw);
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
}

/** 10ms 窗包络，用于粗对齐 */
function envelope(x, win = SR / 100) {
  const n = Math.floor(x.length / win);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < win; j++) { const v = x[i * win + j]; s += v * v; }
    out[i] = Math.sqrt(s / win);
  }
  return out;
}

const rms = (x, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

/** 归一化互相关（包络域，10ms 分辨率） */
function bestLag(a, b, maxLag) {
  let best = 0, bestR = -2;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    let sa = 0, sb = 0, sab = 0, n = 0;
    for (let i = 0; i < a.length; i++) {
      const j = i + lag;
      if (j < 0 || j >= b.length) continue;
      sa += a[i] * a[i]; sb += b[j] * b[j]; sab += a[i] * b[j]; n++;
    }
    if (!n) continue;
    const r = sab / (Math.sqrt(sa * sb) + 1e-12);
    if (r > bestR) { bestR = r; best = lag; }
  }
  return { lag: best, r: bestR };
}

/** 二阶带通（RBJ），用于 1/3 倍频程逐带能量 */
function bandRms(x, fc, q = 4.318) {
  const w0 = 2 * Math.PI * fc / SR, cos0 = Math.cos(w0), alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha, b1 = 0, b2 = -alpha, a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, s = 0;
  for (let i = 0; i < x.length; i++) {
    const x0 = x[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
    s += y0 * y0;
  }
  return Math.sqrt(s / x.length);
}

const BANDS = [125, 250, 500, 1000, 2000, 4000, 8000, 12000];

console.log(`录音：${REC}`);
console.log(`母版：${MASTER}（对齐中心 ${AT}s，对比长度 ${LEN}s）`);

const rec = decode(REC, 0, LEN + 2 * SEARCH);
const mast = decode(MASTER, Math.max(0, AT - SEARCH), LEN + 2 * SEARCH);
console.log(`样本数：录音 ${rec.length} / 母版段 ${mast.length}（${(rec.length / SR).toFixed(2)}s）`);

const M0 = Math.max(0, AT - SEARCH);
const er = envelope(rec), em = envelope(mast);
// 粗对齐：10ms 分辨率的包络互相关
const { lag: coarseBins, r: coarseR } = bestLag(er, em, Math.round(SEARCH * 100));

/**
 * 细对齐：在粗对齐附近做**样本级**互相关（1/48000s ≈ 0.021ms），返回录音相对母版的偏移（秒，正=录音更晚）。
 * 只在 rawWin 秒的窗口上算，够快也够稳。
 */
function fineOffset(recStartSec, rawWin = 0.6) {
  // 粗对齐给出的母版时刻 **加上窗偏移**（recStartSec 处该对应哪一刻的母版）
  const masterSec = M0 + coarseBins * 0.01 + recStartSec;
  // 注意：`mast` 是从 M0 开始截的，所以下标要减掉 M0
  const masterFrom = Math.round((masterSec - M0) * SR);
  const recFrom = Math.round(recStartSec * SR);
  const n = Math.round(rawWin * SR);
  if (recFrom + n > rec.length || masterFrom + n > mast.length) return { t0: NaN, r: NaN };
  let bestLagS = 0, bestR = -2;
  // 粗对齐给的是"窗首附近"的估计，但整曲漂移可能到几百毫秒 → 先 ±400ms 粗扫（16 样本 ≈ 0.33ms），
  // 再在 ±16 样本内精修到 1 样本（1/48000s ≈ 0.021ms）。
  const maxLagS = Math.round(0.4 * SR);
  for (let lag = -maxLagS; lag <= maxLagS; lag += 16) {
    const r = corr(rec.subarray(recFrom, recFrom + n), mast, masterFrom + lag, n);
    if (r > bestR) { bestR = r; bestLagS = lag; }
  }
  let lo = bestLagS - 8, hi = bestLagS + 8;
  for (let lag = lo; lag <= hi; lag++) {                  // 再 1 样本精修
    const r = corr(rec.subarray(recFrom, recFrom + n), mast, masterFrom + lag, n);
    if (r > bestR) { bestR = r; bestLagS = lag; }
  }
  // 录音 t=recStartSec ↔ 母版 (M0 + 粗对齐 + lag/SR)；所以录音 t=0 ↔ 母版 t0
  const t0 = masterSec + bestLagS / SR - recStartSec;
  return { t0, r: bestR };
}

/** 归一化互相关：a[0..n) 与 b[bFrom+lag .. +n) */
function corr(a, b, bFrom, n) {
  let sa = 0, sb = 0, sab = 0, m = 0;
  for (let i = 0; i < n; i++) {
    const j = bFrom + i;
    if (j < 0 || j >= b.length) continue;
    const x = a[i], y = b[j];
    sa += x * x; sb += y * y; sab += x * y; m++;
  }
  return sab / (Math.sqrt(sa * sb) + 1e-12);
}

const first = fineOffset(0);
const lastSec = Math.max(0, Math.min(LEN - 2, (rec.length / SR) - 2));
const last = fineOffset(lastSec);
const driftMs = (last.t0 - first.t0) * 1000;
const spanSec = lastSec;
/** 相对用户给的 --at 的偏差：正 = 实际录音起点比 --at 更晚 */
const offsetMs = (first.t0 - AT) * 1000;

console.log(`\n① 对齐（样本级，1/48000s 精度）`);
console.log(`   录音 t=0 ↔ 母版 **${first.t0.toFixed(3)}s**（相对 --at ${AT}s 的偏差 `
  + `**${offsetMs >= 0 ? '+' : ''}${offsetMs.toFixed(1)}ms**）`);
console.log(`   未细调时窗相关 r = ${coarseR.toFixed(4)} → 细对齐 r = ${first.r.toFixed(4)}`
  + `${first.r > 0.9 ? '（对齐很好）' : first.r > 0.6 ? '（一般：可能有额外声音/丢帧/音量差）' : '（差：先确认录的是同一段）'}`);
console.log(`② 漂移：窗首 t0=${first.t0.toFixed(3)}s → 窗尾（+${spanSec.toFixed(1)}s）t0=${last.t0.toFixed(3)}s`
  + ` → **${driftMs >= 0 ? '+' : ''}${driftMs.toFixed(1)}ms / ${spanSec.toFixed(1)}s**`
  + `（${Math.abs(driftMs) < 5 ? '基本无漂移，速度一致' : Math.abs(driftMs) < 25 ? '轻微漂移，可用偏移量补偿' : '漂移明显，速度或刻率有问题'}）`);

// 取对齐后的同长窗口做频带对比：起点用"录音里音乐真正开始"的位置（跳过开头静音），
// 母版侧按细对齐的偏移换算过去。
const bin = SR / 100;
const thr = 0.1 * Math.max(...er.slice(0, Math.min(er.length, 2000)));
let i0 = 0;
while (i0 < er.length - 1 && er[i0] < thr) i0++;
const startRec = Math.min(rec.length, Math.round(i0 * bin));
const masterAtRecStart = first.t0;   // 录音 t=0 对应的母版时刻
const startMast = Math.round((masterAtRecStart - M0) * SR);   // 母版段内的下标
const n = Math.max(0, Math.min(rec.length - startRec, mast.length - startMast - 1, Math.round(LEN * SR)));
if (n < SR) throw new Error('对齐后可用长度不足 1 秒——检查 --at/--len，或录音太短');
const recW = rec.subarray(startRec, startRec + n);
const mastW = mast.subarray(Math.max(0, startMast), Math.max(0, startMast) + n);
const rRec = rms(recW), rMast = rms(mastW);
console.log(`\n③ 电平：录音 ${db(rRec).toFixed(2)}dBFS / 母版 ${db(rMast).toFixed(2)}dBFS → 差 ${(db(rRec) - db(rMast)).toFixed(2)}dB`);
console.log(`\n④ 1/3 倍频程逐带（录音 − 母版，dB）：`);
let worst = { band: 0, d: 0 };
for (const fc of BANDS) {
  const a = db(bandRms(recW, fc)), b = db(bandRms(mastW, fc));
  const d = a - b;
  if (Math.abs(d) > Math.abs(worst.d)) worst = { band: fc, d };
  const bar = d > 0 ? '+'.repeat(Math.min(20, Math.round(Math.abs(d) * 2))) : '-'.repeat(Math.min(20, Math.round(Math.abs(d) * 2)));
  console.log(`   ${String(fc).padStart(5)}Hz  ${d >= 0 ? '+' : ''}${d.toFixed(2)}dB  ${bar}`);
}
console.log(`\n结论：频谱最大偏差在 ${worst.band}Hz（${worst.d >= 0 ? '+' : ''}${worst.d.toFixed(2)}dB）`);
console.log(`判读：±1.5dB 内＝链路一致；2~6dB 某带偏高/偏低＝音量/编码差异或游戏内混音；`
  + `结构性偏差（整段频带形状不同）＝录的不是同一段，或中间经过了别的处理。`);
console.log(`\n拿这个偏移去补偿：视频合成时给 tools/mux-video.mjs 的 --offset 加上 ${(first.offsetMs / 1000).toFixed(3)}s`
  + `（正=游戏内更晚，就把母版音轨往后推同样的量），或用 /nbm machine start 0 <提前毫秒> 让机器提前触发。`);
fs.rmSync(TMP, { recursive: true, force: true });
