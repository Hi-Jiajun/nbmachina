// M2-3 · 路径收口测试
//
// M2-2 只把 16 个脚本接到 `paths.mjs`；剩下的一批（analyze/test/scan/layout/synth/emit 老脚本）里
// 还写死着 `C:/Users/hiliang/Documents/minecraft/...`。M2-3 把它们也收口，本文件负责**守住**这件事：
//   ① 全仓源码审计：除 `src/core/paths.mjs`（历史默认值的唯一住所）之外，任何 .mjs 的**代码行**
//      都不允许再出现那串字面量（注释里作为历史说明可以留）。
//   ② 机器外部路径（存档 / 测试服 / java）的默认值必须与历史硬编码逐字符一致——否则"换歌"时
//      行为会静默漂移，A/B 也就失去了意义。
//   ③ 覆盖入口（`--save/--server/--java` 与对应环境变量）按"参数 > 环境变量 > 历史默认"生效。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  LEGACY_JAVA,
  LEGACY_SAVE,
  LEGACY_SERVER,
  LEGACY_PREFIX,
  defaultBuildDir,
  findFlag,
  resolveExternal,
  resolvePaths,
} from '../src/core/paths.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------------- ① 字面量审计 */

/** 递归列出 src 下的全部 .mjs（相对仓库的 posix 路径） */
function sourceFiles(dir = path.join(REPO, 'src')) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return e.name.endsWith('.mjs') ? [path.relative(REPO, p).replace(/\\/g, '/')] : [];
  });
}

/** 去掉整行注释与行尾注释（注释里引用历史路径是允许的，代码里不允许） */
function codeOnly(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
    .join('\n');
}

const LEGACY_ROOT = 'C:/Users/hiliang/Documents/minecraft';
/** 历史默认值的唯一合法住所 */
const LEGACY_HOME = 'src/core/paths.mjs';

test('M2-3：只有 src/core/paths.mjs 允许出现历史绝对路径（代码行）', () => {
  const offenders = [];
  for (const rel of sourceFiles()) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    const backslash = LEGACY_ROOT.replace(/\//g, '\\');
    for (const [i, line] of codeOnly(text).split('\n').entries()) {
      if (line.includes(LEGACY_ROOT) || line.includes(backslash.replace(/\\/g, '\\\\'))) {
        // 反斜杠转义写法（'C:\\Users\\...'）也一并抓住
        offenders.push(`${rel}:${i + 1}`);
      }
    }
  }
  const outsideHome = offenders.filter((o) => !o.startsWith(`${LEGACY_HOME}:`));
  assert.deepEqual(outsideHome, [], `这些文件还在写死历史绝对路径：${outsideHome.join('、')}`);
  assert.ok(offenders.length > 0, 'paths.mjs 应当保留历史默认值（否则本测试失去意义）');
});

test('M2-3：paths.mjs 是唯一 import 到 paths.mjs 的入口之外——所有脚本都从它取路径', () => {
  // 反向检查：凡是"读 build 目录"的脚本，都应该 import 过 paths.mjs。
  // 允许名单：paths.mjs 自己、以及不碰文件系统路径的纯逻辑模块。
  const allowlist = new Set([
    'src/core/paths.mjs',
    'src/analyze/dsp.mjs',
    'src/emit/layout-pos.mjs',
    'src/emit/tick-map.mjs',
    'src/emit/zip-writer.mjs',
    'src/ingest/project-schema.mjs',
    'src/emit/note-blocks.mjs',
    'src/emit/redo-chain.mjs',
    'src/emit/lint-pack.mjs',
  ]);
  const suspects = [];
  for (const rel of sourceFiles()) {
    if (allowlist.has(rel)) continue;
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    if (text.includes('paths.mjs')) continue;
    // 还在自己拼 build 目录的痕迹（模板串里出现 build/ 或 styx_build）
    if (/\$\{[^}]*\}.*(styx_build|\/build)/.test(text) || /'[^']*build\/[a-z_]+\./.test(text)) suspects.push(rel);
  }
  assert.deepEqual(suspects, [], `这些脚本疑似仍在自拼 build 路径：${suspects.join('、')}`);
});

/* ------------------------------------------------------- ② 外部路径默认值逐字符一致 */

test('M2-3：resolveExternal 默认值与历史硬编码逐字符一致', () => {
  const ex = resolveExternal({ argv: [], env: {} });
  assert.equal(ex.server, 'C:/Users/hiliang/Documents/minecraft/testserver');
  assert.equal(ex.save, 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5/saves/Styx Helix');
  assert.equal(ex.java, 'C:/Users/hiliang/AppData/Roaming/.minecraft/runtime/java-runtime-delta/bin/java.exe');
  assert.equal(ex.server, LEGACY_SERVER);
  assert.equal(ex.save, LEGACY_SAVE);
  assert.equal(ex.java, LEGACY_JAVA);
});

test('M2-3：resolvePaths 的 midi / preview 槽位与历史文件名一致', () => {
  const p = resolvePaths({ argv: [], env: {} });
  assert.equal(p.midi, `${p.build}/${LEGACY_PREFIX}_minecraft.mid`);
  assert.equal(p.prefixed('preview.wav'), `${p.build}/${LEGACY_PREFIX}_preview.wav`);
  assert.equal(p.build, defaultBuildDir());
});

test('M2-3：换工程名后 midi 槽位跟着换（新工程不再吃参考曲的文件）', () => {
  const p = resolvePaths({ argv: ['--build', 'D:/songs/x', '--project', 'mySong'], env: {} });
  assert.equal(p.midi, 'D:/songs/x/mySong_minecraft.mid');
  assert.equal(p.audio, 'D:/songs/x/mySong_full.wav');
  assert.equal(p.packDir, 'D:/songs/x/mySong_build');
});

/* --------------------------------------------------------------- ③ 覆盖入口优先级 */

test('M2-3：--save/--server/--java 优先于环境变量与历史默认', () => {
  const ex = resolveExternal({
    argv: ['--save', 'D:/saves/Other', '--server', 'D:/srv', '--java', 'D:/jdk/bin/java.exe'],
    env: { NBFORGE_SAVE: 'D:/saves/Env', NBFORGE_SERVER: 'D:/srv-env', NBFORGE_JAVA: 'D:/env/java.exe' },
  });
  assert.equal(ex.save, 'D:/saves/Other');
  assert.equal(ex.server, 'D:/srv');
  assert.equal(ex.java, 'D:/jdk/bin/java.exe');
});

test('M2-3：环境变量在没给参数时生效，空字符串视为没给', () => {
  const ex = resolveExternal({
    argv: [],
    env: { NBFORGE_SAVE: 'D:/saves/Env', NBFORGE_SERVER: '   ', NBFORGE_JAVA: '' },
  });
  assert.equal(ex.save, 'D:/saves/Env');
  assert.equal(ex.server, LEGACY_SERVER);
  assert.equal(ex.java, LEGACY_JAVA);
});

test('M2-3：--save 缺参数要报错（不能静默当成 true）', () => {
  assert.throws(() => resolveExternal({ argv: ['--save'], env: {} }), /--save 需要一个路径参数/);
  assert.equal(findFlag(['--save'], 'save'), true);
});

test('M2-3：相对路径按 cwd 归一成绝对路径（正斜杠）', () => {
  const ex = resolveExternal({ argv: ['--server', 'srv2', '--save', 'saves/s'], env: {}, cwd: 'D:/work' });
  assert.equal(ex.server, 'D:/work/srv2');
  assert.equal(ex.save, 'D:/work/saves/s');
});
