// M3-1 · 内声部/和声层（`src/arrange/inner-voice.mjs`）单测
//
// 验收口径（任务书 `nbmachina_inner_voice.md` §2.3）：合成 fixture 覆盖
//   「同刻多音 → 拆成旋律/内声部」「临界音区边界」「单音不产生内声部」「空输入」
//   「幂等（跑两次同结果）」「CSV 契约：既有列逐字符保留，只追加新列」「instrument 取值合法性」
// 之外再加 **真实数据断言**（读 `build/` 的真实 CSV）与 **emit/lint 链路断言**——
// 真实数据断言一律不 skip：产物不在就报错（"跳过"会把回归藏起来）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  APPENDED_COLUMNS,
  INNER_INSTRUMENT,
  innerVoiceCsvText,
  parseTable,
  splitInnerVoice,
} from '../src/arrange/inner-voice.mjs';
import { DEFAULT_VOICE_PRIORITY, INSTRUMENT_VOICE } from '../src/arrange/dedupe.mjs';
import { VOICE_OF_INSTRUMENT, voiceOfInstrument } from '../src/arrange/velocity.mjs';
import { makePos, noteBlockOf } from '../src/emit/layout-pos.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const BUILD = 'C:/Users/hiliang/Documents/minecraft/build';
const HEADER7 = ['step', 'tick', 'time_seconds', 'instrument', 'midi', 'row', 'volume'];
const PC = (m) => ((m % 12) + 12) % 12;

/** 造 7 列 fixture：row 缺省按"音级 + 12 的倍数"推（与 fold.mjs 同口径） */
const csv7 = (rows, header = HEADER7) => [
  header.join(','),
  ...rows.map((r) => [
    r.step,
    r.step * 12,
    (r.step * 0.12).toFixed(3),
    r.instrument,
    r.midi,
    r.row ?? PC(r.midi),
    (r.volume ?? 0.35).toFixed(3),
  ].join(',')),
].join('\n') + '\n';

/** CSV → 行对象（按列名取值，便于断言"哪颗音被标成什么"） */
const toObjs = (csv) => {
  const { header, rows } = parseTable(csv);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r.fields[i]])));
};

test('空输入：只有表头 → 没有音符、没有内声部，只在末尾追加三列表头', () => {
  const { csv, report } = innerVoiceCsvText(csv7([]));
  assert.equal(report.summary.notesIn, 0);
  assert.equal(report.summary.innerNotes, 0);
  assert.equal(report.collisionBefore.physical.cells, 0);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 1, '只有表头');
  assert.equal(lines[0], [...HEADER7, ...APPENDED_COLUMNS].join(','));
});

test('单音 step 不产生内声部；低音不参与拆分（原样透传、role=bass）', () => {
  const { csv, report } = innerVoiceCsvText(csv7([
    { step: 0, instrument: 'bass', midi: 33, row: 9 },
    { step: 0, instrument: 'harp', midi: 75, row: 15 },
    { step: 2, instrument: 'harp', midi: 80, row: 20 },
  ]));
  assert.equal(report.summary.innerNotes, 0);
  assert.equal(report.summary.melodyNotes, 2);
  assert.equal(report.summary.stepsMultiMelodyLayer, 0);
  const objs = toObjs(csv);
  assert.deepEqual(objs.map((o) => [o.instrument, o.voiceRole]), [['bass', 'bass'], ['harp', 'melody'], ['harp', 'melody']]);
});

test('同刻多音 → 续线的那颗留 harp(旋律)，另一颗标 inner 并记 innerOf/innerReason', () => {
  const { csv, report } = innerVoiceCsvText(csv7([
    { step: 0, instrument: 'harp', midi: 75, row: 15 },   // 建立旋律游标 = 75
    { step: 2, instrument: 'harp', midi: 74, row: 14 },   // |74−75|=1 → 旋律
    { step: 2, instrument: 'harp', midi: 66, row: 6 },    // |66−75|=9 → 内声部
  ]));
  assert.equal(report.summary.innerNotes, 1);
  assert.equal(report.summary.innerDistinct, 1);
  const objs = toObjs(csv);
  const inner = objs.find((o) => o.instrument === INNER_INSTRUMENT);
  assert.ok(inner, '必须有 instrument=inner 的行');
  assert.equal(inner.voiceRole, 'inner');
  assert.equal(inner.midi, '66');
  assert.equal(inner.row, '6');
  assert.equal(inner.innerOf, '74', 'innerOf 指向同刻旋律的 midi');
  assert.equal(inner.innerReason, 'chord-tone');
  assert.equal(objs.find((o) => o.midi === '74').instrument, 'harp', '旋律音色不变');
});

