#!/usr/bin/env node
// M3-22 · 拿参考演奏（Animenz 视频）校准机器谱面的**音区**与**时值**
//
// 为什么需要它（三条已量化的证据，见 docs/M3-22-reference-calibration.md）：
//   ① 时间：谱面和视频的时移不是常数，而是随段落漂 ±0.2~0.5s（视频有自由速度，谱面是恒定网格）；
//   ② 音区：`bass` 声部整体比视频低 **两个八度**（每个 20s 窗口的最佳移调都是 +24，
//      命中率 63~96%）；`harp` 声部不动（89.9% 命中）——低音糊成一团的根因就在这里；
//   ③ 时值：谱面没有时值。视频里能听出每颗音的键释放时刻，以及踏板什么时候抬
//      （踏板踩着时松键不制音）——这才是钢琴"该响多久"的真相。
//
// 本工具做三件事：
//   1. 用"同音名 + 时间软匹配"求**时移曲线** lag(t)（10s 窗 × 5s 步进 + 中值滤波 + 线性插值）；
//   2. 逐声部搜索整体八度移调 k（±4 个八度，步进 12 半音），只在证据充分时采纳；
//   3. 修正音高后一对一匹配参考转谱音，取下 keyRelease / pedalOff → `durMs`（实际发声时长）。
//
// 用法：
//   node tools/calibrate-from-reference.mjs                     # 默认：乐句级视频谱面 + 全曲转谱
//   node tools/calibrate-from-reference.mjs --no-register       # 只做时值，不动音高
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';

const P = resolvePaths();
const B = P.build;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const SCORE = opt('score', path.join(B, 'machine_pipeline_video_phrase.csv'));
const TRANSCRIPTION = opt('transcription', path.join(B, 'ref_transcription.json'));
const OUT = opt('out', path.join(B, 'machine_pipeline_calibrated.csv'));
const REPORT = opt('report', path.join(B, 'calibration_report.json'));
const TOL = Number(opt('tol', '0.15'));              // 软匹配/命中判定容差（秒）
const MATCH_TOL = Number(opt('match-tol', '0.20'));  // 取时值时的匹配容差（比命中判定松一点）
const WIN = Number(opt('window', '10'));
const HOP = Number(opt('hop', '5'));
const REG_MARGIN = Number(opt('register-margin', '0.05'));  // 移调要赢过"不动"至少这么多才采纳
const REG_MIN_HIT = Number(opt('register-min-hit', '0.40'));
const FALLBACK_HOLD = Number(opt('fallback', '0.35'));
const MAX_SOUND = Number(opt('max', '9.0'));
const MIN_SOUND = Number(opt('min', '0.08'));
const USE_REGISTER = !has('no-register');

/* ---------------------------------------------------------------- 读入 */
const raw = fs.readFileSync(SCORE, 'utf8').trim();
const lines = raw.split(/\r?\n/);
const header = lines[0].split(',');
const hi = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['step', 'row', 'instrument', 'midi']) {
  if (hi[need] === undefined) throw new Error(`谱面缺列 ${need}：${header.join(',')}`);
}
const rows = lines.slice(1).filter((l) => l.trim()).map((l) => l.split(','));
const notes = rows.map((c) => ({
  cells: c,
  step: Number(c[hi.step]),
  row: Number(c[hi.row]),
  voice: c[hi.instrument],
  midi: Number(c[hi.midi]),
  t: hi.time_seconds !== undefined ? Number(c[hi.time_seconds]) : Number(c[hi.step]) * 0.12,
}));
const tr = JSON.parse(fs.readFileSync(TRANSCRIPTION, 'utf8'));
const ref = tr.note_events.slice().sort((a, b) => a.onset - b.onset);
const pedals = tr.pedal_events.slice().sort((a, b) => a.on - b.on);

/* ---------------------------------------------------------------- 工具函数 */
const byPc = Array.from({ length: 12 }, () => []);
for (const n of ref) byPc[((n.midi % 12) + 12) % 12].push(n.onset);
for (const a of byPc) a.sort((x, y) => x - y);
function nearestPcDt(midi, target) {
  const a = byPc[((midi % 12) + 12) % 12];
  let lo = 0, hi = a.length - 1, best = Infinity;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    const d = a[m] - target;
    if (Math.abs(d) < best) best = Math.abs(d);
    if (d < 0) lo = m + 1; else hi = m - 1;
  }
  return best;
}
/** 一组音在时移 d 下与参考的软匹配得分（0..1） */
function softScore(list, d) {
  let s = 0;
  for (const n of list) {
    const dt = nearestPcDt(n.midi, n.t + d);
    if (dt <= TOL) s += 1 - dt / TOL;
  }
  return list.length ? s / list.length : 0;
}
/** 踏板：t 时刻若踩着踏板，返回该踏板段抬起的时刻；否则返回 t */
function pedalOffAt(t) {
  for (const p of pedals) {
    if (t >= p.on && t < p.off) return p.off;
    if (p.on > t) break;
  }
  return t;
}

