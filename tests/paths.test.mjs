// M2-2 · 工作目录 / 工程名解析单测
//
// 这一层的唯一职责：把「build 目录 + 工程名」解析成绝对路径，让所有脚本都有统一的路径来源。
// 最重要的回归点是**默认取值必须与历史硬编码逐字符一致**——历史脚本里写死的
// `C:/Users/hiliang/Documents/minecraft/build` 与 `styx_helix_*` 是"改造前后产出 sha256 一致"的前提。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultBuildDir, findFlag, normalizeDir, resolvePaths, REPO_ROOT } from '../src/core/paths.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
/** 历史默认 build 目录（改造前写死在每个脚本里的那个字符串） */
const LEGACY_BUILD = path.resolve(REPO, '..', 'build').replace(/\\/g, '/');

const tmp = (label) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `nbmachina-paths-${label}-`));
const posix = (p) => p.replace(/\\/g, '/');

test('默认（无参数、无环境变量）：build = 仓库上层的 build，工程名 = 历史参考曲 styx', () => {
  const P = resolvePaths({ argv: [], env: {} });
  assert.equal(P.build, LEGACY_BUILD);
  assert.equal(P.project, 'styx');
  assert.equal(P.prefix, 'styx_helix');
});

test('默认取值与历史硬编码逐字符一致（改造前后 sha256 一致的前提）', () => {
  const P = resolvePaths({ argv: [], env: {} });
  assert.equal(defaultBuildDir(), LEGACY_BUILD);
  assert.equal(P.audio, `${LEGACY_BUILD}/styx_helix_full.wav`);
  assert.equal(P.notes, `${LEGACY_BUILD}/styx_helix_notes.csv`);
  assert.equal(P.notesV3, `${LEGACY_BUILD}/styx_helix_notes_v3.csv`);
  assert.equal(P.machine, `${LEGACY_BUILD}/styx_helix_machine.csv`);
  assert.equal(P.packDir, `${LEGACY_BUILD}/styx_build`);
  assert.equal(P.datapackDir, `${LEGACY_BUILD}/styx_build/data/styx`);
  assert.equal(P.functionsDir, `${LEGACY_BUILD}/styx_build/data/styx/function`);
  assert.equal(P.structuresDir, `${LEGACY_BUILD}/styx_build/data/styx/structure`);
  assert.equal(P.tagDir, `${LEGACY_BUILD}/styx_build/data/minecraft/tags/function`);
  assert.equal(P.profile, `${LEGACY_BUILD}/single_row_profile.json`);
});