test('旋律判定按"续线"而不是"最高音"：melodyFrom=top 得到另一颗（两种模式都断言）', () => {
  const rows = [
    { step: 0, instrument: 'harp', midi: 75, row: 15 },   // 游标 = 75
    { step: 2, instrument: 'harp', midi: 73, row: 13 },   // 续线：|73−75|=2
    { step: 2, instrument: 'harp', midi: 80, row: 20 },   // 最高音（|80−75|=5）
  ];
  const cont = toObjs(innerVoiceCsvText(csv7(rows), { melodyFrom: 'continuation' }).csv);
  const last = (objs, role) => objs.filter((o) => o.voiceRole === role).at(-1);
  assert.equal(last(cont, 'melody').midi, '73');
  assert.equal(last(cont, 'inner').midi, '80');
  const top = toObjs(innerVoiceCsvText(csv7(rows), { melodyFrom: 'top' }).csv);
  assert.equal(last(top, 'melody').midi, '80');
  assert.equal(last(top, 'inner').midi, '73');
});

test('三音和弦 → 1 旋律 + 2 内声部，两颗内声部的 innerOf 都指向旋律音高', () => {
  const { csv, report } = innerVoiceCsvText(csv7([
    { step: 0, instrument: 'harp', midi: 75, row: 15 },
    { step: 1, instrument: 'harp', midi: 74, row: 14 },
    { step: 1, instrument: 'harp', midi: 66, row: 6 },
    { step: 1, instrument: 'harp', midi: 62, row: 2 },
  ]));
  assert.equal(report.summary.melodyNotes, 2);
  assert.equal(report.summary.innerNotes, 2);
  assert.equal(report.summary.stepsMultiMelodyLayer, 1);
  const inners = toObjs(csv).filter((o) => o.voiceRole === 'inner');
  assert.deepEqual(inners.map((o) => o.midi).sort(), ['62', '66']);
  assert.ok(inners.every((o) => o.innerOf === '74'));
});

test('同 step 同 midi 的完全重复：不造音、不搬八度，一颗旋律 + 一颗 inner(duplicate-of-melody)', () => {
  const { csv, report } = innerVoiceCsvText(csv7([
    { step: 0, instrument: 'harp', midi: 76, row: 4 },
    { step: 1, instrument: 'harp', midi: 76, row: 4 },   // |76−76|=0 → 旋律
    { step: 1, instrument: 'harp', midi: 76, row: 4 },   // 与旋律完全重复
    { step: 1, instrument: 'harp', midi: 81, row: 9 },   // 和弦音（高音）
    { step: 1, instrument: 'harp', midi: 69, row: 9 },   // 和弦音（低音）
  ]));
  assert.equal(report.summary.innerDuplicateOfMelody, 1);
  assert.equal(report.summary.innerDistinct, 2);
  assert.equal(report.register.moved, 0, 'keep 模式一颗都不搬');
  const objs = toObjs(csv);
  const dup = objs.find((o) => o.innerReason === 'duplicate-of-melody');
  assert.equal(dup.midi, '76');
  assert.equal(dup.row, '4');
  assert.equal(objs.filter((o) => o.midi === '76').length, 3, '音高一个没多、一个没少');
});

test('register=keep：midi/row 与输入逐字符一致（只改 instrument 与追加列）', () => {
  const rows = [
    { step: 0, instrument: 'harp', midi: 75, row: 15 },
    { step: 1, instrument: 'harp', midi: 68, row: 8 },
    { step: 1, instrument: 'harp', midi: 71, row: 11 },
    { step: 1, instrument: 'bass', midi: 40, row: 4 },
  ];
  const before = toObjs(csv7(rows));
  const after = toObjs(innerVoiceCsvText(csv7(rows), { register: 'keep' }).csv);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].midi, before[i].midi);
    assert.equal(after[i].row, before[i].row);
    assert.equal(after[i].step, before[i].step);
    for (const c of ['tick', 'time_seconds', 'volume']) assert.equal(after[i][c], before[i][c]);
  }
  assert.equal(after.filter((o) => o.instrument === INNER_INSTRUMENT).length, 1);
});

