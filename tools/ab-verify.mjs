#!/usr/bin/env node
// M2-2 · 改造前后 A/B 验证（docs/M2-2-report.md 的证据来源）
//
// 口径：同一首歌 + **同一个绝对路径的 build 目录**，用两条"路径来源通道"各跑一遍全部脚本：
//   基线 = 改造前的代码（`--baseline <git ref | dir>`），它只会认 `nbmachina_BUILD` 环境变量
//   新版 = 当前工作树，走 `--build <dir>`
// 两侧都从同一份输入开始、写到同一批绝对路径；每个脚本跑完把产出拷成快照，逐文件比 sha256。
//
// 为什么必须同一个目录：路径字符串会进产物（报告 JSON、`apply_notes_v3.mcfunction` 的注释、
// `manifest.json` 的 out 字段）——换成两个目录，"逐字节相同"就成了假命题。
//
// 用法：
//   node tools/ab-verify.mjs --baseline fb6abfc --input C:/Users/hiliang/Documents/minecraft/build
//   可选：--work <scratch 目录>（默认临时目录；跑完保留现场，报告 JSON 也在里面）
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const posix = (p) => p.replace(/\\/g, '/');

/* ------------------------------------------------------------------ 参数 */
const argv = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  const eq = argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : dflt;
};

const baselineRef = opt('baseline');
const inputDir = opt('input');
if (!baselineRef || !inputDir) {
  console.error('用法：node tools/ab-verify.mjs --baseline <git ref | dir> --input <真实 build 目录> [--work <dir>] [--keep]');
  process.exit(2);
}
const work = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'nbmachina-ab-'));
if (opt('work')) fs.mkdirSync(opt('work'), { recursive: true });
const workDir = opt('work') ? path.resolve(opt('work')) : work;
const BUILD = posix(path.join(workDir, 'build'));

/* --------------------------------------------------------------- 基线代码 */
function baselineRepo() {
  if (fs.existsSync(path.join(baselineRef, 'src'))) return posix(path.resolve(baselineRef));
  const repo = posix(path.join(workDir, 'baseline'));
  fs.mkdirSync(repo, { recursive: true });
  const tar = path.join(workDir, 'baseline.tar');
  execFileSync('git', ['archive', '--format=tar', `--output=${tar}`, baselineRef], { cwd: REPO, stdio: 'inherit' });
  execFileSync('tar', ['-xf', tar, '-C', repo], { stdio: 'inherit' });
  fs.rmSync(tar, { force: true });

  // 改造前有 4 个脚本（datapack-playback / note-blocks / redo-chain / lint-pack）把 build 目录**写死**，
  // 环境变量都改不动它们（这正是 M2-2 要修的病）。A/B 要"两侧写同一个绝对目录"，所以在基线副本里
  // 把这个常量整体重写成本次的 build 目录——等价于新版 `--build <dir>` 的效果，逻辑一行未动。
  const rewritten = [];
  const LEGACY = 'C:/Users/hiliang/Documents/minecraft/build';
  const rewrite = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { rewrite(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const text = fs.readFileSync(p, 'utf8');
      if (!text.includes(LEGACY)) continue;
      fs.writeFileSync(p, text.split(LEGACY).join(BUILD), 'utf8');
      rewritten.push(path.relative(repo, p).replace(/\\/g, '/'));
    }
  };
  rewrite(path.join(repo, 'src'));
  console.log(`基线副本里重写死路径的脚本（${rewritten.length}）：${rewritten.join('、')}`);
  return repo;
}
const BASE_REPO = baselineRepo();
const NEW_REPO = posix(REPO);

