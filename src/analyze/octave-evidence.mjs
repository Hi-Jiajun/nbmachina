// T2 · 八度证据（音频逐音标定）
//
// 背景：输入转谱的**音级**大体可信（DISCUSSION-C 实测：转谱 chroma 与音频 chroma 的最佳对齐
// 就在 0 移调），但**八度**大面积不可信 —— 输入里相邻两音相差整数八度的错误对
// 旋律 113 / 贝斯 157，贝斯还有 596 颗音写在 midi ≤ 29（比音符盒最低的贝斯音还低）。
// 这一步只做一件事：**音级固定、8 个候选八度**，逐音用窄带能量判断它到底在哪个八度。
//
// 口径（写死在配置里，报告同步抄一份）：
//   候选：midi =（输入 midi 的音级）+ 12k + 12，k=0..7 → C0..B7 共 8 个八度
//   时间窗：从音符起始时刻起 100ms，Hann 窗（44.1kHz → 4410 采样点）
//   参考音高：A4 = 440Hz（midi 69）
//   窄带能量：Goertzel 在目标频率上的能量（= 该频点加窗 DFT 的功率）
//   打分：Σ_h w_h · E(f0·h)
//     · 旋律（中高频）：先做**谱白化**（除以全曲 LTAS 中位数，下限为 5% 均值），再取 1..4 次
//       谐波的梳状和（w = 1, 1/2, 1/3, 1/4）。白化是必须的：本曲低频能量极大，不白化时旋律的
//       "低八度候选"会捡到贝斯/底鼓的能量（第三方基准 79.5% → 93.5%）。
//     · 贝斯（低频）：直接用基频的**绝对**窄带能量（h=1）。贝斯基频区本来就被自己占满，白化
//       会把背景也算成本音（第三方基准 39.5% → 91.4%），所以低频不白化。
//   音域先验：候选八度再按"音频实测音域"过滤，取域内得分最高者
//     · 贝斯 A0..D#4（midi 21..63）、旋律 B2..F#7（midi 47..102）
//       （取值来自第三方谱峰基准实测到的基频分布，见 `--benchmark`）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/* ------------------------------------------------------------------ 配置 */

/** MC 乐器 → SPEC 声部（只登记用得到的；未登记一律当旋律处理） */
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
  bass: 'bass',
  didgeridoo: 'bass',
};

export const DEFAULT_CONFIG = {
  a4: 440,
  windowSec: 0.1,               // 100ms 分析窗（网格 120ms/步，窗不跨到下一颗音头）
  candidateLowMidi: 12,         // 候选最低八度 = C0
  candidateCount: 8,            // C0..B7
  harmonicFloorFraction: 0.05,  // 白化下限 = 5% ×（各候选谐波频率的 LTAS 均值）
  minRms: 0.01,                 // 窗内 RMS 低于此值 → 证据不足（T3 保留原值并记降级）
  ltas: { frameSize: 4096, hop: 2048, maxFrames: 700, percentile: 0.5 },
  voices: {
    melody: { whiten: true, harmonicWeights: [1, 0.5, 1 / 3, 0.25], minMidi: 47, maxMidi: 102 },
    bass: { whiten: false, harmonicWeights: [1], minMidi: 21, maxMidi: 63 },
  },
};

/** 乐器名 → 声部名（melody / bass） */
export function voiceOfInstrument(instrument) {
  return INSTRUMENT_VOICE[String(instrument ?? '').trim()] ?? 'melody';
}

/** 某个 midi 的 8 个候选八度（音级固定，从 C0 起） */
export function octaveCandidates(midi, { lowMidi = 12, count = 8 } = {}) {
  const pc = ((midi % 12) + 12) % 12;
  return Array.from({ length: count }, (_, k) => pc + 12 * k + lowMidi);
}

/** midi → 频率（A4 = a4） */
export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/* ------------------------------------------------------------- WAV 读写 */

