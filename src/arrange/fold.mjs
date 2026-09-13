// 音高折叠：把任意音域的 midi 折到音符盒的 0..24 行（note 属性上限 24，不是 25）。
// 规则与最早那版 arrange-notes.mjs 完全一致（贪心保留音程走向）：
//   每个音取「音级相同、且离同声部上一个音最近」的八度，音符盒只有 2 个八度所以上限 24。
// 用途：八度修复（T3）之后 row 变成陈旧值，必须按修好的 midi 重折一次，再去撞格（T4）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const DEFAULT_CURSORS = { bass: 8, harp: 18 };

export const voiceOfInstrument = (instrument) => (instrument === 'bass' ? 'bass' : 'harp');

/** 折叠一个音级：候选是 pc, pc+12, pc+24(≤24)；取离 prev 最近的。 */
export function foldOne(midi, prev) {
  const pc = ((midi % 12) + 12) % 12;
  const cands = [];
  for (let p = pc; p <= 24; p += 12) cands.push(p);
  if (!cands.length) cands.push(pc);
  return cands.reduce((a, b) => (Math.abs(b - prev) < Math.abs(a - prev) ? b : a));
}

/** 按 (step, midi) 升序逐音折叠，返回新数组（不改原对象）。 */
export function foldRows(rows, cursors = DEFAULT_CURSORS) {
  const cur = { ...cursors };
  const out = [];
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => a.r.step - b.r.step || a.r.midi - b.r.midi || a.i - b.i);
  for (const { r } of sorted) {
    const voice = voiceOfInstrument(r.instrument ?? r.instr);
    const row = foldOne(r.midi, cur[voice]);
    cur[voice] = row;
    out.push({ ...r, voice, row });
  }
  return out;
}

export function parseCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = (n) => header.indexOf(n);
  const iStep = idx('step'), iInstr = idx('instrument'), iMidi = idx('midi');
  if ([iStep, iInstr, iMidi].some((i) => i < 0)) throw new Error(`缺列（需要 step/instrument/midi）：${header.join(',')}`);
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return {
      step: +c[iStep], instrument: c[iInstr], midi: +c[iMidi],
      time_seconds: idx('time_seconds') >= 0 ? +c[idx('time_seconds')] : null,
    };
  });
}

export function toMachineCsv(rows, { tps = 100, volumeFallback = 0.35 } = {}) {
  const sorted = rows.slice().sort((a, b) => a.step - b.step || a.row - b.row);
  const lines = sorted.map((r) => {
    const tick = Math.round(r.step * 0.12 * tps);
    const time = (r.time_seconds ?? (r.step * 0.12)).toFixed(3);
    const vol = Number.isFinite(r.volume) ? r.volume.toFixed(3) : volumeFallback.toFixed(3);
    return `${r.step},${tick},${time},${r.voice ?? voiceOfInstrument(r.instrument)},${r.midi},${r.row},${vol}`;
  });
  return 'step,tick,time_seconds,instrument,midi,row,volume\n' + lines.join('\n') + '\n';
}

const invoked = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const inPath = args.in ?? `${BUILD}/notes_fixed_v3.csv`;
  const outPath = args.out ?? `${BUILD}/notes_refold.csv`;
  const rows = parseCsv(fs.readFileSync(inPath, 'utf8'));
  const folded = foldRows(rows);
  fs.writeFileSync(outPath, toMachineCsv(folded), 'utf8');
  const byVoice = {};
  for (const r of folded) {
    const b = (byVoice[r.voice] ??= { n: 0, min: 24, max: 0 });
    b.n++; b.min = Math.min(b.min, r.row); b.max = Math.max(b.max, r.row);
  }
  console.log(`折叠 ${folded.length} 颗音：${Object.entries(byVoice).map(([v, b]) => `${v} ${b.n} 颗（行 ${b.min}..${b.max}）`).join('，')}`);
  console.log(`  ${inPath} → ${outPath}`);
}
