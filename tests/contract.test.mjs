// T1 数据契约测试：project.json 校验器（SPEC §3）
// 验收口径：现有数据必须通过；故意破坏的样本必须报出**精确字段名**。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateProject, assertProject, ProjectValidationError, VOICES, SOURCE_FORMATS } from '../src/ingest/project-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, 'fixtures');
const BUILD = process.env.nbmachina_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const pathsOf = (errors) => errors.map((e) => e.path);
const valid = () => readJson(path.join(FIX, 'project.valid.json'));

test('最小合法 project.json 通过校验', () => {
  const res = validateProject(valid());
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.errors, []);
  assert.doesNotThrow(() => assertProject(valid()));
});

test('常量表覆盖 SPEC 的声部与 foreign 标准', () => {
  assert.deepEqual(VOICES, ['melody', 'inner', 'bass', 'perc']);
  for (const f of ['musicxml', 'midi', 'smf', 'dawproject']) assert.ok(SOURCE_FORMATS.includes(f));
});

test('真实数据（build/project.json，由现有 v3 CSV 导出）通过校验', (t) => {
  const p = path.join(BUILD, 'project.json');
  if (!fs.existsSync(p)) return t.skip(`缺少 ${p}（先运行 node src/ingest/project-from-notes-csv.mjs）`);
  const res = validateProject(readJson(p));
  assert.equal(res.ok, true, JSON.stringify(res.errors.slice(0, 5)));
  assert.ok(res.stats.notes > 3000, `notes=${res.stats.notes}`);
});

test('校验器给出音符/声部/速度的统计值', () => {
  const res = validateProject(valid());
  assert.equal(res.stats.notes, 3);
  assert.equal(res.stats.voices, 2);
  assert.equal(res.stats.tempoMapEntries, 1);
});

// ---- 3 个故意破坏的样本：必须报出准确字段名 ----
const brokenCases = [
  { file: '01-missing-tempo.json', expect: ['meta.tempo'] },
  { file: '02-midi-out-of-range.json', expect: ['notes[1].midi'] },
  { file: '03-undeclared-voice.json', expect: ['notes[0].voice'] },
];

for (const c of brokenCases) {
  test(`破坏样本 ${c.file} 只报出字段 ${c.expect.join(', ')}`, () => {
    const res = validateProject(readJson(path.join(FIX, 'broken', c.file)));
    assert.equal(res.ok, false);
    assert.deepEqual(pathsOf(res.errors), c.expect);
    for (const e of res.errors) assert.ok(e.message.includes(e.path), e.message);
  });
}

test('assertProject 抛出的错误聚合全部字段，且可打印', () => {
  const bad = valid();
  bad.meta.tempo = 0;
  bad.meta.license = '';
  bad.notes[0].midi = -1;
  bad.notes[1].velocity = 1.5;
  bad.notes[2].voice = 'inner';
  bad.tempoMap[0].bpm = 'fast';
  let err;
  try {
    assertProject(bad);
  } catch (e) {
    err = e;
  }
  assert.ok(err instanceof ProjectValidationError);
  assert.deepEqual(pathsOf(err.errors), [
    'meta.tempo',
    'meta.license',
    'notes[0].midi',
    'notes[1].velocity',
    'notes[2].voice',
    'tempoMap[0].bpm',
  ]);
  assert.deepEqual(new Set(err.errors.map((e) => e.code)), new Set(['RANGE', 'EMPTY', 'TYPE', 'UNKNOWN_VOICE']));
  const text = err.toString();
  for (const p of pathsOf(err.errors)) assert.ok(text.includes(p), text);
});

test('结构错误：顶层不是对象 / notes 不是数组 / 音符不是对象 / voices 重复或为空', () => {
  assert.deepEqual(pathsOf(validateProject([]).errors), ['$']);
  assert.deepEqual(pathsOf(validateProject(null).errors), ['$']);

  const a = valid();
  a.notes = {};
  assert.deepEqual(pathsOf(validateProject(a).errors), ['notes']);

  const b = valid();
  b.notes[1] = 'boom';
  assert.deepEqual(pathsOf(validateProject(b).errors), ['notes[1]']);

  const c = valid();
  c.voices = ['melody', 'bass', 'bass'];
  assert.deepEqual(pathsOf(validateProject(c).errors), ['voices[2]']);

  const d = valid();
  d.voices = [];
  assert.deepEqual(pathsOf(validateProject(d).errors), ['voices']);
});

test('meta.source：格式必须来自标准表、sha256 必须 64 位小写十六进制', () => {
  const a = valid();
  a.meta.source.format = 'pdf-omr';
  assert.deepEqual(pathsOf(validateProject(a).errors), ['meta.source.format']);

  const b = valid();
  b.meta.source.sha256 = 'ABC';
  assert.deepEqual(pathsOf(validateProject(b).errors), ['meta.source.sha256']);

  const c = valid();
  delete c.meta.source.path;
  assert.deepEqual(pathsOf(validateProject(c).errors), ['meta.source.path']);
});

test('tempoMap 必须非空且从 0 秒开始；onset/dur 必须为非负数与正数', () => {
  const a = valid();
  a.tempoMap = [];
  assert.deepEqual(pathsOf(validateProject(a).errors), ['tempoMap']);

  const b = valid();
  b.tempoMap = [{ sec: 1.5, bpm: 120 }];
  assert.deepEqual(pathsOf(validateProject(b).errors), ['tempoMap[0].sec']);

  const c = valid();
  c.notes[0].onsetSec = -0.1;
  assert.deepEqual(pathsOf(validateProject(c).errors), ['notes[0].onsetSec']);

  const d = valid();
  d.notes[0].durSec = 0;
  assert.deepEqual(pathsOf(validateProject(d).errors), ['notes[0].durSec']);
});

test('tie / slur 缺失时按 false 处理，类型错则报字段', () => {
  const a = valid();
  delete a.notes[0].tie;
  delete a.notes[0].slur;
  assert.equal(validateProject(a).ok, true);

  const b = valid();
  b.notes[0].tie = 'yes';
  assert.deepEqual(pathsOf(validateProject(b).errors), ['notes[0].tie']);
});
