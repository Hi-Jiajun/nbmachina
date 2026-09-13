#!/usr/bin/env node
// M2-2 · 新工程骨架 + 工程状态（"下一步该做什么"）
//
//   node src/core/new-project.mjs --name mySong [--build <dir>]   # 建骨架（空目录可跑、幂等、不覆盖已有文件）
//   node src/core/new-project.mjs [--build <dir>]                 # 看状态：已有什么、下一步该跑哪条命令
//
// 骨架与 paths.mjs 是同一套约定：`project.json` 里的 `nbforge.project` 决定文件名前缀
// （音频 `<前缀>_full.wav`、谱面 `<前缀>_notes_v3.csv`、机器谱面 `<前缀>_machine.csv`、数据包 `<前缀>_build/`），
// 所以建完之后所有已改造的脚本只要 `--build <dir>` 就能找到正确的名字，不用再改代码。
//
// 建骨架时不给 --build 的话，会在**当前目录下**建 `<name>/`——绝不往默认的参考曲目录里写东西。
import fs from 'node:fs';
import path from 'node:path';
import { findFlag, resolvePaths } from './paths.mjs';
import { validateProject } from '../ingest/project-schema.mjs';

const argv = process.argv.slice(2);
const nameFlag = findFlag(argv, 'name') ?? findFlag(argv, 'project');
if (nameFlag === true) throw new Error('--name 需要一个工程名：--name <name>');
const name = typeof nameFlag === 'string' ? nameFlag.trim() : undefined;

const explicitBuild = findFlag(argv, 'build') !== undefined || Boolean(process.env.NBFORGE_BUILD);
const P = resolvePaths({
  argv,
  env: process.env,
  ...(name && !explicitBuild ? { build: `${process.cwd()}\\${name}` } : {}),
  ...(name ? { project: name } : {}),
});

const ZERO_SHA = '0'.repeat(64);

/* ------------------------------------------------------------ project.json */
/** SPEC §3 超集的最小合法模板：自带能过校验器的样值，用户只改要改的字段 */
function projectTemplate(P) {
  return {
    meta: {
      title: P.project,
      author: 'TODO：填作者',
      tempo: 120,
      license: 'TODO：填许可（如 CC0-1.0 / 仅本地研究，未确认授权）',
      source: {
        format: 'midi',
        path: `midi/${P.project}.mid`,
        sha256: ZERO_SHA,
        audio: { path: `${P.prefix}_full.wav`, sha256: ZERO_SHA, bytes: 0 },
      },
    },
    voices: ['melody', 'bass'],
    notes: [
      { voice: 'melody', onsetSec: 0, durSec: 0.24, midi: 72, velocity: 96, tie: false, slur: false },
      { voice: 'bass', onsetSec: 0, durSec: 0.48, midi: 48, velocity: 80, tie: false, slur: false },
    ],
    tempoMap: [{ sec: 0, bpm: 120 }],
    annotations: [],
    // nbforge 自己的字段（SPEC 校验器对未知字段放行）：工程名 → 文件名前缀
    nbforge: { project: P.project, audio: `${P.prefix}_full.wav` },
  };
}

