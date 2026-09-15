// M3-14 · 钢琴库总表工具的两个真实回归
//
// 这两个 bug 都是本轮实际踩到的（而且都会**静默**给出错误结论）：
//   ① 用跨行正则取 `default_path=`：空值后面跟 `<global>` 时，会把 "<global>" 当目录 →
//      整库采样解析到不存在的路径，总表里体积显示 0MB、格式显示空；
//   ② 只读 512 字节的 WAV 头：OLPC 的 wav 带 BWF `bext` 块（602 字节），fmt 在 622 字节处
//      → 格式列全空。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { inspectLibrary, wavFormat } from '../tools/piano-inventory.mjs';

/** 造一个最小 WAV：junkChunk 字节数用来模拟 bext 之类的"fmt 之前的大块" */
function writeWav(file, { bits = 16, sampleRate = 44100, channels = 1, junkBytes = 0 } = {}) {
  const junk = junkBytes > 0 ? Buffer.alloc(8 + junkBytes) : Buffer.alloc(0);
  if (junkBytes > 0) {
    junk.write('bext', 0, 'ascii');
    junk.writeUInt32LE(junkBytes, 4);
  }
  const data = Buffer.alloc(64);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * channels * bits / 8, 28);
  head.writeUInt16LE(channels * bits / 8, 32);
  head.writeUInt16LE(bits, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head.subarray(0, 12), junk, head.subarray(12), data]));
}

test('wavFormat 跨过 bext 等前置块也能读到 fmt（回归：512 字节太小）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-inv-'));
  const plain = path.join(dir, 'plain.wav');
  const bext = path.join(dir, 'bext.wav');
  writeWav(plain, { bits: 24, sampleRate: 48000, channels: 2 });
  writeWav(bext, { bits: 16, sampleRate: 44100, channels: 1, junkBytes: 602 });
  assert.deepEqual(wavFormat(plain), { format: 1, channels: 2, sampleRate: 48000, bits: 24 });
  assert.deepEqual(wavFormat(bext), { format: 1, channels: 1, sampleRate: 44100, bits: 16 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('inspectLibrary：default_path 为空时按 SFZ 所在目录解析（回归：跨行正则把 <global> 当目录）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'piano-inv-'));
  writeWav(path.join(dir, 'A0v1.wav'), { bits: 16 });
  writeWav(path.join(dir, 'A0v2.wav'), { bits: 16 });
  writeWav(path.join(dir, 'C4v1.wav'), { bits: 16 });
  const sfz = path.join(dir, 'piano.sfz');
  fs.writeFileSync(sfz, [
    '<control>',
    'default_path=',          // 空值：后面紧跟 <global>，跨行正则会读成 "<global>"
    '<global>',
    'ampeg_release=0.6',
    '<region> sample=A0v1.wav lokey=21 hikey=22 pitch_keycenter=21 lovel=0 hivel=63',
    '<region> sample=A0v2.wav lokey=21 hikey=22 pitch_keycenter=21 lovel=64 hivel=127',
    '<region> sample=C4v1.wav lokey=23 hikey=127 pitch_keycenter=60 lovel=0 hivel=127',
  ].join('\n') + '\n');
  const r = inspectLibrary({ id: 't', name: 't', license: 'CC0 1.0', author: 't', sfz, role: 't' });
  assert.equal(r.regions, 3, '三个 region 全部可演奏');
  assert.deepEqual(r.roots, [21, 60]);
  assert.deepEqual(r.layers, [2, 1], 'A0 两层力度、C4 一层');
  assert.equal(r.files, 3);
  assert.ok(r.bytes > 0, `采样体积必须 > 0（解析不到文件时这里是 0）`);
  assert.equal(r.fmt?.bits, 16, 'WAV 头必须读到');
  assert.equal(r.maxShift, 48, '21..108 用最近根音的最大变调（最高根音 60 要一直管到 108）');
  fs.rmSync(dir, { recursive: true, force: true });
});
