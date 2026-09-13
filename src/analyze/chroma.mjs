// T5a · chroma（12 音级能量分布）
//
// 为什么需要它：音乐组实测（DISCUSSION-C §1）指出，转谱把音高**吸附到了单一音阶**
// （C# 自然小调：只有 C#/D#/E/F#/G#/A/B 七个音级，另外五个只占 1%–6%），
// 而同一段音频里那五个音级的相对能量是 0.44–0.90。要量化"抹掉了多少"、
// 要能回答"修补音级的改动到底有没有变好"，就需要音频侧与谱面侧两套可比的 12 音级分布。
//
// 口径（写进 M0-3 报告）：
//   · 分帧：默认 8192 点 Hann 窗 / 4096 点 hop（44.1kHz 下 185.8ms 窗、92.9ms 步进）。
//     窗长取 8192 而不是常见的 4096，是为了让低频（贝斯 E2 = 82.4Hz）折叠到最近半音时
//     不至于偏出半音：8192 点 → 5.38Hz/bin，4096 点 → 10.8Hz/bin。
//   · 折叠：对 [fminHz, fmaxHz] 内的每个频点，按连续 midi 就近取整得到音级，
//     把该频点功率累加进去（"折叠式 chromagram"，与 librosa 的 chroma_stft 同口径）。
//   · 归一化：逐帧 l1 归一（只留"音级比例"）；meanRaw 保留原能量累加，
//     需要比例时再调 normalizeChroma。
//   · 谱面侧：notesChroma 把每颗音按音级投票（count = 直方图 / velocity = 力度加权）。
//
// 已知边界：折叠式 chroma 会把泛音也算进目标音级（C 的 2 次谐波仍在 C、3 次在 G）。
// 单测用"含 4 次谐波的拨弦音"验证基频音级仍是最大峰；真实数据上它衡量的是
// "这段音频里 12 个音级各有多少能量"，这正是判定音级吸附所需的量。
import {
  fftInPlace,
  freqToMidi,
  hannWindow,
  pcOf,
} from './dsp.mjs';

export {
  readWav,
  encodeWav,
  midiToFreq,
  freqToMidi,
  goertzelEnergy,
  readNotesCsv,
  csvText,
  pcOf,
  midiName,
  narrowbandEnergy,
  sliceWindow,
  rmsOf,
  NOTE_NAMES,
} from './dsp.mjs';

export const DEFAULT_CHROMA_CONFIG = {
  frameSize: 8192,    // 185.8ms @44.1kHz
  hop: 4096,          // 92.9ms @44.1kHz
  a4: 440,
  fminHz: 55,         // A1：更低的频率（电源嗡嗡、隆隆声）不进 chroma
  fmaxHz: 4186,       // C8：更高的多是齿音/镲片泛音
  weighting: 'power', // power | magnitude
  frameNorm: 'l1',
  maxFrames: 0,       // >0 时按间隔抽样，只取 maxFrames 帧（大文件加速开关）
};

/** 合并用户配置与默认值 */
export function chromaConfig(config = {}) {
  return { ...DEFAULT_CHROMA_CONFIG, ...config };
}

// ------------------------------------------------------------- 频谱 → 音级

/**
 * 把一帧频谱折叠成 12 音级能量（未归一化，0 = C）。
 */
export function foldSpectrumToChroma(re, im, {
  sampleRate,
  frameSize,
  fminHz = DEFAULT_CHROMA_CONFIG.fminHz,
  fmaxHz = DEFAULT_CHROMA_CONFIG.fmaxHz,
  a4 = DEFAULT_CHROMA_CONFIG.a4,
  weighting = DEFAULT_CHROMA_CONFIG.weighting,
} = {}) {
  const binHz = sampleRate / frameSize;
  const out = new Float64Array(12);
  const kLo = Math.max(1, Math.ceil(fminHz / binHz));
  const kHi = Math.min(frameSize / 2 - 1, Math.floor(fmaxHz / binHz));
  for (let k = kLo; k <= kHi; k++) {
    const f = k * binHz;
    const pc = pcOf(Math.round(freqToMidi(f, a4)));
    const p = re[k] * re[k] + im[k] * im[k];
    out[pc] += weighting === 'magnitude' ? Math.sqrt(p) : p;
  }
  return out;
}

