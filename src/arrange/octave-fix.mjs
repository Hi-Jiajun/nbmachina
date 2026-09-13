// T3 · 用八度证据修音高
//
// 规则（决定论、可复现）：
//   ① 有证据、且不弱 → newMidi = 证据的 bestOctave（音域先验已经包含在证据里，见 T2）
//   ② 证据弱（窗内 RMS < minRms）→ **保留原值**，并写进 degradations[]（保真契约：降级不能静默）
//   ③ 没有证据（缺条目）→ 保留原值 + degradations[]
// 也就是说：这一步只动"音频里听得出八度"的音，其余一律原样留给下一步。
//
// 输出：
//   build/notes_fixed.csv        保留原列 + newMidi + octaveEvidence + fixReason
//                                （octaveEvidence 形如 `A1@2.03`：音名 @ 证据边距 = best/次优）
//   build/octave_fix_report.json 统计与全部降级项
//   --emit-v3 <path>（可选）     把修复后的音高写回 v3 列，供 T4 去撞格 / 布局直接消费
//                                （注意：v3 的 row 列是"折叠到音符盒音域"的结果，改音高后
//                                  row/volume 需要在编曲步骤重算，本文件里的 row 保持原值）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  DEFAULT_CONFIG,
  readNotesCsv,
  voiceOfInstrument,
} from '../analyze/octave-evidence.mjs';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/**
 * "相邻两音相差整数八度"的对数（与 DISCUSSION-C / M0-2 报告同一口径）：
 * 同声部内按 (时间, 原 midi) 排序 —— 同一刻的并列音用**原 midi** 定序，
 * 这样"修前/修后"用的是同一组相邻关系，比较才有意义。
 * 相邻两颗音的差值是 12 的非零整数倍才计入。
 */
export function countIntegerOctavePairs(notes) {
  return integerOctavePairStats(notes).total;
}

/** 同上，但返回总数 + 分声部计数 */
export function integerOctavePairStats(notes) {
  const byVoice = new Map();
  for (const n of notes) {
    const v = n.voice ?? voiceOfInstrument(n.instrument);
    if (!byVoice.has(v)) byVoice.set(v, []);
    byVoice.get(v).push(n);
  }
  let total = 0;
  const per = {};
  for (const [v, list] of byVoice) {
    const sorted = list.slice().sort((a, b) => a.timeSec - b.timeSec || a.midi - b.midi);
    let c = 0;
    for (let i = 1; i < sorted.length; i++) {
      const d = (sorted[i].newMidi ?? sorted[i].midi) - (sorted[i - 1].newMidi ?? sorted[i - 1].midi);
      if (d !== 0 && d % 12 === 0) c++;
    }
    per[v] = c;
    total += c;
  }
  return { total, perVoice: per };
}

const rangeOf = (notes, voice) => {
  const ms = notes.filter((n) => (n.voice ?? voiceOfInstrument(n.instrument)) === voice)
    .map((n) => n.newMidi ?? n.midi);
  return ms.length ? [Math.min(...ms), Math.max(...ms)] : null;
};

/**
 * 用证据重写 midi。
 * @param csvText  转谱 CSV 文本（notes.csv 或 v3 都行，按表头取值）
 * @param evidence T2 的 analysis_octave.json 对象（按 noteId 对齐）
 */