test('--build：相对路径按 cwd 解析、反斜杠统一成正斜杠（Windows 与历史写法同形）', () => {
  const d = tmp('rel');
  const rel = path.relative(process.cwd(), d);
  assert.equal(resolvePaths({ argv: ['--build', rel], env: {} }).build, posix(path.resolve(d)));
  assert.equal(resolvePaths({ argv: ['--build', d.replace(/\//g, '\\')], env: {} }).build, posix(path.resolve(d)));
  assert.equal(resolvePaths({ argv: ['--build', d], env: {}, cwd: 'C:/' }).build, posix(path.resolve(d)));
});

test('--build=<dir> 等号写法与 --build <dir> 等价；末尾斜杠被归一化', () => {
  const d = tmp('eq');
  assert.equal(resolvePaths({ argv: [`--build=${d}/`], env: {} }).build, posix(path.resolve(d)));
});

test('nbmachina_BUILD 环境变量生效；--build 覆盖环境变量', () => {
  const envDir = tmp('env');
  const flagDir = tmp('flag');
  assert.equal(resolvePaths({ argv: [], env: { nbmachina_BUILD: envDir } }).build, posix(path.resolve(envDir)));
  assert.equal(
    resolvePaths({ argv: ['--build', flagDir], env: { nbmachina_BUILD: envDir } }).build,
    posix(path.resolve(flagDir)),
  );
});

test('--build 缺值时报错（不静默退回默认目录）', () => {
  assert.throws(() => resolvePaths({ argv: ['--build'], env: {} }), /--build/);
  assert.throws(() => resolvePaths({ argv: ['--project'], env: {} }), /--project/);
});

test('--project <name>：工程名决定文件名前缀（音频/谱面/机器谱面/数据包目录）', () => {
  const d = tmp('proj');
  const P = resolvePaths({ argv: ['--build', d, '--project', 'mySong'], env: {} });
  assert.equal(P.project, 'mySong');
  assert.equal(P.prefix, 'mySong');
  assert.equal(P.audio, `${posix(path.resolve(d))}/mySong_full.wav`);
  assert.equal(P.notes, `${posix(path.resolve(d))}/mySong_notes.csv`);
  assert.equal(P.notesV3, `${posix(path.resolve(d))}/mySong_notes_v3.csv`);
  assert.equal(P.machine, `${posix(path.resolve(d))}/mySong_machine.csv`);
  assert.equal(P.packDir, `${posix(path.resolve(d))}/mySong_build`);
  assert.equal(P.tagDir, `${posix(path.resolve(d))}/mySong_build/data/minecraft/tags/function`);
});

test('--project styx 是历史别名：仍解析成 styx_helix_*，与不传 --project 完全一致', () => {
  const a = resolvePaths({ argv: ['--project', 'styx'], env: {} });
  const b = resolvePaths({ argv: [], env: {} });
  assert.equal(a.prefix, 'styx_helix');
  assert.deepEqual(
    [a.audio, a.notes, a.notesV3, a.machine, a.packDir],
    [b.audio, b.notes, b.notesV3, b.machine, b.packDir],
  );
});

test('nbmachina_PROJECT 生效；--project 覆盖环境变量', () => {
  const d = tmp('envproj');
  assert.equal(resolvePaths({ argv: [], env: { nbmachina_BUILD: d, nbmachina_PROJECT: 'songA' } }).packDir, `${posix(path.resolve(d))}/songA_build`);
  assert.equal(
    resolvePaths({ argv: ['--project', 'songB'], env: { nbmachina_BUILD: d, nbmachina_PROJECT: 'songA' } }).packDir,
    `${posix(path.resolve(d))}/songB_build`,
  );
});

test('工程名非法（空 / 含路径分隔符 / 空格 / 非 ASCII）时明确报错', () => {
  for (const bad of ['', ' ', 'a/b', 'a\\b', 'my song', '歌曲', '.', '..']) {
    assert.throws(() => resolvePaths({ argv: ['--project', bad], env: {} }), /工程名/, `应拒绝工程名 ${JSON.stringify(bad)}`);
  }
});

test('build 目录里的 project.json 可声明 nbmachina.project，作为兜底（--project/环境变量优先）', () => {
  const d = tmp('manifest');
  fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({
    meta: { title: 'Demo' },
    nbmachina: { project: 'demo' },
  }), 'utf8');
  assert.equal(resolvePaths({ argv: ['--build', d], env: {} }).project, 'demo');
  assert.equal(resolvePaths({ argv: ['--build', d], env: {} }).machine, `${posix(path.resolve(d))}/demo_machine.csv`);
  assert.equal(resolvePaths({ argv: ['--build', d, '--project', 'override'], env: {} }).project, 'override');
  assert.equal(resolvePaths({ argv: ['--build', d], env: { nbmachina_PROJECT: 'override2' } }).project, 'override2');
});

test('project.json 坏掉（非法 JSON / nbmachina.project 不是字符串）不抛异常，退回历史默认', () => {
  const d = tmp('broken');
  fs.writeFileSync(path.join(d, 'project.json'), '{ not json', 'utf8');
  assert.equal(resolvePaths({ argv: ['--build', d], env: {} }).project, 'styx');
  fs.writeFileSync(path.join(d, 'project.json'), JSON.stringify({ nbmachina: { project: 42 } }), 'utf8');
  assert.equal(resolvePaths({ argv: ['--build', d], env: {} }).project, 'styx');
});

test('file()/prefixed() 两个辅助函数：普通中间产物 vs 带工程前缀的产物', () => {
  const d = tmp('helper');
  const P = resolvePaths({ argv: ['--build', d, '--project', 'demo'], env: {} });
  assert.equal(P.file('machine_pipeline.csv'), `${posix(path.resolve(d))}/machine_pipeline.csv`);
  assert.equal(P.prefixed('machine.csv'), `${posix(path.resolve(d))}/demo_machine.csv`);
  assert.equal(P.file('manifest.json').startsWith(P.build + '/'), true);
});

test('解析过程是纯的：不创建目录、不写文件', () => {
  const d = path.join(tmp('pure'), 'not-yet-created');
  const P = resolvePaths({ argv: ['--build', d, '--project', 'x'], env: {} });
  assert.equal(fs.existsSync(P.build), false);
  assert.equal(fs.existsSync(P.packDir), false);
});

test('findFlag/normalizeDir 两个小工具的行为', () => {
  assert.equal(findFlag(['--a', '1', '--b'], 'a'), '1');
  assert.equal(findFlag(['--b'], 'b'), true);
  assert.equal(findFlag(['--b=2'], 'b'), '2');
  assert.equal(findFlag(['--bb=3'], 'b'), undefined);
  assert.equal(findFlag([], 'a'), undefined);
  assert.equal(normalizeDir('C:\\a\\b\\'), 'C:/a/b');
  assert.equal(REPO_ROOT, posix(REPO));
});