/** 读 WAV（PCM 8/16/24/32bit，多声道混成单声道）；source 可以是路径或 Buffer */
export function readWav(source) {
  const buf = Buffer.isBuffer(source) ? source : fs.readFileSync(source);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(`不是 RIFF/WAVE 文件: ${buf.subarray(0, 12).toString('hex')}`);
  }
  let pos = 12;
  let fmt = null;
  let data = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') {
      data = buf.subarray(pos + 8, pos + 8 + size);
    }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('缺少 fmt 或 data 块');
  if (fmt.format !== 1) throw new Error(`只支持未压缩 PCM（format=${fmt.format}）`);
  const bytes = fmt.bits / 8;
  const frames = Math.floor(data.length / (bytes * fmt.channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < fmt.channels; c++) {
      const idx = (i * fmt.channels + c) * bytes;
      if (fmt.bits === 16) sum += data.readInt16LE(idx) / 32768;
      else if (fmt.bits === 32) sum += data.readInt32LE(idx) / 2147483648;
      else if (fmt.bits === 8) sum += (data[idx] - 128) / 128;
      else throw new Error(`不支持的位深: ${fmt.bits}`);
    }
    out[i] = sum / fmt.channels;
  }
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, samples: out };
}

/** 写 16bit PCM WAV（测试夹具用） */
export function encodeWav({ samples, sampleRate, channels = 1 }) {
  const frames = Math.floor(samples.length / channels);
  const dataLen = frames * channels * 2;
  const buf = Buffer.alloc(44 + dataLen);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + dataLen, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(channels, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * channels * 2, 28);
  buf.writeUInt16LE(channels * 2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(dataLen, 40);
  for (let i = 0; i < frames * channels; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  return buf;
}

/* ------------------------------------------------------------------ 数学 */

/** 原地迭代 FFT（长度必须是 2 的幂） */
export function fftInPlace(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i]; re[i] = re[j]; re[j] = tr;
      const ti = im[i]; im[i] = im[j]; im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang);
    const wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1;
      let wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const xr = re[i + k + len / 2];
        const xi = im[i + k + len / 2];
        const vr = xr * wr - xi * wi;
        const vi = xr * wi + xi * wr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0;
        wr = nwr;
      }
    }
  }
}

/** Hann 窗 */
export function hannWindow(n) {
  const w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
  return w;
}

/**
 * Goertzel：单频点窄带能量（= 该频点加窗 DFT 的功率 |X(f)|²）。
 * 二级递归实现，一次遍历 O(N) 乘加。
 */
export function goertzelEnergy(segment, window, freq, sampleRate) {
  const coeff = 2 * Math.cos(2 * Math.PI * freq / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < segment.length; i++) {
    const s0 = coeff * s1 - s2 + segment[i] * window[i];
    s2 = s1;
    s1 = s0;
  }
  const e = s1 * s1 + s2 * s2 - coeff * s1 * s2;
  return e > 0 ? e : 0;
}

/**
 * 全曲长期平均谱（LTAS）：逐频点取时间维的百分位（默认中位数），作为"背景"。
 * 某个音在候选频率上的能量要跟它比，才算"这里真有个音"。
 */
