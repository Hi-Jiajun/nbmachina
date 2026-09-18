// T4 去撞格/去重测试：撞格口径 = 同一 (step,row) 上 ≥2 颗音
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  dedupeNotes,
  detectCollisions,
  DEFAULT_VOICE_PRIORITY,
  INSTRUMENT_VOICE,
  readNotesCsv,
  notesToCsv,
  dedupeCsvText,
} from '../src/arrange/dedupe.mjs';

const BUILD = process.env.nbmachina_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const V3 = path.join(BUILD, 'styx_helix_notes_v3.csv');
const n = (o) => ({ instrument: 'harp', len: 1, ...o });

test('声部优先级表：harp→melody、bass→bass，旋律优先于低音', () => {
  assert.equal(INSTRUMENT_VOICE.harp, 'melody');
  assert.equal(INSTRUMENT_VOICE.bass, 'bass');
  assert.ok(DEFAULT_VOICE_PRIORITY.indexOf('melody') < DEFAULT_VOICE_PRIORITY.indexOf('bass'));
  assert.equal(DEFAULT_VOICE_PRIORITY.length, 4);
});

test('detectCollisions 只挑出 ≥2 颗音的 (step,row)，且按 step/row 排序', () => {
  const notes = [
    n({ step: 1, row: 5, midi: 65, velocity: 10 }),
    n({ step: 0, row: 5, midi: 65, velocity: 10 }),
    n({ step: 1, row: 5, midi: 77, velocity: 10 }),
    n({ step: 0, row: 9, midi: 69, velocity: 10 }),
  ];
  const cells = detectCollisions(notes);
  assert.deepEqual(cells.map((c) => [c.step, c.row, c.notes.length]), [[1, 5, 2]]);
});

test('同声部完全重复：合并为一颗并保留力度高者', () => {
  const notes = [
    n({ step: 3, row: 7, midi: 67, velocity: 40 }),
    n({ step: 3, row: 7, midi: 67, velocity: 90 }),
  ];
  const { notes: out, report } = dedupeNotes(notes);
  assert.equal(out.length, 1);
  assert.equal(out[0].velocity, 90);
  assert.equal(report.summary.mergedAway, 1);
  assert.equal(report.merged[0].rule, 'exact-duplicate');
  assert.equal(report.merged[0].kept.velocity, 90);
  assert.equal(report.merged[0].dropped[0].velocity, 40);
});

test('同声部同音级异八度（相差整数八度）：合并，reason=same-voice-octave', () => {
  const notes = [
    n({ step: 64, row: 13, midi: 61, velocity: 35 }),
    n({ step: 64, row: 13, midi: 73, velocity: 35 }),
  ];
  const { notes: out, report } = dedupeNotes(notes);
  assert.equal(out.length, 1);
  assert.equal(report.merged[0].rule, 'same-voice-octave');
  assert.equal(report.summary.collisionsByRule['same-voice-octave'], 1);
  assert.equal(report.merged[0].dropped.length, 1);
});

test('跨声部撞格：按声部优先级保留旋律，力度取组内最大', () => {
  const notes = [
    n({ step: 32, row: 8, midi: 44, velocity: 60, instrument: 'bass', voice: 'bass' }),
    n({ step: 32, row: 8, midi: 80, velocity: 50, instrument: 'harp', voice: 'melody' }),
  ];
  const { notes: out, report } = dedupeNotes(notes);
  assert.equal(out.length, 1);
  assert.equal(out[0].voice, 'melody');
  assert.equal(out[0].midi, 80);
  assert.equal(out[0].velocity, 60, '合并后力度取组内最大（保留"最响的那一次"）');
  assert.equal(report.merged[0].rule, 'cross-voice');
  assert.equal(report.merged[0].dropped[0].voice, 'bass');
  assert.equal(report.summary.droppedByVoice.bass, 1);
});

test('优先级可配置：bass 优先时保留低音', () => {
  const notes = [
    n({ step: 1, row: 8, midi: 44, velocity: 60, instrument: 'bass', voice: 'bass' }),
    n({ step: 1, row: 8, midi: 80, velocity: 50, instrument: 'harp', voice: 'melody' }),
  ];
  const { notes: out } = dedupeNotes(notes, { voicePriority: ['bass', 'melody'] });
  assert.equal(out.length, 1);
  assert.equal(out[0].voice, 'bass');
});