/* ------------------------------------------------------------------ 输入 */
// 参考曲（styx）的全部输入：改造前它们就叫这些名字，新版默认工程（不传 --project）解析出的也是这些名字
const INPUTS = [
  'analysis_octave.json',
  'notes_fixed_v3.csv',
  'notes_recovered.csv',
  'onsets_banded.json',
  'single_row_profile.json',
  'styx_helix_full.wav',
  'styx_helix_notes.csv',
  'styx_helix_notes_v3.csv',
];
// emit 那几个脚本要在**数据包本体**上动手（rm play/、重写 undo/redo、静态自检要能引用到别的函数），
// 所以把现有 build/styx_build 也整份拷进来当起始状态——两侧都从同一份拷贝开始改。
const INPUT_DIRS = ['styx_build'];
// 输入只从真实 build 目录拷一次（之后每侧开跑都从这份"输入库"复制）。
//
// 这里**必须真拷贝，不能用硬链接**：`layout/single-row-layout.mjs` 会原地覆盖
// `<build>/single_row_profile.json`（它既是输入又是输出）。硬链接会把这次改写透过到输入库，
// 于是第二侧开跑时拿到的已经是第一侧跑完后的剖面 —— 第一版 M2-3 的 A/B 就是这么被污染的
// （表现为 play/lo|hi 里音符块的 Y 坐标、apply_notes_v3 的 air 行整片不同）。
const INPUT_STORE = path.join(workDir, 'inputs');
fs.mkdirSync(INPUT_STORE, { recursive: true });
for (const f of INPUTS) {
  const src = path.join(inputDir, f);
  if (!fs.existsSync(src)) throw new Error(`缺少输入 ${src}`);
  fs.copyFileSync(src, path.join(INPUT_STORE, f));
}
for (const d of INPUT_DIRS) {
  const src = path.join(inputDir, d);
  if (!fs.existsSync(src)) throw new Error(`缺少输入目录 ${src}`);
  fs.cpSync(src, path.join(INPUT_STORE, d), { recursive: true });
}
/** 输入库的 sha256 指纹：跑完一侧后核对，任何"输入被改写"都以失败暴露出来，而不是静默污染下一侧 */
const fileSha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const inputPrint = () => Object.fromEntries(INPUTS
  .filter((f) => fs.existsSync(path.join(INPUT_STORE, f)))
  .map((f) => [f, fileSha(path.join(INPUT_STORE, f))]));
const INPUT_PRINT0 = inputPrint();

const resetBuild = () => {
  fs.rmSync(BUILD, { recursive: true, force: true });
  fs.mkdirSync(BUILD, { recursive: true });
  for (const f of INPUTS) {
    fs.copyFileSync(path.join(INPUT_STORE, f), path.join(BUILD, f));
  }
  for (const d of INPUT_DIRS) fs.cpSync(path.join(INPUT_STORE, d), path.join(BUILD, d), { recursive: true });
};

/* ------------------------------------------------------------------ 步骤 */
// args 里的 {B} 会替换成 build 目录；新版额外追加 --build {B}
const STEPS = [
  { name: '01 machine-pipeline', script: 'src/arrange/machine-pipeline.mjs', outputs: ['styx_helix_machine.csv', 'machine-report.json'] },
  { name: '02 sustain（默认输入 = 机器谱面）', script: 'src/arrange/sustain.mjs', outputs: ['machine_sustain.csv', 'sustain-report.json'] },
  { name: '03 velocity（换力度口径）', script: 'src/arrange/velocity.mjs', outputs: ['velocity_fixed.csv'] },
  { name: '04 dedupe（默认输入 = v3 谱面）', script: 'src/arrange/dedupe.mjs', outputs: ['notes_dedup.csv', 'dedupe-report.json'] },
  { name: '05 fold（默认输入 = notes_fixed_v3）', script: 'src/arrange/fold.mjs', outputs: ['notes_refold.csv'] },
  {
    name: '06 arrange-all（整条链，验收口径）',
    script: 'src/arrange/arrange-all.mjs',
    outputs: [
      'machine_pipeline.csv', 'manifest.json', 'pitch_fix_report.json',
      'pipeline_1_pitchfix.csv', 'pipeline_2_refold.csv', 'pipeline_3_accent.csv',
      'pipeline_4_sustain.csv', 'pipeline_5_percussion.csv', 'pipeline_6_merged.csv',
      // 注意：arrange-all 把打击乐输出直接指到 pipeline_5_percussion.csv，所以这里没有 percussion.csv
      'percussion_events.json', 'dedupe-report.json', 'sustain-report.json',
    ],
  },
  { name: '07 chroma', script: 'src/analyze/chroma.mjs', args: ['--out', '{B}/chroma_ab.json'], outputs: ['chroma_ab.json'] },
  { name: '08 octave-evidence', script: 'src/analyze/octave-evidence.mjs', args: ['--out', '{B}/analysis_octave_ab.json'], outputs: ['analysis_octave_ab.json'] },
  { name: '09 verify/score', script: 'src/verify/score.mjs', outputs: ['score_report.json'] },
  {
    name: '10 emit/playback（数据包函数）',
    script: 'src/emit/datapack-playback.mjs',
    outputs: ['styx_build/data/styx/function/play', 'styx_build/data/minecraft/tags/function/tick.json'],
  },
  { name: '11 emit/note-blocks', script: 'src/emit/note-blocks.mjs', outputs: ['styx_build/data/styx/function/apply_notes_v3.mcfunction'] },
  { name: '12 emit/undo-clone', script: 'src/emit/undo-clone.mjs', outputs: ['styx_build/data/styx/function/undo', 'styx_build/data/styx/function/undo.mcfunction'] },
  {
    name: '13 emit/redo-chain',
    script: 'src/emit/redo-chain.mjs',
    outputs: ['styx_build/data/styx/function/redo', 'styx_build/data/styx/function/redo.mcfunction', 'styx_build/data/styx/function/redo_hi.mcfunction'],
  },
  // lint-pack 只吐 stdout：两侧都用"位置参数/--root 指向同一个数据包目录"的方式跑，避免比的是自己刚生成的东西
  { name: '14 emit/lint-pack（静态自检）', script: 'src/emit/lint-pack.mjs', stdoutOnly: true, args: ['{B}/styx_build'], newArgs: ['--root', '{B}/styx_build'] },
  // ---- M2-3 新收口的脚本（过去完全写死路径，测的就是"接上 paths.mjs 之后产出没变"）----
  {
    name: '15 arrange/octave-fix（八度修音）',
    script: 'src/arrange/octave-fix.mjs',
    args: ['--notes', '{B}/styx_helix_notes.csv', '--evidence', '{B}/analysis_octave.json',
      '--out', '{B}/notes_fixed_m23.csv', '--report', '{B}/octave_fix_report.json'],
    outputs: ['notes_fixed_m23.csv', 'octave_fix_report.json'],
  },
  {
    name: '16 analyze/onset-detect（分频带起音检测）',
    script: 'src/analyze/onset-detect.mjs',
    args: ['--out', '{B}/onsets_banded_ab.json'],
    outputs: ['onsets_banded_ab.json'],
  },
  {
    name: '17 analyze/drums（打击乐检测）',
    script: 'src/analyze/drums.mjs',
    args: ['--out', '{B}/drums_ab.json'],
    outputs: ['drums_ab.json'],
  },
  {
    name: '18 layout/single-row-layout（剖面重算 + 灯位）',
    script: 'src/layout/single-row-layout.mjs',
    outputs: [
      'single_row_profile.json',
      'styx_build/data/styx/function/flat_build_v2a.mcfunction',
      'styx_build/data/styx/function/flat_build_v2b.mcfunction',
      'styx_build/data/styx/function/flat_build_v2c.mcfunction',
      'styx_build/data/styx/function/lamps_v2.mcfunction',
      'styx_build/data/styx/function/lamps_v2_clear.mcfunction',
    ],
  },
  {
    name: '19 emit/playsound-hifi（自研音色派发链）',
    script: 'src/emit/playsound-hifi.mjs',
    outputs: ['styx_build/data/styx/function/play'],
  },
];

