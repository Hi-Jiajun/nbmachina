#!/usr/bin/env node
// M3-13 · 把 M0 T5b 的实测力度并进 machine 谱面（只加 velocity / velocitySource 两列，
// 不改任何音符、音高、volume 口径）。
//
// 为什么需要它：`machine_pipeline.csv` 的 `volume` 列全曲恒定 0.350 → 离线渲染与游戏内
// playsound 都拿不到逐音力度（实测：1385 颗旋律音全落同一个采样力度层）。
// 逐音力度（从参考演奏里量出来的 `measured` / `measured-nearest-band`）只存在于中间产物
// `velocity_accent.csv`（2802 行，带 velocity 列；**dedup 版反而没有这列**）。
// 两边行数不同（3053 vs 2802），所以按 (step, instrument, midi) 做主键、
// (step, instrument, row) 退化兜底做连接；打击乐没有力度概念，留空。
//
// 用法：node tools/make-velocity-score.mjs [--build <目录>]
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const B = opt('build', resolvePaths().build);
const SRC = opt('score', path.join(B, 'machine_pipeline.csv'));
const VEL = opt('velocity', path.join(B, 'velocity_accent.csv'));
const OUT = opt('out', path.join(B, 'machine_pipeline_velocity.csv'));

/**
 * 按 (step, instrument, midi) → (step, instrument, row) 两级主键连接力度。
 * @returns {{lines: string[], matched: number, fell: number, missing: number, byInstr: Record<string, {matched:number, missing:number}>}}
 */
export function joinVelocity(srcText, velText) {
  const src = srcText.trim().split(/\r?\n/);
  const velLines = velText.trim().split(/\r?\n/);

  const vh = velLines[0].split(',');
  const vi = Object.fromEntries(['step', 'instrument', 'midi', 'row', 'velocity'].map((k) => [k, vh.indexOf(k)]));
  if (vi.velocity < 0) throw new Error('力度文件缺 velocity 列（dedup 版没有这列，要用 velocity_accent.csv）');
  const byKey = new Map();
  const byRow = new Map();
  for (const line of velLines.slice(1)) {
    const c = line.split(',');
    const v = Number(c[vi.velocity]);
    if (!Number.isFinite(v)) continue;
    const key = `${c[vi.step]}|${c[vi.instrument]}|${c[vi.midi]}`;
    if (!byKey.has(key)) byKey.set(key, v);
    const rkey = `${c[vi.step]}|${c[vi.instrument]}|${c[vi.row]}`;
    if (!byRow.has(rkey)) byRow.set(rkey, v);
  }

  const h = src[0].split(',');
  const ci = Object.fromEntries(['step', 'instrument', 'midi', 'row'].map((k) => [k, h.indexOf(k)]));
  const lines = [src[0] + ',velocity,velocitySource'];
  let matched = 0, fell = 0, missing = 0;
  const byInstr = {};
  for (const line of src.slice(1)) {
    const c = line.split(',');
    let v = byKey.get(`${c[ci.step]}|${c[ci.instrument]}|${c[ci.midi]}`);
    let how = 'key';
    if (v === undefined) { v = byRow.get(`${c[ci.step]}|${c[ci.instrument]}|${c[ci.row]}`); how = 'row'; }
    if (v === undefined) { v = ''; how = 'missing'; missing++; }
    else if (how === 'key') matched++;
    else fell++;
    const rec = byInstr[c[ci.instrument]] ?? (byInstr[c[ci.instrument]] = { matched: 0, missing: 0 });
    rec[how === 'missing' ? 'missing' : 'matched']++;
    lines.push(line + ',' + (v === '' ? '' : v) + ',' + how);
  }
  return { lines, matched, fell, missing, byInstr };
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/make-velocity-score.mjs');
if (isMain) {
  const { lines, matched, fell, missing, byInstr } = joinVelocity(
    fs.readFileSync(SRC, 'utf8'),
    fs.readFileSync(VEL, 'utf8'),
  );
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`写出 ${path.basename(OUT)}：${lines.length - 1} 行`);
  console.log(`主键命中 ${matched} / 退化键命中 ${fell} / 未命中 ${missing}`);
  console.log('按乐器：', JSON.stringify(byInstr));
}