export function fixOctaves({ csvText, evidence, config = {} }) {
  const cfg = { ...DEFAULT_CONFIG, ...config, voices: { ...DEFAULT_CONFIG.voices, ...(config.voices ?? {}) } };
  const { header, rows } = readNotesCsv(csvText);
  const evById = new Map((evidence?.notes ?? []).map((n) => [n.noteId, n]));
  // 证据是按音符身份算的（只跟 时间/乐器/原 midi 有关）。如果传入的 CSV 不是 notes.csv
  // 的那一版（例如 v3 形态：按 tick 排序、行号与 notes.csv 不同），行号对不上，
  // 就按 (时间, 乐器, 原 midi) 兜底匹配 —— 同 key 的音证据必然相同，因此是良定义的。
  const evByKey = new Map();
  for (const n of evidence?.notes ?? []) {
    evByKey.set(`${n.timeSec}|${n.instrument}|${n.midi}`, n);
  }
  const lookup = (r) => {
    const byId = evById.get(r.noteId);
    if (byId && byId.timeSec === r.timeSec && byId.midi === r.midi && byId.instrument === r.instrument) return byId;
    // 行号对得上但身份对不上，说明这份 CSV 的行序不是证据那一版 → 干净地当作"无证据"
    return evByKey.get(`${r.timeSec}|${r.instrument}|${r.midi}`) ?? null;
  };

  const notes = [];
  const degradations = [];
  const stats = {
    notes: rows.length,
    changed: 0,
    kept: 0,
    byVoice: {},
    byReason: {},
  };

  for (const r of rows) {
    const voice = voiceOfInstrument(r.instrument);
    const ev = lookup(r);
    let newMidi = r.midi;
    let reason;
    if (!ev) {
      reason = 'missing-evidence';
      degradations.push({ noteId: r.noteId, step: r.step, timeSec: r.timeSec, voice, midi: r.midi, reason });
    } else if (ev.weak) {
      reason = 'weak-evidence';
      degradations.push({
        noteId: r.noteId, step: r.step, timeSec: r.timeSec, voice, midi: r.midi, reason,
        rms: ev.rms, detail: `窗内 RMS ${ev.rms} < ${cfg.minRms}，证据不足`,
      });
    } else {
      newMidi = ev.bestOctave;
      reason = newMidi === r.midi ? 'kept' : 'evidence';
    }

    const note = {
      noteId: r.noteId,
      step: r.step,
      timeSec: r.timeSec,
      instrument: r.instrument,
      voice,
      midi: r.midi,
      newMidi,
      fixReason: reason,
      changed: newMidi !== r.midi,
      octaveEvidence: ev
        ? `${midiName(ev.bestOctave)}@${Number.isFinite(ev.margin) ? ev.margin.toFixed(2) : 'n/a'}`
        : 'n/a',
      fields: r.fields,
      header,
      ev,
    };
    notes.push(note);

    stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
    stats.byVoice[voice] ??= { n: 0, changed: 0, kept: 0, withEvidence: 0 };
    const bv = stats.byVoice[voice];
    bv.n++;
    if (note.changed) { bv.changed++; stats.changed++; } else { bv.kept++; stats.kept++; }
    if (ev && !ev.weak) bv.withEvidence++;
  }

  const before = { total: 0, perVoice: {} };
  const after = { total: 0, perVoice: {} };
  for (const v of Object.keys(stats.byVoice)) {
    const inV = notes.filter((n) => n.voice === v);
    const a = integerOctavePairStats(inV.map((n) => ({ ...n, newMidi: n.midi })));
    const b = integerOctavePairStats(inV);
    before.perVoice[v] = a.perVoice[v] ?? 0;
    after.perVoice[v] = b.perVoice[v] ?? 0;
    before.total += before.perVoice[v];
    after.total += after.perVoice[v];
  }
  stats.integerOctavePairs = { before, after };

  const agree = (key) => {
    const withEv = notes.filter((n) => n.ev && !n.ev.weak);
    if (!withEv.length) return { n: 0, before: 0, after: 0 };
    const b = withEv.filter((n) => n.midi === n.ev.bestOctave).length;
    const a = withEv.filter((n) => n.newMidi === n.ev.bestOctave).length;
    return {
      n: withEv.length,
      before: Number((100 * b / withEv.length).toFixed(2)),
      after: Number((100 * a / withEv.length).toFixed(2)),
    };
  };
  stats.evidenceAgreement = {};
  for (const v of Object.keys(stats.byVoice)) {
    const inV = notes.filter((n) => n.voice === v);
    const withEv = inV.filter((n) => n.ev && !n.ev.weak);
    const b = withEv.filter((n) => n.midi === n.ev.bestOctave).length;
    const a = withEv.filter((n) => n.newMidi === n.ev.bestOctave).length;
    stats.evidenceAgreement[v] = {
      n: withEv.length,
      before: withEv.length ? Number((100 * b / withEv.length).toFixed(2)) : 0,
      after: withEv.length ? Number((100 * a / withEv.length).toFixed(2)) : 0,
    };
  }
  const asBefore = notes.map((n) => ({ ...n, newMidi: n.midi }));
  stats.register = {
    before: { melody: rangeOf(asBefore, 'melody'), bass: rangeOf(asBefore, 'bass') },
    after: { melody: rangeOf(notes, 'melody'), bass: rangeOf(notes, 'bass') },
  };
  stats.registerName = stats.register;
  stats.agreeOverall = agree();
  stats.degradations = degradations.length;
  stats.degradationsByReason = degradations.reduce((acc, d) => {
    acc[d.reason] = (acc[d.reason] ?? 0) + 1;
    return acc;
  }, {});

  return { notes, degradations, stats, header };
}

