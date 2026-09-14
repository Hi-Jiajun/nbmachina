// 一条命令跑完编曲链（T5）：音级恢复 → 重折行 → 力度(accent) → 长音延音 → [内声部层] → 打击乐 → 去撞格
//   node src/arrange/arrange-all.mjs [--out build/machine_pipeline.csv] [--inner on]
// 每步都调对应模块的 CLI（模块可单独重跑），并输出 build/manifest.json（每步输入输出的 sha256 + 计数）。
// 任一步失败 → 立刻非 0 退出，绝不留半成品当"成功"。
//
// `--inner on`（默认 off）在长音延音之后插一步 `src/arrange/inner-voice.mjs`（M3-1 内声部/和声层），
// 它把同刻"旋律以外的 harp 材料"标成 instrument=inner 并追加 voiceRole/innerOf/innerReason 三列；
// 默认 off 时这一步不跑、不写任何文件，全链路产物与改造前逐字节一致（见 tools/ab-verify.mjs）。
// `--inner-register keep|relocate|band` 透传给该模块（默认 keep，理由见 docs/M3-1-inner-voice-report.md §4）。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { resolvePaths } from '../core/paths.mjs';

const P = resolvePaths();
const B = P.build;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const OUT = opt('out', P.file('machine_pipeline.csv'));
/** 传给每个子脚本：子进程的默认路径与父进程解析出来的完全相同（已显式给 --in/--out 时也不冲突） */
const PASS = ['--build', B, '--project', P.project];
/** 内声部层开关（默认 off）与它的音区映射模式 */
const INNER = String(opt('inner', 'off')).toLowerCase();
const INNER_ON = ['on', '1', 'true', 'yes'].includes(INNER);
const INNER_REGISTER = opt('inner-register', 'keep');

const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex').slice(0, 16) : null);
const rows = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).length - 1 : 0);
const manifest = { at: new Date().toISOString(), steps: [] };

const run = (name, script, args, out) => {
  const t0 = Date.now();
  const log = execFileSync(process.execPath, [script, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const step = { name, script, out, ms: Date.now() - t0, sha256_16: sha(out), notes: rows(out) };
  manifest.steps.push(step);
  console.log(`  ${name}: ${step.notes} 行 → ${out.split('/').pop()}（${step.sha256_16}，${step.ms}ms）`);
  return log;
};

const BASELINE = P.file('notes_fixed_v3.csv');

// 前置检查：新工程骨架刚建出来时就是这个状态（还没放音频/转谱）。
// 这里给"下一步该做什么"而不是抛 ENOENT 栈，且在写任何文件之前就退出（不留半成品）。
const required = [
  [BASELINE, '八度修复后的谱面（编曲链的输入基线）'],
  [P.audio, '参考音频（力度 / 延音 / 打击乐都要用它）'],
];
const missing = required.filter(([p]) => !fs.existsSync(p));
if (missing.length) {
  console.error(`✗ 缺少输入：`);
  for (const [p, why] of missing) console.error(`    ${p}   —— ${why}`);
  console.error(`  下一步：把音频与转谱放进 ${B}/（说明见 ${B}/README.md），或用别的工程：--build <dir> --project <name>`);
  process.exit(1);
}

console.log(`编曲链（工程 ${P.project}，输入基线 ${BASELINE}）`);
const f1 = P.file('pipeline_1_pitchfix.csv');
const f2 = P.file('pipeline_2_refold.csv');
const f3 = P.file('pipeline_3_accent.csv');
const f4 = P.file('pipeline_4_sustain.csv');
const f5 = P.file('pipeline_5_percussion.csv');

run('① 音级恢复', 'src/arrange/pitch-fix.mjs', ['--in', BASELINE, '--out', f1, ...PASS], f1);
run('② 重折 0..24 行', 'src/arrange/fold.mjs', ['--in', f1, '--out', f2, ...PASS], f2);
run('③ 力度 accent 口径', 'src/arrange/velocity.mjs', ['--accent', '--in', f2, '--out', f3, ...PASS], f3);
run('④ 长音延音', 'src/arrange/sustain.mjs', ['--in', f3, '--out', f4, ...PASS], f4);

// ④b · 内声部/和声层（M3-1）：只在 --inner on 时跑，默认不产生任何新文件
const f4b = P.file('pipeline_4b_inner.csv');
let MAIN = f4;
if (INNER_ON) {
  run('④b 内声部层', 'src/arrange/inner-voice.mjs',
    ['--in', f4, '--out', f4b, '--register', INNER_REGISTER, '--report', P.file('inner-voice-report.json'), ...PASS], f4b);
  MAIN = f4b;
}

run('⑤ 打击乐层', 'src/arrange/percussion.mjs', ['--audio', P.audio, '--out', f5, ...PASS], f5);

// 主谱面 + 打击乐：只保留 emit 需要的 7 列（打击乐 CSV 与主谱面列序一致）
const base = fs.readFileSync(MAIN, 'utf8').trim().split(/\r?\n/);
const perc = fs.readFileSync(f5, 'utf8').trim().split(/\r?\n/);
const merge = P.file('pipeline_6_merged.csv');
fs.writeFileSync(merge, [base[0], ...base.slice(1), ...perc.slice(1)].join('\n') + '\n', 'utf8');
console.log(`  ⑥ 合并主谱面 ${base.length - 1} + 打击乐 ${perc.length - 1} = ${base.length + perc.length - 2} 行`);
manifest.merge = { out: merge, sha256_16: sha(merge), notes: rows(merge) };

run('⑦ 去撞格', 'src/arrange/dedupe.mjs', ['--in', merge, '--out', OUT, ...PASS], OUT);
manifest.out = OUT;
fs.writeFileSync(P.file('manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`完成 → ${OUT}（${manifest.steps.at(-1).sha256_16}）；清单 → ${P.file('manifest.json')}`);
