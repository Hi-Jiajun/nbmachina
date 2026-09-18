// M2-2 · 新工程骨架（`src/core/new-project.mjs`）单测
//
// 验收口径（任务书 M2-2 §交付 3 / §验收）：
//   `node src/core/new-project.mjs --name demo --build <空目录>` 要在**空目录**里跑出
//   "下一步该做什么"的提示、退出码 0、且生成的 `project.json` 必须过 SPEC §3 校验器。
//   骨架要能被后续脚本认出来（paths.mjs 从 `project.json` 的 `nbmachina.project` 取工程名）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePaths } from '../src/core/paths.mjs';
import { validateProject } from '../src/ingest/project-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, '..');
const NEW_PROJECT = path.join(REPO, 'src', 'core', 'new-project.mjs');
const tmp = (label) => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `nbmachina-newproj-${label}-`));
const run = (args) => {
  const r = spawnSync(process.execPath, [NEW_PROJECT, ...args], { encoding: 'utf8', cwd: REPO });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};
const posix = (p) => p.replace(/\\/g, '/');

test('空目录里建工程：退出码 0、打印"下一步"、骨架文件齐、project.json 过 SPEC 校验', () => {
  const d = tmp('create');
  assert.equal(fs.readdirSync(d).length, 0, '前置条件：目录是空的');

  const r = run(['--name', 'demo', '--build', d]);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /下一步/);

  for (const f of ['README.md', 'project.json']) {
    assert.ok(fs.existsSync(path.join(d, f)), `缺少 ${f}`);
  }
  for (const dir of ['audio', 'midi', 'demo_build']) {
    assert.ok(fs.statSync(path.join(d, dir)).isDirectory(), `缺少目录 ${dir}/`);
  }

  const project = JSON.parse(fs.readFileSync(path.join(d, 'project.json'), 'utf8'));
  assert.equal(project.nbmachina.project, 'demo');
  const res = validateProject(project);
  assert.equal(res.ok, true, `模板自己先要过校验器：${JSON.stringify(res.errors)}`);
  assert.ok(res.stats.notes >= 1);

  const readme = fs.readFileSync(path.join(d, 'README.md'), 'utf8');
  for (const needle of ['demo_full.wav', 'project.json', 'arrange-all.mjs', '--build']) {
    assert.ok(readme.includes(needle), `README 应提到 ${needle}`);
  }
});

test('骨架能被 paths.mjs 认出来：--build <dir> 就能解析出工程名与它的文件名前缀', () => {
  const d = tmp('resolve');
  assert.equal(run(['--name', 'mySong', '--build', d]).code, 0);
  const P = resolvePaths({ argv: ['--build', d], env: {} });
  assert.equal(P.project, 'mySong');
  assert.equal(P.audio, `${posix(path.resolve(d))}/mySong_full.wav`);
  assert.equal(P.packDir, `${posix(path.resolve(d))}/mySong_build`);
});

test('幂等：第二遍不覆盖已经存在的 README/project.json（只补缺失的）', () => {
  const d = tmp('idempotent');
  assert.equal(run(['--name', 'demo', '--build', d]).code, 0);
  const readme = path.join(d, 'README.md');
  fs.writeFileSync(readme, '# 我手改过的 README\n', 'utf8');
  fs.rmSync(path.join(d, 'midi'), { recursive: true });

  const r = run(['--name', 'demo', '--build', d]);
  assert.equal(r.code, 0, r.out);
  assert.equal(fs.readFileSync(readme, 'utf8'), '# 我手改过的 README\n', '已存在的文件不许被覆盖');
  assert.ok(fs.statSync(path.join(d, 'midi')).isDirectory(), '缺失的目录要补回来');
  assert.match(r.out, /已存在/);
});

test('工程名缺失或非法：给出明确用法/错误，不当成"创建成功"', () => {
  const d = tmp('status');
  const status = run(['--build', d]);           // 不给 --name = 看状态（空目录也要能跑）
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /下一步/);
  assert.equal(fs.existsSync(path.join(d, 'project.json')), false, 'status 模式不许写文件');

  const bad = run(['--name', 'my song', '--build', d]);
  assert.notEqual(bad.code, 0);
  assert.match(bad.out, /工程名/);
  assert.equal(fs.existsSync(path.join(d, 'project.json')), false);
});

test('status 模式：骨架建好后指出的下一步是"放音频"，放了音频之后往下走一格', () => {
  const d = tmp('step');
  assert.equal(run(['--name', 'demo', '--build', d]).code, 0);
  const s1 = run(['--build', d]);
  assert.match(s1.out, /demo_full\.wav/);

  fs.writeFileSync(path.join(d, 'demo_full.wav'), 'not-really-a-wav', 'utf8');
  const s2 = run(['--build', d]);
  assert.equal(s2.code, 0, s2.out);
  assert.ok(!s2.out.includes('① 放音频'), '音频已就位就不该再提示第 ① 步');
  assert.match(s2.out, /demo_notes/);
});

test('新工程跑编曲链：缺输入时给"下一步"而不是 ENOENT 栈，且不留半成品', () => {
  const d = tmp('pipeline');
  assert.equal(run(['--name', 'demo', '--build', d]).code, 0);
  const r = spawnSync(process.execPath, [path.join(REPO, 'src', 'arrange', 'arrange-all.mjs'), '--build', d], { encoding: 'utf8', cwd: REPO });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.notEqual(r.status, 0, '没输入就不许当成功');
  assert.match(out, /缺少输入/);
  assert.match(out, /下一步/);
  assert.ok(!/at .*\.mjs:\d+/.test(out), `不该是 ENOENT 栈：\n${out}`);
  assert.equal(fs.existsSync(path.join(d, 'machine_pipeline.csv')), false, '不许留半成品');
});

test('新工程的空数据包跑静态自检：给"下一步"提示、退出码 0（不是"自检失败"）', () => {
  const d = tmp('lint');
  assert.equal(run(['--name', 'demo', '--build', d]).code, 0);
  const r = spawnSync(process.execPath, [path.join(REPO, 'src', 'emit', 'lint-pack.mjs'), '--build', d], { encoding: 'utf8', cwd: REPO });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  assert.equal(r.status, 0, out);
  assert.match(out, /还没产出|下一步/);
  assert.ok(!out.includes('tick 标签 错误'), out);
});
