// M3-13 · WAV 读取的位深守卫
//
// 为什么单独立一条：`readWav` 旧实现只认 8/16/32bit，遇到 24bit 直接抛
// "不支持的位深: 24"。而我们要用的两套真乐器库里 24bit 是常态：
//   · Salamander Grand Piano V3 **48kHz/24bit 完整母版**（用户明确指定用它，不要 Ogg 包）
//   · VSCO 2 CE 里约四成采样是 24bit（随机抽 120 个：48 个 pcm_s24le）
// 所以这条守卫保的是"母版跑不起来/整曲渲染随机炸"这类真实故障。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { readWav } from '../src/analyze/dsp.mjs';

/** 手工拼一个 24bit PCM WAV（values 为交错排列的 [-1,1] 浮点） */
function wav24(values, { channels = 1, sampleRate = 48000 } = {}) {
  const data = Buffer.alloc(values.length * 3);
  values.forEach((v, i) => {
    const x = Math.max(-1, Math.min(1, v));
    const q = Math.round(x * 8388607);
    const u = q < 0 ? q + 0x1000000 : q;
    data.writeUInt8(u & 0xff, i * 3);
    data.writeUInt8((u >> 8) & 0xff, i * 3 + 1);
    data.writeUInt8((u >> 16) & 0xff, i * 3 + 2);
  });
  const buf = Buffer.alloc(44 + data.length);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + data.length, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 3, 28);
  buf.writeUInt16LE(channels * 3, 32);
  buf.writeUInt16LE(24, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(data.length, 40);
  data.copy(buf, 44);
  return buf;
}

test('24bit 单声道：取值正确（含负数符号扩展，不是无符号读法）', () => {
  const src = [0, 0.5, -0.5, 0.999999, -0.999999, 0.25, -0.25];
  const w = readWav(wav24(src));
  assert.equal(w.bits, 24);
  assert.equal(w.frames, src.length);
  assert.equal(w.sampleRate, 48000);
  src.forEach((v, i) => assert.ok(Math.abs(w.samples[i] - v) < 1e-4, `#${i}: ${w.samples[i]} ≠ ${v}`));
});

test('24bit 立体声：按均值混单声道（L=-1, R=1 → 0）', () => {
  const w = readWav(wav24([-1, 1, -0.5, 0.5], { channels: 2 }));
  assert.equal(w.channels, 2);
  assert.equal(w.frames, 2);
  assert.ok(Math.abs(w.samples[0]) < 1e-4, `期望 0，实得 ${w.samples[0]}`);
  assert.ok(Math.abs(w.samples[1]) < 1e-4, `期望 0，实得 ${w.samples[1]}`);
});

test('真库自检（本机存在才跑）：Salamander 48k/24bit 母版每个采样都读得进来且非静音', () => {
  const ROOT = 'C:/Users/hiliang/Documents/minecraft/_toolchain/piano/salamander48/SalamanderGrandPianoV3_48khz24bit';
  if (!fs.existsSync(ROOT)) return;                      // 库不在（换机器）就跳过
  const wavs = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.wav$/i.test(e.name)) wavs.push(p);
    }
  })(ROOT);
  assert.ok(wavs.length > 600, `母版应有 600+ 个采样，实得 ${wavs.length}`);
  let checked = 0;
  for (const f of wavs.slice(0, 40)) {
    const w = readWav(f);
    assert.equal(w.bits, 24, `${path.basename(f)} 位深应为 24`);
    let peak = 0;
    for (const v of w.samples) peak = Math.max(peak, Math.abs(v));
    assert.ok(peak > 0.005, `${path.basename(f)} 峰值 ${peak} 太低，疑似读成垃圾`);
    checked++;
  }
  assert.ok(checked >= 40, `实读 ${checked} 个`);
});
