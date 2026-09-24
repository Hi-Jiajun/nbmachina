#!/usr/bin/env node
/**
 * 把"点阵封面"切成横向条带，供开场**分批生成**粒子用。
 *
 * 为什么需要：`image-matrix` 一条命令会把整张图的所有不透明像素一次性 spawn 出来。
 * 96² = 9216 颗一次生成会让客户端卡 1~3 帧（实测：开场交叉过渡附近连掉 3 帧），
 * 所以切成 N 条、每条 8 行（96×8 = 768 颗），按刻分散成 12 条 → 每刻只 +768 颗，不会掉帧。
 *
 * 产物是**带 alpha 的条带图**（条带外 alpha=0，引擎会跳过透明像素）：
 *   <gameDir>/particleImages/styx-dot-b{N}.png
 *   —— 含专辑封面，产物不进 git（本脚本进 git）。
 *
 * 用法：
 *   node tools/render-dot-bands.mjs --game "<游戏目录>" [--cover "<封面png>"] [--size 96] [--bands 12]
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
if (!gameDir) {
  console.error('用法: node render-dot-bands.mjs --game "<游戏目录>" [--cover "<封面png>"] [--size 96] [--bands 12]');
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

// 2) 条带：第 i 条只保留 [row0,row1) 行（alpha=255），其余全透明
const rows = Math.ceil(size / bands);
for (let i = 0; i < bands; i++) {
  const row0 = i * rows;
  const row1 = Math.min(size, row0 + rows);
  const file = path.join(out, `styx-dot-b${String(i).padStart(2, '0')}.png`);
  const geq = `format=rgba,geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='if(between(Y,${row0},${row1 - 1}),255,0)'`;
  run(['-i', base, '-vf', geq, '-frames:v', '1', file]);
  console.log(file, `rows ${row0}..${row1 - 1}`);
}
console.log(`已生成 ${bands} 条（每条 ${rows} 行 → ${size * rows} 颗）`);
