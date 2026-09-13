// M2-1 · OGG 编解码薄封装（只调用本机 ffmpeg；Node 侧零依赖）
//
// 为什么用 ffmpeg 而不是自己写 Vorbis 编码器：Minecraft 资源包只吃 ogg/vorbis，
// 而 Vorbis 编码器不是"几百行能写对"的东西（要 psychoacoustic 模型 + 码本）。
// 任务书允许"WAV 后用 ffmpeg 转 ogg"；本机没有 ffmpeg 时 render-all.mjs 会只出 WAV 并如实说明。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

import { readWav } from '../analyze/dsp.mjs';

import { SAMPLE_RATE } from './synth.mjs';

let available = null;

/** ffmpeg 是否可用（结果缓存；失败不抛异常） */
export function ffmpegAvailable() {
  if (available === null) {
    try {
      execFileSync('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
      available = true;
    } catch {
      available = false;
    }
  }
  return available;
}

/** WAV → OGG/Vorbis（单声道）。返回 ogg 文件字节数。 */
export function encodeOgg({ wavPath, oggPath, quality = 4, sampleRate = SAMPLE_RATE }) {
  execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
    '-i', wavPath,
    '-c:a', 'libvorbis', '-q:a', String(quality),
    '-ac', '1', '-ar', String(sampleRate),
    oggPath,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  return fs.statSync(oggPath).size;
}

/** OGG → 单声道浮点样本（用 ffmpeg 解码到 WAV 再从内存读）——验收"容器里的音高对不对" */
export function decodeOggSamples(oggPath, { sampleRate = SAMPLE_RATE } = {}) {
  const buf = execFileSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', oggPath,
    '-f', 'wav', '-c:a', 'pcm_s16le', '-ac', '1', '-ar', String(sampleRate),
    '-',
  ], { maxBuffer: 512 * 1024 * 1024 });
  return readWav(buf).samples;
}
