// M1-1 · 音级恢复：把被吸附到 C# 自然小调的 5 个调外音级找回来
//
// 要打掉的现象（M0-3 §3.1 实测）：调外 5 个音级（C/D/F/G/A#）在音频里占最大音级的
// 0.16–0.57，而 v3 谱面只有 0.01–0.06（差 3–11 倍），合计仅占谱面质量 3.4%。
// 这不是"整体移调"（chroma 最佳移调 +0），是转谱把音高吸附到了单一音阶。
//
// 修法（任务书 M1 Task 1）：对每颗音，在**它自己的八度**上量 12 个音级的窄带能量，
// 取最强音级；只有当"最强 / 次强 ≥ 1.6 且最强音级 ≠ 原音级"时才改，且只改音级不改八度。
//
// 六个刻意的取值（都写进 docs/M1-1-report.md）：
//   ① **只动音级**：候选 = 同一 `floor(midi/12)` 内的 12 个音级，因此 |new−old| ≤ 11、
//      八度命中率（T3 已定稿 0.965）不受影响。模块里对不变式做断言式统计
//      （stats.octavePreserved.violations 必须为 0）。
//   ② **窗长与 T5 一致**：旋律 100ms、贝斯 120ms（M0-3 §T5b 的窗长扫描结论：低音区一个
//      半音 < 1 个 bin，窗太短会把前一颗音的尾巴算进来）。
//   ③ **只用基频**（harmonicWeights [1]）：与 T5b 的默认口径一致；加 2f0 会把"高一个八度
//      的同一个音级"算进候选（C4 的 2 次谐波正是 C5 的基频），正好破坏 ① 的八度隔离。
//      要对照可传 `--comb`（[1,0.5,0.25]）。
//   ④ **探针 ±0.25 bin 取最大**（probeFrac）：单点 Goertzel 有扇形损失（scalloping）——
//      Hann 窗偏离 bin 中心 0.5 bin 时只剩 18% 的能量（振幅 42%），会把"真实音级"的
//      能量压低到次强音级以下，造成误判。取 f0 与 f0±0.25bin 三个探针的最大值后，
//      最坏情况离最近探针 ≤ 0.125 bin（≈ 1.5% 振幅误差）。`--probe 0` 可关掉做对照。
//   ⑤ **两道证据门槛**（都保持原值 + 写 degradations，绝不静默改音）：
//      · 窗内 RMS < minRms → `weak-evidence`（这一段音频里听不出东西）；
//      · 最强峰的基频振幅 < minAmplitude，或 < minAmpOverRms × 窗内 RMS → `no-peak`。
//        这一条专门挡"八度错了的音"：一个在别的八度上的音，在本候选八度里只剩旁瓣泄漏
//        （Hann 窗 3 bin 处 ≈ −31.5dB → 振幅等效 0.03–0.04 × 真音振幅），
//        能量门槛能把它挡掉，否则会按噪声随机改音级。
//   ⑥ 边距不足（最强/次强 < 1.6）→ `below-margin`：两个音级差不多强，宁可不动。
//   ⑦ **只允许 ±1 半音的"解吸附"**（maxPcShift，默认 1）：诊断出来的缺陷是"被吸附到最近的
//      音阶音"，位移上限就是 1 个半音。真实数据上按任务书原样放开 12 个音级时，102 条改动里
//      只有 15 条是 ±1，其余是 ±2..±6——那些不是"解吸附"，而是把**同时响着的别的声部**当成了
//      这颗音（报告 §3 有半音位移直方图）。用 `--pc-window 11` 可回到原样的放宽口径。
//   ⑧ **只对可判声部做音级改写**（pcFixVoices，默认 melody/inner）：贝斯声部（midi 21–63）
//      一个半音只有 4.3–6.9Hz，而 100–120ms 窗的频率分辨率是 8.3–10Hz——**一个半音不到一个
//      bin**。实测邻居/自身能量比中位 0.96（旋律 0.00–0.12），即"上邻半音和自身一样强"，
//      音级在音频上不可判（M0-3 §3.3/§5.2 同一结论）。贝斯一律保持原值 + `register-ambiguous`。
//
// 限制（如实写在报告里）：低音区（一个半音 < 1 个 bin）12 个候选高度重叠，边距天然偏小，
// 所以贝斯的改动数会明显少于旋律；这不是"贝斯没错"，而是"证据不足时不猜"。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolvePaths } from '../core/paths.mjs';

