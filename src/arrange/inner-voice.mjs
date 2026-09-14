// M3-1 · 内声部 / 和声层：把 harp 层里"同一刻的第二颗及以后的音"拆成**内声部**。
//
// 为什么需要这一层（`docs/DESIGN.md` v0.2 第 ③ 条 / `docs/DISCUSSION-C-music.md` §3.3）：
//   转谱出来的 harp 轨里混着两样东西——**旋律线**（同一刻只有一颗）和**中音区/和声材料**
//   （和弦音、内声部填充）。现在的编排把它们都塞进同一个 `harp` 音色里，于是
//   ① 渲染层分不出主次（M2-1 的 hifi 渲染器只能自己"按行号最高者=旋律"临时猜，见
//   `src/emit/playsound-hifi.mjs` 的 planHifi 注释）；② 同一格上旋律与和声材料互相挤（撞格）。
//   本模块把"哪颗是旋律、哪颗是内声部"变成**谱面上的数据**（`instrument` 取新值 `inner` + 追加列），
//   下游（dedupe / emit / 自研音色）就不必各自再猜一遍。
//
// 判定规则（全部可在报告里核对，改这里必须同步 docs/M3-1-inner-voice-report.md）：
//   · 只有 `instrument=harp` 参与拆分；bass / basedrum / hat 原样透传（低音不是内声部）。
//   · 按 step 升序走，维护**旋律游标** cursorMidi = 上一颗旋律音的 midi：
//       - 某 step 只有 1 颗 harp → 它就是旋律，cursor 更新为它；
//       - 某 step 有 ≥2 颗 harp → 旋律 = 离 cursorMidi 最近的那颗（并列取 row 高者，再并列取
//         音高小者、最后按原始行序，保证决定论）；其余 = 内声部候选。
//       - 第一个多音 step 之前没有 cursor → 取 row 最高者（与 M2-1 hifi 现有口径一致）。
//     为什么不用"音高最高者=旋律"：实测同一份数据上旋律线更抖（平均音程 5.14 → 4.78 半音，
//     >7 半音的大跳 217 → 178 处，见 docs/M3-1-inner-voice-report.md §3.2）。
//   · **完全重复**的音高（同一 step 上与旋律/其它 harp 音同 midi）也标 inner：它们本来就是内声部
//     材料（转谱重复），交给 dedupe 按"同一格"合并，本模块不凭空造音、也不搬八度。
//
// 音区映射（`register`，默认 `keep`，理由见报告 §4）：
//   · `keep`     —— 不动行号：内声部保留 T3 用原曲音频标定出来的八度（`docs/M0-2-report.md`）。
//                    实测：客观分与改造前逐位不动（0.8026 → 0.8025，chroma/八度/漏音全同）。
//   · `relocate` —— 只在"这颗音本来会被撞格合并掉"（同格已被 bass/打击乐/另一颗内声部占住）时，
//                    搬到**同音级的另一个空闲八度格**（优先向下），把音救回来。实测 +51 颗发声、
//                    客观分 −0.0052（八度命中率 0.913 → 0.899）。
//   · `band`     —— 设计文档字面的"内声部 harp 0–11"：内声部一律落到低带里该音级的唯一一行
//                    （被占则保持原行）。实测 −0.0252 客观分、漏音率 6.3% → 11.7%，
//                    因为它和音频标定的八度对着干 —— 所以**不是**默认。
//
// 文件进 / 文件出、幂等、可单独运行；路径一律走 `src/core/paths.mjs`（`--build` / `--project`）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePaths } from '../core/paths.mjs';

/** 内声部在 `instrument` 列里的取值（dedupe/velocity/score 的声部表里已登记为 inner 声部） */
export const INNER_INSTRUMENT = 'inner';
/** 本模块追加的列（既有列一律逐字符保留，只追加这三列） */
export const APPENDED_COLUMNS = ['voiceRole', 'innerOf', 'innerReason'];

export const DEFAULT_INNER_CONFIG = {
  /** keep | relocate | band —— 音区映射，见文件头 */
  register: 'keep',
  /** continuation | top —— 旋律判定 */
  melodyFrom: 'continuation',
  /** 参与拆分的音色（旋律/内声部都从这一层里出） */
  melodyInstrument: 'harp',
};

