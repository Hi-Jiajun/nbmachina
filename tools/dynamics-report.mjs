#!/usr/bin/env node
// M3-15 · 力度编排报告：把"这首曲子怎么安排强弱"变成一张能看、能改的表 + 一张曲线图
//
// 用户问题（2026-09-15）："我想知道你是怎样编排力度的——演奏家多是按情感、乐曲某段特点来区分力度，
// 从而体现自己对琴曲的独特理解。"
//
// 这个工具做三件事：
//   ① 从**源曲音频**（P.audio，与谱面同一时间轴）算出 0.25s 步进的短时响度包络（dB）；
//   ② 用一维 k-means 把全曲切成 K 段（默认 12 段、每段至少 8s）——这就是"乐曲某段特点"的机器版，
//      段电平 = 该段响度的分位数归一值（0..1）；
//   ③ 写三份产物：
//        build/dynamics-sections.json  段表（**可手改**：level/arc 改完重跑渲染即生效）
//        build/dynamics-report.md      段表 + 与三种力度口径的对照
//        build/dynamics-curve.png      曲线图（需要 _toolchain/py312 的 Pillow）
//
// 用法：node tools/dynamics-report.mjs [--k 12] [--min-sec 8] [--out build]
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWav } from '../src/analyze/dsp.mjs';
import { resolvePaths } from '../src/core/paths.mjs';
import { interpretVelMidi, phraseVelMidi, velMidiToAmplitude } from '../src/arrange/dynamics.mjs';
import { parseScoreCsv } from '../src/emit/playsound-hifi.mjs';
import { STEP_SECONDS } from '../src/emit/tick-map.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const K = Number(opt('k', 12));
const MIN_SEC = Number(opt('min-sec', 8));
const HOP = 0.25;
const PY = 'C:/Users/hiliang/Documents/minecraft/_toolchain/py312/python.exe';
/** 画图脚本按**本文件所在目录**解析：从仓库外（cwd=workspace 根）跑时 path.resolve 会指错 */
const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ---------------------------------------------------------------- ① 响度包络 */
const audio = readWav(P.audio);
const win = Math.round(0.5 * audio.sampleRate);
const hop = Math.round(HOP * audio.sampleRate);
const envelope = [];
for (let i = 0; i + win <= audio.samples.length; i += hop) {
  let acc = 0;
  for (let j = i; j < i + win; j++) acc += audio.samples[j] * audio.samples[j];
  const rms = Math.sqrt(acc / win);
  envelope.push({ t: i / audio.sampleRate, db: 20 * Math.log10(Math.max(rms, 1e-6)) });
}
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1]; };
const at = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]; };

/* ---------------------------------------------------------------- ② 段落切分（一维 k-means） */
const dbs = envelope.map((e) => e.db);
const sorted = [...dbs].sort((a, b) => a - b);
const lo = sorted[Math.floor(sorted.length * 0.05)];
const hi = sorted[Math.floor(sorted.length * 0.95)];
const norm = (db) => Math.max(0, Math.min(1, (db - lo) / Math.max(1e-6, hi - lo)));

/** 有最小段长约束的一维 k-means（把响度分成 K 档，再按时间顺序合并成段）
 *  注意：合并时必须保持 frames **有序**——否则 start/end 会算反（实测第一版 33 段全是 start>end）。 */
function segmentByLevel(values, k, minFrames) {
  let centers = Array.from({ length: k }, (_, i) => lo + (hi - lo) * (i / (k - 1)));
  let assign = values.map(() => 0);
  for (let iter = 0; iter < 30; iter++) {
    assign = values.map((v) => {
      let best = 0, bd = Infinity;
      centers.forEach((c, i) => { const d = Math.abs(v - c); if (d < bd) { bd = d; best = i; } });
      return best;
    });
    const next = centers.map((c, i) => {
      const g = values.filter((_, j) => assign[j] === i);
      return g.length ? g.reduce((a, b) => a + b, 0) / g.length : c;
    });
    if (next.every((c, i) => Math.abs(c - centers[i]) < 1e-6)) break;
    centers = next;
  }
  // 相邻同档 → 段
  let segs = [];
  assign.forEach((a, i) => {
    const last = segs.at(-1);
    if (last && last.level === a) last.frames.push(i);
    else segs.push({ level: a, frames: [i] });
  });
  // 反复把"最短的段"并进电平最接近的邻居，直到所有段 ≥ minFrames
  while (segs.length > 1 && segs.some((s) => s.frames.length < minFrames)) {
    let idx = 0;
    for (let i = 1; i < segs.length; i++) if (segs[i].frames.length < segs[idx].frames.length) idx = i;
    const cur = segs[idx], prev = segs[idx - 1], next = segs[idx + 1];
    const mergeIntoPrev = !next || (prev && Math.abs(prev.level - cur.level) <= Math.abs(next.level - cur.level));
    if (mergeIntoPrev && prev) prev.frames = prev.frames.concat(cur.frames);
    else if (next) next.frames = cur.frames.concat(next.frames);
    else break;
    segs.splice(idx, 1);
  }
  return segs;
}

const minFrames = Math.max(1, Math.round(MIN_SEC / HOP));
const segs = segmentByLevel(dbs, K, minFrames);
/** 段电平 = 该段响度在全曲响度里的分位排名（0..1）。
 *  不用"幅度归一"是因为源曲是响度压缩过的流行混音：除个别段落外都挤在高位，
 *  按幅度归一得到的段电平全在 0.7~0.98（实测），做出来的力度几乎没有段落对比。 */