/* ------------------------------------------------------------------ 工具 */
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});
const copyInto = (src, dst) => fs.cpSync(src, dst, { recursive: true });
// stdout 比对口径：耗时字段天然不同；另外新版会在自检里把"扫的是哪个数据包目录"打出来（基线不打），
// 所以只丢掉**提到 build 目录**的括号说明，别的括号文字照比。
const normalizeStdout = (s) => s
  .replace(/（[^）\n]*）/g, (m) => (m.includes(BUILD) ? '' : m))
  .replace(/\d+(\.\d+)?ms/g, '<ms>')
  .replace(/用时 \d+(\.\d+)?s/g, '用时 <s>');

// 时间类字段（`manifest.json` 的 at/ms、报告里的 durationMs）天然每次不同：
// 只在**原始字节不同**时退回"剥掉这些字段再比"，并在结果里标明，不静默放过别的差异。
const TIMING_KEYS = new Set(['at', 'ms', 'durationMs']);
const stripTiming = (v) => (Array.isArray(v) ? v.map(stripTiming)
  : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).filter(([k]) => !TIMING_KEYS.has(k)).map(([k, x]) => [k, stripTiming(x)]))
    : v);
const jsonEqualIgnoringTiming = (a, b) => {
  try {
    return JSON.stringify(stripTiming(JSON.parse(fs.readFileSync(a, 'utf8'))))
      === JSON.stringify(stripTiming(JSON.parse(fs.readFileSync(b, 'utf8'))));
  } catch { return false; }
};

