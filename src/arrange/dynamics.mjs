#!/usr/bin/env node
// M3-14 · 实测力度 → 可用力度（velMidi，1..127）
//
// 要解决的问题（用户 2026-09-15 听感反馈："力度强弱关系我没有听出来"）：
// M0 T5b 量出来的 `velocity` = 该音**自己的音级 + 自己的八度**上的短时窄带能量，
// 按 p10/p90 **线性**映到 0.35..1.0。能量是重尾分布，线性映射的结果是绝大多数音挤在
// 0.35~0.48 这一小段（实测旋律 n=1639：p5 0.359 / 中位 0.422 / p95 0.504），
// 于是采样力度层几乎不变、增益差不到 1dB —— 听起来就是"没有强弱"。
//
// 这里做两件事（都只依赖谱面自身的统计，不需要再听音频）：
//   ① **分位数拉伸**：按声部（旋律/贝斯分别统计）把 p5→floor、p95→ceiling 线性拉开，
//      保留原有的强弱**次序**，只是把被压缩的动态范围还原；
//   ② 输出 **1..127 的 MIDI 力度**（`velMidi`）：这是唯一能让"采样力度层选择"
//      （SFZ 的 lovel/hivel）和"播放音量"共用同一把尺子的口径。
//
// 下游两处消费同一列：
//   · 离线渲染 `tools/render-ensemble.mjs --dynamics measured`：velMidi → 采样层 + 增益；
//   · 游戏内 hifi `src/emit/playsound-hifi.mjs`：velMidi → playsound 的 volume 参数。
//
// 打击乐（basedrum/hat）没有"力度"概念 → velMidi 留空，渲染时走它们各自的峰值定标。
//
// 用法：node src/arrange/dynamics.mjs --in <csv> --out <csv>
import fs from 'node:fs';

import { resolvePaths } from '../core/paths.mjs';
import { voiceOfInstrument } from './velocity.mjs';

export const DYNAMICS_DEFAULTS = {
  pLow: 0.05,      // 分位数下界（p5 → floor）
  pMid: 0.5,       // 中位数（p50 → mid）
  pHigh: 0.95,     // 分位数上界（p95 → ceiling）
  floor: 10,       // 最轻的 MIDI 力度（≈ -16.7dB，见 velMidiToAmplitude）
  mid: 64,         // 中位音落位：让全曲坐在"中强"而不是"极弱"（只有两端按分位数拉伸会整体偏轻）
  ceiling: 127,    // 最响
  curve: 1.0,      // >1 更压动态、<1 更拉动态
  rangeDb: 18,     // 满量程动态范围：velMidi 从 1 → 127 对应 -18dB → 0dB
};

const clamp01 = (x) => Math.max(0, Math.min(1, x));

/**
 * 给每个音符补 `velMidi`（1..127；打击乐与"没有力度证据"的音为 null）。
 * @param {Array<{instrument?:string, velocity?:number|string}>} notes
 * @param {object} [opts] 见 DYNAMICS_DEFAULTS
 * @returns {Array<object>} 新数组（不改输入）
 */