import {
  NOTE_NAMES,
  midiName,
  midiToFreq,
  narrowbandEnergy,
  pcOf,
  readNotesCsv,
  readWav,
} from '../analyze/dsp.mjs';
import { voiceOfInstrument } from './velocity.mjs';

export { midiName, pcOf, readNotesCsv, readWav };

export const DEFAULT_PITCH_FIX_CONFIG = {
  a4: 440,
  margin: 1.6,            // 最强/次强 ≥ 1.6 才改（任务书给的证据门槛）
  minRms: 0.01,           // 窗内 RMS 低于此值 → 无证据（与 T5b 同口径）
  minAmplitude: 0.02,     // 最强峰的基频振幅下限（由窄带能量反推）
  minAmpOverRms: 0.1,     // 最强峰的基频振幅 / 窗内 RMS 的下限
  probeFrac: 0.25,        // 探针跨度（单位：bin）；0 = 单点测量
  maxPcShift: 1,          // 新音级与原音级相差几个半音以内（环绕）；11 = 不限制（任务书原口径）
  pcFixVoices: ['melody', 'inner'], // 可判声部（贝斯一个半音 < 1 个 bin，不可判）
  windows: { melody: 0.1, inner: 0.1, bass: 0.12, perc: 0.1 },
  harmonicWeights: { melody: [1], inner: [1], bass: [1], perc: [1] },
};

export function pitchFixConfig(config = {}) {
  return {
    ...DEFAULT_PITCH_FIX_CONFIG,
    ...config,
    windows: { ...DEFAULT_PITCH_FIX_CONFIG.windows, ...(config.windows ?? {}) },
    harmonicWeights: { ...DEFAULT_PITCH_FIX_CONFIG.harmonicWeights, ...(config.harmonicWeights ?? {}) },
  };
}

/**
 * 一颗音在某个八度内的 12 个音级候选：`floor(midi/12)*12 + pc`。
 * 这是"只改音级、不改八度"的硬约束（midiName 的八度是 floor(midi/12)−1，这里用的是折叠索引）。
 */
export function candidateMidis(midi) {
  const base = Math.floor(midi / 12) * 12;
  return Array.from({ length: 12 }, (_, pc) => base + pc);
}

/**
 * 窄带能量 → 基频振幅：x[i] = A·sin(2πf0·i/SR) 时 |X(f0)| = (A/2)·Σw、Σw = N/2，
 * 故 A = 4·sqrt(E)/N。用于把"证据门槛"从能量换算成一个与窗长无关的物理量。
 */
export function energyToAmplitude(energy, windowSamples) {
  if (!(energy > 0) || !(windowSamples > 0)) return 0;
  return (4 * Math.sqrt(energy)) / windowSamples;
}

/** 音级环绕距离（0..6） */
export function pcDistance(a, b) {
  const d = Math.abs(pcOf(a) - pcOf(b));
  return Math.min(d, 12 - d);
}

/**
 * 单个候选音级的能量：在 f0 与 f0±(probeFrac·binHz) 三个频点上取最大（抵消扇形损失）。
 * 仍复用 `narrowbandEnergy`（探针用分数 midi 表示频点）。
 */
export function candidatePeak({
  samples,
  sampleRate,
  midi,
  timeSec,
  a4,
  windowSec,
  harmonicWeights,
  probeFrac,
}) {
  const n = Math.max(16, Math.round(sampleRate * windowSec));
  const binHz = sampleRate / n;
  const f0 = midiToFreq(midi, a4);
  const dMidi = probeFrac > 0 ? 12 * Math.log2(1 + (probeFrac * binHz) / f0) : 0;
  const offsets = dMidi > 0 ? [-dMidi, 0, dMidi] : [0];
  let energy = 0;
  let rms = 0;
  let windowSamples = n;
  for (const off of offsets) {
    const m = narrowbandEnergy({
      samples, sampleRate, midi: midi + off, timeSec, a4, windowSec, harmonicWeights,
    });
    if (m.energy > energy) energy = m.energy;
    rms = m.rms;
    windowSamples = m.windowSamples;
  }
  return { energy, rms, windowSamples, f0, binHz };
}

/**
 * 逐音恢复音级。
 * @returns {{header: string[], notes: Array, degradations: Array, stats: object}}
 */
