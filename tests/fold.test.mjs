import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { foldOne, foldRows, parseCsv, toMachineCsv } from '../src/arrange/fold.mjs';

const BUILD = 'C:/Users/hiliang/Documents/minecraft/build';

test('foldOne 保持音级，且结果落在 0..24', () => {
  for (let midi = 0; midi <= 127; midi++) {
    for (const prev of [0, 5, 12, 18, 24]) {
      const row = foldOne(midi, prev);
      assert.ok(row >= 0 && row <= 24, `midi ${midi} prev ${prev} → ${row}`);
      assert.equal(row % 12, ((midi % 12) + 12) % 12, `midi ${midi} 音级被改了`);
    }
  }
});

test('foldOne 选离上一个音最近的八度（保留走向）', () => {
  assert.equal(foldOne(60, 18), 12);  // C4 的两个候选 0/12，离 18 更近的是 12
  assert.equal(foldOne(61, 1), 1);    // C#4 候选 1/13，离 1 更近的是 1
  assert.equal(foldOne(85, 20), 13);  // C#6 → 1/13，离 20 更近的是 13
});

test('对原始 v3 数据折叠必须逐行复现现有 row（3099/3099，注意 foldRows 会按 step/midi 重排）', (t) => {
  const p = `${BUILD}/styx_helix_notes_v3.csv`;
  if (!fs.existsSync(p)) return t.skip('缺少 build/styx_helix_notes_v3.csv');
  const notes = parseCsv(fs.readFileSync(p, 'utf8')).map((n, id) => ({ ...n, id }));
  const folded = foldRows(notes);
  const rows = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).slice(1).map((l) => +l.split(',')[5]);
  assert.equal(folded.length, rows.length);
  const byId = new Map(folded.map((r) => [r.id, r.row]));
  let bad = 0;
  for (let i = 0; i < rows.length; i++) if (byId.get(i) !== rows[i]) bad++;
  assert.equal(bad, 0, `${bad} 行与原 row 不一致`);
});

test('toMachineCsv 输出 v3 列形态，且 tick = round(step×0.12×tps)', () => {
  const csv = toMachineCsv(foldRows([{ step: 0, instrument: 'harp', midi: 75 }, { step: 5, instrument: 'bass', midi: 33 }]));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'step,tick,time_seconds,instrument,midi,row,volume');
  assert.equal(lines[1].split(',')[1], '0');
  assert.equal(lines[2].split(',')[1], String(Math.round(5 * 0.12 * 100)));
});