test('3~4 颗音同时撞一格：合成一颗，其余全部进 dropped', () => {
  const notes = [
    n({ step: 2, row: 4, midi: 64, velocity: 10, instrument: 'bass', voice: 'bass' }),
    n({ step: 2, row: 4, midi: 64, velocity: 20, instrument: 'bass', voice: 'bass' }),
    n({ step: 2, row: 4, midi: 76, velocity: 30, instrument: 'bass', voice: 'bass' }),
    n({ step: 2, row: 4, midi: 88, velocity: 40, instrument: 'bass', voice: 'bass' }),
  ];
  const { notes: out, report } = dedupeNotes(notes);
  assert.equal(out.length, 1);
  assert.equal(out[0].velocity, 40);
  assert.equal(report.merged[0].dropped.length, 3);
  assert.equal(report.summary.notesIn, 4);
  assert.equal(report.summary.notesOut, 1);
});

test('力度相同时用"离本声部音域中心更近"决策，最后用 midi 兜底（决定论）', () => {
  const notes = [
    n({ step: 0, row: 0, midi: 72, velocity: 50 }),
    n({ step: 0, row: 0, midi: 84, velocity: 50 }),
    n({ step: 0, row: 0, midi: 96, velocity: 50 }),
  ];
  const { notes: out, report } = dedupeNotes(notes);
  assert.equal(out.length, 1);
  assert.equal(out[0].midi, 84, '声部中心中位数 = 84，应保留它');
  assert.deepEqual(report.merged[0].dropped.map((d) => d.midi).sort((a, b) => a - b), [72, 96]);
});

test('不乱动没撞格的音，且输出按 (step,row) 排序；len 取组内最大', () => {
  const notes = [
    n({ step: 5, row: 3, midi: 63, velocity: 10, len: 2 }),
    n({ step: 2, row: 9, midi: 69, velocity: 10 }),
    n({ step: 5, row: 3, midi: 63, velocity: 20, len: 7 }),
  ];
  const { notes: out } = dedupeNotes(notes);
  assert.deepEqual(out.map((x) => [x.step, x.row]), [[2, 9], [5, 3]]);
  assert.equal(out[1].len, 7);
});

test('输入顺序不影响结果（决定论）', () => {
  const base = [
    n({ step: 1, row: 1, midi: 61, velocity: 30 }),
    n({ step: 1, row: 1, midi: 73, velocity: 30 }),
    n({ step: 0, row: 2, midi: 62, velocity: 30, instrument: 'bass', voice: 'bass' }),
  ];
  const a = dedupeNotes(base).notes;
  const b = dedupeNotes([...base].reverse()).notes;
  assert.deepEqual(a, b);
});

test('去撞格后撞格数必须为 0（幂等：再跑一次不再变）', () => {
  const notes = [
    n({ step: 1, row: 1, midi: 61, velocity: 30 }),
    n({ step: 1, row: 1, midi: 73, velocity: 30 }),
    n({ step: 1, row: 1, midi: 61, velocity: 80 }),
  ];
  const once = dedupeNotes(notes);
  assert.equal(detectCollisions(once.notes).length, 0);
  const twice = dedupeNotes(once.notes);
  assert.deepEqual(twice.notes, once.notes);
  assert.equal(twice.report.summary.mergedAway, 0);
});

test('report 里带策略与统计，便于写进验收报告', () => {
  const { report } = dedupeNotes([
    n({ step: 1, row: 1, midi: 61, velocity: 30 }),
    n({ step: 1, row: 1, midi: 73, velocity: 30 }),
  ]);
  assert.equal(report.policy.velocityPolicy, 'max');
  assert.deepEqual(report.policy.voicePriority, DEFAULT_VOICE_PRIORITY);
  assert.deepEqual(report.policy.decideOrder, ['voicePriority', 'velocity', 'registerDistance', 'midi']);
  assert.equal(report.summary.cells, 1);
  assert.equal(report.summary.collisionCells, 1);
  assert.equal(report.summary.notesIn, 2);
  assert.equal(report.summary.notesOut, 1);
});

