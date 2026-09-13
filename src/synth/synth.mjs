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
  const buf = Float64Array.from(exc);
  const out = new Float64Array(n);
  let w = 0;
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const i1 = w; // 延迟 L
    const i2 = (w - 1 + L) % L; // 延迟 L+1
    const s = buf[i1] * (1 - frac) + buf[i2] * frac;
    out[i] = s;
    const y = h0 * s + h1 * prev;
    prev = s;
    buf[w] = y * g;
    w = (w + 1) % L;
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
