// M3-11 · SFZ 采样库读取层的单测
//
// 这里守的是"真乐器库接入"最容易出错的三件事：
//   ① 音名解析（A#0 = 22，不是 21；C4 = 60）——差一位就整体跑调
//   ② 单行 region 与 group 继承 —— Salamander 用单行写法，VSCO 用块写法，两种都得认
//   ③ 区域选择（力度分层 / rr 轮换 / 音域外兜底）——选错层 = 机关枪感或力度全平
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { keyToMidi, loadSfz, parseSfzText, pickRegion } from '../src/sample/sfz.mjs';

test('音名 → midi：A#0=22、C4=60、数字原样、垃圾返回 null', () => {
  assert.equal(keyToMidi('A#0'), 22);
  assert.equal(keyToMidi('A0'), 21);
  assert.equal(keyToMidi('C4'), 60);
  assert.equal(keyToMidi('Bb-1'), 10);
  assert.equal(keyToMidi('60'), 60);
  assert.equal(keyToMidi(42), 42);
  assert.equal(keyToMidi('nope'), null);
  assert.equal(keyToMidi(''), null);
});

test('单行 region + group 继承 + 含空格的 default_path', () => {
  const text = [
    '<control>',
    'default_path=Keys\\Upright Piano\\',       // 值里有空格：不能被 opcode 切分切坏
    '<group> amp_veltrack=73 ampeg_release=1',
    '<region> sample=ogg\\A0v1.ogg lokey=21 hikey=22 lovel=1 hivel=26 pitch_keycenter=21',
    '<region> sample=ogg\\A0v2.ogg lokey=21 hikey=22 lovel=27 hivel=34 pitch_keycenter=21 volume=5',
    '<group> ampeg_release=2',                  // 新 group 必须**重置**上一个 group 的继承
    '<region> sample=ogg\\C4v1.ogg lokey=60 hikey=60 lovel=1 hivel=127 pitch_keycenter=60',
  ].join('\n');
  const { defaultPath, regions } = parseSfzText(text);
  assert.equal(defaultPath, 'Keys\\Upright Piano\\');
  assert.equal(regions.length, 3);
  assert.deepEqual(regions[0], {
    sample: 'ogg\\A0v1.ogg', loKey: 21, hiKey: 22, root: 21, loVel: 1, hiVel: 26, gainDb: 0, tuneCents: 0,
    trigger: 'attack',            // 解析器会显式标注触发类型（loadSfz 靠它丢松键层）
  });
  assert.equal(regions[1].gainDb, 5);
  assert.equal(regions[2].hiVel, 127);
});

test('区域选择：按力度分层，同区间 rr 轮换，音域外用最近区域兜底', () => {
  const regions = [
    { file: 'a_rr1.wav', loKey: 30, hiKey: 32, root: 31, loVel: 0, hiVel: 79, gainDb: 0, tuneCents: 0 },
    { file: 'a_rr2.wav', loKey: 30, hiKey: 32, root: 31, loVel: 0, hiVel: 79, gainDb: 0, tuneCents: 0 },
    { file: 'b_v3.wav', loKey: 30, hiKey: 32, root: 31, loVel: 80, hiVel: 127, gainDb: 0, tuneCents: 0 },
  ];
  assert.equal(pickRegion(regions, 31, 40, 0).file, 'a_rr1.wav');
  assert.equal(pickRegion(regions, 31, 40, 1).file, 'a_rr2.wav');
  assert.equal(pickRegion(regions, 31, 100, 0).file, 'b_v3.wav');
  // 28 落在所有区域之外 → 最近的 [30,32] 区域 + 变调（不静音）
  const far = pickRegion(regions, 28, 40, 0);
  assert.equal(far.root, 31);
  assert.equal(pickRegion([], 60, 100, 0), null);
});