export function pitchFix({ csvText, samples, sampleRate, config = {} }) {
  const cfg = pitchFixConfig(config);
  const { header, notes: rows } = readNotesCsv(csvText);

  const notes = [];
  const degradations = [];
  const stats = {
    notes: rows.length,
    changed: 0,
    kept: 0,
    byVoice: {},
    byReason: {},
    pcsMoved: {},
    octavePreserved: { checked: 0, violations: 0 },
    degradations: 0,
    degradationsByReason: {},
    gates: { weakEvidence: 0, noPeak: 0, belowMargin: 0, keptOriginal: 0, changed: 0, pcAllAgrees: 0 },
  };

  for (const r of rows) {
    const voice = voiceOfInstrument(r.instrument);
    const windowSec = cfg.windows[voice] ?? cfg.windows.melody ?? cfg.windows.inner;
    const harmonicWeights = cfg.harmonicWeights[voice] ?? [1];
    const cands = candidateMidis(r.midi);
    const measured = cands.map((m) => ({
      midi: m,
      pc: pcOf(m),
      allowed: pcDistance(m, r.midi) <= cfg.maxPcShift,
      ...candidatePeak({
        samples,
        sampleRate,
        midi: m,
        timeSec: r.timeSec,
        a4: cfg.a4,
        windowSec,
        harmonicWeights,
        probeFrac: cfg.probeFrac,
      }),
    }));

    // 决定论排序：只允许"±maxPcShift 半音以内"的候选参与判定，能量降序、同能量按 midi 升序
    const order = measured.map((_, i) => i).filter((i) => measured[i].allowed)
      .sort((a, b) => measured[b].energy - measured[a].energy || measured[a].midi - measured[b].midi);
    const orderAll = measured.map((_, i) => i)
      .sort((a, b) => measured[b].energy - measured[a].energy || measured[a].midi - measured[b].midi);
    const bi = order[0];
    const si = order[1];
    const best = measured[bi];
    const second = measured[si];
    const orig = measured.find((m) => m.midi === r.midi);
    const bestAll = measured[orderAll[0]];
    const rms = measured[0].rms;
    const amplitude = energyToAmplitude(best.energy, best.windowSamples);
    const ampOverRms = rms > 0 ? amplitude / rms : 0;
    const margin = second.energy > 0 ? best.energy / second.energy : Infinity;

    let newMidi = r.midi;
    let reason;
    if (!cfg.pcFixVoices.includes(voice)) {
      reason = 'register-ambiguous';
    } else if (rms < cfg.minRms) {
      reason = 'weak-evidence';
    } else if (amplitude < cfg.minAmplitude || ampOverRms < cfg.minAmpOverRms) {
      reason = 'no-peak';
    } else if (best.pc === pcOf(r.midi)) {
      reason = 'kept';
    } else if (!(margin >= cfg.margin)) {
      reason = 'below-margin';
    } else {
      newMidi = best.midi;
      reason = 'evidence';
    }

    const changed = newMidi !== r.midi;
    const note = {
      noteId: r.noteId,
      step: r.step,
      timeSec: r.timeSec,
      instrument: r.instrument,
      voice,
      midi: r.midi,
      newMidi,
      pcBefore: pcOf(r.midi),
      pcAfter: pcOf(newMidi),
      midiBeforeName: midiName(r.midi),
      midiAfterName: midiName(newMidi),
      changed,
      reason,
      bestPc: best.pc,
      bestPcName: midiName(best.midi),
      bestMidi: best.midi,
      bestEnergy: best.energy,
      secondPcName: midiName(second.midi),
      secondEnergy: second.energy,
      originalEnergy: orig.energy,
      allowedCandidates: order.length,
      bestPcAllName: midiName(bestAll.midi),
      bestPcAllEnergy: bestAll.energy,
      bestPcAllIsOriginal: bestAll.pc === pcOf(r.midi),
      margin,
      amplitude,
      ampOverRms,
      rms,
      windowSec,
      fields: r.fields,
      header,
    };
    notes.push(note);

    stats.byReason[reason] = (stats.byReason[reason] ?? 0) + 1;
    if (!bestAll || bestAll.pc === pcOf(r.midi)) stats.gates.pcAllAgrees++;
    stats.byVoice[voice] ??= { n: 0, changed: 0, kept: 0, degradations: 0 };
    const bv = stats.byVoice[voice];
    bv.n++;
    if (changed) {
      bv.changed++;
      stats.changed++;
      stats.gates.changed++;
      const k = `${midiName(r.midi)}→${midiName(newMidi)}`;
      stats.pcsMoved[k] = (stats.pcsMoved[k] ?? 0) + 1;
    } else {
      bv.kept++;
      stats.kept++;
      if (reason === 'weak-evidence') stats.gates.weakEvidence++;
      else if (reason === 'no-peak') stats.gates.noPeak++;
      else if (reason === 'below-margin') stats.gates.belowMargin++;
      else stats.gates.keptOriginal++;
    }
    stats.octavePreserved.checked++;
    if (!(Math.abs(newMidi - r.midi) <= 11 && Math.floor(newMidi / 12) === Math.floor(r.midi / 12))) {
      stats.octavePreserved.violations++;
    }
    if (reason !== 'kept' && reason !== 'evidence') {
      bv.degradations++;
      stats.degradations++;
      stats.degradationsByReason[reason] = (stats.degradationsByReason[reason] ?? 0) + 1;
      const up = measured.find((m) => m.midi === r.midi + 1);
      const down = measured.find((m) => m.midi === r.midi - 1);
      const ratio = (x) => (x && orig.energy > 0 ? num(x.energy / orig.energy) : null);
      degradations.push({
        noteId: r.noteId,
        step: r.step,
        timeSec: r.timeSec,
        instrument: r.instrument,
        voice,
        midi: r.midi,
        midiName: midiName(r.midi),
        reason,
        bestPcName: midiName(best.midi),
        bestEnergy: num(best.energy),
        secondEnergy: num(second.energy),
        margin: num(margin),
        amplitude: num(amplitude),
        rms: num(rms),
        neighborUpOverOwn: ratio(up),
        neighborDownOverOwn: ratio(down),
      });
    }
  }

  return { header, notes, degradations, stats };
}