test('临界音区边界 register=band：内声部落进 0..11 带内该音级的唯一行；目标被占则保持原行', () => {
  const free = innerVoiceCsvText(csv7([
    { step: 0, instrument: 'harp', midi: 76, row: 4 },
    { step: 1, instrument: 'harp', midi: 77, row: 5 },   // 旋律
    { step: 1, instrument: 'harp', midi: 80, row: 20 },  // 内声部：pc 8 → 低带 row 8
  ]), { register: 'band' });
  const moved = toObjs(free.csv).find((o) => o.instrument === INNER_INSTRUMENT);
  assert.equal(moved.row, '8', '内声部落到低带（0..11）该音级的唯一一行');
  assert.equal(moved.midi, '68', '同音级（pc 8）换八度：midi 80 → 68');
  assert.equal(PC(+moved.midi), PC(80));

  const blocked = innerVoiceCsvText(csv7([
    { step: 0, instrument: 'harp', midi: 76, row: 4 },
    { step: 1, instrument: 'bass', midi: 68, row: 8 },   // 低带 row 8 被低音占住
    { step: 1, instrument: 'harp', midi: 77, row: 5 },
    { step: 1, instrument: 'harp', midi: 80, row: 20 },
  ]), { register: 'band' });
  const kept = toObjs(blocked.csv).find((o) => o.instrument === INNER_INSTRUMENT);
  assert.equal(kept.row, '20', '目标格被占 → 保持原行（不静默丢掉、也不抢低音的格）');
  assert.ok(blocked.report.register.blockedOccupied >= 1);
});

test('register=relocate：只在"否则会被撞格合并"时搬，同音级、优先向下、不越界', () => {
  const base = [
    { step: 0, instrument: 'harp', midi: 76, row: 4 },
    { step: 1, instrument: 'harp', midi: 77, row: 5 },
    { step: 1, instrument: 'harp', midi: 80, row: 20 },
  ];
  // 没撞格 → 一颗都不搬（最小改动）
  const noCollision = innerVoiceCsvText(csv7(base), { register: 'relocate' });
  assert.equal(noCollision.report.register.moved, 0);
  assert.equal(toObjs(noCollision.csv).find((o) => o.instrument === INNER_INSTRUMENT).row, '20');

  // 同格被低音占住 → 搬到同音级的另一个空闲八度，优先向下（内声部在下）
  const down = innerVoiceCsvText(csv7([...base.slice(0, 2), { step: 1, instrument: 'bass', midi: 68, row: 20 }, base[2]]), { register: 'relocate' });
  assert.equal(down.report.register.moved, 1);
  assert.equal(down.report.register.movedDown, 1);
  const movedDown = toObjs(down.csv).find((o) => o.instrument === INNER_INSTRUMENT);
  assert.equal(movedDown.row, '8');
  assert.equal(movedDown.midi, '68');

  // 向下越界（row < 12 没有向下候选）→ 只能向上，且任何结果都在 0..24
  const up = innerVoiceCsvText(csv7([
    { step: 0, instrument: 'harp', midi: 76, row: 4 },
    { step: 1, instrument: 'harp', midi: 77, row: 5 },
    { step: 1, instrument: 'bass', midi: 68, row: 8 },  // pc 8 的低带格被占
    { step: 1, instrument: 'harp', midi: 68, row: 8 },  // 内声部与低音同格
  ]), { register: 'relocate' });
  const movedUp = toObjs(up.csv).find((o) => o.instrument === INNER_INSTRUMENT);
  assert.equal(movedUp.row, '20');
  assert.equal(up.report.register.movedUp, 1);
  for (const o of toObjs(up.csv)) assert.ok(+o.row >= 0 && +o.row <= 24, `row ${o.row} 越界`);
});

test('幂等：同一输入跑两次逐字节相同；对已拆分的输出再跑不会产生新的内声部', () => {
  const input = csv7([
    { step: 0, instrument: 'harp', midi: 75, row: 15 },
    { step: 1, instrument: 'harp', midi: 74, row: 14 },
    { step: 1, instrument: 'harp', midi: 66, row: 6 },
    { step: 1, instrument: 'bass', midi: 33, row: 9 },
    { step: 3, instrument: 'harp', midi: 62, row: 2 },
  ]);
  const a = innerVoiceCsvText(input);
  const b = innerVoiceCsvText(input);
  assert.equal(a.csv, b.csv);
  const again = innerVoiceCsvText(a.csv);
  assert.equal(again.csv, a.csv, '二次运行必须逐字节相同（含追加列）');
  assert.equal(again.report.summary.innerNotes, 0, '已经没有"同刻多音"可拆了');
  assert.equal(again.report.summary.melodyNotes, a.report.summary.melodyNotes);
});

