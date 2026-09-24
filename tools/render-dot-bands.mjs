#!/usr/bin/env node
/**
 * 把"点阵封面"切成条带，供开场**分批生成**粒子用。
 *
 * 为什么需要：`image-matrix` 一条命令会把整张图的所有不透明像素一次性 spawn 出来。
 * 96² = 9216 颗一次生成会让客户端卡 1~3 帧（实测：开场交叉过渡附近连掉 3 帧），
 * 所以切成 N 条、按刻分散生成 → 每刻只 +几百颗，不会掉帧。
 *
 * 两种切法（`--mode`）：
 *   · `rows`（旧）：横向条带，第 i 条 = 第 i 段行 → 打印方向"自上而下逐行"。
 *   · `diagonal`（2026-09-24 用户口径）：**从左下角到右上角的斜带**按面积均分，
 *     第 0 条只含左上角那一小块、最后一条只含右下角那一小块 → 打印方向
 *     "从左上角一路推到右下角"。每带像素数基本相等（等墨水流量），扫过时不会
 *     在中间突然变快/变慢。
 *
 * 产物是**带 alpha 的条带图**（条带外 alpha=0，引擎会跳过透明像素）：
 *   <gameDir>/particleImages/styx-dot-b{N}.png
 *   —— 含专辑封面，产物不进 git（本脚本进 git）。
 *
 * 用法：
 *   node tools/render-dot-bands.mjs --game "<游戏目录>" [--cover "<封面png>"]
 *        [--size 96] [--bands 24] [--mode diagonal|rows]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const gameDir = args.get('game');
const size = Number(args.get('size') ?? 96);
const bands = Number(args.get('bands') ?? 12);
const mode = args.get('mode') ?? 'rows';
if (!gameDir) {
  console.error('用法: node render-dot-bands.mjs --game "<游戏目录>" [--cover "<封面png>"] [--size 96] [--bands 24] [--mode diagonal|rows]');
  process.exit(1);
}
const out = path.join(gameDir, 'particleImages');
fs.mkdirSync(out, { recursive: true });

const run = (argv) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...argv], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('ffmpeg 失败:', r.stderr?.trim());
    process.exit(1);
  }
};

// 1) 基准点阵图（没有就从封面现做）
const base = path.join(out, `styx-cover-${size}.png`);
if (!fs.existsSync(base)) {
  const cover = args.get('cover');
  if (!cover || !fs.existsSync(cover)) {
    console.error(`缺少 ${base}，且没有可用的 --cover`);
    process.exit(1);
  }
  run(['-i', cover, '-vf', `scale=${size}:${size}:flags=lanczos,unsharp=3:3:0.5`, '-frames:v', '1', base]);
  console.log('生成', base);
}

/** 条带边界（闭区间 [lo, hi]），单位：rows 模式 = Y；diagonal 模式 = X+Y */
const bounds = [];
if (mode === 'rows') {
  const rows = Math.ceil(size / bands);
  for (let i = 0; i < bands; i++) {
    const y0 = i * rows;
    bounds.push([y0, Math.min(size, y0 + rows) - 1]);
  }
} else if (mode === 'diagonal') {
  // X+Y ∈ [0, 2*(size-1)]，等面积切分（三角形分布 → 边界在角上密、中间稀）
  const maxD = 2 * (size - 1);
  const w = (d) => Math.min(d, maxD - d) + 1;          // 该条对角线上的像素数
  const cum = [0];
  for (let d = 0; d <= maxD; d++) cum.push(cum[d] + w(d));
  const total = cum[maxD + 1];
  /** 第一个满足 cum[i] >= target 的 i */
  const at = (target) => {
    let i = 0;
    while (i < cum.length && cum[i] < target) i++;
    return i;
  };
  for (let i = 0; i < bands; i++) {
    const lo = Math.max(0, at(Math.round((total * i) / bands)) - 1);
    const hi = i === bands - 1 ? maxD : Math.min(maxD, at(Math.round((total * (i + 1)) / bands)));
    bounds.push([lo, hi]);   // 两端各放宽一格 → 相邻带重叠 1 像素，接缝不会露点
  }
} else {
  console.error(`未知 --mode ${mode}（可用：rows / diagonal）`);
  process.exit(1);
}

// 2) 逐条生成：只保留本条带内的像素（alpha=255），其余全透明
for (let i = 0; i < bounds.length; i++) {
  const [lo, hi] = bounds[i];
  const coord = mode === 'rows' ? 'Y' : '(X+Y)';
  const file = path.join(out, `styx-dot-b${String(i).padStart(2, '0')}.png`);
  const geq = `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(${coord},${lo},${hi}),255,0)'`;
  run(['-i', base, '-vf', geq, '-frames:v', '1', file]);
  console.log(file, `${mode === 'rows' ? 'rows' : 'X+Y'} ${lo}..${hi}`);
}
console.log(`已生成 ${bands} 条（mode=${mode}，size=${size}）`);