const pcOf = (midi) => ((midi % 12) + 12) % 12;

/* ------------------------------------------------------------------ CSV 读写 */

/**
 * 解析成"表头 + 原样字段数组"的表：**不改字段字符串**，只按列名定位。
 * 这样"既有列逐字符保留"是结构上成立的，而不是靠格式化函数小心翼翼地复原。
 */
export function parseTable(text) {
  const all = text.split(/\r?\n/);
  const lines = all.filter((l, i) => (i === all.length - 1 && l === '' ? false : true)).filter((l) => l.trim() !== '');
  if (lines.length === 0) return { header: null, rows: [] };
  const header = lines[0].split(',').map((s) => s.trim());
  const at = (n) => header.indexOf(n);
  const idx = {
    step: at('step'),
    instrument: at('instrument'),
    midi: at('midi'),
    row: at('row'),
  };
  for (const [k, v] of Object.entries(idx)) {
    if (v < 0) throw new Error(`谱面 CSV 缺列 ${k}：${header.join(',')}`);
  }
  const rows = lines.slice(1).map((line, i) => {
    const fields = line.split(',');
    return {
      i,
      fields,
      step: Number(fields[idx.step]),
      instrument: fields[idx.instrument],
      midi: Number(fields[idx.midi]),
      row: Number(fields[idx.row]),
      idx,
    };
  });
  return { header, rows };
}

/** 表头 + 字段数组 → CSV 文本（末尾换行，与流水线其余产物同形） */
export function tableToCsv(header, fieldsList) {
  if (!header) return '';
  return [header.join(','), ...fieldsList.map((f) => f.join(','))].join('\n') + '\n';
}

/* --------------------------------------------------------------- 拆分（纯函数） */

const roleOfInstrument = (instrument, cfg) => {
  if (instrument === cfg.melodyInstrument) return 'melody';
  if (instrument === INNER_INSTRUMENT) return 'inner';
  return instrument; // bass / basedrum / hat / 其它：原样带过，报告里按 instrument 归类
};

/**
 * 内声部拆分（纯函数，不读文件）。
 *
 * @param {Array<{step:number,instrument:string,midi:number,row:number,fields?:string[],i?:number}>} notes
 * @param {object} [config] 覆盖 DEFAULT_INNER_CONFIG
 * @returns {{notes: Array, report: object}} 按**输入行序**排好的新数组（不改入参对象）；
 *   每颗音多带 `role` / `innerOf` / `innerReason`（CSV 的三列由 `innerVoiceCsvText` 负责写）。
 */
