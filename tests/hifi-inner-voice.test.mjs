// M3-1 收尾 · hifi 渲染器认显式声部标签（`instrument=inner` / `voiceRole=inner`）
//
// 背景：M2-1 的 `/playsound` 渲染器判"谁是旋律"用的是临时启发式——同一刻 harp 家族里
// **行号最高者**算旋律，其余算内声部。M3-1 落地后谱面里有了显式标签（`inner` + `voiceRole`），
// 两者在真实数据上并不一致（续线判定 vs 最高音，见 docs/M3-1-inner-voice-report.md §2.1）。
// 本文件守住三条：
//   ① 有标签就**以标签为准**（标签优先于启发式）；
//   ② 没有标签的老谱面**行为一字不变**（老启发式 + 逐字节口径，A/B 另有覆盖）；
//   ③ 两种口径的差异是**可量化**的，不是"看起来差不多"。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { parseScoreCsv, planHifi } from '../src/emit/playsound-hifi.mjs';
import { innerVoiceCsvText } from '../src/arrange/inner-voice.mjs';

const BUILD = path.resolve(import.meta.dirname, '../../build');
const at = (events, step, row) => events.find((e) => e.step === step && e.row === row);

/* ------------------------------------------------------------------ ① 标签优先 */

test('显式 instrument=inner：走 --inner 音色（默认 bell），且不再被当成未知乐器', () => {
  const notes = [
    { step: 0, instr: 'harp', row: 20, vol: 0.8 },   // 旋律
    { step: 0, instr: 'inner', row: 22, vol: 0.6 },  // 内声部（行号更高！）
  ];
  const { events, stats } = planHifi(notes);
  assert.equal(at(events, 0, 20).timbre, 'strings', 'harp 仍是旋律音色');
  assert.equal(at(events, 0, 22).timbre, 'bell', 'inner 走内声部音色');
  assert.equal(stats.innerExplicit, 1);
  assert.equal(stats.innerHeuristic, 0);
  assert.equal(stats.unknownInstrument, 0, 'inner 是已知乐器（修复前会退成 strings）');
  assert.equal(stats.fallback, 0);
});

test('显式 inner 不被"最高行=旋律"抢走：内声部行更高时旋律也不掉音色', () => {
  // 这条就是老启发式会判错的形态：修复前 row 22 会被当旋律(strings)、row 20 被当内声部(bell)
  const notes = [
    { step: 3, instr: 'harp', row: 20, vol: 0.8 },
    { step: 3, instr: 'inner', row: 22, vol: 0.5 },
  ];
  const { events } = planHifi(notes);
  assert.equal(at(events, 3, 20).timbre, 'strings');
  assert.equal(at(events, 3, 22).timbre, 'bell');
});

test('--inner pad 对显式标签同样生效', () => {
  const notes = [
    { step: 0, instr: 'harp', row: 18, vol: 0.7 },
    { step: 0, instr: 'inner', row: 12, vol: 0.7 },
  ];
  const { events, stats } = planHifi(notes, { inner: 'pad' });
  assert.equal(at(events, 0, 12).timbre, 'pad');
  assert.equal(stats.pad, 1);
  assert.equal(stats.innerExplicit, 1);
});

test('voiceRole=inner（instrument 仍写 harp）也被认，且同刻其它 harp 仍是旋律', () => {
  const notes = [
    { step: 5, instr: 'harp', row: 21, vol: 0.9, role: 'melody' },
    { step: 5, instr: 'harp', row: 23, vol: 0.4, role: 'inner' },
  ];
  const { events, stats } = planHifi(notes);
  assert.equal(at(events, 5, 21).timbre, 'strings', '标了 melody 的那颗是旋律');
  assert.equal(at(events, 5, 23).timbre, 'bell', '标了 inner 的那颗是内声部');
  assert.equal(stats.innerExplicit, 1);
});

test('标签与启发式混用：各自计数互不串台', () => {
  const notes = [
    { step: 0, instr: 'harp', row: 12, vol: 0.5 },   // 无标签多音 step → 启发式
    { step: 0, instr: 'harp', row: 18, vol: 0.5 },   // （row 18 = 旋律）
    { step: 4, instr: 'harp', row: 16, vol: 0.5 },   // 显式标签 step
    { step: 4, instr: 'inner', row: 9, vol: 0.5 },
  ];
  const { events, stats } = planHifi(notes);
  assert.equal(at(events, 0, 12).timbre, 'bell', '老口径：次高音算内声部');
  assert.equal(at(events, 0, 18).timbre, 'strings');
  assert.equal(at(events, 4, 16).timbre, 'strings');
  assert.equal(at(events, 4, 9).timbre, 'bell');
  assert.equal(stats.innerExplicit, 1);
  assert.equal(stats.innerHeuristic, 1);
  assert.equal(stats.inner, 2);
});

/* ----------------------------------------------------------- ② 老口径不变 */

test('无标签老谱面：最高行=旋律、其余=内声部（与 M2-1 口径一致）', () => {
  const notes = [
    { step: 7, instr: 'harp', row: 10, vol: 0.5 },
    { step: 7, instr: 'harp', row: 20, vol: 0.5 },
    { step: 7, instr: 'harp', row: 15, vol: 0.5 },
  ];
  const { events, stats } = planHifi(notes);
  assert.equal(at(events, 7, 20).timbre, 'strings');
  assert.equal(at(events, 7, 15).timbre, 'bell');
  assert.equal(at(events, 7, 10).timbre, 'bell');
  assert.equal(stats.innerExplicit, 0);
  assert.equal(stats.innerHeuristic, 2);
});

/* ------------------------------------------------- ④ 音高口径：用真实 midi 而不是折叠 row */