/* ----------------------------------------------------------------- README */
function readmeText(P) {
  const names = {
    audio: `${P.prefix}_full.wav`,
    notes: `${P.prefix}_notes.csv`,
    notesV3: `${P.prefix}_notes_v3.csv`,
    machine: `${P.prefix}_machine.csv`,
    fixed: 'notes_fixed_v3.csv',
    chain: 'machine_pipeline.csv',
    pack: path.basename(P.packDir),
  };
  return [
    `# ${P.project} · nbforge 工程骨架`,
    '',
    `这是 nbforge 的**工作目录**（\`--build ${P.build}\`）：**一个目录 = 一首歌**。`,
    `本骨架由 \`src/core/new-project.mjs\` 生成，随便改；用 \`node src/core/new-project.mjs --build ${P.build}\` 随时看还缺什么。`,
    '',
    '## 放什么',
    '',
    '| 放什么 | 放哪儿 | 说明 |',
    '|---|---|---|',
    `| 音频 wav | \`${names.audio}\` | 力度 / 延音 / 打击乐 / 评分都读它；也可以先丢进 \`audio/\`，跑的时候用 \`--audio\` 指过去 |`,
    `| MIDI / MusicXML / DAWproject | \`midi/\` | \`project.json\` 的 \`meta.source\` 指向它 |`,
    '| 谱面工程 | `project.json` | SPEC §3 超集（见 `docs/SPEC.md`）；已给一份**能过校验器**的最小模板，把 TODO 换成真值即可 |',
    `| 数据包（产物） | \`${names.pack}/\` | \`emit\` 阶段生成，可直接丢进存档的 \`datapacks/\` |`,
    '',
    '## 下一步（按顺序，全部在本仓库根目录执行）',
    '',
    '```bash',
    `# 0) 随时看状态（不会写任何文件）`,
    `node src/core/new-project.mjs --build ${P.build}`,
    '',
    `# 1) 放音频：把歌放成 ${P.audio}`,
    '',
    `# 2) 转谱：M0 阶段唯一的入口是 CSV → project.json（MIDI/OMR 解析还没做，见 docs/DISCUSSION-B-architecture.md）`,
    `node src/ingest/project-from-notes-csv.mjs --csv ${P.notesV3} --out ${P.build}/project.json --audio ${P.audio} --title ${P.project}`,
    '',
    `# 3) 八度修复（这个脚本还没接到 paths.mjs，所以显式给 --notes/--out/--report）`,
    `node src/arrange/octave-fix.mjs --notes ${P.notes} --out ${P.build}/${names.fixed} --report ${P.build}/octave_fix_report.json`,
    '',
    `# 4) 编曲链：音级恢复 → 重折行 → 力度 → 延音 → 打击乐 → 去撞格`,
    `node src/arrange/arrange-all.mjs --build ${P.build}`,
    '',
    `# 5) 出数据包：摆音符盒 → 生成播放器函数 → 静态自检`,
    `node src/emit/note-blocks.mjs --build ${P.build}`,
    `node src/emit/datapack-playback.mjs --build ${P.build}`,
    `node src/emit/lint-pack.mjs --build ${P.build}`,
    '',
    `# 6) 客观评分（起音对齐 / 音级相似 / 八度命中 / 力度包络…）`,
    `node src/verify/score.mjs --build ${P.build}`,
    '```',
    '',
    '## 已知边界（M2-2 未覆盖的部分）',
    '',
    `- 还没接到 \`paths.mjs\` 的脚本（\`octave-fix\` / \`onset-detect\` / \`drums\` / \`layout\` / \`scan\` / \`ingest\` / \`test\`）仍然只认 \`NBFORGE_BUILD\` 环境变量，`,
    `  且默认文件名带历史前缀 \`styx_helix_\`——用它们时请显式给 \`--notes/--out/--report\`，或先 \`set NBFORGE_BUILD=${P.build}\`。清单见 \`docs/M2-2-report.md\` §6。`,
    '- 数据包命名空间（函数名 `styx:play/tick`、计分板 `styx.t`）与文件路径无关，本阶段不动；换歌只换文件名与目录。',
    '',
    '## 契约',
    '',
    `- 工程名（\`project.json\` 的 \`nbforge.project\`）= 文件名前缀：**${P.prefix}**。改名要连文件名一起改。`,
    `- 带前缀的是"工程身份"文件：\`${names.audio}\` / \`${names.notes}\` / \`${names.notesV3}\` / \`${names.machine}\` / \`${names.pack}/\`。`,
    '- 中间产物（`pipeline_*.csv`、`notes_*.csv`、`*-report.json`、`manifest.json`…）不带前缀——一个目录一首歌，同目录内唯一。',
  ].join('\n') + '\n';
}

