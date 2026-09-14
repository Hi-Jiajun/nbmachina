// M2-1 · 零依赖音色合成器（纯 Node，无任何第三方采样/音源/依赖）
//
// 三个音色家族（参数在 src/synth/voices.mjs，算法与取舍写进 docs/M2-1-report.md）：
//   · karplusStrong ：Karplus–Strong 拨弦（strings / bass）—— 噪声激励 + 延迟线 + 环路阻尼
//   · fmPad         ：加法（含轻微 FM 味）柔和铺底（pad）
//   · modalBell     ：模态合成钟琴（bell）—— 一组非谐阻尼正弦
//
// 三个"为什么这么写"（都是被验收指标逼出来的）：
//   ① 音准：延迟线必须能取"小数延迟"，否则 44.1kHz 下低音区（midi 19 = 24.5Hz）延迟 1800 采样、
//      高音区（midi 78 = 1046Hz）延迟 42 采样，整数取整误差可达百分之几 → 直接违反"基频误差 ≤1%"。
//      做法：读延迟用线性插值取 L+frac，并把**环路滤波器的相位延迟**从延迟长度里扣掉。
//   ② 环路阻尼用两抽头 FIR h=[1-0.5d, 0.5d]，而不是一极点低通：它在低频的相位延迟恰好是 0.5d 采样，
//      可以精确补偿（一极点低通的相位延迟随频率变化，补偿起来很容易把音准做成 5% 级误差）。
//   ③ 输出一律做 DC 阻断 + 峰值归一化 + 首尾淡入淡出：避免文件边界"咔"声，也保证不被 16bit 削波。
//
// 确定性：噪声激励来自 mulberry32(seed)，同参数两次渲染逐样本相同（可回归）。
export const SAMPLE_RATE = 44100;

/* ---------------------------------------------------------- M3-6 · 扩散混响 */

/**
 * Schroeder 混响（4 并联梳状 + 3 串联全通）：给采样加"空间/空气"。
 *
 * <p>为什么需要它：拿 Animenz 真演奏（build/animenz_styx_helix.wav）做长时平均谱对比，
 * 我们的 strings 在高频 2.5–11 kHz 比真钢琴**少 11–15 dB**、中低 320–640 Hz 少 9 dB ——
 * 听感就是"没有空灵、偏木头"。真钢琴的"空气"一半来自高次分音、一半来自厅堂尾音，
 * 所以音色侧补高次分音（见 pianoVoice），这里补尾音。
 *
 * @returns {Float64Array} 比输入更长的数组（含 rt60 长度的尾巴）
 */
export function schroederReverb(samples, { sampleRate = SAMPLE_RATE, rt60 = 1.3, mix = 0.22, seed = 1 } = {}) {
  const tail = Math.round(rt60 * sampleRate);
  const n = samples.length + tail;
  const combs = [1116, 1188, 1277, 1356].map((d) => Math.round((d * sampleRate) / 44100));
  const allpasses = [556, 441, 341].map((d) => Math.round((d * sampleRate) / 44100));
  const acc = new Float64Array(n);
  for (const d of combs) {
    const buf = new Float64Array(d);
    const g = 10 ** ((-3 * d) / (rt60 * sampleRate));   // 每圈衰减 60dB/rt60
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const x = (i < samples.length ? samples[i] : 0) + g * buf[idx];
      buf[idx] = x;
      idx = (idx + 1) % d;
      acc[i] += x / combs.length;
    }
  }
  let sig = acc;
  for (const d of allpasses) {
    const buf = new Float64Array(d);
    const out = new Float64Array(n);
    let idx = 0;
    for (let i = 0; i < n; i++) {
      const bufout = buf[idx];
      const x = sig[i] + -0.5 * bufout;
      out[i] = bufout + 0.5 * x;
      buf[idx] = x;
      idx = (idx + 1) % d;
    }
    sig = out;
  }
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = (i < samples.length ? samples[i] * (1 - mix) : 0) + sig[i] * mix;
  return out;
}

/* ------------------------------------------------------- M3-6 · 钢琴类音色 */