test('音高：有 `midi` 列时按**真实音高**播（后端 A 不受 2 个八度限制）', () => {
  // 同一颗音：row=11（折叠到音符盒音域）vs midi=75（音频标定后的真实音高，D#5）
  const foldedOnly = planHifi([{ step: 0, instr: 'harp', row: 11, vol: 0.8 }]).events[0];
  assert.equal(foldedOnly.midi, 53, '没有 midi 列时退回 row→midi（老口径）');
  const withTrue = planHifi([{ step: 0, instr: 'harp', row: 11, midi: 75, vol: 0.8 }]).events[0];
  assert.equal(withTrue.midi, 75, '有 midi 列时必须按真实音高播');
  assert.equal(withTrue.event, 'nbforge:strings_ds5');
  assert.equal(withTrue.pitch, '1', '用的是一音一采样，不该再叠 pitch');
});

test('音高：真实音高超出采样音域时退回折叠 row，并计入 octaveFallback', () => {
  const { events, stats } = planHifi([{ step: 0, instr: 'harp', row: 11, midi: 120, vol: 0.8 }]);
  assert.equal(events[0].midi, 53, '超音域 → 退回 row→midi');
  assert.equal(stats.octaveFallback, 1, '退回次数要计数，便于发现音域覆盖不足');
});

test('真实数据：整份机器谱面没有一颗音因超音域退回（音域已覆盖原曲）', () => {
  const p = path.join(BUILD, 'machine_pipeline.csv');
  assert.ok(fs.existsSync(p), `缺真实数据 ${p}——真实数据断言不许跳过`);
  const { notes } = parseScoreCsv(fs.readFileSync(p, 'utf8'));
  const { events, stats } = planHifi(notes);
  assert.equal(events.length, notes.length);
  assert.equal(stats.octaveFallback, 0, `有 ${stats.octaveFallback} 颗音超出采样音域`);
  const high = events.filter((e) => e.midi !== null && e.midi >= 90).length;
  assert.ok(high > 100, `高音区（midi ≥ 90）应占相当比例，实测 ${high} 颗`);
});

test('CSV 解析：有 voiceRole 列就读，没有就空串（老谱面逐字节兼容）', () => {
  const withRole = parseScoreCsv('step,instrument,row,volume,voiceRole\n1,harp,12,0.5,inner\n');
  assert.equal(withRole.notes[0].role, 'inner');
  const without = parseScoreCsv('step,instrument,row,volume\n1,harp,12,0.5\n');
  assert.equal(without.notes[0].role, '');
});

/* ------------------------------------------------- ③ 真实数据（不许 skip） */

test('真实数据：当前机器谱面（无标签）用的仍是启发式口径', () => {
  const p = path.join(BUILD, 'machine_pipeline.csv');
  assert.ok(fs.existsSync(p), `缺真实数据 ${p}——真实数据断言不许跳过`);
  const { notes, stats: scoreStats } = parseScoreCsv(fs.readFileSync(p, 'utf8'));
  const { stats } = planHifi(notes);
  assert.ok(scoreStats.notes > 3000, `谱面 ${scoreStats.notes} 颗音`);
  assert.equal(stats.innerExplicit, 0, '这份谱面没有 inner 标签（arrange 默认 --inner off）');
  assert.ok(stats.innerHeuristic > 0, '老口径下存在被启发式判为内声部的音');
  assert.equal(stats.unknownInstrument, 0);
});

test('真实数据 + 模块联动：inner-voice 产出的谱面被 hifi 全量认作显式标签', () => {
  const p = path.join(BUILD, 'pipeline_4_sustain.csv');
  assert.ok(fs.existsSync(p), `缺真实数据 ${p}——真实数据断言不许跳过`);
  const labeled = innerVoiceCsvText(fs.readFileSync(p, 'utf8'), { register: 'keep' }).csv;
  const { notes, stats: scoreStats } = parseScoreCsv(labeled);
  const innerRows = notes.filter((n) => n.instr === 'inner').length;
  const { stats } = planHifi(notes);
  assert.ok(innerRows > 100, `内声部行数 ${innerRows}`);
  assert.equal(stats.innerExplicit, innerRows, '每一颗标了 inner 的音都要按显式标签处理');
  assert.equal(stats.unknownInstrument, 0, '标签谱面不该出现未知乐器');
  assert.ok(scoreStats.notes > 3000);
});

test('真实数据：两种口径确实会选出不同的音（差异可量化，不是"看着差不多"）', () => {
  const p = path.join(BUILD, 'pipeline_4_sustain.csv');
  assert.ok(fs.existsSync(p), `缺真实数据 ${p}——真实数据断言不许跳过`);
  const text = fs.readFileSync(p, 'utf8');
  const legacy = parseScoreCsv(text);
  const labeled = parseScoreCsv(innerVoiceCsvText(text, { register: 'keep' }).csv);
  // 同一颗音（step,row）在两套口径下的音色：strings <-> bell 翻转就是"选错了旋律"
  const legacyTimbre = new Map(planHifi(legacy.notes).events.map((e) => [`${e.step}:${e.row}`, e.timbre]));
  let flipped = 0;
  const innerSteps = new Set();
  for (const e of planHifi(labeled.notes).events) {
    const k = `${e.step}:${e.row}`;
    if (legacyTimbre.get(k) === e.timbre) continue;
    if ((e.timbre === 'strings' && legacyTimbre.get(k) === 'bell')
      || (e.timbre === 'bell' && legacyTimbre.get(k) === 'strings')) { flipped++; innerSteps.add(e.step); }
  }
  assert.ok(flipped > 0, `两套口径应当存在分歧（实测 ${flipped} 颗）`);
  console.log(`   两套口径分歧：${flipped} 颗音 / ${innerSteps.size} 个 step`);
});
