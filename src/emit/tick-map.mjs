// 时间轴规划（纯函数，可单测）：把「步」映射成服务器刻，并把刻分成两级派发用的桶与组。
//
// 背景（实测）：
//   · 原曲网格是 0.12 秒/步；1.21.10 数据包函数权限等级为 2，`/tick rate` 需要等级 3，
//     所以函数里**不能**出现 `tick rate`，播放速率只能由玩家在聊天里注入或保持默认 20 tps。
//   · 20 tps 时 1 步 = 2.4 刻，只能四舍五入（抖动 ≤±1 刻 = ±50 ms，不累积）；
//     100 tps 时 1 步 = 12 刻，完全精确。两种模式都要生成，由 #hi 标记切换。
//   · 单刻把所有桶都调用一遍的代价是 桶数×桶内行数 次守卫求值（100 tps 下约 2.2 万次/刻），
//     因此按「桶 → 组」两级派发：每刻只调用 组数 + 组内桶数 个函数。

export const STEP_SECONDS = 0.12;

/** 第 step 步落在哪一刻（tps = 服务器刻率）。 */
export function tickOfStep(step, tps) {
  return Math.round(step * STEP_SECONDS * tps);
}

/** 强加载窗口切换点（第 1248 步，x≈1728）落在哪一刻。 */
export function switchTick(tps) {
  return tickOfStep(1248, tps);
}

/**
 * 按 tick 分组。notes 只需带 `step`；返回值是 Map<tick, note[]>（tick 升序插入，取用时再排序）。
 * 传入的 note 会被浅拷贝并补上 `tick` 字段，不修改原对象。
 */
export function buildTickGroups(notes, tps) {
  const groups = new Map();
  for (const n of notes) {
    const tick = tickOfStep(n.step, tps);
    const list = groups.get(tick);
    const copy = { ...n, tick };
    if (list) list.push(copy);
    else groups.set(tick, [copy]);
  }
  return new Map([...groups.entries()].sort((a, b) => a[0] - b[0]));
}

/** 把刻升序数组切成固定宽度的桶。返回 [{index, startTick, endTick, ticks}]。 */
export function planBuckets(ticks, bucketSize = 100) {
  const buckets = [];
  for (const t of ticks) {
    const index = Math.floor(t / bucketSize);
    const last = buckets[buckets.length - 1];
    if (last && last.index === index) last.ticks.push(t);
    else buckets.push({ index, startTick: index * bucketSize, endTick: index * bucketSize + bucketSize - 1, ticks: [t] });
  }
  return buckets;
}

/** 把桶按每 binSize 个一组，供两级派发。返回 [{index, fromTick, toTick, buckets}]，覆盖且只覆盖所有桶。 */
export function planBins(buckets, binSize = 15) {
  const bins = [];
  for (let i = 0; i < buckets.length; i += binSize) {
    const slice = buckets.slice(i, i + binSize);
    bins.push({
      index: bins.length,
      fromTick: slice[0].startTick,
      toTick: slice[slice.length - 1].endTick,
      buckets: slice,
    });
  }
  return bins;
}

/** 单刻函数调用次数（用于报告与验收）：1 次模式入口 + bins + 当前 bin 内 buckets（#t 递增与收尾判断是同一函数里的行，不额外算调用）。 */
export function callsPerTick(binCount, maxBucketsPerBin) {
  return 1 + binCount + maxBucketsPerBin;
}

export const pad = (i, w = 3) => String(i).padStart(w, '0');