/**
 * 钢琴类：**非谐加性合成 + 锤击瞬态 + 扩散尾音**（M3-6，按真演奏的频谱标定）。
 *
 * <p>标定依据（1/3 倍频程能量占比，dB，见 build/animenz_styx_helix.wav）：
 * 真演奏的能量中心在 320–640 Hz（−3.2 dB），2.5–11 kHz 仍有 −25.8 / −40.1 dB；
 * 旧 strings 分别是 −11.9 / −37.1 / −54.8 dB —— 中低"琴体"与高频"空气"都不够。
 * 所以这里：① 部分音幅度用 k^-ampPow（指数比 KS 缓）并给高频 shelf；② 高次分音的
 * t60 不要掉太快（t60Floor）；③ 频率按真实钢琴的**非谐性** f_k = k·f0·√(1+B·k²)；
 * ④ 尾部接 schroederReverb。
 */
export function pianoVoice({
  freq,
  sampleRate = SAMPLE_RATE,
  durationSec = 2.9,
  vel = 0.8,
  partials = 22,
  inharmonicity = 0.00012,
  ampPow = 0.85,
  hfShelf = 0.55,        // 高频 shelf 起始（相对部分音序号的比例）
  hfGain = 1.9,          // shelf 之后额外乘的倍数（提亮）
  bodyLo = 160,          // "琴体"频带（真演奏的能量中心在 320–640Hz，
  bodyHi = 800,          //   我们的旧音色在这一带少 8–9dB → 落在带内的部分音加权）
  bodyGain = 1.7,
  t60Low = 3.4,
  t60High = 1.7,
  t60Floor = 0.55,       // 高次分音的 t60 下限（别把"空气"衰减掉）
  partialMaxHz = 9000,   // 部分音频率上限（超过就停）：5–11kHz 靠锤击瞬态与混响补，
                         // 不靠把泛音堆到 20kHz —— 实测那样会让高频比真钢琴高 14dB（发刺）
  strikeMs = 9,
  strikeGain = 0.085,
  reverbMix = 0.22,
  reverbRt60 = 1.3,
  seed = 7,
} = {}) {
  const v = Math.min(1, Math.max(0, vel));
  const n = Math.round(durationSec * sampleRate);
  const out = new Float64Array(n);
  const nyq = sampleRate / 2;
  let k = 0;
  for (let p = 1; p <= partials; p++) {
    const fk = freq * p * Math.sqrt(1 + inharmonicity * p * p);
    if (fk >= Math.min(nyq * 0.92, partialMaxHz)) break;
    let amp = Math.pow(p, -ampPow);
    if (p >= partials * hfShelf) amp *= hfGain;
    if (fk >= bodyLo && fk <= bodyHi) amp *= bodyGain;
    const t60 = Math.max(t60Floor, lerp(t60Low, t60High, Math.min(1, (fk / 900) ** 0.5)));
    const tau = t60 / 6.907755;
    const phase = (p * p * 0.37) % (2 * Math.PI);
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      out[i] += amp * Math.exp(-t / tau) * Math.sin(2 * Math.PI * fk * t + phase);
    }
    k++;
  }
  // 锤击瞬态：短促、带高频（真钢琴起音里那点"击弦"声）
  const rnd = mulberry32(seed + 977);
  const strikeN = Math.round((strikeMs / 1000) * sampleRate);
  let prev = 0;
  for (let i = 0; i < Math.min(strikeN, n); i++) {
    const w = rnd() * 2 - 1;
    const hp = w - prev;   // 一阶差分 = 提亮
    prev = w;
    out[i] += hp * strikeGain * Math.exp((-i / strikeN) * 6) * (0.5 + 0.5 * v);
  }
  // 起音斜坡（避免咔声）+ 力度→亮度/响度
  const rampN = Math.round(0.004 * sampleRate);
  const bright = 1 + 0.8 * (v - 0.5);
  for (let i = 0; i < n; i++) {
    const r = i < rampN ? 0.5 - 0.5 * Math.cos((Math.PI * i) / rampN) : 1;
    out[i] *= r * (0.55 + 0.45 * v);
  }
  // 归一化 + 混响尾巴
  let m = 0;
  for (const s of out) m = Math.max(m, Math.abs(s));
  if (m > 0) for (let i = 0; i < n; i++) out[i] = (out[i] / m) * (0.5 + 0.5 * v) * (0.6 + 0.4 * bright);
  const wet = schroederReverb(out, { sampleRate, rt60: reverbRt60, mix: reverbMix, seed });
  // DC 阻断 + 超低频清理：Schroeder 的并联梳状会在直流/极低频累积能量，
  // 实测会让自检的"最强谱峰"跑到 ~0Hz（音准误差直接报 100%）。
  let y1 = 0;
  let x1 = 0;
  for (let i = 0; i < wet.length; i++) {
    const x = wet[i];
    const y = x - x1 + 0.9985 * y1;
    x1 = x;
    y1 = y;
    wet[i] = y;
  }
  // 末尾淡出（防文件边界咔声）
  const fadeN = Math.round(0.08 * sampleRate);
  for (let i = 0; i < fadeN; i++) {
    const j = wet.length - fadeN + i;
    if (j >= 0) wet[j] *= 0.5 + 0.5 * Math.cos((Math.PI * i) / fadeN);
  }
  return wet;
}