export function splitInnerVoice(notes, config = {}) {
  const cfg = { ...DEFAULT_INNER_CONFIG, ...config };
  if (!['keep', 'relocate', 'band'].includes(cfg.register)) {
    throw new Error(`register 只支持 keep/relocate/band，收到 ${cfg.register}`);
  }
  if (!['continuation', 'top'].includes(cfg.melodyFrom)) {
    throw new Error(`melodyFrom 只支持 continuation/top，收到 ${cfg.melodyFrom}`);
  }

  // 按 step 分组（组内保持**输入行序**；`ord` 就是数组下标，做并列时的最后一道决定论）
  const byStep = new Map();
  notes.forEach((n, ord) => {
    const item = { ...n, ord };
    if (!byStep.has(item.step)) byStep.set(item.step, []);
    byStep.get(item.step).push(item);
  });
  const steps = [...byStep.keys()].sort((a, b) => a - b);

  // 结果按"输入行序"回写（不乱序：下游 diff、A/B 逐字节都依赖它）
  const out = new Array(notes.length);
  // 0..24 的每一行都至少有一个合法的"同音级另一个八度"（row ≤ 11 → row+12；row ≥ 12 → row−12），
  // 所以只有"候选格被占"这一种搬不动的情形，没有越界情形（tests/inner-voice.test.mjs 有断言）。
  const registerStats = { moved: 0, movedDown: 0, movedUp: 0, keptColliding: 0, blockedOccupied: 0 };
  const summary = {
    notesIn: notes.length,
    steps: steps.length,
    stepsWithMelodyLayer: 0,
    stepsMultiMelodyLayer: 0,
    melodyNotes: 0,
    innerNotes: 0,
    innerDistinct: 0,
    innerDuplicateOfMelody: 0,
    innerDuplicateOfInner: 0,
  };
  const samples = [];
  let cursorMidi = null;
  const melodyMidis = [];

  /** 决定论排序：离 cursor 近者优先，并列取 row 高者，再取音高小者，最后按原始行序 */
  const pickMelody = (hs) => {
    if (cfg.melodyFrom === 'top' || cursorMidi === null) {
      return hs.slice().sort((a, b) => b.row - a.row || a.midi - b.midi || a.ord - b.ord)[0];
    }
    return hs
      .slice()
      .sort((a, b) =>
        Math.abs(a.midi - cursorMidi) - Math.abs(b.midi - cursorMidi)
        || b.row - a.row
        || a.midi - b.midi
        || a.ord - b.ord)[0];
  };

  for (const step of steps) {
    const group = byStep.get(step);
    const hs = group.filter((n) => n.instrument === cfg.melodyInstrument);
    // 非 harp：原样带过（role 就是自己的 instrument 名）
    for (const n of group) if (n.instrument !== cfg.melodyInstrument) {
      const { ord, ...rest } = n;
      out[ord] = { ...rest, role: roleOfInstrument(n.instrument, cfg), innerOf: '', innerReason: '' };
    }
    if (hs.length === 0) continue;
    summary.stepsWithMelodyLayer++;

    const melody = pickMelody(hs);
    const inners = hs.length === 1 ? [] : hs.filter((n) => n !== melody);
    if (hs.length > 1) summary.stepsMultiMelodyLayer++;
    cursorMidi = melody.midi;
    melodyMidis.push({ step, midi: melody.midi, row: melody.row });
    summary.melodyNotes++;

    // 该 step 上已被占用的行：所有非 harp 音 + 旋律自己（用于 relocate/band 找空格）
    const occupied = new Set(group.filter((n) => n !== melody && n.instrument !== cfg.melodyInstrument).map((n) => n.row));
    occupied.add(melody.row);
    {
      const { ord, ...rest } = melody;
      out[ord] = { ...rest, role: 'melody', innerOf: '', innerReason: '' };
    }

    const midiCount = new Map();
    for (const n of hs) midiCount.set(n.midi, (midiCount.get(n.midi) ?? 0) + 1);

    // 拆分示例：报告里留前几个多音 step 的明细，方便人工核对（只在有内声部时记）
    const sample = inners.length && samples.length < 8 ? { step, rows: [{ kind: 'melody', midi: melody.midi, row: melody.row }] } : null;
    if (sample) samples.push(sample);

    for (const n of inners) {
      summary.innerNotes++;
      const isDupOfMelody = n.midi === melody.midi;
      const isDupOfInner = !isDupOfMelody && (midiCount.get(n.midi) ?? 0) > 1;
      const reason = isDupOfMelody ? 'duplicate-of-melody' : (isDupOfInner ? 'duplicate-in-chord' : 'chord-tone');
      if (isDupOfMelody) summary.innerDuplicateOfMelody++;
      else if (isDupOfInner) summary.innerDuplicateOfInner++;
      else summary.innerDistinct++;

      let row = n.row;
      const collides = occupied.has(row);
      if (cfg.register === 'band') {
        // 设计文档的"内声部 harp 0–11"：低带里该音级只有一行（= pc）
        const target = pcOf(n.midi);
        if (target !== row && !occupied.has(target)) row = target;
        else if (target !== row) registerStats.blockedOccupied++;
      } else if (cfg.register === 'relocate' && collides && reason === 'chord-tone') {
        // 只在"这颗**独立音高**的和声音否则会被合并掉"时救：同音级的另一个空闲八度格，优先向下
        // （转谱重复的重复音不救：那会凭空多出一个八度齐奏，属"造音"）
        const cands = [row - 12, row + 12].filter((r) => r >= 0 && r <= 24);
        const free = cands.find((r) => !occupied.has(r));
        if (free === undefined) registerStats.blockedOccupied++;
        else row = free;
      }
      if (row !== n.row) {
        registerStats.moved++;
        if (row < n.row) registerStats.movedDown++; else registerStats.movedUp++;
      } else if (occupied.has(row)) {
        registerStats.keptColliding++;
      }
      occupied.add(row);
      const midi = n.midi + (row - n.row); // 同音级换八度：音级不变，midi 随行号平移
      const { ord, ...rest } = n;
      out[ord] = { ...rest, instrument: INNER_INSTRUMENT, midi, row, role: 'inner', innerOf: melody.midi, innerReason: reason };
      if (sample) sample.rows.push({
        kind: `inner(${reason})`,
        midi: n.midi, row: n.row, newRow: row, melodyMidi: melody.midi,
      });
    }
  }

  // 旋律线统计（报告里用来说明"为什么用 continuation 判定"）
  const leaps = melodyMidis.slice(1).map((m, i) => Math.abs(m.midi - melodyMidis[i].midi));
  const sorted = leaps.slice().sort((a, b) => a - b);
  const melodyLine = {
    notes: melodyMidis.length,
    meanAbsInterval: leaps.length ? Number((leaps.reduce((a, b) => a + b, 0) / leaps.length).toFixed(3)) : null,
    medianAbsInterval: sorted.length ? sorted[sorted.length >> 1] : null,
    maxLeap: sorted.length ? sorted[sorted.length - 1] : null,
    leapsOver7: leaps.filter((x) => x > 7).length,
    leapsOver12: leaps.filter((x) => x > 12).length,
    rule: cfg.melodyFrom,
  };

  const byInstrumentOut = {};
  for (const n of out) byInstrumentOut[n.instrument] = (byInstrumentOut[n.instrument] ?? 0) + 1;
  summary.notesOut = out.length;
  summary.melodyLayerNotesOut = summary.melodyNotes + summary.innerNotes;
  summary.byInstrumentOut = byInstrumentOut;

  return {
    notes: out,
    report: { config: cfg, summary, melodyLine, register: registerStats, samples },
  };
}