test('通配区域不得抢走精确键位区域（回归：实测出现过 42 半音离谱变调）', () => {
  // 真实形态：Salamander 里既有 lokey=21 hikey=22 的精确区域，也有加料层（无 lokey/hikey，
  // 解析成 0..127）与踏板噪声（lokey=-1 hikey=-1）。若按文件名排序轮换，精确音会被通配区域抢走。
  const regions = [
    { file: 'z_wide.wav', loKey: 0, hiKey: 127, root: 60, loVel: 0, hiVel: 127, gainDb: 0, tuneCents: 0 },
    { file: 'A0v1.ogg', loKey: 21, hiKey: 22, root: 21, loVel: 1, hiVel: 26, gainDb: 0, tuneCents: 0 },
    { file: 'A0v2.ogg', loKey: 21, hiKey: 22, root: 21, loVel: 27, hiVel: 34, gainDb: 0, tuneCents: 0 },
  ];
  assert.equal(pickRegion(regions, 21, 20, 0).file, 'A0v1.ogg');
  assert.equal(pickRegion(regions, 21, 30, 0).file, 'A0v2.ogg');
  assert.equal(pickRegion(regions, 100, 20, 0).file, 'z_wide.wav', '没有任何精确区域时，通配区域才是兜底');
});

test('真库自检（本机存在才跑）：Salamander 单行写法与 VSCO 块写法都能读出区域', () => {
  const LIB = 'C:/Users/hiliang/Documents/minecraft/_toolchain/piano';
  const salamander = `${LIB}/SalamanderGrandPianoV3_OggVorbis/SalamanderGrandPianoV3.sfz`;
  const vsco = `${LIB}/vsco2ce/VSCO-2-CE-SFZ/ContrabassPizz.sfz`;
  if (!fs.existsSync(salamander) || !fs.existsSync(vsco)) return;   // 库不在（换机器）就跳过
  const s = loadSfz(salamander);
  // 口径（2026-09-15 修正）：Salamander 是 30 个录音根音（A/C/D#/F#，小三度间隔）× 16 层力度
  // = 恰好 480 个可演奏区域；Ogg 包与 48k/24bit 母版**同一套映射**（旧注释里"Ogg 只有 16 个
  // 录音点"是错的，实测两边都是 480 区域 / 30 根音，差别只在有损编码）。
  assert.equal(s.regions.length, 480, `Salamander 可演奏区域数应恰为 480（30 根音 × 16 层），实得 ${s.regions.length}`);
  assert.equal(new Set(s.regions.map((r) => r.root)).size, 30, '应落在 30 个录音根音上');
  const roots = [...new Set(s.regions.map((r) => r.root))].sort((a, b) => a - b);
  assert.equal(roots[0], 21);
  assert.equal(roots.at(-1), 108);
  assert.ok(s.regions.every((r) => fs.existsSync(r.file)), 'Salamander 每个 region 的采样都必须存在');
  // 松键层（trigger=release 的 rel*.ogg）必须被丢掉，否则会被误当音高采样（实测 42 半音变调）
  assert.equal(s.droppedTrigger > 100, true, `Salamander 应丢弃大量松键层，实际 ${s.droppedTrigger}`);
  assert.ok(s.regions.every((r) => r.trigger === 'attack' && r.hiKey >= 0), '留下的必须全是按键触发的可演奏区域');
  const v = loadSfz(vsco);
  assert.ok(v.regions.length > 20, `ContrabassPizz 区域数 ${v.regions.length}`);
  const keys = v.regions.flatMap((r) => [r.loKey, r.hiKey]);
  assert.equal(Math.min(...keys), 24);
  const r = pickRegion(v.regions, 40, 100, 0);
  assert.ok(r && fs.existsSync(r.file), '低音提琴第 40 号音应能选到真实采样文件');

  // 48kHz/24bit 完整母版才是默认旋律源（用户明确否掉了 Ogg 包），它的区域映射必须同构
  const master = `${LIB}/salamander48/SalamanderGrandPianoV3_48khz24bit/SalamanderGrandPianoV3.sfz`;
  if (fs.existsSync(master)) {
    const m = loadSfz(master);
    assert.equal(m.regions.length, 480, `48k/24bit 母版区域数应恰为 480，实得 ${m.regions.length}`);
    assert.ok(m.regions.every((x) => fs.existsSync(x.file)), '母版每个 region 的采样都必须存在');
  }
});
