#!/usr/bin/env node
// M3-32 · 成片合成：把"画面"（ReplayMod 渲染 / OBS 录制）与"无损母版音轨"合到一起
//
// 为什么要这一步：画面是从游戏里录的（帧率/分辨率由渲染决定），而音轨我们用离线母版
// （48k/24bit，`build/master/styx_master_48k24bit.wav`）——两者必须按**同一条时间轴**对齐：
// 录制通常从"按下开始"起算，音乐是之后再起的，所以音频要往后推 `--offset` 秒。
//
// 用法：
//   node tools/mux-video.mjs --video D:/render/styx.mp4 --offset 3.2 --out build/final/styx_final.mkv
//   node tools/mux-video.mjs --video ... --audio build/master/styx_master_48k24bit.wav --check
//
// 产物：MKV（视频流直接 copy，音轨 PCM 48k/24bit = 无损，可直接投 B 站 hi-res）
//      `--aac` 可改成 MP4+AAC 320k（兼容优先）；`--loudness -14` 可加 EBU R128 归一（默认关）。
//      `--flac` 音轨用 FLAC（同样无损，但体积只有 PCM 的 ~1/4）。
//
// M3-75：默认音轨改成**自动挑最新的母版**（`build/master_v2/` 里的 *48k24bit.wav`，没有才退回旧的
// `build/master/`）。这条路径就是 ReplayMod 出片的正解 —— ReplayMod 2.6.27 本身**完全没有音频功能**
// （jar 里没有任何音频类，语言文件里也没有音频选项），它只渲染画面；音轨必须在这里合进去。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { resolvePaths } from '../src/core/paths.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const VIDEO = opt('video');
if (!VIDEO) throw new Error('缺少 --video <渲染出来的视频>');

/**
 * 默认音轨：优先最新的 `build/master_v2/*_48k24bit.wav`（**排除 stem_** —— 分轨文件比合成母版写得晚，
 * 按 mtime 排序会误选成 bass 分轨，实测踩过），再退回 `build/master/styx_master_48k24bit.wav`
 */
function defaultAudio() {
  for (const dir of [path.join(P.build, 'master_v2'), path.join(P.build, 'master')]) {
    if (!fs.existsSync(dir)) continue;
    const cands = fs.readdirSync(dir)
      .filter((f) => /_48k24bit\.wav$/.test(f) && !/stem_/i.test(f))
      .sort((a, b) => (/(^|_)master/i.test(b) ? 1 : 0) - (/(^|_)master/i.test(a) ? 1 : 0))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    if (cands.length) return path.join(dir, cands[0].f);
  }
  return path.join(P.build, 'master', 'styx_master_48k24bit.wav');
}
const AUDIO = opt('audio', defaultAudio());
const OFFSET = Number(opt('offset', '0'));      // 音乐在视频里从第几秒开始
const TAIL = Number(opt('tail', '6'));          // 结尾多留几秒（画面延续）
const AAC = has('aac');
const FLAC = has('flac');
const OUT = opt('out', path.join(P.build, 'final', `styx_final.${AAC ? 'mp4' : 'mkv'}`));
const LOUDNESS = opt('loudness', null);         // 例如 -14（EBU R128）

const probe = (file) => JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format',
  '-of', 'json', file], { encoding: 'utf8' }));
const fmt = (p) => {
  const v = p.streams.find((s) => s.codec_type === 'video');
  const a = p.streams.find((s) => s.codec_type === 'audio');
  return {
    duration: Number(p.format.duration),
    video: v ? `${v.codec_name} ${v.width}x${v.height} ${v.avg_frame_rate}fps` : '（无视频）',
    audio: a ? `${a.codec_name} ${a.sample_rate}Hz ${a.channels}ch` : '（无音频）',
  };
};

if (!fs.existsSync(AUDIO)) throw new Error(`找不到音轨母版：${AUDIO}（先跑 render-ensemble --master-kit）`);
if (!fs.existsSync(VIDEO)) throw new Error(`找不到视频：${VIDEO}`);
const pv = fmt(probe(VIDEO));
const pa = fmt(probe(AUDIO));
console.log(`视频：${path.basename(VIDEO)}  ${pv.video}  时长 ${pv.duration.toFixed(2)}s`);
console.log(`音轨：${path.basename(AUDIO)}  ${pa.audio}  时长 ${pa.duration.toFixed(2)}s（无损母版）`);
console.log(`对齐：音轨从视频第 ${OFFSET}s 处开始；结尾多留 ${TAIL}s 画面`);
const need = OFFSET + pa.duration;
if (pv.duration + 0.05 < need) {
  console.warn(`⚠️ 视频比"偏移+音轨"短 ${(need - pv.duration).toFixed(2)}s —— 结尾会被截断。`
    + '建议重录时多留几秒，或把 --offset 调小。');
} else if (pv.duration > need + TAIL + 1) {
  console.log(`提示：视频比需要的长 ${(pv.duration - need).toFixed(2)}s（多出来的部分保留为片尾）`);
}
if (has('check')) {
  console.log('（--check：只体检不合成）');
  process.exit(0);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
const args = ['-y', '-v', 'error'];
if (OFFSET > 0) args.push('-itsoffset', String(OFFSET));
args.push('-i', AUDIO, '-i', VIDEO);
const audioFilter = LOUDNESS ? ['-af', `loudnorm=I=${LOUDNESS}:TP=-1.5:LRA=11`] : [];
if (AAC) {
  execFileSync('ffmpeg', [...args, '-map', '1:v', '-map', '0:a', '-c:v', 'copy',
    ...(audioFilter.length ? audioFilter : []), '-c:a', 'aac', '-b:a', '320k', '-shortest', OUT]);
} else if (FLAC) {
  execFileSync('ffmpeg', [...args, '-map', '1:v', '-map', '0:a', '-c:v', 'copy',
    ...(audioFilter.length ? audioFilter : []), '-c:a', 'flac', '-compression_level', '8', '-shortest', OUT]);
} else {
  execFileSync('ffmpeg', [...args, '-map', '1:v', '-map', '0:a', '-c:v', 'copy',
    ...(audioFilter.length ? audioFilter : []), '-c:a', 'pcm_s24le', '-ar', '48000', '-shortest', OUT]);
}
const po = fmt(probe(OUT));
console.log(`成片：${OUT.replace(/\\/g, '/')}  ${po.video} + ${po.audio}  时长 ${po.duration.toFixed(2)}s`);
console.log(LOUDNESS ? `（已做 EBU R128 归一 I=${LOUDNESS} LUFS —— 注意这会改动母版电平）`
  : (FLAC ? '（音轨未做任何电平处理，FLAC 无损，就是母版本身）' : '（音轨未做任何电平处理，就是无损母版本身）'));