/** 输出 CSV：原列逐字符保留，只改 `midi`，追加一列 `reason` */
export function pitchFixedCsv(notes, header = notes[0]?.header) {
  if (!notes.length) return '';
  const cols = header ?? null;
  if (!cols) throw new Error('pitchFixedCsv 需要表头（notes[].header）');
  const mi = cols.indexOf('midi');
  if (mi < 0) throw new Error('CSV 缺少 midi 列');
  const lines = [[...cols, 'reason'].join(',')];
  for (const n of notes) {
    const f = n.fields.slice();
    f[mi] = String(n.newMidi);
    lines.push([...f, n.reason].join(','));
  }
  return lines.join('\n') + '\n';
}

/** 文本入口：CSV 文本 + 音频 → CSV 文本（CLI 与测试共用） */
export function pitchFixCsvText({ csvText, samples, sampleRate, config = {} }) {
  const { header, notes, degradations, stats } = pitchFix({ csvText, samples, sampleRate, config });
  return { csv: pitchFixedCsv(notes, header), notes, degradations, stats, header };
}

/**
 * 「邻居支持」诊断（决定"音级到底错没错"的可复现实验）：
 * 对每颗音，在**它自己的八度**上量自身音级与上/下各一个半音的能量。
 *   · 如果谱面音级是对的，自身应该赢（真实数据：旋律 99%）；
 *   · 如果谱面被"吸附"过，应该是**相邻**半音赢（吸附只会挪 1 个半音）。
 * 这个口径不依赖混音级 chroma（见报告 §3：M0-3 的"被压制音级"是宽带底噪 + 泛音折叠造成的），
 * 也不依赖任何音阶先验。
 */
