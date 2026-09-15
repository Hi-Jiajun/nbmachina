// M3-14 · 实测力度 → velMidi 归一（用户听感反馈："力度强弱关系我没有听出来"）
//
// 守三件事：
//   ① 归一后必须真的拉开（原来旋律 80% 的音挤在 0.36~0.48，映射后要覆盖大半个 1..127）；
//   ② 强弱**次序**不能变（只能拉伸，不能打乱）；
//   ③ 声部各自统计、打击乐留空、无证据（velocity=0）落在地板。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DYNAMICS_DEFAULTS, addVelMidiColumn, assignVelMidi, describeVelMidi, velMidiToAmplitude, writeCsv,
} from '../src/arrange/dynamics.mjs';

/** 造一条"重尾"力度序列：绝大多数音挤在 0.36~0.48，少数音到 1.0（与真谱面同形） */
function compressed(n = 100) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = i < n * 0.8
      ? 0.36 + (0.48 - 0.36) * (i / (n * 0.8))
      : 0.48 + (1.0 - 0.48) * ((i - n * 0.8) / (n * 0.2));
    out.push({ instrument: 'harp', velocity: v });
  }
  return out;
}

test('归一：压缩的力度被拉开到大半个 1..127，且次序不变', () => {
  const notes = compressed(100);
  const withDyn = assignVelMidi(notes);
  const mids = withDyn.map((n) => n.velMidi);
  const min = Math.min(...mids), max = Math.max(...mids);
  assert.ok(min >= DYNAMICS_DEFAULTS.floor, `最小 ${min} 不得低于地板 ${DYNAMICS_DEFAULTS.floor}`);
  assert.equal(max, 127, 'p95 及以上必须到天花板');
  assert.ok(max - min > 80, `动态范围只有 ${max - min} 级，还是没拉开`);

  // 次序不变（严格递增的输入 → 非递减的输出）
  for (let i = 1; i < mids.length; i++) {
    assert.ok(mids[i] >= mids[i - 1], `第 ${i} 颗的力度次序被打乱：${mids[i - 1]} → ${mids[i]}`);
  }
  // 中位数不再贴地板（原口径中位 0.42 ≈ 贴地）
  const sorted = [...mids].sort((a, b) => a - b);
  assert.ok(sorted[49] > 50, `中位力度只有 ${sorted[49]}，动态仍被压缩在地板附近`);
  assert.equal(withDyn[0].velocity, notes[0].velocity, '不得改动原始 velocity 列');
});

test('声部分别统计：贝斯与旋律各用各的分位数', () => {
  const notes = [];
  for (let i = 0; i < 50; i++) notes.push({ instrument: 'harp', velocity: 0.36 + i * 0.002 });
  for (let i = 0; i < 50; i++) notes.push({ instrument: 'bass', velocity: 0.40 + i * 0.005 });
  const withDyn = assignVelMidi(notes);
  const harpMax = Math.max(...withDyn.filter((n) => n.instrument === 'harp').map((n) => n.velMidi));
  const bassMax = Math.max(...withDyn.filter((n) => n.instrument === 'bass').map((n) => n.velMidi));
  const harpMin = Math.min(...withDyn.filter((n) => n.instrument === 'harp').map((n) => n.velMidi));
  const bassMin = Math.min(...withDyn.filter((n) => n.instrument === 'bass').map((n) => n.velMidi));
  assert.equal(harpMax, 127);
  assert.equal(bassMax, 127, '贝斯也要用满自己的动态范围，而不是被旋律的分布压扁');
  assert.equal(harpMin, DYNAMICS_DEFAULTS.floor);
  assert.equal(bassMin, DYNAMICS_DEFAULTS.floor);
  // 同一个原始力度（0.45）落在两个声部分布的不同分位上 → 必须得到不同的 velMidi
  const probeHarp = assignVelMidi([...notes.filter((n) => n.instrument === 'harp'), { instrument: 'harp', velocity: 0.45 }]).at(-1);
  const probeBass = assignVelMidi([...notes.filter((n) => n.instrument === 'bass'), { instrument: 'bass', velocity: 0.45 }]).at(-1);
  assert.notEqual(probeHarp.velMidi, probeBass.velMidi, '同一原始力度在旋律/贝斯上应按各自的分布落位');
});

test('打击乐留空、无证据落地板', () => {
  const notes = [
    { instrument: 'harp', velocity: 0.5 },
    { instrument: 'harp', velocity: 0 },
    { instrument: 'basedrum', velocity: 0.9 },
    { instrument: 'hat', velocity: NaN },
  ];
  const [a, b, c, d] = assignVelMidi(notes);
  assert.ok(Number.isFinite(a.velMidi));
  assert.equal(b.velMidi, DYNAMICS_DEFAULTS.floor, 'velocity=0 = 音频里没有证据 → 地板');
  assert.equal(c.velMidi, null, '打击乐没有力度概念');
  assert.equal(d.velMidi, null);
});

test('velMidi → 振幅：127 = 1.0，1 ≈ -18dB，单调', () => {
  assert.equal(velMidiToAmplitude(127), 1);
  assert.ok(Math.abs(velMidiToAmplitude(1) - 10 ** (-18 / 20)) < 1e-6);
  assert.ok(velMidiToAmplitude(64) > velMidiToAmplitude(32));
  assert.ok(velMidiToAmplitude(100) < 1);
});

test('CSV 入口：补 velMidi 列，并把"主谱面 12 列 + 打击乐 7 列"对齐', () => {
  const header = 'step,tick,time_seconds,instrument,midi,row,volume,velocity,velocityRaw,velocityReason,sustainOf,sustainIndex';
  const text = [
    header,
    '0,0,0.000,harp,72,12,0.350,0.420,0.15,measured,,0',
    '1,12,0.120,harp,74,14,0.350,0.500,0.58,measured,,0',
    '2,24,0.240,basedrum,36,0,0.350',                       // 打击乐：只有 7 列
  ].join('\n') + '\n';
  const { header: outHeader, rows, notes } = addVelMidiColumn(text);
  assert.equal(outHeader.at(-1), 'velMidi');
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.length === outHeader.length), '所有行必须与表头等长');
  assert.ok(Number(rows[0].at(-1)) >= DYNAMICS_DEFAULTS.floor);
  assert.equal(rows[2].at(-1), '', '打击乐的 velMidi 留空');
  assert.equal(rows[0][7], '0.420', '原有列必须逐字符保留');
  const stats = describeVelMidi(notes);
  assert.equal(stats.perc.n, 1);
  assert.equal(stats.melody.withVel, 2);
  // 再写一遍必须可被重新解析（列数一致）
  const round = writeCsv(outHeader, rows).trim().split(/\r?\n/);
  assert.equal(round.length, 4);
  assert.ok(round.slice(1).every((l) => l.split(',').length === outHeader.length));
});
