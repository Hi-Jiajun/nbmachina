#!/usr/bin/env node
// M3-20 · 一条命令重建"以 Animenz 视频为准"的谱面（力度取自视频，而不是原曲混音）
//
// 链路（每一步都可单独跑，这里只是把它们串起来）：
//   ① 对齐：视频实际演奏从 3.90s 开始、比谱面慢 0.7% → 生成 build/animenz_aligned.wav
//      （ffmpeg -ss <lag> -af atempo=<scale>），让它的时间轴与谱面 1:1；
//   ② 从视频重测力度：`src/arrange/velocity.mjs --accent`（与 M0 同一套口径，只是换了音源）；
//   ③ 并入 machine 谱面：`tools/make-velocity-score.mjs`（按 step/instrument/midi 连接）；
//   ④ 力度归一：`src/arrange/dynamics.mjs --mode phrase|measured`（乐句级 / 逐音）；
//   ⑤ 导出并部署 mod 谱面：`tools/export-mod-score.mjs --preset piano --deploy`。
//
// 用户听感定稿（2026-09-16）：**乐句级（phrase）好得多** → 默认就是 phrase。
//
// 用法：
//   node tools/build-video-score.mjs                    # 乐句级 + 部署到客户端与测试服
//   node tools/build-video-score.mjs --mode measured    # 改逐音档
//   node tools/build-video-score.mjs --no-deploy        # 只生成不部署
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';

const P = resolvePaths();
const B = P.build;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const VIDEO = opt('video', path.join(B, 'animenz_styx_helix_clean.wav'));
const LAG = Number(opt('lag', '4.30'));         // 视频开头多出来的引子（秒）
const SCALE = Number(opt('scale', '1.007'));    // 视频/谱面 速度比（视频略慢）
const MODE = String(opt('mode', 'phrase'));
if (!['phrase', 'measured'].includes(MODE)) throw new Error('--mode 只支持 phrase/measured');
const DEPLOY = !has('no-deploy');

const ALIGNED = path.join(B, 'animenz_aligned.wav');
const VELOCITY = path.join(B, 'velocity_video.csv');
const JOINED = path.join(B, 'machine_pipeline_video.csv');
const DYNAMICS = path.join(B, `machine_pipeline_video_${MODE}.csv`);

const run = (label, cmd, args) => {
  const t0 = Date.now();
  const out = execFileSync(cmd, args, { encoding: 'utf8' });
  const last = out.trim().split(/\r?\n/).slice(-3).join('\n    ');
  console.log(`  ${label}（${((Date.now() - t0) / 1000).toFixed(1)}s）\n    ${last}`);
};

if (!fs.existsSync(VIDEO)) throw new Error(`找不到参考视频音频：${VIDEO}`);
console.log(`以视频为准重建谱面：${path.basename(VIDEO)}（lag=${LAG}s scale=${SCALE} mode=${MODE}）`);

// ① 对齐音频
run('① 对齐视频音频', 'ffmpeg', ['-y', '-v', 'error', '-ss', String(LAG), '-i', VIDEO,
  '-af', `atempo=${SCALE}`, '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', ALIGNED]);

// ② 从视频量力度
run('② 从视频重测力度', process.execPath, [path.join('src', 'arrange', 'velocity.mjs'), '--accent',
  '--in', P.machineScore, '--out', VELOCITY, '--audio', ALIGNED,
  '--report', path.join(B, 'velocity_video_report.json')]);

// ③ 并入谱面
run('③ 并入 machine 谱面', process.execPath, [path.join('tools', 'make-velocity-score.mjs'),
  '--score', P.machineScore, '--velocity', VELOCITY, '--out', JOINED]);

// ④ 力度归一
run(`④ 力度归一（${MODE}）`, process.execPath, [path.join('src', 'arrange', 'dynamics.mjs'),
  '--in', JOINED, '--out', DYNAMICS, '--mode', MODE]);

// ⑤ 导出 mod 谱面
run('⑤ 导出 mod 谱面', process.execPath, [path.join('tools', 'export-mod-score.mjs'),
  '--in', DYNAMICS, '--preset', 'piano', ...(DEPLOY ? ['--deploy'] : [])]);

console.log(`完成：${DYNAMICS.replace(/\\/g, '/')}${DEPLOY ? '（已部署，游戏内 /nbforge score load 即可听）' : ''}`);