/** 某一时刻一帧的 chroma（从 startSample 起 frameSize 点，已按 config.frameNorm 归一） */
export function chromaFrameAt({ samples, sampleRate, startSample = 0, config = {} }) {
  const cfg = chromaConfig(config);
  const win = hannWindow(cfg.frameSize);
  const re = new Float64Array(cfg.frameSize);
  const im = new Float64Array(cfg.frameSize);
  for (let i = 0; i < cfg.frameSize; i++) {
    const idx = startSample + i;
    re[i] = (idx >= 0 && idx < samples.length ? samples[idx] : 0) * win[i];
  }
  fftInPlace(re, im);
  return normalizeChroma(
    foldSpectrumToChroma(re, im, {
      sampleRate,
      frameSize: cfg.frameSize,
      fminHz: cfg.fminHz,
      fmaxHz: cfg.fmaxHz,
      a4: cfg.a4,
      weighting: cfg.weighting,
    }),
    { norm: cfg.frameNorm },
  );
}

// ------------------------------------------------------------------- 分帧

/**
 * 整段音频的 chromagram。
 * frames[].chroma 已归一；meanRaw 是**原能量**逐帧累加（除以帧数即平均 chroma 的原能量）。
 */
export function chromagram({ samples, sampleRate, config = {}, maxFrames } = {}) {
  const cfg = chromaConfig(config);
  const limit = maxFrames ?? cfg.maxFrames;
  const win = hannWindow(cfg.frameSize);
  const re = new Float64Array(cfg.frameSize);
  const im = new Float64Array(cfg.frameSize);
  const meanRaw = new Float64Array(12);
  const frames = [];

  const totalFrames = samples.length > cfg.frameSize
    ? Math.floor((samples.length - cfg.frameSize) / cfg.hop) + 1
    : 0;
  const step = limit > 0 && totalFrames > limit ? Math.max(1, Math.floor(totalFrames / limit)) : 1;

  for (let fi = 0; fi < totalFrames; fi += step) {
    const startSample = fi * cfg.hop;
    for (let i = 0; i < cfg.frameSize; i++) {
      const idx = startSample + i;
      re[i] = (idx < samples.length ? samples[idx] : 0) * win[i];
      im[i] = 0;
    }
    fftInPlace(re, im);
    const raw = foldSpectrumToChroma(re, im, {
      sampleRate,
      frameSize: cfg.frameSize,
      fminHz: cfg.fminHz,
      fmaxHz: cfg.fmaxHz,
      a4: cfg.a4,
      weighting: cfg.weighting,
    });
    for (let i = 0; i < 12; i++) meanRaw[i] += raw[i];
    frames.push({
      startSample,
      timeSec: startSample / sampleRate,
      chroma: normalizeChroma(raw, { norm: cfg.frameNorm }),
    });
  }

  return {
    frames,
    meanRaw,
    meta: {
      method: 'fft-fold-to-nearest-semitone',
      sampleRate,
      frameSize: cfg.frameSize,
      hop: cfg.hop,
      frameSec: cfg.frameSize / sampleRate,
      hopSec: cfg.hop / sampleRate,
      fminHz: cfg.fminHz,
      fmaxHz: cfg.fmaxHz,
      a4: cfg.a4,
      weighting: cfg.weighting,
      frameNorm: cfg.frameNorm,
      frames: frames.length,
      sampled: step > 1,
      frameStep: step,
    },
  };
}

// -------------------------------------------------------------- 归一化/比较

/** 归一化：l1（和为 1）/ l2（模为 1）/ max（最大值为 1）；全零向量原样返回 */
export function normalizeChroma(v, { norm = 'l1' } = {}) {
  const out = Float64Array.from(v);
  if (norm === 'max') {
    let m = 0;
    for (const x of out) m = Math.max(m, x);
    if (m <= 0) return out;
    for (let i = 0; i < out.length; i++) out[i] /= m;
    return out;
  }
  let s = 0;
  for (const x of out) s += norm === 'l2' ? x * x : x;
  if (s <= 0) return out;
  const k = norm === 'l2' ? 1 / Math.sqrt(s) : 1 / s;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}

/** 两个非负 12 维向量的余弦相似度（0..1；任一为零向量时返回 0） */
export function chromaCos(a, b) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < 12; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na <= 0 || nb <= 0) return 0;
  return dot / Math.sqrt(na * nb);
}

/** 把 b 整体升高 s 个半音（音级 p 的内容移到 p+s） */
export function rotateChroma(b, s) {
  const k = ((s % 12) + 12) % 12;
  return Float64Array.from({ length: 12 }, (_, i) => b[(i - k + 12) % 12]);
}