export function assignVelMidi(notes, opts = {}) {
  const cfg = { ...DYNAMICS_DEFAULTS, ...opts };
  const voices = notes.map((n) => voiceOfInstrument(n.instrument));

  // 按声部分别统计（旋律与贝斯的能量分布差得远，共用一套分位数会把贝斯压平）
  const pools = new Map();
  notes.forEach((n, i) => {
    if (voices[i] === 'perc') return;
    const v = Number(n.velocity);
    if (!Number.isFinite(v) || v <= 0) return;              // 0 = 音频里没有证据（weak）
    if (!pools.has(voices[i])) pools.set(voices[i], []);
    pools.get(voices[i]).push(v);
  });
  const stats = new Map();
  for (const [voice, arr] of pools) {
    const s = arr.slice().sort((a, b) => a - b);
    const at = (p) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))];
    const lo = at(cfg.pLow);
    const hi = Math.max(at(cfg.pHigh), lo + 1e-9);
    const mid = Math.min(Math.max(at(cfg.pMid), lo), hi);
    stats.set(voice, { n: s.length, lo, mid, hi, min: s[0], max: s.at(-1) });
  }

  // 三点分段线性：p5→floor、p50→mid、p95→ceiling。只用两端拉伸会让整首曲子偏轻
  // （绝大多数音落在被压缩的低段），加上中点锚才既拉开动态又不丢"中强"的基本位置。
  const toMidi = (v, st) => {
    let x;
    if (v <= st.lo) x = cfg.floor;
    else if (v <= st.mid) x = cfg.floor + (cfg.mid - cfg.floor) * ((v - st.lo) / (st.mid - st.lo));
    else if (v <= st.hi) x = cfg.mid + (cfg.ceiling - cfg.mid) * ((v - st.mid) / (st.hi - st.mid));
    else x = cfg.ceiling;
    if (cfg.curve !== 1) {
      const t = clamp01((x - cfg.floor) / (cfg.ceiling - cfg.floor));
      x = cfg.floor + (cfg.ceiling - cfg.floor) * t ** cfg.curve;
    }
    return Math.round(x);
  };
  return notes.map((n, i) => {
    const voice = voices[i];
    if (voice === 'perc') return { ...n, velMidi: null };
    const st = stats.get(voice);
    if (!st) return { ...n, velMidi: null };
    const v = Number(n.velocity);
    if (!Number.isFinite(v) || v <= 0) return { ...n, velMidi: cfg.floor };   // 无证据 → 地板
    return { ...n, velMidi: Math.max(cfg.floor, Math.min(cfg.ceiling, toMidi(v, st))) };
  });
}

/** velMidi → 线性振幅（1 → -18dB，127 → 0dB）；volume 参数直接用它 */
export function velMidiToAmplitude(velMidi, rangeDb = DYNAMICS_DEFAULTS.rangeDb) {
  const v = Math.max(1, Math.min(127, Number(velMidi)));
  return 10 ** (((v - 127) / 126) * rangeDb / 20);
}

export const PHRASE_DEFAULTS = {
  windowSec: 1.5,   // 平滑窗：乐句级（~1.5s）而不是逐音
  pLow: 0.10,       // 平滑后的分位数下界
  pHigh: 0.90,      // 上界
  floor: 52,        // 只留 ~6.5dB 的动态：逐音 26 级的跳变听感上就是"乱"，乐句级才像人弹的
  ceiling: 104,
};

export const INTERPRET_DEFAULTS = {
  floor: 56,        // 最安静的段落 → 中弱
  ceiling: 104,     // 全曲高点 → 强
  shapeWeight: 0.45, // 段内弧线（平滑实测）的权重；剩下给"段电平"（乐曲结构）
};

/**
 * 段落解读（M3-15）：像演奏家那样按"乐曲某段的特点"分配力度，而不是逐音跟测量走。
 *
 * 模型 = **段电平**（该段在源曲里的相对响度，0..1，按段落分位排名得到）× (1-w)
 *      + **段内弧线**（该段内部平滑后的实测曲线，归一化到 0..1）× w
 * 然后压到 floor..ceiling。段电平负责"这一段的性格"（前奏弱/副歌强/尾声收），
 * 段内弧线负责"这一句内部的走向"（渐强、渐弱、落句）。
 *
 * 段落表是可编辑的 JSON（`build/dynamics-sections.json`）——改 `level` 就是改"我的理解"。
 * @param {Array<{timeSec?:number, time?:number}>} notes
 * @param {Array<{start:number,end:number,level:number}>} sections
 */