test('CSV 往返：列名与格式保持不变（可直接替换 v3 喂给 layout）', () => {
  const csv = [
    'step,tick,time_seconds,instrument,midi,row,volume',
    '0,0,0.000,bass,33,9,0.900',
    '0,0,0.000,harp,75,9,0.400',
    '2,24,0.240,harp,80,20,0.500',
    '',
  ].join('\n');
  const rows = readNotesCsv(csv);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].instrument, 'harp');
  assert.equal(rows[1].velocity, Math.round(0.4 * 127), 'CSV 的 volume 必须同时归一成 0..127 的 velocity');
  const back = notesToCsv(rows);
  assert.equal(back.split('\n')[0], 'step,tick,time_seconds,instrument,midi,row,volume');
  assert.ok(back.includes('0,0,0.000,bass,33,9,0.900'), '未合并的音必须逐字符往返');

  const { csv: out, report } = dedupeCsvText(csv);
  assert.equal(out.trim().split('\n').length, 3, '同 step/row 的两颗音合成一颗（另加表头）');
  assert.equal(report.summary.collisionCells, 1);
  const kept = out.trim().split('\n')[1].split(',');
  assert.equal(kept[3], 'harp', '跨声部撞格保留旋律声部（音高/音色由声部优先级决定）');
  assert.equal(kept[5], '9');
  assert.equal(kept[6], '0.900', '但响度取组内最大（最响的那次）');
});

test('真实数据：v3 CSV 的 276 个撞格 → 0', (t) => {
  if (!fs.existsSync(V3)) return t.skip(`缺少 ${V3}`);
  const { csv, report } = dedupeCsvText(fs.readFileSync(V3, 'utf8'));
  assert.ok(report.summary.collisionCells >= 200, `撞格数 ${report.summary.collisionCells}`);
  assert.equal(detectCollisions(readNotesCsv(csv)).length, 0);
  assert.equal(report.summary.collisionsByRule['exact-duplicate'], 2);
  assert.equal(report.summary.notesIn - report.summary.notesOut, report.summary.mergedAway);
  console.log(
    `    v3: ${report.summary.notesIn} 音 / ${report.summary.cells} 格 → 撞格 ${report.summary.collisionCells} → 0，` +
      `合并掉 ${report.summary.mergedAway} 颗（${JSON.stringify(report.summary.collisionsByRule)}）`,
  );
});

test('M3-14：去撞格不得吞掉追加列（velocity/velMidi 要能到 emit）', () => {
  // 编曲链在去撞格之前会追加 velocity / velocityRaw / velocityReason / velMidi 四列，
  // 去撞格是它们的必经之路：一旦被"固定 7 列"重写掉，实测力度就永远到不了数据包。
  const header = 'step,tick,time_seconds,instrument,midi,row,volume,velocity,velocityRaw,velocityReason,velMidi';
  const row = (step, midi, vol, vel, raw, semis) =>
    [step, step * 12, (step * 0.12).toFixed(3), 'harp', midi, midi - 60, vol.toFixed(3), vel, raw, 'measured', semis].join(',');
  const withExtra = [header, row(0, 72, 0.35, 0.42, 0.15), row(1, 74, 0.5, 0.61, 0.9)].join('\n') + '\n';
  // 对照：同样的音符、没有追加列（旧口径）
  const plain = withExtra.split('\n').map((l) => l.split(',').slice(0, 7).join(',')).join('\n');

  const a = dedupeCsvText(withExtra);
  const b = dedupeCsvText(plain);
  assert.equal(a.csv.split('\n')[0], header, '追加列必须原样保留在表头里');
  const rows = a.csv.trim().split('\n').slice(1);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].split(',').slice(7).join(','), '0.42,0.15,measured,', '追加列逐字符保留');
  // 去撞格的决策字段（前 7 列）必须与旧口径完全一致
  assert.deepEqual(
    a.csv.trim().split('\n').map((l) => l.split(',').slice(0, 7).join(',')),
    b.csv.trim().split('\n').map((l) => l.split(',').slice(0, 7).join(',')),
    '追加列不得影响去撞格结果',
  );
});
