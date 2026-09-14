// 引导导出器（M0 过渡件）：把现有的转谱 CSV 变成契约化的 project.json
//
// 为什么需要它：M0 阶段还没有真正的 MIDI/MusicXML/OMR 解析器（那是 ingest 的正式输入通路），
// 但"现有数据必须通过契约校验"这条验收得能跑。这个脚本把
//   build/styx_helix_notes_v3.csv（step,tick,time_seconds,instrument,midi,row,volume）
// 映射成 SPEC §3 的 project.json，并把来源信息（音频/CSV 的 sha256、每颗音的原始行号与
// 混音 RMS）一并写进去，方便后续按"来源可追溯"回溯。
//
// 明确的近似（写进 annotations，不假装是精确值）：
//   - durSec：CSV 没有时值，统一取一个步长（0.12s）
//   - velocity：CSV 的 volume 是 0.12s 混音 RMS（不是"这颗音弹多重"），线性映射到 0..127
//
// 用法：
//   node src/ingest/project-from-notes-csv.mjs
//   node src/ingest/project-from-notes-csv.mjs --csv <path> --out <path> --audio <wav> --title <t> --tempo 125
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertProject, VOICES } from './project-schema.mjs';
import { resolvePaths } from '../core/paths.mjs';

// M2-3：build 目录与三个默认输入都走 paths.mjs（--build/--project 可覆盖）
const P = resolvePaths();
const BUILD = P.build;

/** MC 乐器 → SPEC 声部（harp 是这台机器的旋律声部，bass 是低音声部） */
export const INSTRUMENT_TO_VOICE = {
  harp: 'melody',
  melody: 'melody',
  bass: 'bass',
  inner: 'inner',
  perc: 'perc',
  basedrum: 'perc',
  snare: 'perc',
  hat: 'perc',
};

const sha256File = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/** 来源路径一律写成"相对 build 根目录"的 POSIX 形式，便于跨机器 diff */
const relPath = (p) => {
  const abs = path.resolve(p);
  const rel = path.relative(path.resolve(BUILD), abs);
  return (rel && !rel.startsWith('..') ? rel : abs).replace(/\\/g, '/');
};

/** 解析 CSV（只支持本项目这种简单格式：无引号、无内嵌逗号） */
export function parseNotesCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  return lines.slice(1).map((line) => {
    const cols = line.split(',');
    const row = {};
    header.forEach((k, i) => {
      row[k] = cols[i];
    });
    return row;
  });
}

/**
 * CSV 行 → project.json 的 notes[]
 * @param {Array<Record<string,string>>} rows
 * @param {{secPerStep: number, velocityMax: number}} opts
 */
export function csvRowsToProjectNotes(rows, { secPerStep = 0.12, velocityMax = 127 } = {}) {
  return rows.map((r) => {
    const instrument = r.instrument;
    const voice = INSTRUMENT_TO_VOICE[instrument];
    if (!voice) throw new Error(`未知乐器 ${JSON.stringify(instrument)}，无法映射到声部`);
    const mixRms = Number(r.volume);
    return {
      voice,
      onsetSec: Number(r.time_seconds ?? r.time ?? Number(r.tick) * secPerStep),
      durSec: secPerStep,
      midi: Number(r.midi),
      velocity: Math.max(0, Math.min(velocityMax, Math.round(mixRms * velocityMax))),
      tie: false,
      slur: false,
      src: { step: Number(r.step), row: Number(r.row), instrument, mixRms },
    };
  });
}

/** 组装一个完整的 project.json 对象 */
export function buildProject({
  rows,
  title = 'Styx Helix',
  author = 'MYTH & ROID',
  tempo = 125,
  license = 'unknown（仅本地研究，未确认授权）',
  csvPath = P.notesV3,
  audioPath = P.audio,
  secPerStep = 0.12,
} = {}) {
  const notes = csvRowsToProjectNotes(rows, { secPerStep });
  // 声部顺序固定成 SPEC 的枚举顺序，保证同一份输入永远产出逐字节相同的 JSON
  const used = new Set(notes.map((n) => n.voice));
  const voices = VOICES.filter((v) => used.has(v));
  const source = {
    format: 'csv',
    path: relPath(csvPath),
    sha256: fs.existsSync(csvPath) ? sha256File(csvPath) : '0'.repeat(64),
  };
  if (fs.existsSync(audioPath)) {
    source.audio = {
      path: relPath(audioPath),
      sha256: sha256File(audioPath),
      bytes: fs.statSync(audioPath).size,
    };
  }
  return {
    meta: { title, author, tempo, license, source },
    voices,
    notes,
    tempoMap: [{ sec: 0, bpm: tempo }],
    annotations: [
      { type: 'grid', sec: 0, text: `${secPerStep} 秒/步（${tempo} BPM 的十六分音符网格）` },
      { type: 'derived', sec: 0, text: 'durSec 无来源时值，统一取一个步长 0.12s' },
      { type: 'derived', sec: 0, text: 'velocity = round(混音 RMS × 127)；这是混音响度而非"单音力度"，M0-T5 会用窄带能量替换' },
    ],
  };
}

/* ---------- CLI ---------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '');
    out[k] = argv[i + 1];
  }
  return out;
}

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const args = parseArgs(process.argv.slice(2));
  const csvPath = args.csv ?? P.notesV3;
  const outPath = args.out ?? P.file('project.json');
  const audioPath = args.audio ?? P.audio;
  const rows = parseNotesCsv(fs.readFileSync(csvPath, 'utf8'));
  const project = buildProject({
    rows,
    title: args.title ?? 'Styx Helix',
    author: args.author ?? 'MYTH & ROID',
    tempo: Number(args.tempo ?? 125),
    license: args.license ?? 'unknown（仅本地研究，未确认授权）',
    csvPath,
    audioPath,
  });
  assertProject(project, `${csvPath} → project.json`);
  fs.writeFileSync(outPath, JSON.stringify(project, null, 2) + '\n', 'utf8');
  const voices = project.voices.map((v) => `${v}=${project.notes.filter((n) => n.voice === v).length}`).join(' ');
  console.log(`${csvPath} → ${outPath}`);
  console.log(`  notes=${project.notes.length}（${voices}）tempo=${project.meta.tempo} 来源 sha256=${project.meta.source.sha256.slice(0, 12)}…`);
  console.log(`  契约校验：通过`);
}
