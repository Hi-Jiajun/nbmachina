// M1-4 · 打击乐层映射：检测事件 → 机器已有的打击乐格（basedrum row 0 / hat row 24）+ 0.12s 网格
//
// 口径（写进 docs/M1-4-report.md §2）：
//   · 时间：`step = round(t / 0.12)`（取最近的 step）、`tick = step × 12`（100 tps 下精确）、
//     `time_seconds = step × 0.12`；离网超过半个 step 的事件（默认不允许）记 offGrid 丢弃
//   · 格：底鼓 → `minecraft:stone` 甲板 = basedrum，固定 row 0；踩镲 → `minecraft:glass` = hat，固定 row 24
//     （两者必须占不同 row，否则同一 step 撞格；row 对打击乐只表示"哪个音符盒"，音高无意义）
//   · 军鼓**机器上没有对应格**（stone→basedrum、glass→hat 是本机仅有的两组打击乐方块）：
//     降级为 basedrum（与底鼓同一格），显式记进 stats.mergedSameCell 与 degradations，不静默丢弃
//   · 同一 step 同一类只保留最强的一次；不同类可以共存（占不同 row）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  CSV_COLUMNS,
  DEFAULT_PERCUSSION_CONFIG,
  PERCUSSION_CELLS,
  percussionCsv,
  percussionFromAudio,
  percussionRowsFromEvents,
  snapToGrid,
} from '../src/arrange/percussion.mjs';
import { readWav } from '../src/analyze/dsp.mjs';

const BUILD = process.env.nbmachina_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const WAV = path.join(BUILD, 'styx_helix_full.wav');

const ev = (time, kind, strength = 0.8) => ({ time, kind, strength });
const rowsOf = (events, config) => percussionRowsFromEvents(events, config);
const cells = (rows) => rows.map((r) => `${r.step}:${r.instrument}:${r.row}`);

/* ------------------------------------------------------------------ 契约 */

test('契约：CSV 列固定为 step,tick,time_seconds,instrument,midi,row,volume', () => {
  assert.deepEqual(CSV_COLUMNS, ['step', 'tick', 'time_seconds', 'instrument', 'midi', 'row', 'volume']);
  const { rows } = rowsOf([ev(0, 'kick'), ev(0.12, 'hat')]);
  const text = percussionCsv(rows);
  assert.equal(text.split('\n')[0], CSV_COLUMNS.join(','));
  for (const line of text.trim().split('\n').slice(1)) {
    assert.equal(line.split(',').length, 7, `列数不对：${line}`);
  }
});

test('契约：打击乐格 —— 底鼓 basedrum/row 0/stone，踩镲 hat/row 24/glass', () => {
  assert.equal(PERCUSSION_CELLS.kick.instrument, 'basedrum');
  assert.equal(PERCUSSION_CELLS.kick.row, 0);
  assert.equal(PERCUSSION_CELLS.kick.block, 'minecraft:stone');
  assert.equal(PERCUSSION_CELLS.hat.instrument, 'hat');
  assert.equal(PERCUSSION_CELLS.hat.row, 24);
  assert.equal(PERCUSSION_CELLS.hat.block, 'minecraft:glass');
  assert.equal(PERCUSSION_CELLS.snare.instrument, 'basedrum');
  assert.equal(PERCUSSION_CELLS.snare.row, 0);
  assert.ok(PERCUSSION_CELLS.kick.row !== PERCUSSION_CELLS.hat.row, '底鼓与踩镲必须占不同 row');

  const { rows } = rowsOf([ev(0, 'kick'), ev(0, 'hat')]);
  assert.deepEqual(cells(rows), ['0:basedrum:0', '0:hat:24']);
});

/* --------------------------------------------------------------- 网格吸附 */

test('网格：step = round(t/0.12)、tick = step×12、time = step×0.12；tick 与 time 自洽', () => {
  assert.deepEqual(snapToGrid(0.02), { step: 0, offsetSec: 0.02 });
  assert.deepEqual(snapToGrid(0.121), { step: 1, offsetSec: 0.001 });
  assert.deepEqual(snapToGrid(0.108), { step: 1, offsetSec: -0.012 });
  assert.equal(snapToGrid(0.12).step, 1);
  assert.equal(snapToGrid(2.4).step, 20);
  assert.equal(DEFAULT_PERCUSSION_CONFIG.stepSec, 0.12);
  assert.equal(DEFAULT_PERCUSSION_CONFIG.ticksPerStep, 12);

  const { rows } = rowsOf([ev(0.245, 'kick'), ev(1.234, 'hat')]);
  for (const r of rows) {
    assert.equal(r.tick, r.step * 12, `tick 与 step 不自洽：${JSON.stringify(r)}`);
    assert.equal(r.time_seconds, Number((r.step * 0.12).toFixed(3)), `time 与 step 不自洽：${JSON.stringify(r)}`);
  }
  assert.deepEqual(rows.map((r) => r.step), [2, 10]);
});

