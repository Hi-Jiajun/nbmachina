// 共用底层原语：WAV 读写 + 窄带能量（Goertzel）+ FFT + 音符表 CSV I/O
//
// 为什么要有这个文件：M0 里 chroma（T5a）、力度（T5b）、评分（T6）三个模块都要
// "读 WAV + 在某个频点/某个音上量能量 + 读谱面 CSV"。把这三件事放一份实现里，
// 才能保证三处口径一致（同一段音频、同一个 A4、同一个窗、同一套对数刻度），
// 也避免 T2（八度证据）与 T5/T6 两份实现各自漂移。
//
// 口径（写进 M0-3 报告）：
//   · WAV：只支持未压缩 PCM（8/16/32bit），多声道按均值合成单声道浮点 [-1,1]
//   · 频率：A4 = 440Hz（midi 69），f = a4 · 2^((m−69)/12)
//   · 窄带能量：Goertzel 在目标频点上的加窗 DFT 功率 |X(f)|²（Hann 窗）
//   · 谱面 CSV：按表头取列，保留原始字段（`fields`）以便逐列回写
//
// M1 建议：这个文件按职责拆成 `ingest/wav.mjs` + `ingest/notes-csv.mjs` + `analyze/dsp.mjs`。
import fs from 'node:fs';

export const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** 音级（0 = C） */
export const pcOf = (midi) => ((Math.round(midi) % 12) + 12) % 12;

/** midi → 音名（C4 = 60，A4 = 69） */
export const midiName = (m) => `${NOTE_NAMES[pcOf(m)]}${Math.floor(m / 12) - 1}`;

/** midi → 频率（A4 = a4） */
export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/** 频率 → 连续 midi（用于把频点折叠到最近半音） */
export function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

/* ------------------------------------------------------------- WAV 读写 */

/** 读 WAV（PCM 8/16/32bit，多声道混成单声道）；source 可以是路径或 Buffer */
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
  const out = new Float64Array(frames);
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
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bits: fmt.bits,
    frames,
    seconds: frames / fmt.sampleRate,
    samples: out,
  };
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
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
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

/** Hann 窗（带缓存：同一长度在整首歌里会重复用几万次） */
const hannCache = new Map();
export function hannWindow(n) {
  let w = hannCache.get(n);
  if (w) return w;
  w = new Float64Array(n);
  for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
  hannCache.set(n, w);
  return w;
}

/**
 * Goertzel：单频点窄带能量（= 该频点加窗 DFT 的功率 |X(f)|²）。
 * 二次递归实现，一次遍历 O(N) 乘加；与 FFT 的对应 bin 值等价（窗相同）。
 */
export function goertzelEnergy(segment, window, freq, sampleRate) {
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
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

/** 取一段音频（越界补零） */
export function sliceWindow(samples, startSample, length) {
  const seg = new Float64Array(length);
  for (let i = 0; i < length; i++) {
    const idx = startSample + i;
    seg[i] = idx >= 0 && idx < samples.length ? samples[idx] : 0;
  }
  return seg;
}

/** 均方根（窗内整体响度） */
export function rmsOf(seg) {
  let sum = 0;
  for (let i = 0; i < seg.length; i++) sum += seg[i] * seg[i];
  return Math.sqrt(sum / seg.length);
}

/* ------------------------------------------------------------ 窄带能量 */

/**
 * 一颗音在"它自己的音级 + 八度"上的短时窄带能量。
 * 这是 T5b 力度与 T6 力度相关/漏音率的共同描述子：f0 与 2f0..hf0 的加窗 DFT 功率
 * 按 harmonicWeights 加权求和。注意它量的是**那颗音自己的能量**，不是"整段混音多响"。
 *
 * @returns {{energy: number, rms: number, f0: number, harmonicEnergies: number[], windowSamples: number}}
 */
export function narrowbandEnergy({
  samples,
  sampleRate,
  midi,
  timeSec,
  startSample,
  a4 = 440,
  windowSec = 0.1,
  harmonicWeights = [1],
  nyquistFraction = 0.45,
}) {
  const n = Math.max(16, Math.round(sampleRate * windowSec));
  const win = hannWindow(n);
  const start = startSample ?? Math.round(timeSec * sampleRate);
  const seg = sliceWindow(samples, start, n);
  const f0 = midiToFreq(midi, a4);
  const harmonicEnergies = [];
  let energy = 0;
  for (let h = 0; h < harmonicWeights.length; h++) {
    const f = f0 * (h + 1);
    if (f > sampleRate * nyquistFraction) break;
    const e = goertzelEnergy(seg, win, f, sampleRate);
    harmonicEnergies.push(e);
    energy += harmonicWeights[h] * e;
  }
  return { energy, rms: rmsOf(seg), f0, harmonicEnergies, windowSamples: n };
}

/* --------------------------------------------------- 音符表 CSV 读写 */

/**
 * 读谱面 CSV（按表头取列，列顺序无所谓）：
 *   · 必需列：step、instrument、midi、时间列（time_seconds / time / timeSec）之一
 *   · 可选列：tick、row、volume（0..1 监听音量）、velocity（0..127）、newMidi（T3 修复值）
 * 返回 {header, notes}；每颗音保留 `fields`（原始字符串列），便于逐列回写。
 */
export function readNotesCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((s) => s.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));
  const tIdx = idx.time_seconds ?? idx.time ?? idx.timeSec;
  if (tIdx === undefined) throw new Error(`CSV 缺少时间列（time_seconds/time/timeSec）：${header.join(',')}`);
  const numAt = (c, key) => (idx[key] === undefined ? undefined : Number(c[idx[key]]));
  const notes = lines.slice(1).filter((l) => l.trim() !== '').map((line, i) => {
    const c = line.split(',');
    const volume = numAt(c, 'volume');
    const velocity = numAt(c, 'velocity');
    return {
      noteId: i,
      step: numAt(c, 'step'),
      tick: numAt(c, 'tick'),
      timeSec: Number(c[tIdx]),
      instrument: c[idx.instrument],
      midi: numAt(c, 'midi'),
      newMidi: numAt(c, 'newMidi'),
      row: numAt(c, 'row'),
      volume,
      // velocity 缺失时退回"混音 RMS × 127"（v3 CSV 的口径，见 M0-1 报告 §4.5）
      velocity: velocity ?? (volume === undefined ? undefined : Math.round(volume * 127)),
      fields: c,
    };
  });
  return { header, notes };
}

/** 用表头 + 行数组拼 CSV 文本（固定 3 位小数由调用方决定，这里只拼字符串） */
export function csvText(header, rows) {
  return [header.join(','), ...rows.map((r) => r.join(','))].join('\n') + '\n';
}

/** 名字 → 输入文件是否存在（CLI 里用来做可选产物判断） */
export const fileExists = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};
