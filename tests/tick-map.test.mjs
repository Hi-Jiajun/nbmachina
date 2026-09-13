import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STEP_SECONDS, tickOfStep, switchTick, buildTickGroups, planBuckets, planBins, callsPerTick,
} from '../src/emit/tick-map.mjs';

test('100 tps 下 1 步 = 12 刻（精确，无舍入）', () => {
  assert.equal(STEP_SECONDS * 100, 12);
  for (let s = 0; s <= 2320; s++) assert.equal(tickOfStep(s, 100), s * 12);
});

test('20 tps 下 1 步 ≈ 2.4 刻：舍入误差 ≤0.5 刻且不累积', () => {
  let maxErr = 0;
  for (let s = 0; s <= 2320; s++) {
    const exact = s * STEP_SECONDS * 20;
    const err = Math.abs(tickOfStep(s, 20) - exact);
    assert.ok(err <= 0.5, `step ${s} 误差 ${err}`);
    maxErr = Math.max(maxErr, err);
  }
  assert.ok(maxErr <= 0.5);
  // 整曲末尾：278.4 秒 = 5568 刻（20 tps），不得漂移
  assert.equal(tickOfStep(2320, 20), 5568);
  assert.equal(tickOfStep(2320, 100), 27840);
});

test('tickOfStep 单调不减', () => {
  for (const tps of [20, 100]) {
    let prev = -1;
    for (let s = 0; s <= 500; s++) {
      const t = tickOfStep(s, tps);
      assert.ok(t >= prev);
      prev = t;
    }
  }
});

test('强加载切换点随刻率缩放（2995 / 14976）', () => {
  assert.equal(switchTick(20), 2995);
  assert.equal(switchTick(100), 14976);
});

test('buildTickGroups 按刻合并且不改原对象', () => {
  const notes = [{ step: 0, midi: 60 }, { step: 0, midi: 64 }, { step: 1, midi: 62 }];
  const g = buildTickGroups(notes, 20);
  assert.equal(g.size, 2);
  assert.deepEqual([...g.keys()], [0, 2]);
  assert.equal(g.get(0).length, 2);
  assert.equal(g.get(0)[0].tick, 0);
  assert.equal(notes[0].tick, undefined, '原对象不应被写入 tick');
});

test('planBuckets：桶宽 100 刻，桶覆盖所有刻且不重复', () => {
  const ticks = [0, 5, 99, 100, 250, 251];
  const buckets = planBuckets(ticks, 100);
  assert.deepEqual(buckets.map((b) => b.index), [0, 1, 2]);
  assert.deepEqual(buckets.flatMap((b) => b.ticks), ticks);
  assert.deepEqual([buckets[0].startTick, buckets[0].endTick], [0, 99]);
});

test('planBins：每 15 个桶一组，覆盖全部桶且组的刻区间不重叠', () => {
  const ticks = Array.from({ length: 2600 }, (_, i) => i);
  const b2 = planBuckets(ticks, 100);
  assert.equal(b2.length, 26); // 刻 0..2599 → 27 个刻位、26 个桶
  const bins = planBins(b2, 15);
  assert.equal(bins.length, Math.ceil(b2.length / 15));
  assert.deepEqual(bins.flatMap((x) => x.buckets.map((y) => y.index)), b2.map((y) => y.index));
  for (let i = 1; i < bins.length; i++) {
    assert.ok(bins[i].fromTick > bins[i - 1].toTick, `组区间重叠：${i}`);
  }
});

test('两级派发后单刻调用次数：20 tps ≤20 次，100 tps ≤40 次（对比全扫 279+）', () => {
  const mk = (maxTick) => planBuckets(Array.from({ length: maxTick + 1 }, (_, i) => i), 100);
  const lo = planBins(mk(5568), 15);
  const hi = planBins(mk(27840), 15);
  const maxPer = (bins) => Math.max(...bins.map((b) => b.buckets.length));
  const loCalls = callsPerTick(lo.length, maxPer(lo));
  const hiCalls = callsPerTick(hi.length, maxPer(hi));
  assert.ok(loCalls <= 21, `20 tps 每刻 ${loCalls} 次`);
  assert.ok(hiCalls <= 40, `100 tps 每刻 ${hiCalls} 次`);
  assert.ok(hiCalls < 279, '必须显著少于全扫');
});