/* ------------------------------------------------------------------ 小工具 */

/** 确定性 PRNG（mulberry32）：同一 seed 永远给同一串噪声 —— 采样可复现的前提 */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const lerp = (a, b, t) => a + (b - a) * t;

/** 均方根（响度代理） */
export function rms(samples) {
  let s = 0;
  for (let i = 0; i < samples.length; i++) s += samples[i] * samples[i];
  return Math.sqrt(s / Math.max(1, samples.length));
}

/** 绝对峰值（防削波检查） */
export function peak(samples) {
  let m = 0;
  for (let i = 0; i < samples.length; i++) m = Math.max(m, Math.abs(samples[i]));
  return m;
}

/** 纯正弦（用于 FFT 自查与低频支撑层） */
export function sine({ freq, sampleRate = SAMPLE_RATE, durationSec = 1, amp = 0.8, phase = 0 }) {
  const n = Math.max(1, Math.round(durationSec * sampleRate));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.sin(phase + (2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** 一极点低通的极点系数：fc 越低 → pole 越接近 1 */
export const poleOf = (cutoffHz, sampleRate = SAMPLE_RATE) => Math.exp((-2 * Math.PI * cutoffHz) / sampleRate);

/** 一极点低通 y = (1-pole)x + pole·y（返回新数组，不改入参） */
export function onePoleLowpass(samples, pole) {
  const out = new Float64Array(samples.length);
  let y = 0;
  for (let i = 0; i < samples.length; i++) {
    y = (1 - pole) * samples[i] + pole * y;
    out[i] = y;
  }
  return out;
}

/** DC 阻断（一极点高通，截止 ≈7Hz）：去掉延迟线/合成器里可能残留的直流分量 */
export function dcBlock(samples, r = 0.9995) {
  const out = new Float64Array(samples.length);
  let x1 = 0;
  let y1 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    y1 = x0 - x1 + r * y1;
    x1 = x0;
    out[i] = y1;
  }
  return out;
}

/**
 * RBJ Audio EQ Cookbook 双二阶滤波器（peaking / lowshelf / highshelf）。
 * 用来给拨弦加"琴体共振"：低中频一个峰（木头感）+ 高频一个 shelf（避免塑料味）。
 */
export function biquad(samples, { type = 'peaking', freq, q = 1, gainDb = 0, sampleRate = SAMPLE_RATE }) {
  const A = 10 ** (gainDb / 40);
  const w0 = (2 * Math.PI * freq) / sampleRate;
  const cosw = Math.cos(w0);
  const sinw = Math.sin(w0);
  const alpha = sinw / (2 * q);
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;
  if (type === 'lowpass') {
    b0 = (1 - cosw) / 2;
    b1 = 1 - cosw;
    b2 = (1 - cosw) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cosw;
    a2 = 1 - alpha;
  } else if (type === 'peaking') {
    b0 = 1 + alpha * A;
    b1 = -2 * cosw;
    b2 = 1 - alpha * A;
    a0 = 1 + alpha / A;
    a1 = -2 * cosw;
    a2 = 1 - alpha / A;
  } else if (type === 'highshelf' || type === 'lowshelf') {
    const shelfAlpha = (sinw / 2) * Math.SQRT2; // S = 1
    const ap1 = A + 1;
    const am1 = A - 1;
    const sq = 2 * Math.sqrt(A) * shelfAlpha;
    if (type === 'highshelf') {
      b0 = A * (ap1 + am1 * cosw + sq);
      b1 = -2 * A * (am1 + ap1 * cosw);
      b2 = A * (ap1 + am1 * cosw - sq);
      a0 = ap1 - am1 * cosw + sq;
      a1 = 2 * (am1 - ap1 * cosw);
      a2 = ap1 - am1 * cosw - sq;
    } else {
      b0 = A * (ap1 - am1 * cosw + sq);
      b1 = 2 * A * (am1 - ap1 * cosw);
      b2 = A * (ap1 - am1 * cosw - sq);
      a0 = ap1 + am1 * cosw + sq;
      a1 = -2 * (am1 + ap1 * cosw);
      a2 = ap1 + am1 * cosw - sq;
    }
  } else {
    throw new Error(`未知滤波器类型：${type}`);
  }
  const nb0 = b0 / a0;
  const nb1 = b1 / a0;
  const nb2 = b2 / a0;
  const na1 = a1 / a0;
  const na2 = a2 / a0;
  const out = new Float64Array(samples.length);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = nb0 * x0 + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    out[i] = y0;
    x2 = x1;
    x1 = x0;
    y2 = y1;
    y1 = y0;
  }
  return out;
}

/** 峰值归一化（target ≤1，留 0.1dB 余量给 16bit 量化） */
export function normalizePeak(samples, target = 0.9) {
  const p = peak(samples);
  if (p <= 0) return samples;
  const k = target / p;
  const out = new Float64Array(samples.length);
  for (let i = 0; i < samples.length; i++) out[i] = samples[i] * k;
  return out;
}

/** 首尾淡入淡出（线性，毫秒）：避免采样文件边界爆音 */
export function fadeEdges(samples, { inMs = 0.5, outMs = 45, sampleRate = SAMPLE_RATE } = {}) {
  const out = Float64Array.from(samples);
  const ni = Math.min(out.length, Math.round((inMs / 1000) * sampleRate));
  const no = Math.min(out.length, Math.round((outMs / 1000) * sampleRate));
  for (let i = 0; i < ni; i++) out[i] *= i / ni;
  for (let i = 0; i < no; i++) out[out.length - 1 - i] *= i / no;
  return out;
}

/* --------------------------------------------------------------- 拨弦（KS） */

/**
 * Karplus–Strong 拨弦。
 * @param {object} o
 * @param {number} o.freq            目标基频（Hz）
 * @param {number} [o.vel]           力度 0..1 → 亮度（激励低通 + 环路阻尼）、响度
 * @param {Array}  [o.damping]       [vel=0, vel=1] 的环路阻尼 d（0=不阻尼，0.6=最暗）；越大高次泛音衰减越快
 * @param {Array}  [o.toneCutoff]    [vel=0, vel=1] 的末端两级低通截止（对数插值）—— 力度→亮度的总闸
 * @param {Array}  [o.excitationLowpass] [vel=0, vel=1] 的激励低通极点（越接近 1 越暗）
 * @param {number} [o.pickPosition]  拨弦位置（0..0.5），决定激励梳状零点（= 被压掉的泛音）
 * @param {Array}  [o.pluckMix]      [vel=0, vel=1] 位移波形里"锯齿成分"占比 β：0=纯三角（暗），1=纯锯齿（亮）
 * @param {number} [o.noiseMix]      拨片噪声相对位移波形的幅度
 * @param {number} [o.decayT60]      参考频率处的 T60（秒）
 * @param {number} [o.decayRefHz]    参考频率
 * @param {number} [o.decayExponent] 高音衰减更快的指数（T60 ∝ (ref/f)^k）
 * @param {number} [o.subMix]        叠加同频正弦的幅度（0 = 不加；低音支撑用）
 * @param {Array}  [o.body]          琴体 EQ 链（[{type,freq,q,gainDb}]）
 * @param {number} [o.seed]          噪声种子
 */
export function karplusStrong({
  freq,
  sampleRate = SAMPLE_RATE,
  durationSec,
  vel = 0.8,
  damping = [0.55, 0.25],
  toneCutoff = [900, 9000],
  excitationLowpass = [0.88, 0.42],
  pickPosition = 0.18,
  pluckMix = [0.06, 0.8],
  noiseMix = 0.3,
  decayT60 = 2.9,
  decayRefHz = 220,
  decayExponent = 0.35,
  subMix = 0,
  body = [],
  seed = 1,
} = {}) {
  const v = Math.min(1, Math.max(0, vel));
  const d = lerp(damping[0], damping[1], v);
  const h0 = 1 - 0.5 * d;
  const h1 = 0.5 * d;
  // 环路总延迟 = fs/f：扣掉两抽头 FIR 在基频处的相位延迟（低频近似 h1/(h0+h1) = 0.5d）
  const required = sampleRate / freq - 0.5 * d;
  const L = Math.max(2, Math.floor(required));
  const frac = Math.max(0, Math.min(0.999, required - L));

  // 激励 = 位移波形（三角 + 力度控制的锯齿成分）+ 拨片噪声
  //   为什么"力度→亮度"落在谐波斜率上：一极点低通只有 6dB/oct，压不动 -12dB/oct 的三角波
  //   （实测谱心只差 7%，不达标）；三角(1/k²，p≈2) 与锯齿(1/k，p≈1) 按 β(v) 混合，
  //   两次实测谱心比 ≈1.6×（见 docs/M2-1-report.md §3）。
  const rnd = mulberry32(seed);
  const raw = new Float64Array(L);
  for (let i = 0; i < L; i++) raw[i] = rnd() * 2 - 1;
  const p = Math.min(0.49, Math.max(0.02, pickPosition));
  const comb = Math.round(p * L);
  const beta = lerp(pluckMix[0], pluckMix[1], v);
  const K = Math.max(1, Math.min(64, Math.floor(L / 2)));
  const shape = new Float64Array(L);
  for (let k = 1; k <= K; k++) {
    const nullGain = Math.abs(Math.sin(Math.PI * k * p)); // 拨弦位置零点：k = m/p 处的泛音被压掉
    const amp = nullGain * ((1 - beta) / k ** 2 + beta / k);
    if (amp < 1e-5) continue;
    const w = (2 * Math.PI * k) / L;
    for (let i = 0; i < L; i++) shape[i] += amp * Math.sin(w * i);
  }
  const shapeScale = 1 / (peak(shape) || 1);
  for (let i = 0; i < L; i++) shape[i] *= shapeScale;
  // 拨片噪声：同一拨弦位置的梳状滤波（前 comb 点淡入，避免 t=0 跳变）+ 一极点低通
  const noiseRaw = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    const prev = i - comb >= 0 ? raw[i - comb] : 0;
    noiseRaw[i] = (raw[i] - prev) * (i < comb ? i / comb : 1);
  }
  const noise = onePoleLowpass(noiseRaw, lerp(excitationLowpass[0], excitationLowpass[1], v));
  const noiseScale = (1 / (peak(noise) || 1)) * noiseMix;
  const exc = new Float64Array(L);
  for (let i = 0; i < L; i++) exc[i] = shape[i] + noise[i] * noiseScale;
  // 归一化激励，保证不同音高/力度下起音电平一致（响度由 vel 的输出归一化决定）
  const excPeak = peak(exc) || 1;
  for (let i = 0; i < L; i++) exc[i] /= excPeak;

  // 环路增益：每绕一圈衰减 g → T60 秒后 -60dB（一圈 = 1/f 秒）
  const t60 = decayT60 * (decayRefHz / freq) ** decayExponent;
  const g = Math.min(0.9999, 10 ** (-3 / (freq * t60)));

  const n = Math.max(8, Math.round((durationSec ?? t60) * sampleRate));
  // 延迟线长度必须是 L+1：小数延迟要在"延迟 L"与"延迟 L+1"两个抽头之间插值。
  // 只用 L 个槽（曾经的写法）会让第二个抽头落在"延迟 1"上 —— 环路里混进近距抽头，
  // frac 接近 0 或 1 的音（midi 48/61/74/77）会退化成亚音频漂移，基频直接错到 6%~97%。
  const M = L + 1;
  const buf = new Float64Array(M);
  for (let i = 0; i < M; i++) buf[i] = exc[i % L];
  const out = new Float64Array(n);
  let w = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const i1 = (w - L + M) % M; // 延迟 L
    const i2 = (w - L - 1 + M) % M; // 延迟 L+1
    const s = buf[i1] * (1 - frac) + buf[i2] * frac;
    out[i] = s;
    const y = h0 * s + h1 * prev;
    prev = s;
    buf[w] = y * g;
    w = (w + 1) % M;
  }

  // 低频支撑：叠加同频正弦（低音在监听设备上放不出来的补偿；由 voices.mjs 决定是否启用）
  if (subMix > 0) {
    const amp = subMix * Math.max(0.05, peak(out));
    const tau = t60 / 6.907755;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      out[i] += amp * Math.sin(2 * Math.PI * freq * t) * Math.exp(-t / tau);
    }
  }

  let sig = dcBlock(out);
  for (const spec of body) sig = biquad(sig, { ...spec, sampleRate });
  // 音色总闸：两级（12dB/oct）低通，截止随力度**对数**插值。一极点低通（6dB/oct）压不动
  // -12dB/oct 的三角激励（实测谱心只差 7%，不达标）；两级低通后 vel 0.35→1.0 的谱心比 ≈1.9×。
  const toneHz = toneCutoff[0] * (toneCutoff[1] / toneCutoff[0]) ** v;
  if (toneHz < sampleRate * 0.45) sig = biquad(sig, { type: 'lowpass', freq: toneHz, q: 0.707, sampleRate });
  sig = normalizePeak(sig, 0.35 + 0.55 * v);
  return fadeEdges(sig, { inMs: 0.4, outMs: 45, sampleRate });
}