export function neighborSupport({ csvText, samples, sampleRate, config = {} }) {
  const cfg = pitchFixConfig(config);
  const { notes: rows } = readNotesCsv(csvText);
  const out = [];
  for (const r of rows) {
    const voice = voiceOfInstrument(r.instrument);
    const windowSec = cfg.windows[voice] ?? cfg.windows.melody;
    const harmonicWeights = cfg.harmonicWeights[voice] ?? [1];
    const at = (midi) => candidatePeak({
      samples, sampleRate, midi, timeSec: r.timeSec, a4: cfg.a4, windowSec, harmonicWeights, probeFrac: cfg.probeFrac,
    });
    const own = at(r.midi);
    const up = at(r.midi + 1);
    const down = at(r.midi - 1);
    const bestEnergy = Math.max(own.energy, up.energy, down.energy);
    let winner = 'own';
    if (up.energy === bestEnergy && up.energy > own.energy) winner = 'up';
    else if (down.energy === bestEnergy && down.energy > own.energy) winner = 'down';
    out.push({
      noteId: r.noteId, step: r.step, timeSec: r.timeSec, instrument: r.instrument, voice,
      midi: r.midi, midiName: midiName(r.midi), pc: pcOf(r.midi),
      rms: own.rms,
      ownEnergy: own.energy, upEnergy: up.energy, downEnergy: down.energy,
      winner,
      ownBest: winner === 'own',
      upOverOwn: own.energy > 0 ? up.energy / own.energy : null,
      downOverOwn: own.energy > 0 ? down.energy / own.energy : null,
    });
  }

  const median = (xs) => {
    const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
    if (!s.length) return null;
    const mid = s.length >> 1;
    return Number(((s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2)).toFixed(4));
  };
  const summary = {};
  for (const v of [...new Set(out.map((n) => n.voice))]) {
    const list = out.filter((n) => n.voice === v);
    const byPc = {};
    for (const n of list) {
      byPc[n.pc] ??= { n: 0, own: 0, up: 0, down: 0 };
      byPc[n.pc].n++;
      byPc[n.pc][n.winner]++;
    }
    summary[v] = {
      n: list.length,
      own: list.filter((n) => n.winner === 'own').length,
      up: list.filter((n) => n.winner === 'up').length,
      down: list.filter((n) => n.winner === 'down').length,
      ownRate: Number((list.filter((n) => n.winner === 'own').length / list.length).toFixed(4)),
      medianUpOverOwn: median(list.map((n) => n.upOverOwn)),
      medianDownOverOwn: median(list.map((n) => n.downOverOwn)),
      byPc: Object.fromEntries(Object.entries(byPc).map(([pc, s]) => [NOTE_NAMES[Number(pc)], s])),
    };
  }
  return { notes: out, summary };
}