export function buildLtas(samples, sampleRate, cfg = DEFAULT_CONFIG.ltas) {
  const { frameSize, hop, maxFrames, percentile } = cfg;
  const win = hannWindow(frameSize);
  const starts = [];
  for (let s = 0; s + frameSize <= samples.length; s += hop) starts.push(s);
  const step = Math.max(1, Math.floor(starts.length / maxFrames));
  const used = starts.filter((_, i) => i % step === 0);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  const nBins = frameSize / 2;
  const cols = [];
  for (const s of used) {
    for (let i = 0; i < frameSize; i++) {
      re[i] = samples[s + i] * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const p = new Float64Array(nBins);
    for (let k = 0; k < nBins; k++) p[k] = re[k] * re[k] + im[k] * im[k];
    cols.push(p);
  }
  const bins = new Float64Array(nBins);
  const tmp = new Float64Array(cols.length);
  for (let k = 0; k < nBins; k++) {
    for (let c = 0; c < cols.length; c++) tmp[c] = cols[c][k];
    const sorted = tmp.slice().sort();
    bins[k] = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
  }
  return { binHz: sampleRate / frameSize, bins, frames: cols.length, frameSize, hop, percentile };
}

/** LTAS 在任意频率上的线性插值 */
export function ltasAt(ltas, freq) {
  const x = freq / ltas.binHz;
  const k = Math.min(ltas.bins.length - 2, Math.max(0, Math.floor(x)));
  const t = x - k;
  const v = ltas.bins[k] * (1 - t) + ltas.bins[k + 1] * t;
  return v > 1e-20 ? v : 1e-20;
}

/** 白化下限：全部候选谐波频率上的 LTAS 均值 × harmonicFloorFraction */
export function whiteningFloor(ltas, config = DEFAULT_CONFIG) {
  const harmonics = config.voices.melody.harmonicWeights.length;
  let sum = 0;
  let n = 0;
  for (let pc = 0; pc < 12; pc++) {
    for (let k = 0; k < config.candidateCount; k++) {
      const f0 = midiToFreq(pc + 12 * k + config.candidateLowMidi, config.a4);
      for (let h = 1; h <= harmonics; h++) {
        const f = f0 * h;
        if (f > ltas.binHz * (ltas.bins.length - 1)) break;
        sum += ltasAt(ltas, f);
        n++;
      }
    }
  }
  return n ? config.harmonicFloorFraction * (sum / n) : 1e-12;
}

/* -------------------------------------------------------------- 单音证据 */

/** 取一段音频（不足补零、越界补零） */
export function sliceWindow(samples, startSample, length) {
  const seg = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const idx = startSample + i;
    seg[i] = idx >= 0 && idx < samples.length ? samples[idx] : 0;
  }
  return seg;
}

const rmsOf = (seg) => {
  let sum = 0;
  for (let i = 0; i < seg.length; i++) sum += seg[i] * seg[i];
  return Math.sqrt(sum / seg.length);
};

/** 合并用户配置与默认配置 */
function mergeConfig(config = {}) {
  // voices 要**逐个声部深合并**：只覆盖调用方显式给的字段，
  // 否则 `{ voices: { melody: { minMidi: 0 } } }` 会把 harmonicWeights 冲掉。
  const voices = { ...DEFAULT_CONFIG.voices };
  for (const [name, patch] of Object.entries(config.voices ?? {})) {
    voices[name] = { ...(DEFAULT_CONFIG.voices[name] ?? {}), ...patch };
  }
  return {
    ...DEFAULT_CONFIG,
    ...config,
    ltas: { ...DEFAULT_CONFIG.ltas, ...(config.ltas ?? {}) },
    voices,
  };
}

/**
 * 单音八度证据。
 * bestOctave：音域先验内的最高分候选（这就是 T3 用的值）
 * bestOctaveAny：8 个候选里的最高分（不设音域先验，用于诊断）
 */
export function noteEvidence({ samples, sampleRate, timeSec, midi, instrument, voice, config = {}, ltas, floor }) {
  const cfg = mergeConfig(config);
  const voiceName = voice ?? voiceOfInstrument(instrument);
  const profile = cfg.voices[voiceName] ?? cfg.voices.melody;
  const winN = Math.max(16, Math.round(sampleRate * cfg.windowSec));
  const win = hannWindow(winN);
  const seg = sliceWindow(samples, Math.round(timeSec * sampleRate), winN);
  const rms = rmsOf(seg);

  const candidates = octaveCandidates(midi, { lowMidi: cfg.candidateLowMidi, count: cfg.candidateCount });
  const scores = candidates.map((m) => {
    const f0 = midiToFreq(m, cfg.a4);
    let sum = 0;
    for (let h = 0; h < profile.harmonicWeights.length; h++) {
      const f = f0 * (h + 1);
      if (f > sampleRate * 0.45) break;
      const e = goertzelEnergy(seg, win, f, sampleRate);
      const g = profile.whiten ? e / Math.max(floor ?? 0, ltasAt(ltas, f)) : e;
      sum += profile.harmonicWeights[h] * g;
    }
    return sum;
  });

  const order = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const inReg = candidates.map((m, i) => (m >= profile.minMidi && m <= profile.maxMidi ? i : -1)).filter((i) => i >= 0);
  const bestAny = order[0];
  const bestInReg = (inReg.length ? inReg.slice().sort((a, b) => scores[b] - scores[a])[0] : order[0]);
  const runnerUp = order.find((i) => i !== bestInReg) ?? order[0];

  return {
    voice: voiceName,
    candidates,
    scores,
    bestOctave: candidates[bestInReg],
    bestOctaveAny: candidates[bestAny],
    bestScore: scores[bestInReg],
    secondOctave: candidates[runnerUp],
    secondScore: scores[runnerUp] ?? 0,
    margin: scores[bestInReg] / Math.max(scores[runnerUp] ?? 0, 1e-30),
    rms,
    weak: rms < cfg.minRms,
    registerClamped: bestInReg !== bestAny,
  };
}

