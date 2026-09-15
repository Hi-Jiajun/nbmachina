// M3-13 · 实测力度并入 machine 谱面的连接规则守卫
//
// 背景：machine 谱面 3053 行（volume 恒为 0.35），力度文件 2802 行（带 velocity 列），
// 两边不是同一批行——连错了会静默把 A 音的力度贴到 B 音上（听感上是"表情错位"）。
// 这里用小型夹具锁住：主键优先、退化键兜底、命中不了就留空（而不是瞎填默认值）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { joinVelocity } from '../tools/make-velocity-score.mjs';

const SRC = [
  'step,tick,time_seconds,instrument,midi,row,volume',
  '0,0,0.000,harp,72,12,0.350',     // 主键能命中
  '1,12,0.120,harp,74,14,0.350',    // 只有 row 键能命中（midi 变了）
  '2,24,0.240,bass,33,9,0.350',     // 完全命中不了 → 留空
  '3,36,0.360,basedrum,36,0,0.350', // 打击乐：力度文件里根本没有 → 留空
].join('\n');

const VEL = [
  'step,tick,time_seconds,instrument,midi,row,volume,velocity,velocityRaw,velocityReason',
  '0,0,0.000,harp,72,12,0.425,0.91,3.1,measured',
  '1,12,0.120,harp,73,14,0.425,0.48,1.9,measured-nearest-band',
].join('\n');

test('力度连接：主键优先 → 退化 row 键 → 未命中留空', () => {
  const { lines, matched, fell, missing } = joinVelocity(SRC, VEL);
  assert.equal(matched, 1);
  assert.equal(fell, 1);
  assert.equal(missing, 2);
  assert.equal(lines[0], 'step,tick,time_seconds,instrument,midi,row,volume,velocity,velocitySource');
  const rows = lines.slice(1).map((l) => l.split(','));
  assert.equal(rows[0].at(-2), '0.91');
  assert.equal(rows[0].at(-1), 'key');
  assert.equal(rows[1].at(-2), '0.48', 'midi 对不上时必须退到 row 键');
  assert.equal(rows[1].at(-1), 'row');
  assert.equal(rows[2].at(-2), '', '命中不了就留空，不许填默认力度');
  assert.equal(rows[2].at(-1), 'missing');
  assert.equal(rows[3].at(-2), '', '打击乐没有力度概念，留空');
});

test('力度文件缺 velocity 列（例如拿了 dedup 版）→ 直接报错，不静默全空', () => {
  const noVel = 'step,instrument,midi,row,volume\n0,harp,72,12,0.425';
  assert.throws(() => joinVelocity(SRC, noVel), /缺 velocity 列/);
});