/* ------------------------------------------------------------ 铺底（pad） */

/**
 * 加法（+轻微 FM 味）柔和铺底：每个泛音一对失谐振荡器 + 慢起音 + 慢颤音 + 一极点低通。
 * 力度 → 高次泛音增益（brightnessVel）与低通截止（cutoff），所以"力度"在这里也是音色参数。
 */
export function fmPad({
  freq,
  sampleRate = SAMPLE_RATE,
  durationSec = 2.6,
  vel = 0.8,
  partials = [1, 0.45, 0.28, 0.17, 0.11, 0.07],
  detuneCents = [0, -4, 5, -7, 8, -10],
  attackMs = 150,
  decayT60 = 3.0,
  vibratoHz = 4.4,
  vibratoCents = 3.5,
  brightnessVel = [0.45, 1.0],
  cutoff = [1200, 4200],
} = {}) {
  const v = Math.min(1, Math.max(0, vel));
  const n = Math.max(8, Math.round(durationSec * sampleRate));
  const out = new Float64Array(n);
  const upper = lerp(brightnessVel[0], brightnessVel[1], v);
  for (let k = 0; k < partials.length; k++) {
    // 高次泛音随力度放大/缩小；每个泛音自身衰减更快（t60 按 1/(1+0.35k) 收缩）
    const amp = partials[k] * (k === 0 ? 1 : upper ** k);
    const tau = decayT60 / (1 + 0.35 * k) / 6.907755;
    const cents = detuneCents[k] ?? 0;
    const f = freq * (k + 1);
    const fDet = f * 2 ** (cents / 1200);
    let phase = 0;
    let phase2 = Math.PI / 3;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      const vib = 1 + (vibratoCents / 1200) * Math.sin(2 * Math.PI * vibratoHz * t + k);
      phase += (2 * Math.PI * fDet * vib) / sampleRate;
      phase2 += (2 * Math.PI * fDet * 2 ** (7 / 1200) * vib) / sampleRate;
      out[i] += amp * 0.5 * (Math.sin(phase) + Math.sin(phase2)) * Math.exp(-t / tau);
    }
  }
  // 慢起音（raished-cosine）+ 一极点低通（力度控制亮度）
  const attack = Math.max(1, Math.round((attackMs / 1000) * sampleRate));
  for (let i = 0; i < Math.min(attack, n); i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
  let sig = onePoleLowpass(out, poleOf(lerp(cutoff[0], cutoff[1], v), sampleRate));
  sig = dcBlock(sig);
  sig = normalizePeak(sig, 0.35 + 0.45 * v);
  return fadeEdges(sig, { inMs: 2, outMs: 200, sampleRate });
}