/** 批量：一段音频 + 一批音符 → 全部证据（LTAS 只算一次） */
export function analyzeNotes({ samples, sampleRate, notes, config = {} }) {
  const cfg = mergeConfig(config);
  const ltas = buildLtas(samples, sampleRate, cfg.ltas);
  const floor = whiteningFloor(ltas, cfg);
  const rows = notes.map((n) => {
    const ev = noteEvidence({
      samples,
      sampleRate,
      timeSec: n.timeSec,
      midi: n.midi,
      instrument: n.instrument,
      voice: n.voice,
      config: cfg,
      ltas,
      floor,
    });
    const round = (x) => Number(x.toPrecision(6));
    return {
      noteId: n.noteId,
      step: n.step,
      timeSec: n.timeSec,
      instrument: n.instrument,
      voice: ev.voice,
      midi: n.midi,
      candidates: ev.candidates,
      scores: ev.scores.map(round),
      bestOctave: ev.bestOctave,
      bestOctaveAny: ev.bestOctaveAny,
      bestScore: round(ev.bestScore),
      secondOctave: ev.secondOctave,
      secondScore: round(ev.secondScore),
      margin: Number(ev.margin.toPrecision(4)),
      rms: Number(ev.rms.toPrecision(4)),
      weak: ev.weak,
      registerClamped: ev.registerClamped,
    };
  });
  return {
    meta: {
      sampleRate,
      windowSec: cfg.windowSec,
      windowType: 'hann',
      a4: cfg.a4,
      candidateLowMidi: cfg.candidateLowMidi,
      candidateCount: cfg.candidateCount,
      harmonicFloorFraction: cfg.harmonicFloorFraction,
      minRms: cfg.minRms,
      voices: cfg.voices,
      ltas: {
        frameSize: ltas.frameSize,
        hop: ltas.hop,
        frames: ltas.frames,
        percentile: ltas.percentile,
        floor: Number(floor.toPrecision(6)),
      },
    },
    notes: rows,
  };
}

/* ------------------------------------------------------------------ CSV */

/** 解析转谱 CSV（表头任意列序）：返回 {header, rows}，行内保留原始字段 */
export function readNotesCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const tIdx = idx.time_seconds ?? idx.time;
  const rows = lines.slice(1).map((line, i) => {
    const c = line.split(',');
    return {
      noteId: i,
      step: Number(c[idx.step]),
      timeSec: Number(c[tIdx]),
      instrument: c[idx.instrument],
      midi: Number(c[idx.midi]),
      fields: c,
    };
  });
  return { header, rows };
}

/* ------------------------------------------------------- 第三方谱峰基准 */

/**
 * 第三方证据（只用于**交叉验证**，不参与修复决策）：
 * 186ms 窗（8192 点 Hann，零填充到 16384）里找该声部音域内最强的谱峰，抛物线插值细化频率。
 * 若该峰落在"本音 8 个候选"之一的 ±60 音分内，就作为这个音的独立八度基准
 * （不同音级至少差 100 音分，因此这条判据很干净）。
 */