/** 输出 CSV：保留原列 + newMidi + octaveEvidence + fixReason */
export function notesFixedCsv(notes) {
  if (!notes.length) return '';
  const header = [...notes[0].header, 'newMidi', 'octaveEvidence', 'fixReason'];
  const lines = notes.map((n) => [...n.fields, String(n.newMidi), n.octaveEvidence, n.fixReason].join(','));
  return [header.join(','), ...lines].join('\n') + '\n';
}

/** 把修复后的音高写回原来的列（v3 供 T4/布局直接消费；其余列保持原样） */
export function toV3Csv(notes) {
  if (!notes.length) return '';
  const header = notes[0].header;
  const mi = header.indexOf('midi');
  if (mi < 0) throw new Error('CSV 缺少 midi 列');
  const lines = notes.map((n) => {
    const f = n.fields.slice();
    f[mi] = String(n.newMidi);
    return f.join(',');
  });
  return [header.join(','), ...lines].join('\n') + '\n';
}

/* ---------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const notesPath = args.notes ?? `${BUILD}/styx_helix_notes.csv`;
  const evPath = args.evidence ?? `${BUILD}/analysis_octave.json`;
  const outPath = args.out ?? `${BUILD}/notes_fixed.csv`;
  const reportPath = args.report ?? `${BUILD}/octave_fix_report.json`;

  const evidence = JSON.parse(fs.readFileSync(evPath, 'utf8'));
  const csvText = fs.readFileSync(notesPath, 'utf8');
  const { notes, degradations, stats } = fixOctaves({ csvText, evidence });
  fs.writeFileSync(outPath, notesFixedCsv(notes), 'utf8');
  fs.writeFileSync(reportPath, JSON.stringify({ meta: { notesPath, evPath, outPath }, stats, degradations }, null, 1) + '\n', 'utf8');
  if (typeof args['emit-v3'] === 'string') fs.writeFileSync(args['emit-v3'], toV3Csv(notes), 'utf8');

  console.log(`八度修复：${stats.notes} 颗音（证据 ${evPath}）`);
  for (const [v, s] of Object.entries(stats.byVoice)) {
    const a = stats.evidenceAgreement[v];
    const reg = stats.register;
    console.log(`  ${v}: 改了 ${s.changed} / 保留 ${s.kept}（有证据 ${s.withEvidence}）`
      + ` | 与证据一致 ${a.before}% → ${a.after}%`
      + ` | 相邻整数八度对 ${stats.integerOctavePairs.before.perVoice[v]} → ${stats.integerOctavePairs.after.perVoice[v]}`);
    if (reg.after[v]) {
      console.log(`    音域 ${midiName(reg.before[v][0])}..${midiName(reg.before[v][1])}`
        + ` → ${midiName(reg.after[v][0])}..${midiName(reg.after[v][1])}`);
    }
  }
  console.log(`  相邻整数八度对合计 ${stats.integerOctavePairs.before.total} → ${stats.integerOctavePairs.after.total}`);
  console.log(`  降级 ${stats.degradations} 项 ${JSON.stringify(stats.degradationsByReason)}`);
  console.log(`  → ${outPath}`);
  console.log(`  → ${reportPath}`);
}
