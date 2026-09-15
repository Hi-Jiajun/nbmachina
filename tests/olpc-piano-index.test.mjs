// M3-13 · OLPC Yamaha Disklavier Pro 完整合集 → SFZ 索引的守卫
//
// 这条守的是"文件命名规则 → 键位/力度区间"的换算：算错一位就会整体跑调、
// 或者同一颗音被两个区域同时接住（重叠区）。用临时目录造假文件跑，不依赖真库。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { parseSfzText } from '../src/sample/sfz.mjs';

const TOOL = path.resolve('tools/import-olpc-piano.mjs');

function makeFixture(names) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'olpc-piano-'));
  for (const n of names) fs.writeFileSync(path.join(dir, n), '');
  return dir;
}

test('命名 → 区域：键位/力度区间连续不重叠，click 与非目标奏法被丢弃', () => {
  const dir = makeFixture([
    'pno021v100leg.wav', 'pno021v120leg.wav',
    'pno024v100leg.wav', 'pno024v120leg.wav',
    'pno027v100leg.wav', 'pno027v120leg.wav',
    'pno027v060sta.wav',                 // 非 leg：默认要丢
    'pno024v110leg-click.wav',           // 带杂音：必须丢
    'README.txt',                        // 非采样：忽略
  ]);
  const out = path.join(dir, 'index.sfz');
  execFileSync(process.execPath, [TOOL, '--dir', dir, '--out', out], { stdio: 'pipe' });
  const { regions } = parseSfzText(fs.readFileSync(out, 'utf8'));

  // 3 根音 × 2 层力度 = 6 个区域
  assert.equal(regions.length, 6, `应生成 6 个区域，实得 ${regions.length}`);
  assert.ok(!regions.some((r) => /click|sta/.test(r.sample)), 'click/sta 采样不得进入索引');

  const byPitch = new Map();
  for (const r of regions) {
    if (!byPitch.has(r.root)) byPitch.set(r.root, []);
    byPitch.get(r.root).push(r);
  }
  assert.deepEqual([...byPitch.keys()].sort((a, b) => a - b), [21, 24, 27]);

  // 键位区间：21:[0,22] 24:[23,25] 27:[26,127]，首尾相接、无重叠
  const keySpans = [...byPitch.entries()].sort((a, b) => a[0] - b[0]).map(([root, rs]) => {
    const lo = Math.min(...rs.map((r) => r.loKey));
    const hi = Math.max(...rs.map((r) => r.hiKey));
    return { root, lo, hi };
  });
  assert.deepEqual(keySpans, [
    { root: 21, lo: 0, hi: 22 },
    { root: 24, lo: 23, hi: 25 },
    { root: 27, lo: 26, hi: 127 },
  ]);

  // 力度区间：每根音两段，100 段吃掉 0..110 的一半、120 段接上到 127
  for (const [root, rs] of byPitch) {
    const spans = rs.map((r) => [r.loVel, r.hiVel]).sort((a, b) => a[0] - b[0]);
    assert.equal(spans.length, 2, `根音 ${root} 应有 2 层力度`);
    assert.equal(spans[0][0], 0);
    assert.equal(spans[1][1], 127);
    assert.equal(spans[0][1] + 1, spans[1][0], `根音 ${root} 的力度区间必须首尾相接`);
  }

  fs.rmSync(dir, { recursive: true, force: true });
});

test('真库自检（本机存在才跑）：完整合集索引可加载且每个采样都在', () => {
  const SFZ = 'C:/Users/hiliang/Documents/minecraft/_toolchain/olpc/x/yamahaGrandPiano44/yamaha_disklavier_olpc.sfz';
  if (!fs.existsSync(SFZ)) return;
  const { regions } = parseSfzText(fs.readFileSync(SFZ, 'utf8'));
  assert.ok(regions.length > 800, `完整合集应有 800+ 个 leg 区域，实得 ${regions.length}`);
  const roots = [...new Set(regions.map((r) => r.root))].sort((a, b) => a - b);
  assert.equal(roots.length, 30, `应有 30 个录音根音，实得 ${roots.length}`);
  assert.equal(roots[0], 21);
  assert.equal(roots.at(-1), 108, '最高根音必须到 C8(108)——SF2 子集只到 C7(96)');
  const base = path.dirname(SFZ);
  const missing = regions.filter((r) => !fs.existsSync(path.resolve(base, r.sample)));
  assert.equal(missing.length, 0, `缺采样 ${missing.length} 个：${missing.slice(0, 3).map((r) => r.sample).join(', ')}`);
});