/** 数字 → JSON 友好的有限数（Infinity/NaN 记 null，避免报告里出现 null 之外的怪值） */
function num(x) {
  return Number.isFinite(x) ? Number(x.toFixed(6)) : null;
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
  const inPath = args.in ?? P.file('notes_fixed_v3.csv');
  const outPath = args.out ?? P.file('notes_pitchfixed.csv');
  const reportPath = args.report ?? P.file('pitch_fix_report.json');
  const wavPath = args.audio ?? P.audio;
  const config = {
    ...(args.margin !== undefined ? { margin: Number(args.margin) } : {}),
    ...(args['min-amplitude'] !== undefined ? { minAmplitude: Number(args['min-amplitude']) } : {}),
    ...(args['min-amp-over-rms'] !== undefined ? { minAmpOverRms: Number(args['min-amp-over-rms']) } : {}),
    ...(args.probe !== undefined ? { probeFrac: Number(args.probe) } : {}),
    ...(args['pc-window'] !== undefined ? { maxPcShift: Number(args['pc-window']) } : {}),
    ...(typeof args['pc-voices'] === 'string' ? { pcFixVoices: args['pc-voices'].split(',') } : {}),
    ...(args.comb ? { harmonicWeights: { melody: [1, 0.5, 0.25], inner: [1, 0.5, 0.25], bass: [1, 0.5, 0.25], perc: [1, 0.5, 0.25] } } : {}),
  };
  const cfg = pitchFixConfig(config);

  // --neighbor-check：只跑"邻居支持"诊断（决定音级到底错没错的可复现实验，见函数注释）
  if (args['neighbor-check']) {
    const tN = Date.now();
    const w = readWav(wavPath);
    const { summary } = neighborSupport({
      csvText: fs.readFileSync(inPath, 'utf8'), samples: w.samples, sampleRate: w.sampleRate, config,
    });
    console.log(`邻居支持诊断：${inPath}（${w.seconds.toFixed(1)}s 音频，${w.sampleRate}Hz）`);
    console.log('  口径：每颗音在**自身八度**上量"自身音级 / 上邻半音 / 下邻半音"的窄带能量（窗与探针同上）');
    console.log('  读法：谱面音级若是对的 → 自身赢；若被"吸附"过（最多挪 1 个半音）→ 邻音赢');
    for (const [v, s] of Object.entries(summary)) {
      console.log(`  ${v}：n=${s.n}｜自身赢 ${s.own}（${(100 * s.ownRate).toFixed(1)}%）、上邻赢 ${s.up}、下邻赢 ${s.down}`
        + `｜中位能量比：上邻/自身 ${s.medianUpOverOwn}、下邻/自身 ${s.medianDownOverOwn}`);
      console.log(`     逐音级（自身赢/该音级总数）：${Object.entries(s.byPc).map(([pc, x]) => `${pc} ${x.own}/${x.n}`).join('，')}`);
    }
    console.log(`  用时 ${((Date.now() - tN) / 1000).toFixed(1)}s`);
    process.exit(0);
  }

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(wavPath);
  const text = fs.readFileSync(inPath, 'utf8');
  const { csv, notes, degradations, stats } = pitchFixCsvText({ csvText: text, samples, sampleRate, config });
  fs.writeFileSync(outPath, csv, 'utf8');
  if (reportPath) {
    fs.writeFileSync(reportPath, JSON.stringify({
      meta: {
        inPath, wavPath, outPath, audioSeconds: Number(seconds.toFixed(1)), sampleRate,
        config: {
          margin: cfg.margin,
          minRms: cfg.minRms,
          minAmplitude: cfg.minAmplitude,
          minAmpOverRms: cfg.minAmpOverRms,
          probeFrac: cfg.probeFrac,
          windows: cfg.windows,
          harmonicWeights: cfg.harmonicWeights,
          a4: cfg.a4,
        },
        durationMs: Date.now() - t0,
      },
      stats,
      degradations,
      changed: notes.filter((n) => n.changed).map((n) => ({
        noteId: n.noteId,
        step: n.step,
        timeSec: Number(n.timeSec.toFixed(3)),
        instrument: n.instrument,
        voice: n.voice,
        midi: n.midi,
        newMidi: n.newMidi,
        midiBeforeName: n.midiBeforeName,
        midiAfterName: n.midiAfterName,
        margin: num(n.margin),
        bestEnergy: num(n.bestEnergy),
        secondEnergy: num(n.secondEnergy),
        originalEnergy: num(n.originalEnergy),
        amplitude: num(n.amplitude),
      })),
    }, null, 1) + '\n', 'utf8');
  }

  const windows = Object.entries(cfg.windows).map(([v, w]) => `${v} ${(w * 1000).toFixed(0)}ms`).join(' / ');
  console.log(`音级恢复：${inPath}（${stats.notes} 颗音，${seconds.toFixed(1)}s 音频）`);
  console.log(`  口径：候选 12 音级（同八度）/ 窗 ${windows} / 探针 ±${cfg.probeFrac} bin`
    + ` / ${JSON.stringify(cfg.harmonicWeights.melody)}${args.comb ? '（梳状，对照用）' : ''}`);
  console.log(`  允许的音级位移：±${cfg.maxPcShift} 半音${cfg.maxPcShift >= 11 ? '（任务书原口径：任意音级）' : '（"解吸附"口径）'}`
    + `｜可判声部 ${cfg.pcFixVoices.join('/')}`
    + `｜12 音级里最强音级与谱面一致 ${stats.gates.pcAllAgrees}/${stats.notes}`
    + `（不一致的 ${stats.notes - stats.gates.pcAllAgrees} 颗 = 同时响着的别的声部更强，不代表音级错）`);
  console.log(`  判定：最强/次强 ≥ ${cfg.margin} 且音级不同才改；振幅 < ${cfg.minAmplitude}`
    + ` 或 < ${cfg.minAmpOverRms}×窗内 RMS（${cfg.minRms} 以下算无证据）→ 保持原值 + degradations`);
  console.log(`  结果：改 ${stats.changed} / 保留 ${stats.kept}（`
    + Object.entries(stats.byVoice).map(([v, b]) => `${v} ${b.changed}/${b.n}`).join('，') + '）');
  console.log(`  门槛拦下：边距不足 ${stats.gates.belowMargin}、峰不足 ${stats.gates.noPeak}、`
    + `无证据 ${stats.gates.weakEvidence}、证据支持原值 ${stats.gates.keptOriginal}`);
  console.log(`  降级 ${stats.degradations} 项 ${JSON.stringify(stats.degradationsByReason)}`);
  const moves = Object.entries(stats.pcsMoved).sort((a, b) => b[1] - a[1]);
  if (moves.length) console.log(`  音级迁移（前 12）：${moves.slice(0, 12).map(([k, v]) => `${k} ${v}`).join('｜')}`);
  console.log(`  八度不变式：检查 ${stats.octavePreserved.checked}，违例 ${stats.octavePreserved.violations}`);
  console.log(`  → ${outPath}`);
  if (reportPath) console.log(`  → ${reportPath}`);
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