/* ---------------------------------------------- ① 时移曲线 lag(t) */
const pitched = notes.filter((n) => Number.isFinite(n.midi));
const winPts = [];
for (let t0 = 0; t0 + WIN <= 300; t0 += HOP) {
  const seg = pitched.filter((n) => n.t >= t0 && n.t < t0 + WIN);
  if (seg.length < 6) continue;
  let best = { d: 0, s: -1 };
  for (let d = -1.5; d <= 1.5; d += 0.005) {
    const s = softScore(seg, d);
    if (s > best.s) best = { d, s };
  }
  winPts.push({ t: t0 + WIN / 2, d: best.d, s: best.s });
}
const smoothPts = winPts.map((p, i) => {
  const w = winPts.slice(Math.max(0, i - 2), Math.min(winPts.length, i + 3)).map((q) => q.d).sort((a, b) => a - b);
  return { t: p.t, d: w[w.length >> 1] };
});
function lagAt(t) {
  if (!smoothPts.length) return 0;
  if (t <= smoothPts[0].t) return smoothPts[0].d;
  if (t >= smoothPts.at(-1).t) return smoothPts.at(-1).d;
  for (let i = 1; i < smoothPts.length; i++) {
    if (t <= smoothPts[i].t) {
      const a = smoothPts[i - 1], b = smoothPts[i];
      return a.d + (b.d - a.d) * (t - a.t) / (b.t - a.t);
    }
  }
  return 0;
}
const lagStats = smoothPts.length
  ? { min: Math.min(...smoothPts.map((p) => p.d)), max: Math.max(...smoothPts.map((p) => p.d)) }
  : { min: 0, max: 0 };
console.log(`① 时移曲线：${smoothPts.length} 个窗，lag ∈ [${lagStats.min.toFixed(2)}, ${lagStats.max.toFixed(2)}]s`);

/* ---------------------------------------------- ② 逐声部音区校准 */
const hitRate = (list, shift) => {
  if (!list.length) return 0;
  let hit = 0;
  for (const n of list) {
    const target = n.t + lagAt(n.t);
    if (ref.some((r) => r.midi === n.midi + shift && Math.abs(r.onset - target) <= TOL)) hit++;
  }
  return hit / list.length;
};
const shifts = {};
for (const voice of [...new Set(notes.map((n) => n.voice))]) {
  const list = notes.filter((n) => n.voice === voice && Number.isFinite(n.midi));
  const base = hitRate(list, 0);
  if (!list.length || !USE_REGISTER) { shifts[voice] = { k: 0, before: base, after: base, kept: false }; continue; }
  let best = { k: 0, hit: base };
  for (let k = -48; k <= 48; k += 12) {
    if (k === 0) continue;
    const hit = hitRate(list, k);
    if (hit > best.hit) best = { k, hit };
  }
  const keep = best.k !== 0 && best.hit >= REG_MIN_HIT && best.hit - base >= REG_MARGIN;
  shifts[voice] = { k: keep ? best.k : 0, before: base, after: keep ? best.hit : base, bestK: best.k, bestHit: best.hit, kept: keep, notes: list.length };
  console.log(`② ${voice}：${list.length} 颗，命中 ${(base * 100).toFixed(1)}%`
    + ` → 最佳移调 ${best.k > 0 ? '+' : ''}${best.k} 命中 ${(best.hit * 100).toFixed(1)}%`
    + `${keep ? ' → 采纳' : ' → 不采纳（证据不足）'}`);
}
for (const n of notes) {
  const s = shifts[n.voice];
  n.shift = s ? s.k : 0;
  n.midi2 = n.midi + n.shift;
}