// 在 12 个半音的循环移调里找"b 需要升高多少半音才与 a 最像"。
// shift = 0 表示不必移调（谱面与原曲同调）；shift 不为 0 且相似度明显更高时，
// 差异主因是**整体移调**，而不是"音级被吸附到某个音阶"——两者要用这个数分开。
export function chromaBestShift(a, b) {
  let best = { shift: 0, cos: chromaCos(a, b) };
  for (let s = 1; s < 12; s++) {
    const cos = chromaCos(a, rotateChroma(b, s));
    if (cos > best.cos + 1e-12) best = { shift: s, cos };
  }
  return best;
}

// ------------------------------------------------------------ 谱面侧 chroma

// 谱面（音符表）→ 12 音级直方图（未归一化）。
// weighting='count'    每颗音投 1 票（口径干净、可复现）
// weighting='velocity' 每颗音投其 velocity 票（velocity 缺失时按 1 票）
export function notesChroma(notes, { weighting = 'count', velocityField = 'velocity' } = {}) {
  const out = new Float64Array(12);
  for (const n of notes) {
    const w = weighting === 'count' ? 1 : (Number.isFinite(n[velocityField]) ? n[velocityField] : 1);
    out[pcOf(n.midi)] += w;
  }
  return out;
}

// --------------------------------------------------------------------- CLI

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('src/analyze/chroma.mjs');

if (invokedDirectly) {
  const fs = await import('node:fs');
  const { readWav, readNotesCsv, midiName } = await import('./dsp.mjs');
  const { resolvePaths } = await import('../core/paths.mjs');
  const P = resolvePaths();
  const argv = process.argv.slice(2);
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const next = argv[i + 1];
    args[argv[i].replace(/^--/, '')] = next === undefined || next.startsWith('--') ? true : next;
  }
  const wavPath = args.wav ?? P.audio;
  const notesPath = args.notes ?? P.notesV3;
  const outPath = typeof args.out === 'string' ? args.out : null;

  const t0 = Date.now();
  const { samples, sampleRate, seconds } = readWav(wavPath);
  const g = chromagram({ samples, sampleRate });
  const audio = normalizeChroma(g.meanRaw, { norm: 'l1' });
  const { notes } = readNotesCsv(fs.readFileSync(notesPath, 'utf8'));
  const chart = normalizeChroma(notesChroma(notes, { weighting: 'count' }), { norm: 'l1' });
  const best = chromaBestShift(audio, chart);
  const maxA = Math.max(...audio);
  const maxC = Math.max(...chart);
  const fmt = (v, m) => [...v].map((x, pc) => `${midiName(pc + 60)}:${(x / m).toFixed(2)}`).join(' ');
  const audioRel = [...audio].map((v) => v / maxA);
  const chartRel = [...chart].map((v) => v / maxC);

  console.log(`chroma：${wavPath}（${seconds.toFixed(1)}s，${sampleRate}Hz）`);
  console.log(`  口径：${g.meta.frameSize} 点 ${g.meta.frameSec.toFixed(3)}s 窗 / ${g.meta.hop} 点 hop /`
    + ` ${g.meta.fminHz}-${g.meta.fmaxHz}Hz / ${g.meta.weighting} 折叠 / 帧内 ${g.meta.frameNorm} 归一`
    + `（${g.meta.frames} 帧${g.meta.sampled ? `，1/${g.meta.frameStep} 抽样` : ''}）`);
  console.log(`  音频音级占比（各值 ÷ 最大音级）：${fmt(audio, maxA)}`);
  console.log(`  谱面音级占比（count 权重）：      ${fmt(chart, maxC)}`);
  console.log(`  余弦相似度（shift 0）：${best.cos.toFixed(4)}`);
  console.log(`  最佳移调：+${best.shift} 半音 → 余弦 ${best.cos.toFixed(4)}`);
  // 音级吸附的直接判据：音频里明显存在（>10% 最大音级）、谱面却压到不足其一半的音级
  const suppressed = [...audio.keys()].filter((pc) => audioRel[pc] > 0.1 && chartRel[pc] < 0.5 * audioRel[pc]);
  const mass = suppressed.reduce((a, pc) => a + chart[pc], 0);
  console.log(`  被压制音级（谱面占比 < 音频的一半）${suppressed.length} 个：`
    + `${suppressed.map((pc) => `${midiName(pc + 60)} 音频${audioRel[pc].toFixed(2)}/谱面${chartRel[pc].toFixed(2)}`).join('，') || '无'}`
    + `（合计占谱面质量 ${(100 * mass).toFixed(1)}%）`);
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({
      meta: { wavPath, notesPath, ...g.meta },
      audioChroma: [...audio],
      chartChroma: [...chart],
      cosine: best.cos,
      bestShift: best,
    }, null, 1) + '\n', 'utf8');
    console.log(`  → ${outPath}`);
  }
  console.log(`  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