/* ------------------------------------------------------------------ 撞格口径 */

/**
 * 撞格统计（两种口径都给，报告里必须同时出现，避免"只看对自己有利的那个"）：
 *   · `physical`  —— 同一 (step,row) 上有 ≥2 颗音：机器上那一格只能响一颗（= dedupe 的口径）
 *   · `sameInstrument` —— 同一 (step,instrument,row) 上有 ≥2 颗音（任务书 §报告 要求的那个口径）
 */
export function collisionStats(notes) {
  const physical = new Map();
  const sameInstrument = new Map();
  for (const n of notes) {
    const p = `${n.step}|${n.row}`;
    physical.set(p, (physical.get(p) ?? 0) + 1);
    const s = `${n.step}|${n.instrument}|${n.row}`;
    sameInstrument.set(s, (sameInstrument.get(s) ?? 0) + 1);
  }
  const fold = (map) => {
    const counts = [...map.values()];
    return { cells: counts.filter((c) => c >= 2).length, extraNotes: counts.filter((c) => c >= 2).reduce((a, c) => a + c - 1, 0) };
  };
  return { physical: fold(physical), sameInstrument: fold(sameInstrument) };
}

/* ------------------------------------------------------- CSV 文本 → 文本（供 CLI） */

/** 主入口：CSV 文本进 → CSV 文本 + 报告出（幂等；跑两次逐字节相同） */
export function innerVoiceCsvText(text, config = {}) {
  const { header, rows } = parseTable(text);
  if (!header) return { csv: '', report: { config: { ...DEFAULT_INNER_CONFIG, ...config }, summary: { notesIn: 0, notesOut: 0 }, collisionBefore: collisionStats([]), collisionAfter: collisionStats([]), samples: [] } };
  const before = rows.map((r) => ({ ...r }));
  const { notes, report } = splitInnerVoice(rows, config);

  // 追加列：表里已经有（例如对已拆分的产物再跑一次）→ 就**就地改写**，不重复追加 —— 这是幂等的关键
  const existing = APPENDED_COLUMNS.map((c) => header.indexOf(c));
  const missing = APPENDED_COLUMNS.filter((_, j) => existing[j] < 0);
  const outHeader = [...header, ...missing];
  const fieldsList = notes.map((n) => {
    const f = n.fields.slice();
    f[n.idx.instrument] = n.instrument;
    f[n.idx.midi] = String(n.midi);
    f[n.idx.row] = String(n.row);
    const values = [n.role ?? '', n.innerOf === '' || n.innerOf === undefined ? '' : String(n.innerOf), n.innerReason ?? ''];
    APPENDED_COLUMNS.forEach((c, j) => {
      // 本模块没给出新值时（例如对已拆分的产物再跑一次）：沿用表里已有的记录，别把来源信息抹掉
      if (existing[j] >= 0) f[existing[j]] = values[j] !== '' ? values[j] : (f[existing[j]] ?? '');
    });
    f.push(...missing.map((c) => values[APPENDED_COLUMNS.indexOf(c)]));
    return f;
  });
  return {
    csv: tableToCsv(outHeader, fieldsList),
    report: {
      ...report,
      collisionBefore: collisionStats(before),
      collisionAfter: collisionStats(notes),
    },
  };
}