/* ---------------------------------------------- ③ 逐音匹配 → 时值 */
const byMidi = new Map();
ref.forEach((n, i) => {
  if (!byMidi.has(n.midi)) byMidi.set(n.midi, []);
  byMidi.get(n.midi).push(i);
});
const used = new Uint8Array(ref.length);
const stats = { matched: 0, dup: 0, fallbackPedal: 0, fallbackHold: 0, dur: [], keyhold: [] };
// 输出口径：`midi` 列直接写成**校准后**的音高（下游工具只认 midi，不用各自再加位移），
// 另附 `midiBefore`/`regShift` 留痕，`durMs` 是这颗音的实际发声时长（毫秒）。
const outHeader = [...header, 'midiBefore', 'regShift', 'durMs', 'refMatched'];
const outRows = [];
const iMidi = hi.midi;
for (const n of [...notes].sort((a, b) => a.t - b.t)) {
  let durMs = '';
  let matched = 0;
  if (Number.isFinite(n.midi2)) {
    const target = n.t + lagAt(n.t);
    const cands = byMidi.get(n.midi2) ?? [];
    let best = -1, bestDt = Infinity;
    for (const i of cands) {
      if (used[i]) continue;
      const dt = Math.abs(ref[i].onset - target);
      if (dt > MATCH_TOL) continue;
      if (dt < bestDt) { bestDt = dt; best = i; }
    }
    let keyoff;
    if (best >= 0) {
      used[best] = 1;
      keyoff = ref[best].offset;
      matched = 1;
      stats.matched++;
      stats.keyhold.push(keyoff - ref[best].onset);
    } else {
      const po = pedalOffAt(target);
      keyoff = po > target ? po : target + FALLBACK_HOLD;
      if (po > target) stats.fallbackPedal++; else stats.fallbackHold++;
    }
    const pedalOff = pedalOffAt(keyoff);
    const sound = Math.min(MAX_SOUND, Math.max(MIN_SOUND, Math.max(keyoff, pedalOff) - target));
    stats.dur.push(sound);
    durMs = Math.round(sound * 1000);
  }
  const cells = [...n.cells];
  cells[iMidi] = String(n.midi2);
  outRows.push([...cells, n.midi, n.shift, durMs, matched].join(','));
}

/* ---------------------------------------------- 写出 + 报告 */
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, [outHeader.join(','), ...outRows].join('\n') + '\n', 'utf8');

const q = (arr, p) => (arr.length ? arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(p * arr.length))] : 0);
const report = {
  score: path.basename(SCORE),
  transcription: path.basename(TRANSCRIPTION),
  lag_curve: smoothPts.map((p) => ({ t: +p.t.toFixed(1), lag: +p.d.toFixed(3) })),
  register: Object.fromEntries(Object.entries(shifts).map(([k, v]) => [k, {
    shift: v.k, notes: v.notes ?? 0, hit_before: +v.before.toFixed(3), hit_after: +v.after.toFixed(3),
    best_shift_searched: v.bestK ?? 0, best_hit_searched: +(v.bestHit ?? 0).toFixed(3), adopted: !!v.kept,
  }])),
  durations: {
    matched: stats.matched, dup: 0, fallback_pedal: stats.fallbackPedal, fallback_hold: stats.fallbackHold,
    match_ratio: +(stats.matched / Math.max(1, notes.length)).toFixed(3),
    keyhold_p10: +q(stats.keyhold, 0.1).toFixed(3), keyhold_median: +q(stats.keyhold, 0.5).toFixed(3),
    sound_p10: +q(stats.dur, 0.1).toFixed(3), sound_median: +q(stats.dur, 0.5).toFixed(3),
    sound_p90: +q(stats.dur, 0.9).toFixed(3),
  },
  pedal_segments: pedals.length,
  pedal_down_ratio: +(pedals.reduce((s, p) => s + (p.off - p.on), 0) / tr.duration_seconds).toFixed(3),
};
fs.writeFileSync(REPORT, JSON.stringify(report, null, 1), 'utf8');
console.log(`③ 时值：匹配 ${stats.matched}/${notes.length} = ${(report.durations.match_ratio * 100).toFixed(1)}%`
  + `（踏板兜底 ${stats.fallbackPedal}，短触键兜底 ${stats.fallbackHold}）`);
console.log(`   键按住 中位 ${report.durations.keyhold_median}s；实际发声 p10 ${report.durations.sound_p10}s /`
  + ` 中位 ${report.durations.sound_median}s / p90 ${report.durations.sound_p90}s`);
console.log(`写出 ${OUT}`);
console.log(`报告 ${REPORT}`);
