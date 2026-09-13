// 机器用谱面流水线（M0 数据 → 可直接喂给 emit 的 CSV）：
//   notes_fixed_v3.csv（T3 八度修复后的 midi，但 row/volume 是陈旧值）
//     → ① fold：按修好的 midi 重折 note_block 行（0..24，保留走向）
//     → ② velocity：窄带能量换力度口径（T5）
//     → ③ volume := velocity（机器只认 volume 列；velocity 单独留档）
//     → ④ dedupe：撞格 → 0（T4）
//     → build/styx_helix_machine.csv + build/machine-report.json
//
// 用法：node src/arrange/machine-pipeline.mjs [--in <fixed csv>] [--out <machine csv>]
import fs from 'node:fs';
import { resolvePaths } from '../core/paths.mjs';
import { foldRows, parseCsv, toMachineCsv } from './fold.mjs';
import { readWav, velocityCsvText } from './velocity.mjs';
import { dedupeCsvText, detectCollisions, readNotesCsv } from './dedupe.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
const args = {};
for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];

const inPath = args.in ?? P.file('notes_fixed_v3.csv');
const outPath = args.out ?? P.machine;
const reportPath = args.report ?? P.file('machine-report.json');
const wavPath = args.audio ?? P.audio;

/* ① 重折 note_block 行 */
const fixedRows = parseCsv(fs.readFileSync(inPath, 'utf8'));
const folded = foldRows(fixedRows);
const foldedCsv = toMachineCsv(folded);
const rowsBefore = folded.length;

/* ② 力度换口径 */
const { samples, sampleRate, seconds } = readWav(wavPath);
const vel = velocityCsvText({ csvText: foldedCsv, samples, sampleRate });

/* ③ volume := velocity（保留 velocity 列备查） */
const lines = vel.csv.trim().split(/\r?\n/);
const head = lines[0].split(',');
const iVol = head.indexOf('volume'), iVel = head.indexOf('velocity');
if (iVel < 0) throw new Error('velocity 列缺失，无法替换 volume');
const swapped = [lines[0], ...lines.slice(1).map((l) => {
  const c = l.split(',');
  c[iVol] = c[iVel];
  return c.join(',');
})].join('\n') + '\n';

/* ④ 去撞格 */
const before = readNotesCsv(swapped);
const { csv: finalCsv, report } = dedupeCsvText(swapped);
const after = readNotesCsv(finalCsv);

fs.writeFileSync(outPath, finalCsv, 'utf8');
fs.writeFileSync(reportPath, JSON.stringify({
  meta: { inPath, wavPath, outPath, audioSeconds: +seconds.toFixed(1) },
  fold: { notes: rowsBefore },
  velocity: vel.meta,
  dedupe: report.summary,
}, null, 2) + '\n', 'utf8');

const s = report.summary;
console.log(`① 重折 ${rowsBefore} 颗音的行（按修好的 midi，保留走向）`);
console.log(`② 力度换口径：${vel.meta.summary.measured} 颗 measured / ${vel.meta.reasons.weak ?? 0} 颗 weak（窗 ${Object.values(vel.meta.windows).map((w) => (w * 1000) + 'ms').join('/')}）`);
console.log(`③ volume := velocity`);
console.log(`④ 去撞格：${detectCollisions(before).length} 格 → ${detectCollisions(after).length} 格（合并掉 ${s.notesIn - s.notesOut} 颗）`);
console.log(`→ ${outPath}`);
console.log(`→ ${reportPath}`);