/* ------------------------------------------------------------------- CLI */

const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const P = resolvePaths();
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const inPath = typeof args.in === 'string' ? args.in : P.file('pipeline_4_sustain.csv');
  const outPath = typeof args.out === 'string' ? args.out : P.file('pipeline_4b_inner.csv');
  const reportPath = typeof args.report === 'string' ? args.report : P.file('inner-voice-report.json');
  const register = typeof args.register === 'string' ? args.register : DEFAULT_INNER_CONFIG.register;
  const melodyFrom = typeof args.melody === 'string' ? args.melody : DEFAULT_INNER_CONFIG.melodyFrom;

  if (!fs.existsSync(inPath)) {
    console.error(`✗ 找不到输入谱面：${inPath}`);
    console.error(`  下一步：先跑 node src/arrange/arrange-all.mjs --build ${P.build}（本模块吃第 ④ 步的长音延音产物）`);
    process.exit(1);
  }
  const text = fs.readFileSync(inPath, 'utf8');
  const { csv, report } = innerVoiceCsvText(text, { register, melodyFrom });
  fs.writeFileSync(outPath, csv, 'utf8');
  const out = {
    $schema: 'nbforge.inner-voice-report/v0',
    meta: {
      at: new Date().toISOString(),
      build: P.build,
      project: P.project,
      inPath,
      outPath,
      reportPath,
      appendedColumns: APPENDED_COLUMNS,
    },
    command: `node src/arrange/inner-voice.mjs --in ${inPath} --out ${outPath} --register ${register} --melody ${melodyFrom}`,
    ...report,
  };
  fs.writeFileSync(reportPath, JSON.stringify(out, null, 2) + '\n', 'utf8');

  const s = report.summary;
  const c0 = report.collisionBefore;
  const c1 = report.collisionAfter;
  console.log(`内声部层（工程 ${P.project}，register=${register}，旋律判定=${melodyFrom}）`);
  console.log(`  ${inPath}（${s.notesIn} 颗音 / ${s.steps} 个 step）`);
  console.log(`  ① 旋律层：${s.stepsWithMelodyLayer} 个 step 有 harp，其中 ${s.stepsMultiMelodyLayer} 个是多音 step`
    + ` → 旋律 ${s.melodyNotes} 颗 + 内声部 ${s.innerNotes} 颗`
    + `（独立和声音 ${s.innerDistinct} / 与旋律同音高的重复 ${s.innerDuplicateOfMelody} / 和弦内重复 ${s.innerDuplicateOfInner}）`);
  console.log(`  ② 旋律线：平均音程 ${report.melodyLine.meanAbsInterval} 半音，>7 半音大跳 ${report.melodyLine.leapsOver7} 处，>12 半音 ${report.melodyLine.leapsOver12} 处`);
  console.log(`  ③ 音区映射：搬动 ${report.register.moved} 颗（向下 ${report.register.movedDown} / 向上 ${report.register.movedUp}）`
    + `，仍落在已占格 ${report.register.keptColliding} 颗`);
  console.log(`  ④ 撞格（同 step+row，机器上只能响一颗）：${c0.physical.cells} 格 / 多 ${c0.physical.extraNotes} 颗`
    + ` → ${c1.physical.cells} 格 / 多 ${c1.physical.extraNotes} 颗`);
  console.log(`     撞格（同 step+instrument+row）：${c0.sameInstrument.cells} 格 / 多 ${c0.sameInstrument.extraNotes} 颗`
    + ` → ${c1.sameInstrument.cells} 格 / 多 ${c1.sameInstrument.extraNotes} 颗`);
  console.log(`  → ${outPath}`);
  console.log(`  → ${reportPath}`);
}