export function interpretVelMidi(notes, sections, opts = {}) {
  const cfg = { ...INTERPRET_DEFAULTS, ...opts };
  const phrase = phraseVelMidi(notes, cfg.base ?? {});
  const ts = notes.map((n, i) => Number(n.timeSec ?? n.time ?? phrase[i]?.timeSec ?? NaN));
  const secOf = (t) => sections.find((s) => t >= s.start && t < s.end) ?? sections.at(-1);

  // 段内归一：拿该段内部各音的音高走线当"弧线形状"
  const shapes = new Map();
  for (const s of sections) {
    const vals = [];
    ts.forEach((t, i) => { if (t >= s.start && t < s.end && phrase[i].velMidi !== null) vals.push(phrase[i].velMidi); });
    if (!vals.length) { shapes.set(s, null); continue; }
    const sorted = [...vals].sort((a, b) => a - b);
    const at = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))];
    shapes.set(s, { lo: at(0.1), hi: at(0.9) });
  }
  return phrase.map((n, i) => {
    if (n.velMidi === null || !Number.isFinite(ts[i])) return { ...n, velMidi: n.velMidi };
    const sec = secOf(ts[i]);
    const sh = shapes.get(sec);
    const shape = sh && sh.hi > sh.lo ? Math.max(0, Math.min(1, (n.velMidi - sh.lo) / (sh.hi - sh.lo))) : 0.5;
    const level = Math.max(0, Math.min(1, Number(sec.level) || 0));
    const mixed = level * (1 - cfg.shapeWeight) + shape * cfg.shapeWeight;
    return { ...n, velMidi: Math.round(cfg.floor + (cfg.ceiling - cfg.floor) * mixed) };
  });
}

/**
 * 乐句级力度（M3-14b）：把逐音 velMidi 用**时间窗中位数**平滑，再压到较窄的范围。
 *
 * 为什么需要它：逐音 velMidi 虽然指标上"动态更大"，但实测相邻音跳变中位 26 级、p90 68 级、
 * 42% 的相邻音跳变 >32 级 —— 听感上就是"每颗音随机强弱"，用户判定"完全不如恒定力度"。
 * 平滑后同一乐句里的音落在同一档，只在乐句之间起伏（= 人实际弹琴的样子）。
 *
 * @param {Array<{instrument?:string, velocity?:number, timeSec?:number, time?:number}>} notes
 */
export function phraseVelMidi(notes, opts = {}) {
  const cfg = { ...PHRASE_DEFAULTS, ...opts };
  // 注意：短语档的 floor/ceiling 只作用于"平滑后再压范围"这一步，不能漏进逐音归一
  // （否则窄档会把逐音拉伸的上限也改掉，实测会让整段力度整体偏移）。
  const base = assignVelMidi(notes, cfg.base ?? {});
  const timed = base
    .map((n, i) => ({ i, v: n.velMidi, t: Number(n.timeSec ?? n.time ?? NaN) }))
    .filter((x) => x.v !== null && Number.isFinite(x.t))
    .sort((a, b) => a.t - b.t);
  if (!timed.length) return base;

  const smoothed = new Map();
  for (const x of timed) {
    const win = [];
    for (const y of timed) {
      if (Math.abs(y.t - x.t) <= cfg.windowSec / 2) win.push(y.v);
    }
    win.sort((a, b) => a - b);
    // 截尾均值（去掉两端 10%）而不是中位数：中位数在"逐音交替抖动"的序列上会随窗口相位来回翻，
    // 实测夹具里就会出现 52↔76 的跳变；截尾均值既抗离群又能给出连续曲线。
    const cut = Math.floor(win.length * 0.1);
    const core = win.slice(cut, win.length - cut || win.length);
    smoothed.set(x.i, core.reduce((a, b) => a + b, 0) / core.length);
  }
  const vals = [...smoothed.values()].sort((a, b) => a - b);
  const at = (p) => vals[Math.min(vals.length - 1, Math.max(0, Math.round((vals.length - 1) * p)))];
  const lo = at(cfg.pLow);
  const hi = Math.max(at(cfg.pHigh), lo + 1);
  return base.map((n, i) => {
    if (!smoothed.has(i)) return n;
    const t = Math.max(0, Math.min(1, (smoothed.get(i) - lo) / (hi - lo)));
    return { ...n, velMidi: Math.round(cfg.floor + (cfg.ceiling - cfg.floor) * t) };
  });
}