test('CSV 契约：既有列（含 velocity 等额外列）逐字符保留，只在末尾追加三列', () => {
  const header = [...HEADER7, 'velocity', 'velocityRaw', 'velocityReason'];
  const input = csv7([
    { step: 0, instrument: 'harp', midi: 75, row: 15 },
    { step: 1, instrument: 'harp', midi: 74, row: 14 },
    { step: 1, instrument: 'harp', midi: 66, row: 6 },
  ], header).trim().split('\n').map((l, i) => (i === 0 ? l : `${l},0.979,3.099749,measured`)).join('\n') + '\n';

  const { csv } = innerVoiceCsvText(input);
  const inLines = input.trim().split('\n');
  const outLines = csv.trim().split('\n');
  assert.equal(outLines[0], `${header.join(',')},${APPENDED_COLUMNS.join(',')}`);
  assert.equal(outLines.length, inLines.length);
  for (let i = 1; i < inLines.length; i++) {
    const before = inLines[i].split(',');
    const after = outLines[i].split(',');
    assert.equal(after.length, before.length + APPENDED_COLUMNS.length, '只追加，不多不少');
    const instrCol = HEADER7.indexOf('instrument');
    for (let c = 0; c < before.length; c++) {
      if (c === instrCol) continue;
      assert.equal(after[c], before[c], `第 ${i} 行第 ${c} 列被改了`);
    }
  }
});

test('instrument 取值合法性：inner 被 dedupe/velocity 的声部表认，且 emit 的摆方块规则接受它', () => {
  assert.equal(INSTRUMENT_VOICE.inner, 'inner');
  assert.equal(VOICE_OF_INSTRUMENT.inner, 'inner');
  assert.equal(voiceOfInstrument('inner'), 'inner');
  assert.ok(DEFAULT_VOICE_PRIORITY.includes('inner'), '声部优先级表里要有 inner');
  assert.ok(
    DEFAULT_VOICE_PRIORITY.indexOf('inner') > DEFAULT_VOICE_PRIORITY.indexOf('bass'),
    '设计口径：低音优先于内声部（bass > inner）',
  );
  // 未登记音色的甲板 → note-blocks.mjs 会把 instrument 退回 harp（同一台机器照常摆方块）
  assert.equal(noteBlockOf('inner', 7), 'minecraft:note_block[instrument=harp,note=7,powered=false]');
  assert.equal(noteBlockOf('harp', 7), noteBlockOf('inner', 7));
});

test('真实数据：build/pipeline_4_sustain.csv 的拆分数字（旋律 1385 / 内声部 354 / 撞格两种口径）', () => {
  const p = `${BUILD}/pipeline_4_sustain.csv`;
  assert.ok(fs.existsSync(p), `缺真实数据 ${p}（先跑 node src/arrange/arrange-all.mjs）——真实数据断言不许跳过`);
  const input = fs.readFileSync(p, 'utf8');
  const { csv, report } = innerVoiceCsvText(input, { register: 'keep' });
  const s = report.summary;
  assert.equal(s.notesIn, 3209);
  assert.equal(s.notesOut, 3209, '拆分不增不减音符');
  assert.equal(s.melodyNotes, 1385);
  assert.equal(s.innerNotes, 354);
  assert.equal(s.stepsMultiMelodyLayer, 238);
  assert.equal(s.innerDistinct + s.innerDuplicateOfMelody + s.innerDuplicateOfInner, 354);
  assert.equal(s.byInstrumentOut.bass, 1470, '低音层原样透传');
  // 撞格：物理口径（机器一格只能响一颗）keep 模式不动行 → 不变；同音色同格口径必须下降
  assert.equal(report.collisionBefore.physical.extraNotes, 294);
  assert.equal(report.collisionAfter.physical.extraNotes, report.collisionBefore.physical.extraNotes);
  assert.equal(report.collisionBefore.sameInstrument.extraNotes, 159);
  assert.equal(report.collisionAfter.sameInstrument.extraNotes, 91);
  // 输出行数与输入一致（幂等的必要条件）
  assert.equal(csv.trim().split('\n').length, input.trim().split('\n').length);
});