export function peakGroundTruth({ samples, sampleRate, timeSec, midi, voice, config = {} }) {
  const cfg = mergeConfig(config);
  const N = 8192;
  const PAD = 16384;
  const win = hannWindow(N);
  const start = Math.round(timeSec * sampleRate);
  const re = new Float64Array(PAD);
  const im = new Float64Array(PAD);
  for (let i = 0; i < N; i++) {
    const idx = start + i;
    re[i] = idx >= 0 && idx < samples.length ? samples[idx] * win[i] : 0;
  }
  fftInPlace(re, im);
  const band = voice === 'bass' ? [30, 400] : [120, 3000];
  const binHz = sampleRate / PAD;
  const kLo = Math.max(1, Math.ceil(band[0] / binHz));
  const kHi = Math.min(PAD / 2 - 2, Math.floor(band[1] / binHz));
  let bk = kLo;
  let bm = -1;
  for (let k = kLo; k <= kHi; k++) {
    const m = Math.hypot(re[k], im[k]);
    if (m > bm) {
      bm = m;
      bk = k;
    }
  }
  const l1 = Math.log(Math.hypot(re[bk - 1], im[bk - 1]) + 1e-30);
  const l0 = Math.log(bm + 1e-30);
  const l2 = Math.log(Math.hypot(re[bk + 1], im[bk + 1]) + 1e-30);
  const den = l1 - 2 * l0 + l2;
  const freq = (bk + (den === 0 ? 0 : 0.5 * (l1 - l2) / den)) * binHz;
  for (const m of octaveCandidates(midi, cfg)) {
    const cents = 1200 * Math.log2(freq / midiToFreq(m, cfg.a4));
    if (Math.abs(cents) < 60) return { octave: m, freq, cents };
  }
  return { octave: null, freq, cents: null };
}