/** 给日志/报告用的可读统计 */
export function describeVelMidi(notes) {
  const out = {};
  for (const n of notes) {
    const voice = voiceOfInstrument(n.instrument);
    if (!out[voice]) out[voice] = { n: 0, withVel: 0, min: null, max: null, hist: {} };
    const rec = out[voice];
    rec.n++;
    if (n.velMidi === null || n.velMidi === undefined) continue;
    rec.withVel++;
    rec.min = rec.min === null ? n.velMidi : Math.min(rec.min, n.velMidi);
    rec.max = rec.max === null ? n.velMidi : Math.max(rec.max, n.velMidi);
    const bucket = `${Math.floor(n.velMidi / 16) * 16}-${Math.floor(n.velMidi / 16) * 16 + 15}`;
    rec.hist[bucket] = (rec.hist[bucket] ?? 0) + 1;
  }
  return out;
}

/* ---------------------------------------------------------------- CLI */
export function readCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  const rows = lines.slice(1).filter((l) => l.trim()).map((l) => l.split(','));
  return { header, rows };
}

/** 按 header 对齐写出（不足的列补空——修掉"主谱面 12 列 + 打击乐 7 列"混排的历史问题） */
export function writeCsv(header, rows) {
  const body = rows.map((r) => header.map((_, i) => (r[i] ?? '').toString().trim()).join(','));
  return [header.join(','), ...body].join('\n') + '\n';
}

/**
 * 给 CSV 文本补 `velMidi` 列。
 * @param {string} text
 * @param {{mode?:'measured'|'phrase', [k:string]:any}} [opts] mode 默认 measured
 */
export function addVelMidiColumn(text, opts = {}) {
  const { mode = 'measured', ...rest } = opts;
  const { header, rows } = readCsv(text);
  const iInstr = header.indexOf('instrument');
  const iVel = header.indexOf('velocity');
  const iTime = header.indexOf('time_seconds');
  const notes = rows.map((r) => ({
    instrument: iInstr >= 0 ? r[iInstr] : '',
    velocity: iVel >= 0 ? Number(r[iVel]) : NaN,
    timeSec: iTime >= 0 ? Number(r[iTime]) : NaN,
  }));
  const assign = mode === 'phrase' ? phraseVelMidi : assignVelMidi;
  const withDyn = assign(notes, rest);
  const outHeader = header.includes('velMidi') ? header : [...header, 'velMidi'];
  const iOut = outHeader.indexOf('velMidi');
  const outRows = rows.map((r, i) => {
    const aligned = outHeader.map((col) => {
      const j = header.indexOf(col);
      return j >= 0 ? (r[j] ?? '') : '';
    });
    aligned[iOut] = withDyn[i].velMidi === null ? '' : String(withDyn[i].velMidi);
    return aligned;
  });
  return { header: outHeader, rows: outRows, notes: withDyn };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/arrange/dynamics.mjs');
if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const P = resolvePaths();
  const IN = opt('in', P.machineScore);
  const OUT = opt('out', P.file('pipeline_6b_dynamics.csv'));
  const MODE = String(opt('mode', 'measured'));
  if (!['measured', 'phrase'].includes(MODE)) throw new Error('--mode 只支持 measured/phrase');
  const { header, rows, notes } = addVelMidiColumn(fs.readFileSync(IN, 'utf8'), { mode: MODE });
  fs.writeFileSync(OUT, writeCsv(header, rows), 'utf8');
  const stats = describeVelMidi(notes);
  console.log(`${IN.split(/[\\/]/).pop()} + velMidi（mode=${MODE}）→ ${OUT.split(/[\\/]/).pop()}（${rows.length} 行）`);
  for (const [voice, s] of Object.entries(stats)) {
    console.log(`  ${voice}: ${s.n} 行，其中 ${s.withVel} 行有力度；velMidi ${s.min ?? '-'}..${s.max ?? '-'}`
      + `；分布 ${Object.entries(s.hist).sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  }
}