function runStep(step, side) {
  const repo = side === 'base' ? BASE_REPO : NEW_REPO;
  const baseArgs = (step.args ?? []).map((a) => a.replace('{B}', BUILD));
  const extra = side === 'base'
    ? baseArgs                                                            // 基线：只给通用参数（build 目录由环境变量给）
    : (step.newArgs ?? [...baseArgs, '--build', BUILD]).map((a) => a.replace('{B}', BUILD));
  const t0 = Date.now();
  let out = '', err = '', code = 0;
  try {
    out = execFileSync(process.execPath, [posix(path.join(repo, step.script)), ...extra], {
      cwd: repo,
      encoding: 'utf8',
      env: { ...process.env, nbmachina_BUILD: side === 'base' ? BUILD : '' },
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    code = e.status ?? 1;
    out = e.stdout ?? '';
    err = e.stderr ?? '';
  }
  const snapDir = path.join(workDir, side, step.name.replace(/[^\w.-]+/g, '_'));
  fs.rmSync(snapDir, { recursive: true, force: true });
  if (step.stdoutOnly) {
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, '_stdout.txt'), normalizeStdout(out) + (err ? `\n[stderr]\n${normalizeStdout(err)}` : ''), 'utf8');
  } else {
    for (const rel of step.outputs) {
      const src = path.join(BUILD, rel);
      if (!fs.existsSync(src)) {
        throw new Error(`${step.name}（${side}）没有产出 ${rel}（exit=${code}）\n--- stdout ---\n${out.trim()}\n--- stderr ---\n${err.trim()}`);
      }
      copyInto(src, path.join(snapDir, rel));
    }
  }
  return { code, ms: Date.now() - t0, snapDir, out: normalizeStdout(out).trim().split('\n').slice(-1)[0] ?? '' };
}

/* ------------------------------------------------------------------ 跑 */
console.log(`仓库（新版）：${NEW_REPO}`);
console.log(`仓库（基线）：${BASE_REPO}`);
console.log(`build 目录（两侧同一个）：${BUILD}\n`);

// 一侧一整轮：build 目录只在**换侧**时重置（步与步之间有依赖，比如 sustain 的默认输入是
// machine-pipeline 刚生成的机器谱面）；每一侧内部始终用同一个绝对路径。
const taken = { base: {}, new: {} };
for (const side of ['base', 'new']) {
  resetBuild();
  for (const step of STEPS) taken[side][step.name] = runStep(step, side);
  const now = inputPrint();
  const mutated = Object.keys(INPUT_PRINT0).filter((f) => now[f] !== INPUT_PRINT0[f]);
  if (mutated.length) {
    console.error(`✘ ${side} 侧跑完发现输入库被改写：${mutated.join('、')}（A/B 结果不可信，先修脚本再去重）`);
    process.exit(1);
  }
}

const results = [];
for (const step of STEPS) {
  const a = taken.base[step.name], b = taken.new[step.name];
  const filesA = walk(a.snapDir).map((p) => path.relative(a.snapDir, p));
  const filesB = walk(b.snapDir).map((p) => path.relative(b.snapDir, p));
  const all = [...new Set([...filesA, ...filesB])].sort();
  const diffs = [], normalized = [];
  for (const rel of all) {
    const pa = path.join(a.snapDir, rel), pb = path.join(b.snapDir, rel);
    if (!fs.existsSync(pa) || !fs.existsSync(pb)) { diffs.push(`${rel}（只有一侧有）`); continue; }
    if (sha(pa) === sha(pb)) continue;
    if (rel.endsWith('.json') && jsonEqualIgnoringTiming(pa, pb)) { normalized.push(rel); continue; }
    if (rel === '_stdout.txt' && normalizeStdout(fs.readFileSync(pa, 'utf8')) === normalizeStdout(fs.readFileSync(pb, 'utf8'))) continue;
    diffs.push(rel);
  }
  const okExit = a.code === b.code;
  const status = okExit && diffs.length === 0 ? '✔' : '✘';
  results.push({ step: step.name, status, files: all.length, normalized, diffs, exit: [a.code, b.code], ms: [a.ms, b.ms], last: [a.out, b.out] });
  console.log(`${status} ${step.name}：${all.length} 个产出文件`
    + `${normalized.length ? `，${normalized.length} 个仅时间字段不同（${normalized.join('、')}）` : ''}`
    + `${diffs.length ? `，不一致：${diffs.join('、')}` : ''}`
    + `${okExit ? '' : `，退出码 ${a.code} vs ${b.code}`}（${a.ms}ms / ${b.ms}ms）`);
}

const bad = results.filter((r) => r.status === '✘');
const report = {
  $schema: 'nbmachina.ab-verify/v0',
  baseline: baselineRef,
  input: posix(path.resolve(inputDir)),
  buildDir: BUILD,
  steps: results,
  summary: {
    steps: results.length,
    ok: results.length - bad.length,
    bad: bad.length,
    files: results.reduce((n, r) => n + r.files, 0),
    normalizedOnly: results.reduce((n, r) => n + r.normalized.length, 0),
  },
};
fs.writeFileSync(path.join(workDir, 'ab-result.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n${bad.length ? '✘' : '✔'} ${report.summary.ok}/${report.summary.steps} 步逐字节一致；`
  + `结果 → ${posix(path.join(workDir, 'ab-result.json'))}`);
process.exit(bad.length ? 1 : 0);