test('真实数据：keep 不改动任何音高/行号，且"续线"旋律线比"最高音"更平滑', () => {
  const input = fs.readFileSync(`${BUILD}/pipeline_4_sustain.csv`, 'utf8');
  const before = toObjs(input);
  const cont = innerVoiceCsvText(input, { melodyFrom: 'continuation', register: 'keep' });
  const after = toObjs(cont.csv);
  assert.equal(after.length, before.length);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].midi, before[i].midi, `第 ${i} 行 midi 被改`);
    assert.equal(after[i].row, before[i].row, `第 ${i} 行 row 被改`);
  }
  const top = innerVoiceCsvText(input, { melodyFrom: 'top', register: 'keep' }).report.melodyLine;
  assert.ok(cont.report.melodyLine.notes > 1000, '真实数据上旋律线要有上千颗音');
  assert.ok(
    cont.report.melodyLine.meanAbsInterval < top.meanAbsInterval,
    `续线应更平滑：${cont.report.melodyLine.meanAbsInterval} vs ${top.meanAbsInterval}`,
  );
  assert.ok(cont.report.melodyLine.leapsOver7 < top.leapsOver7, '大跳（>7 半音）次数应更少');
});

test('真实数据 + emit 链路：开 --inner 的谱面能被 note-blocks 摆成方块、并被 lint-pack 静态自检通过', () => {
  const input = fs.readFileSync(`${BUILD}/pipeline_4_sustain.csv`, 'utf8');
  const { csv, report } = innerVoiceCsvText(input, { register: 'keep' });
  const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nbmachina-m31-'));
  // note-blocks 需要地形剖面；其余输入（音频）只有 percussion 才要，这里用不到
  fs.copyFileSync(`${BUILD}/single_row_profile.json`, path.join(tmp, 'single_row_profile.json'));
  fs.writeFileSync(path.join(tmp, 'chart.csv'), csv, 'utf8');
  const run = (script, args) => spawnSync(process.execPath, [path.join(REPO, script), '--build', tmp.replace(/\\/g, '/'), ...args], { encoding: 'utf8', cwd: REPO });
  const nb = run('src/emit/note-blocks.mjs', ['--notes', `${tmp.replace(/\\/g, '/')}/chart.csv`]);
  assert.equal(nb.status, 0, `note-blocks 失败：${nb.stdout}${nb.stderr}`);
  const dp = run('src/emit/datapack-playback.mjs', ['--notes', `${tmp.replace(/\\/g, '/')}/chart.csv`]);
  assert.equal(dp.status, 0, `datapack-playback 失败：${dp.stdout}${dp.stderr}`);
  const lp = run('src/emit/lint-pack.mjs', []);
  assert.equal(lp.status, 0, `lint-pack 失败：${lp.stdout}${lp.stderr}`);
  assert.match(lp.stdout, /静态自检通过/);

  // 内声部的格真的被摆出来了：按 makePos 算 (x,z) 与 note=<row> 必须出现在函数里
  const profile = JSON.parse(fs.readFileSync(`${BUILD}/single_row_profile.json`, 'utf8'));
  const pos = makePos(profile);
  const fn = fs.readFileSync(path.join(tmp, 'styx_build', 'data', 'styx', 'function', 'apply_notes_v3.mcfunction'), 'utf8');
  const inners = report.samples?.length
    ? toObjs(csv).filter((o) => o.instrument === INNER_INSTRUMENT)
    : [];
  assert.ok(inners.length > 0);
  const innerCells = new Set(inners.map((o) => {
    const p = pos(+o.step, +o.row);
    return `${p.x} ${p.y + 1} ${p.z} minecraft:note_block[instrument=harp,note=${+o.row},powered=false]`;
  }));
  const placed = [...innerCells].filter((line) => fn.includes(line)).length;
  assert.ok(placed > 0, `内声部的坐标一条都没摆出来（${placed}/${innerCells.size}）`);
});

test('splitInnerVoice 纯函数：不改入参、非法配置报错、空数组安全', () => {
  const input = [{ step: 0, instrument: 'harp', midi: 75, row: 15, i: 0 }];
  const snapshot = JSON.stringify(input);
  const { notes, report } = splitInnerVoice(input);
  assert.equal(JSON.stringify(input), snapshot, '入参对象不被就地修改');
  assert.equal(notes.length, 1);
  assert.equal(report.summary.innerNotes, 0);
  assert.throws(() => splitInnerVoice(input, { register: 'nope' }), /register 只支持/);
  assert.throws(() => splitInnerVoice(input, { melodyFrom: 'nope' }), /melodyFrom 只支持/);
  assert.equal(splitInnerVoice([]).notes.length, 0);
});