/* ------------------------------------------------------------ 统计与 CLI */

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const midiName = (m) => `${NOTE_NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

/** 与输入八度的一致率（严格 / ±1 八度容差） */
export function agreementStats(evidence) {
  const out = {};
  for (const n of evidence.notes) {
    out[n.voice] ??= { n: 0, exact: 0, within1: 0, weak: 0, clamped: 0 };
    const s = out[n.voice];
    s.n++;
    if (n.bestOctave === n.midi) s.exact++;
    if (Math.abs(n.bestOctave - n.midi) <= 12) s.within1++;
    if (n.weak) s.weak++;
    if (n.registerClamped) s.clamped++;
  }
  return out;
}

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
  const wavPath = args.wav ?? `${BUILD}/styx_helix_full.wav`;
  const notesPath = args.notes ?? `${BUILD}/styx_helix_notes.csv`;
  const outPath = args.out ?? `${BUILD}/analysis_octave.json`;
  const limit = args.limit ? Number(args.limit) : 0;

  const { sampleRate, samples, channels, bits } = readWav(wavPath);
  const { rows } = readNotesCsv(fs.readFileSync(notesPath, 'utf8'));
  const notes = (limit ? rows.slice(0, limit) : rows).map((r) => ({
    ...r,
    voice: voiceOfInstrument(r.instrument),
  }));

  if (args.benchmark) {
    // 第三方独立基准：只统计"该声部音域内最强谱峰落在本音某个候选八度 ±60 音分内"的音。
    // 用它交叉验证口径/修复结果，而不是替代证据本身。
    const gt = notes.map((row) => peakGroundTruth({
      samples, sampleRate, timeSec: row.timeSec, midi: row.midi, voice: row.voice,
    }));
    const coveredIdx = gt.map((g, i) => (g.octave == null ? -1 : i)).filter((i) => i >= 0);

    const variants = {
      '最终口径（旋律白化梳状 h4 / 贝斯基频 h1 + 音域先验）': {},
      '对照：全部不白化（h1）': { voices: { melody: { whiten: false, harmonicWeights: [1] } } },
      '对照：全部白化梳状 h4': { voices: { bass: { whiten: true, harmonicWeights: [1, 0.5, 1 / 3, 0.25] } } },
      '对照：最终口径但去掉音域先验': { voices: { melody: { minMidi: 0, maxMidi: 127 }, bass: { minMidi: 0, maxMidi: 127 } } },
    };
    console.log(`第三方谱峰基准（独立判据，覆盖 ${coveredIdx.length}/${notes.length} 颗音 = ${(100 * coveredIdx.length / notes.length).toFixed(1)}%）`);
    const perVoice = { melody: [], bass: [] };
    for (const i of coveredIdx) perVoice[notes[i].voice].push(i);
    const pct = (k, n) => `${(100 * k / n).toFixed(1)}%（${k}/${n}）`;

    for (const [label, cfg] of Object.entries(variants)) {
      const ev = analyzeNotes({ samples, sampleRate, notes, config: cfg });
      console.log(`\n[${label}]`);
      for (const v of ['melody', 'bass']) {
        const idx = perVoice[v];
        if (!idx.length) continue;
        const inHit = idx.filter((i) => notes[i].midi === gt[i].octave).length;
        const hit = idx.filter((i) => ev.notes[i].bestOctave === gt[i].octave).length;
        console.log(`  ${v}: n=${idx.length}  输入原值 ${pct(inHit, idx.length)}  证据 bestOctave ${pct(hit, idx.length)}`
          + `  ±1 八度内 ${pct(idx.filter((i) => Math.abs(ev.notes[i].bestOctave - gt[i].octave) <= 12).length, idx.length)}`);
      }
    }

    if (typeof args.fixed === 'string') {
      const { rows: frows } = readNotesCsv(fs.readFileSync(args.fixed, 'utf8'));
      const newIdx = frows.length ? frows[0].fields.length - 3 : -1;   // 原列 + newMidi + octaveEvidence + fixReason
      console.log('\n[修复结果（--fixed）]');
      for (const v of ['melody', 'bass']) {
        const idx = perVoice[v];
        if (!idx.length) continue;
        const hit = idx.filter((i) => Number(frows[i].fields[newIdx]) === gt[i].octave).length;
        console.log(`  ${v}: n=${idx.length}  修复后正确率 ${pct(hit, idx.length)}`
          + `  ±1 八度内 ${pct(idx.filter((i) => Math.abs(Number(frows[i].fields[newIdx]) - gt[i].octave) <= 12).length, idx.length)}`);
      }
    }
  } else {
    const t0 = Date.now();
    const ev = analyzeNotes({ samples, sampleRate, notes, config: {} });
    fs.writeFileSync(outPath, JSON.stringify(ev, null, 1) + '\n', 'utf8');
    const st = agreementStats(ev);
    console.log(`八度证据：${notes.length} 颗音（${Object.entries(st).map(([v, s]) => `${v} ${s.n}`).join(' / ')}）`);
    console.log(`  输入 ${wavPath}（${(samples.length / sampleRate).toFixed(1)}s，${sampleRate}Hz，${channels}ch ${bits}bit）`);
    console.log(`  口径：窗 ${ev.meta.windowSec * 1000}ms Hann，A4=${ev.meta.a4}Hz，候选 ${midiName(ev.meta.candidateLowMidi)}`
      + `..${midiName(ev.meta.candidateLowMidi + 12 * ev.meta.candidateCount - 1)} 共 ${ev.meta.candidateCount} 个八度`);
    console.log(`  LTAS：${ev.meta.ltas.frameSize} 帧长 / ${ev.meta.ltas.hop} 跳 / ${ev.meta.ltas.frames} 帧 /`
      + ` p${ev.meta.ltas.percentile * 100}，白化下限 ${ev.meta.ltas.floor}`);
    for (const [v, s] of Object.entries(st)) {
      console.log(`  ${v}: 与输入八度一致 ${(100 * s.exact / s.n).toFixed(1)}%（±1 八度内 ${(100 * s.within1 / s.n).toFixed(1)}%）`
        + `，音域先验回拉 ${s.clamped}，弱证据 ${s.weak}`);
    }
    console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s → ${outPath}`);
  }
}