test('离网超过容差的事件被丢弃并计入 offGrid；默认容差 = 半个 step（等价于永不舍弃）', () => {
  // 默认：0.06 正好是 0 与 0.12 的中点，按四舍五入归到 step 1，|偏移| = 0.06 = 容差 → 保留
  const dflt = rowsOf([ev(0.06, 'kick')]);
  assert.equal(dflt.rows.length, 1);
  assert.equal(dflt.rows[0].step, 1);
  assert.equal(dflt.rows[0].offsetSec, -0.06);
  assert.equal(dflt.stats.offGrid, 0);

  // 收紧到 30ms：离网 50ms 与 60ms 的两条都被丢弃
  const { rows, stats } = rowsOf([ev(0.05, 'kick'), ev(0.3, 'hat'), ev(0.13, 'hat')], { maxOffsetSec: 0.03 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'hat');
  assert.equal(rows[0].step, 1);
  assert.equal(stats.offGrid, 2);
  assert.equal(stats.events, 3);
  assert.equal(stats.kept, 1);
  assert.equal(stats.offGridDropped.length, 2);
});

/* -------------------------------------------------- 同 step 去重与不同类共存 */

test('同一 step 上的同类只保留最强的一次，并计入 mergedSameKind', () => {
  const { rows, stats } = rowsOf([
    ev(0.118, 'hat', 0.4),
    ev(0.125, 'hat', 0.9),
    ev(0.121, 'hat', 0.6),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].strength, 0.9);
  assert.equal(rows[0].volume, 0.9);
  assert.equal(stats.mergedSameKind, 2);
});

test('不同类在同一 step 上共存（底鼓 row 0 + 踩镲 row 24）', () => {
  const { rows, stats } = rowsOf([ev(0.121, 'kick', 0.5), ev(0.119, 'hat', 0.7), ev(0.6, 'snare', 0.8)]);
  assert.deepEqual(cells(rows), ['1:basedrum:0', '1:hat:24', '5:basedrum:0']);
  assert.equal(stats.mergedSameKind, 0);
  assert.equal(stats.mergedSameCell, 0);
});

test('军鼓在机器上没有对应格 → 降级成 basedrum（同格），同 step 与底鼓合并并显式记降级', () => {
  const { rows, stats, degradations } = rowsOf([ev(0.121, 'kick', 0.5), ev(0.121, 'snare', 0.9)]);
  assert.equal(rows.length, 1, '同 step 同格只留一次');
  assert.equal(rows[0].kind, 'snare', '更强的军鼓胜出');
  assert.equal(rows[0].instrument, 'basedrum');
  assert.equal(rows[0].row, 0);
  assert.equal(stats.mergedSameCell, 1);
  assert.ok(degradations.some((d) => d.reason === 'no-snare-cell'), '必须显式记录"军鼓无对应格"');
  assert.ok(degradations.some((d) => d.reason === 'same-cell-merge'), '必须显式记录同格合并');
});

test('volume = 检测强度（0..1，3 位小数），midi 列填 row（打击乐音高无意义）', () => {
  const { rows } = rowsOf([ev(0.12, 'kick', 0.45678), ev(0.24, 'hat', 1)]);
  assert.equal(rows[0].volume, 0.457);
  assert.equal(rows[0].midi, rows[0].row);
  assert.equal(rows[0].strength, 0.45678);
  assert.equal(rows[1].volume, 1);
});

test('决定论：同样的事件序列两次映射结果逐字节相同（含排序）', () => {
  const events = [ev(1.2, 'hat', 0.3), ev(0.12, 'kick', 0.9), ev(0.6, 'snare', 0.5), ev(0.119, 'hat', 0.4)];
  const a = rowsOf(events);
  const b = rowsOf([...events].reverse());
  assert.equal(percussionCsv(a.rows), percussionCsv(b.rows));
  assert.deepEqual(a.stats, b.stats);
});

/* ---------------------------------------------------------------- 真实数据 */

test('真实数据：整段音频 → 打击乐 CSV（行数 ≥100，可被逐列读回）', (t) => {
  if (!fs.existsSync(WAV)) return t.skip(`缺少 ${WAV}`);
  const { samples, sampleRate } = readWav(WAV);
  const { rows, stats, detect } = percussionFromAudio({ samples, sampleRate });
  assert.ok(detect.events.length >= 100, `检测事件 ${detect.events.length}`);
  assert.ok(rows.length >= 100, `打击乐行 ${rows.length}`);
  assert.ok(rows.length <= detect.events.length, '网格化只会合并/丢弃，不应凭空多出行');

  const lines = percussionCsv(rows).trim().split('\n').slice(1);
  assert.equal(lines.length, rows.length);
  for (const line of lines) {
    const c = line.split(',');
    assert.equal(c.length, 7);
    assert.ok(c[3] === 'basedrum' || c[3] === 'hat', `乐器列非法：${line}`);
    assert.ok(c[5] === '0' || c[5] === '24', `行号列非法：${line}`);
    assert.ok(Number(c[1]) === Number(c[0]) * 12, `tick 列非法：${line}`);
  }
  assert.ok(stats.snapOffsetMs.maxAbs <= 60, `吸附偏移 |最大| ${stats.snapOffsetMs.maxAbs}ms 超过半个 step`);
});

test('真实数据（宽松口径）：密集事件下同 step 去重与同格降级真的会发生', (t) => {
  if (!fs.existsSync(WAV)) return t.skip(`缺少 ${WAV}`);
  const { samples, sampleRate } = readWav(WAV);
  // minExcess: 0 = 关掉"绝对超额"闸门（宽松口径，事件密度高得多），用来验证合并逻辑在真实事件上生效
  const { rows, stats, detect, degradations } = percussionFromAudio({
    samples, sampleRate, detectorConfig: { minExcess: 0 },
  });
  assert.ok(detect.events.length > 1000, `宽松口径事件 ${detect.events.length}`);
  assert.ok(stats.mergedSameKind + stats.mergedSameCell > 0, '宽松口径下必须有同 step 合并');
  assert.ok(rows.length < detect.events.length, '去重后行数必须少于事件数');
  assert.ok(degradations.some((d) => d.reason === 'no-snare-cell'), '军鼓降级必须被记录');
});
