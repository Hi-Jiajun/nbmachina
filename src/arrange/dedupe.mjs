// T4 · 去撞格与去重（撞格口径：同一 (step,row) 上有 ≥2 颗音）
//
// 为什么必须去撞格：机器上一格只有一颗音符盒（音符盒的 note 决定音高），两颗音落在
// 同一个 (step,row) 就**只有一个能响**；不去掉的话，数据说 2 颗、机器只响 1 颗，
// 目标里的"触发计数差 0"永远对不上。所以这里把撞格显式合并，并把"合并掉了什么、
// 依据什么规则"写进报告（保真契约：降级不能是静默的）。
//
// 决策顺序（可配置，默认值见 DEFAULT_VOICE_PRIORITY）：
//   ① 声部优先级（旋律 > 低音 > 内声部 > 打击乐）
//   ② 力度（大者胜）
//   ③ 离本声部音域中位数更近者
//   ④ midi 小者（兜底，保证决定论）
// 合并后力度取组内最大（velocityPolicy='max'）：一格只响一次，那就按"最响的那次"响。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 声部优先级（高 → 低）：旋律最不可替代，打击乐合并损失最小 */
export const DEFAULT_VOICE_PRIORITY = ['melody', 'bass', 'inner', 'perc'];

/** MC 乐器 → SPEC 声部；未登记的乐器落到 inner（优先级最低，不会挤掉旋律/低音） */
export const INSTRUMENT_VOICE = {
  harp: 'melody',
  bell: 'melody',
  chime: 'melody',
  guitar: 'melody',
  flute: 'melody',
  xylophone: 'melody',
  iron_xylophone: 'melody',
  cow_bell: 'melody',
  bit: 'melody',
  banjo: 'melody',
  pling: 'melody',
  didgeridoo: 'bass',
  bass: 'bass',
  basedrum: 'perc',
  snare: 'perc',
  hat: 'perc',
  melody: 'melody',
  inner: 'inner',
  perc: 'perc',
};

export const CSV_HEADER = ['step', 'tick', 'time_seconds', 'instrument', 'midi', 'row', 'volume'];

/**
 * 合并时要取"组内最大"的响度字段：
 *  - velocity：0..127 的谱面力度（score.json 口径）
 *  - volume：0..1 的监听音量（v3 CSV 口径；两者同时存在时都按 max 合并，避免口径漂移）
 */
const LEVEL_FIELDS = ['velocity', 'volume'];

const voiceOf = (n) => n.voice ?? INSTRUMENT_VOICE[n.instrument] ?? 'inner';
const cellKey = (n) => `${n.step}|${n.row}`;

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  if (s.length === 0) return null;
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** 各声部的 midi 中位数（用于第 ③ 条"离本声部音域中心更近"） */
export function registerMedians(notes) {
  const byVoice = new Map();
  for (const n of notes) {
    const v = voiceOf(n);
    if (!byVoice.has(v)) byVoice.set(v, []);
    byVoice.get(v).push(n.midi);
  }
  const out = {};
  for (const [v, ms] of byVoice) out[v] = median(ms);
  return out;
}

/** 撞格检测：返回所有 ≥2 颗音的 (step,row)，按 step、row 排序 */
export function detectCollisions(notes) {
  const map = new Map();
  for (const n of notes) {
    const k = cellKey(n);
    if (!map.has(k)) map.set(k, { step: n.step, row: n.row, notes: [] });
    map.get(k).notes.push(n);
  }
  return [...map.values()]
    .filter((c) => c.notes.length >= 2)
    .sort((a, b) => a.step - b.step || a.row - b.row);
}

/** 判定同一格里的撞格类型（对整格判定，用于统计"按规则各合并了多少格"） */
function classify(group) {
  const voices = new Set(group.map(voiceOf));
  if (voices.size > 1) return 'cross-voice';
  const midis = group.map((n) => n.midi);
  if (new Set(midis).size === 1) return 'exact-duplicate';
  const pairs = [];
  for (let i = 0; i < midis.length; i++) {
    for (let j = i + 1; j < midis.length; j++) pairs.push(Math.abs(midis[i] - midis[j]));
  }
  if (pairs.every((d) => d % 12 === 0)) return 'same-voice-octave';
  return 'same-voice-pitch-class';
}

const RULE_TEXT = {
  'exact-duplicate': '同声部完全重复：同 step/row/声部/音高，合并为一颗',
  'same-voice-octave': '同声部相差整数八度：折叠到同一行，合并为一颗',
  'same-voice-pitch-class': '同声部同音级不同音高：折叠到同一行，合并为一颗',
  'cross-voice': '跨声部撞格：按声部优先级 + 力度决策，低优先级那颗被合并',
};

/**
 * 去撞格主函数（纯函数，不读文件）。
 * @param {Array<object>} notes 需含 step、row；建议含 midi、velocity、instrument/voice、len
 * @param {{voicePriority?: string[], velocityPolicy?: 'max'|'winner'}} [options]
 * @returns {{notes: Array<object>, report: object}}
 */