/* ----------------------------------------------------------------- 状态 */
function stepList(P) {
  const fixed = P.file('notes_fixed_v3.csv');
  const chain = P.file('machine_pipeline.csv');
  const playDir = `${P.datapackDir}/function/play`;
  const noEnvHint = '（还没接到 paths.mjs，需要显式给 --notes/--out/--report）';
  return [
    {
      n: '①', title: '音频', action: '放音频', done: fs.existsSync(P.audio), where: P.audio,
      cmd: `把 wav 放成 ${P.audio}`,
      hint: `也可以先扔进 ${P.build}/audio/，跑的时候用 --audio 指过去`,
    },
    {
      n: '②', title: '转谱', action: '转谱', done: fs.existsSync(P.notesV3) || fs.existsSync(P.notes), where: P.notesV3,
      cmd: `node src/ingest/project-from-notes-csv.mjs --csv ${P.notesV3} --out ${P.build}/project.json --audio ${P.audio} --title ${P.project}`,
      hint: '产物是 project.json；MIDI/OMR 直解还没做，先走 CSV 入口',
    },
    {
      n: '③', title: '八度修复', action: '八度修复', done: fs.existsSync(fixed), where: fixed,
      cmd: `node src/arrange/octave-fix.mjs --notes ${P.notes} --out ${fixed} --report ${P.file('octave_fix_report.json')}`,
      hint: noEnvHint,
    },
    {
      n: '④', title: '编曲链', action: '跑编曲链', done: fs.existsSync(chain), where: chain,
      cmd: `node src/arrange/arrange-all.mjs --build ${P.build}`,
      hint: '输出 machine_pipeline.csv（+ 每步的 pipeline_*.csv 与报告）',
    },
    {
      n: '⑤', title: '出数据包', action: '出数据包', done: fs.existsSync(playDir) && fs.existsSync(`${P.tagDir}/tick.json`), where: P.packDir,
      cmd: `node src/emit/note-blocks.mjs --build ${P.build} && node src/emit/datapack-playback.mjs --build ${P.build} && node src/emit/lint-pack.mjs --build ${P.build}`,
      hint: 'lint-pack 是静态自检，不需要起服务器',
    },
    {
      n: '⑥', title: '评分', action: '评分', done: fs.existsSync(P.file('score_report.json')), where: P.file('score_report.json'),
      cmd: `node src/verify/score.mjs --build ${P.build}`,
      hint: '输出 score_report.json（客观分 + 各分量）',
    },
  ];
}

function printStatus(P) {
  console.log(`\n工程：${P.project}（文件名前缀 ${P.prefix}）`);
  console.log(`工作目录：${P.build}`);
  const steps = stepList(P);
  for (const s of steps) console.log(`  ${s.done ? '✔' : '✗'} ${s.n} ${s.title}      ${s.where}`);
  const next = steps.find((s) => !s.done);
  if (!next) {
    console.log('\n全部就绪：改完谱面/参数后重跑 ④→⑤→⑥ 即可。');
    return;
  }
  console.log(`\n下一步：${next.n} ${next.action} —— ${next.cmd}`);
  console.log(`  （${next.hint}）`);
}

/* ----------------------------------------------------------------- 建骨架 */
function writeIfMissing(file, text, { created, skipped }) {
  if (fs.existsSync(file)) { skipped.push(path.relative(P.build, file).replace(/\\/g, '/') || file); return false; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
  created.push(path.relative(P.build, file).replace(/\\/g, '/') || file);
  return true;
}

function ensureDir(dir, { created, skipped }) {
  const rel = path.relative(P.build, dir).replace(/\\/g, '/') || dir;
  if (fs.existsSync(dir)) { skipped.push(`${rel}/`); return; }
  fs.mkdirSync(dir, { recursive: true });
  created.push(`${rel}/`);
}

function createSkeleton(P) {
  fs.mkdirSync(P.build, { recursive: true });
  const created = [], skipped = [];

  const project = projectTemplate(P);
  const check = validateProject(project);
  if (!check.ok) throw new Error(`模板自己就没过 SPEC 校验器：${JSON.stringify(check.errors)}`);

  writeIfMissing(path.join(P.build, 'project.json'), JSON.stringify(project, null, 2) + '\n', { created, skipped });
  writeIfMissing(path.join(P.build, 'README.md'), readmeText(P), { created, skipped });
  ensureDir(path.join(P.build, 'audio'), { created, skipped });
  ensureDir(path.join(P.build, 'midi'), { created, skipped });
  ensureDir(P.packDir, { created, skipped });
  writeIfMissing(path.join(P.packDir, 'pack.mcmeta'), JSON.stringify({
    pack: { pack_format: 88, min_format: 88, max_format: 88, description: `nbforge ${P.project}（new-project.mjs 生成，可改）` },
  }, null, 2) + '\n', { created, skipped });

  console.log(`新建工程骨架：${P.build}（工程名 ${P.project}，文件名前缀 ${P.prefix}）`);
  if (created.length) console.log(`  新建：${created.join('、')}`);
  if (skipped.length) console.log(`  已存在，跳过：${skipped.join('、')}`);
  if (!created.length) console.log('  什么都没变（幂等：已存在的文件一律不覆盖）');
}

/* ----------------------------------------------------------------- 入口 */
try {
  if (name) createSkeleton(P);
  printStatus(P);
} catch (e) {
  console.error(`✘ ${e.message}`);
  process.exit(1);
}