const rankOf = (db) => {
  let c = 0;
  for (const x of dbs) if (x < db) c++;
  return c / dbs.length;
};
const sections = segs.map((s) => {
  const t0 = envelope[s.frames[0]].t;
  const t1 = envelope[s.frames.at(-1)].t + HOP;
  const segDb = s.frames.map((i) => dbs[i]);
  const level = rankOf(median(segDb));
  return { start: +t0.toFixed(2), end: +t1.toFixed(2), level: +level.toFixed(3), loudnessDb: +median(segDb).toFixed(1) };
});
// 补一个"性格标签"：按段电平高低（人看表更直观）
for (const s of sections) {
  s.label = s.level >= 0.75 ? '强（全曲高点）' : s.level >= 0.55 ? '中强' : s.level >= 0.35 ? '中' : s.level >= 0.18 ? '中弱' : '弱（安静段）';
}

/* ---------------------------------------------------------------- ③ 三种口径的力度序列 */
const { notes } = parseScoreCsv(fs.readFileSync(P.machineScore, 'utf8'));
const withT = notes.map((n) => ({ ...n, timeSec: n.step * STEP_SECONDS }));
const phrase = phraseVelMidi(withT).map((n) => n.velMidi);

const interpret = interpretVelMidi(withT, sections).map((n) => n.velMidi);
const flat = withT.map((n) => (n.instr === 'harp' ? Math.round(0.35 * 127) : null));

/* ---------------------------------------------------------------- 段表（含三种口径的均值） */
const bySection = sections.map((s) => {
  // 用 `velocity`（谱面里始终有）判断"这颗音有力度信息"，不要用 velMidi
  // —— `--dynamics off` 的谱面根本没有这一列（实测第一版这里全是"旋律 0 颗"）。
  const sel = withT.map((n, i) => (n.timeSec >= s.start && n.timeSec < s.end && Number.isFinite(n.velocity) ? i : -1)).filter((i) => i >= 0);
  const harpIdx = sel.filter((i) => withT[i].instr === 'harp');
  const meanAt = (arr) => (harpIdx.length ? harpIdx.reduce((a, i) => a + arr[i], 0) / harpIdx.length : null);
  return {
    ...s,
    notes: sel.length,
    melody: harpIdx.length,
    phrase: meanAt(phrase) === null ? null : +meanAt(phrase).toFixed(1),
    interpret: meanAt(interpret) === null ? null : +meanAt(interpret).toFixed(1),
  };
});

fs.writeFileSync(path.join(P.build, 'dynamics-sections.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: P.audio,
  note: '段电平 level 来自源曲响度（0..1）；手改 level 后重跑渲染即生效；shapeWeight 控制"段内弧线"占比',
  shapeWeight: 0.55,
  sections: bySection.map(({ start, end, level, label, loudnessDb }) => ({ start, end, level, label, loudnessDb })),
}, null, 2) + '\n', 'utf8');

const md = [
  '# 力度编排报告（自动生成）',
  '',
  `源曲：\`${P.audio}\`（与谱面同一时间轴）；包络步进 ${HOP}s / 窗 0.5s；段落 = 一维 k-means（K=${K}，最短 ${MIN_SEC}s）。`,
  '',
  '| # | 时间段 | 长度 | 段电平 | 性格 | 源曲响度 | 音符数 | 旋律数 | 乐句级均值 | 段落解读均值 |',
  '|---|---|---|---|---|---|---|---|---|---|',
  ...bySection.map((s, i) => `| ${i + 1} | ${s.start}–${s.end}s | ${(s.end - s.start).toFixed(1)}s | ${s.level.toFixed(2)} | ${s.label} | ${s.loudnessDb}dB | ${s.notes} | ${s.melody} | ${s.phrase ?? '—'} | ${s.interpret ?? '—'} |`),
  '',
  '> 段电平 = 该段源曲响度在 p5..p95 上的归一值；"段落解读"= 段电平（55%）+ 段内平滑后的实测弧线（45%），',
  '> 再压到 46..108。整曲曲线见 `build/dynamics-curve.png`。',
].join('\n') + '\n';
fs.writeFileSync(path.join(P.build, 'dynamics-report.md'), md, 'utf8');

// 曲线图交给 Pillow 画（本机 py312 里有 Pillow）
const plotJson = path.join(P.build, 'dynamics-curve.json');
fs.writeFileSync(plotJson, JSON.stringify({
  duration: Math.max(...envelope.map((e) => e.t)),
  sections,
  envelope: envelope.map((e) => [e.t, norm(e.db)]),
  notes: withT.map((n, i) => [n.timeSec, n.instr === 'harp', phrase[i], interpret[i]]),
}, null, 0), 'utf8');
let png = false;
if (fs.existsSync(PY)) {
  const script = path.join(HERE, 'plot-dynamics.py');
  execFileSync(PY, [script, plotJson, path.join(P.build, 'dynamics-curve.png')], { stdio: 'inherit' });
  png = true;
}

console.log(`段落 ${bySection.length} 段；段表 → build/dynamics-sections.json`);
console.log(`报告 → build/dynamics-report.md${png ? '；曲线图 → build/dynamics-curve.png' : '（未找到 py312，跳过画图）'}`);
for (const [i, s] of bySection.entries()) {
  console.log(`  ${String(i + 1).padStart(2)} ${String(s.start).padStart(6)}–${String(s.end).padStart(6)}s 电平 ${s.level.toFixed(2)} ${s.label}`
    + `  旋律 ${String(s.melody).padStart(4)} 颗  乐句级 ${s.phrase ?? '—'}  解读 ${s.interpret ?? '—'}`
    + `  （振幅 ×${(velMidiToAmplitude(s.interpret ?? 80)).toFixed(3)}）`);
}