export function dedupeNotes(notes, options = {}) {
  const voicePriority = options.voicePriority ?? DEFAULT_VOICE_PRIORITY;
  const velocityPolicy = options.velocityPolicy ?? 'max';
  const levelFields = options.levelFields ?? LEVEL_FIELDS;
  const register = registerMedians(notes);

  const cells = new Map();
  for (const n of notes) {
    const k = cellKey(n);
    if (!cells.has(k)) cells.set(k, []);
    cells.get(k).push(n);
  }

  const out = [];
  const merged = [];
  const collisionsByRule = {
    'exact-duplicate': 0,
    'same-voice-octave': 0,
    'same-voice-pitch-class': 0,
    'cross-voice': 0,
  };
  const droppedByVoice = {};

  const rankOf = (n) => {
    const i = voicePriority.indexOf(voiceOf(n));
    return i === -1 ? voicePriority.length : i;
  };
  const regDist = (n) => {
    const c = register[voiceOf(n)];
    return c === null || c === undefined ? 0 : Math.abs(n.midi - c);
  };

  for (const group of cells.values()) {
    if (group.length === 1) {
      out.push({ ...group[0], voice: voiceOf(group[0]) });
      continue;
    }

    const rule = classify(group);
    const order = group.slice().sort(
      (a, b) =>
        rankOf(a) - rankOf(b) ||
        b.velocity - a.velocity ||
        regDist(a) - regDist(b) ||
        a.midi - b.midi ||
        String(a.instrument ?? '').localeCompare(String(b.instrument ?? '')),
    );
    const winner = order[0];
    const losers = order.slice(1);
    const maxLen = Math.max(...group.map((n) => n.len ?? 1));
    const kept = {
      ...winner,
      voice: voiceOf(winner),
      len: maxLen,
    };
    for (const f of levelFields) {
      const vals = group.map((n) => n[f]).filter((v) => typeof v === 'number' && Number.isFinite(v));
      if (vals.length === 0) continue;
      kept[f] = velocityPolicy === 'max' ? Math.max(...vals) : winner[f];
    }
    out.push(kept);

    collisionsByRule[rule] += 1;
    for (const l of losers) {
      const v = voiceOf(l);
      droppedByVoice[v] = (droppedByVoice[v] ?? 0) + 1;
    }
    merged.push({
      step: group[0].step,
      row: group[0].row,
      rule,
      ruleText: RULE_TEXT[rule],
      kept: {
        voice: kept.voice,
        instrument: kept.instrument ?? null,
        midi: kept.midi,
        velocity: kept.velocity ?? null,
        ...(kept.volume === undefined ? {} : { volume: kept.volume }),
      },
      dropped: losers.map((l) => ({
        voice: voiceOf(l),
        instrument: l.instrument ?? null,
        midi: l.midi,
        velocity: l.velocity,
        step: l.step,
        row: l.row,
        reason: rule,
      })),
    });
  }

  out.sort((a, b) => a.step - b.step || a.row - b.row || a.midi - b.midi);
  merged.sort((a, b) => a.step - b.step || a.row - b.row);

  const report = {
    policy: {
      voicePriority,
      velocityPolicy,
      decideOrder: ['voicePriority', 'velocity', 'registerDistance', 'midi'],
      collisionDefinition: '同一 (step,row) 上有 ≥2 颗音',
      mergedLengthPolicy: 'max',
    },
    summary: {
      notesIn: notes.length,
      notesOut: out.length,
      mergedAway: notes.length - out.length,
      cells: cells.size,
      collisionCells: merged.length,
      collisionsByRule,
      droppedByVoice,
    },
    merged,
  };
  return { notes: out, report };
}

/* ---------- CSV 读写（列名与 v3 完全一致，可直接替换给 layout） ---------- */

/** 读 v3 风格 CSV → 音符对象数组 */
export function readNotesCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  return lines.slice(1).map((line) => {
    const c = line.split(',');
    return {
      step: Number(c[idx.step]),
      tick: Number(c[idx.tick]),
      timeSec: Number(c[idx.time_seconds]),
      instrument: c[idx.instrument],
      midi: Number(c[idx.midi]),
      row: Number(c[idx.row]),
      volume: Number(c[idx.volume]),
      velocity: Math.round(Number(c[idx.volume]) * 127),
      len: 1,
    };
  });
}

/** 音符对象数组 → v3 风格 CSV（固定列顺序，数字格式保持 3 位小数） */
export function notesToCsv(notes) {
  const rows = notes.map((n) =>
    [n.step, n.tick, n.timeSec.toFixed(3), n.instrument, n.midi, n.row, n.volume.toFixed(3)].join(','),
  );
  return [CSV_HEADER.join(','), ...rows].join('\n') + '\n';
}

/** CSV 文本 → 去撞格后的 CSV + 报告 */
export function dedupeCsvText(text, options = {}) {
  const rows = readNotesCsv(text);
  const { notes, report } = dedupeNotes(rows, options);
  return { csv: notesToCsv(notes), report };
}

/* ---------- CLI ---------- */
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, '')] = argv[i + 1];
  const inPath = args.in ?? `${BUILD}/styx_helix_notes_v3.csv`;
  const outPath = args.out ?? `${BUILD}/notes_dedup.csv`;
  const reportPath = args.report ?? `${BUILD}/dedupe-report.json`;

  const before = readNotesCsv(fs.readFileSync(inPath, 'utf8'));
  const { csv, report } = dedupeCsvText(fs.readFileSync(inPath, 'utf8'));
  fs.writeFileSync(outPath, csv, 'utf8');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n', 'utf8');

  const after = readNotesCsv(csv);
  const s = report.summary;
  console.log(`${inPath}`);
  console.log(`  撞格前: ${s.notesIn} 颗音 / ${s.cells} 格，撞格 ${detectCollisions(before).length} 格（涉及 ${detectCollisions(before).reduce((a, c) => a + c.notes.length, 0)} 颗音）`);
  console.log(`  撞格后: ${s.notesOut} 颗音，撞格 ${detectCollisions(after).length} 格`);
  console.log(`  按规则合并掉的格数: ${JSON.stringify(s.collisionsByRule)}`);
  console.log(`  被合并掉的音（按声部）: ${JSON.stringify(s.droppedByVoice)}`);
  console.log(`  → ${outPath}`);
  console.log(`  → ${reportPath}`);
}