/* ------------------------------------------------------------ 钟琴（bell） */

/**
 * 模态合成钟琴：每个分音 = 一对相差 ±beatCents/2 的阻尼正弦（互相拍频 → "活的"钟声）。
 * 分音比例刻意非谐（0.5 哼音 / 1.19 / 1.56 / 2.66 …），这是钟琴与"正弦叠加"的分界。
 * 力度 → 顶部两个分音的幅度（敲得重才有高频"叮"）与攻击噪声电平。
 */
export function modalBell({
  freq,
  sampleRate = SAMPLE_RATE,
  durationSec = 2.4,
  vel = 0.8,
  ratios = [0.5, 1, 1.19, 1.56, 2, 2.66, 3.01],
  amps = [0.22, 1, 0.62, 0.45, 0.33, 0.24, 0.15],
  t60 = [2.2, 2.6, 2.0, 1.7, 1.4, 1.15, 1.0],
  beatCents = [1.0, 1.4, 1.2, 1.0, 0.9, 0.8, 0.7],
  strikeMs = 3,
  strikeGainDb = -18,
  strikeBand = [1500, 6000],
  topRolloff = [0.45, 1.0],
  seed = 7,
} = {}) {
  const v = Math.min(1, Math.max(0, vel));
  const n = Math.max(8, Math.round(durationSec * sampleRate));
  const out = new Float64Array(n);
  const top = lerp(topRolloff[0], topRolloff[1], v);
  for (let k = 0; k < ratios.length; k++) {
    const roll = k >= ratios.length - 2 ? top : 1; // 最高两个分音受力度控制
    const amp = amps[k] * roll;
    const tau = t60[k] / 6.907755;
    const f = freq * ratios[k];
    const beat = beatCents[k] / 1200;
    const fA = f * 2 ** (-beat / 2);
    const fB = f * 2 ** (beat / 2);
    let pA = k * 0.7;
    let pB = k * 1.3;
    for (let i = 0; i < n; i++) {
      const t = i / sampleRate;
      pA += (2 * Math.PI * fA) / sampleRate;
      pB += (2 * Math.PI * fB) / sampleRate;
      out[i] += amp * 0.5 * (Math.sin(pA) + Math.sin(pB)) * Math.exp(-t / tau);
    }
  }
  // 槌击噪声：短促带通噪声（一极点低通 + 一阶差分高通），力度越大越明显
  const strikeN = Math.max(8, Math.round((strikeMs / 1000) * sampleRate * 6));
  const rnd = mulberry32(seed);
  const noise = new Float64Array(strikeN);
  for (let i = 0; i < strikeN; i++) noise[i] = rnd() * 2 - 1;
  const lp = onePoleLowpass(noise, poleOf(strikeBand[1], sampleRate));
  const hp = onePoleLowpass(lp, poleOf(strikeBand[0], sampleRate));
  const hp2 = new Float64Array(strikeN);
  for (let i = 0; i < strikeN; i++) hp2[i] = hp[i] - (i > 0 ? hp[i - 1] : 0);
  const hpPeak = peak(hp2) || 1;
  const strikeAmp = 10 ** (strikeGainDb / 20) * lerp(0.6, 1.6, v);
  for (let i = 0; i < strikeN; i++) {
    const env = Math.exp(-i / (sampleRate * 0.0015));
    out[i] += (hp2[i] / hpPeak) * strikeAmp * env;
  }
  const attack = Math.max(1, Math.round(0.004 * sampleRate));
  for (let i = 0; i < Math.min(attack, n); i++) out[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / attack);
  let sig = dcBlock(out);
  sig = normalizePeak(sig, 0.35 + 0.5 * v);
  return fadeEdges(sig, { inMs: 0.5, outMs: 80, sampleRate });
}
