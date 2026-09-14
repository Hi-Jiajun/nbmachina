// M2-1 · 音色表：把"合成器算法"（src/synth/synth.mjs）绑定成可交付的音色 + 音域 + 命名规则
//
// 音域取舍（任务书要求 ≥3 个八度、每半音一个采样）：
//   · strings / bell / pad：midi 42..78（F#2..F#6，37 个半音 = 3 个八度）—— 完整覆盖 harp 音轨
//     （harp 行 0..24 → midi 42..66），另外各留 12 个半音给后续"内声部升八度"用
//   · bass：midi 19..55（G0..G3，37 个半音）—— 完整覆盖 bass 音轨（行 1..24 → midi 19..42）
//   为什么不"1 个采样 + pitch 参数"：/playsound 的 pitch 只在 0.5..2.0 之间（±1 个八度），
//   变调超过一个八度会有明显的"花栗鼠/慢放"失真；每半音一个采样把 pitch 恒定为 1.0，
//   代价是文件数（4×37=148 个 ogg，实测 zip <4MB，见 docs/M2-1-report.md §4）。
//
// 行→音高（与原版音符盒定调一致，和 src/emit/datapack-playback.mjs 的 pitchMul 同口径）：
//   · harp/bell/…：midi = row + 42（row 0 = F#2 = 93.0Hz，row 12 = F#3 = 185.0Hz，row 24 = F#4）
//   · bass      ：midi = row + 18（原版 bass 音色比 harp 低两个八度）
import { midiName, midiToFreq } from '../analyze/dsp.mjs';

import {
  SAMPLE_RATE, fmPad, karplusStrong, modalBell, pianoVoice,
} from './synth.mjs';

export const SOUND_NAMESPACE = 'nbforge';
export const TIMBRES = ['strings', 'pad', 'bell', 'bass', 'piano'];
export const REGISTERS = {
  // M3-5：音域按**谱面真实音高**重定（后端 A 没有"2 个八度"的方块限制）。
  // 依据 `machine_pipeline.csv` 的 midi 列：harp 56..102（G#3..F#7，p50=G#6 附近）、bass 21..61。
  // 旧值 [42,78] / [19,55] 是按"折叠后的 row"定的，结果 hifi 渲染器把旋律播低了一到两个八度
  // （玩家 15:50 反馈"中高音不好听、没有空灵感"——根因就是音高不在原曲的八度上）。
  strings: [42, 102],
  pad: [42, 102],
  bell: [42, 102],
  bass: [19, 61],
  // M3-6：钢琴类（非谐加性 + 锤击 + 扩散尾音），与 strings 同音域，用于旋律层 A/B
  piano: [42, 102],
};
/** 采样里烘死的参考力度（playsound 路径按谱面 volume 调音量，M4 才做多层力度采样） */
export const REFERENCE_VEL = 0.8;

/** 每个音色的算法与参数（注释里写清"这个数为什么是这个数"） */
export const VOICE_PARAMS = {
  // M3-6：按真钢琴（Animenz 演奏）的长时平均谱标定 —— 中低"琴体"更足、高频"空气"不掉太快。
  // 依据与迭代过程见 docs/M3-6-report.md；算法见 src/synth/synth.mjs 的 pianoVoice。
  piano: {
    kind: 'piano',
    partials: 22,
    inharmonicity: 0.00012,
    ampPow: 0.85,
    hfShelf: 0.55,
    hfGain: 1.9,
    bodyLo: 160,
    bodyHi: 800,
    bodyGain: 1.7,
    t60Low: 3.4,
    t60High: 1.7,
    t60Floor: 0.55,
    partialMaxHz: 9000,
    strikeGain: 0.085,
    reverbMix: 0.22,
  },
  // 拨弦：明亮、衰减快，靠琴体 EQ 加木头感
  strings: {
    kind: 'karplus',
    damping: [0.55, 0.25], // 力度 0→1：环路阻尼，越大高次泛音衰减越快（越暗）
    excitationLowpass: [0.90, 0.30], // 力度 0→1：激励低通极点（≈750Hz → ≈8.4kHz）
    pickPosition: 0.18, // 拨弦位置：压掉第 5~6 次泛音，介于"太薄(0.5)"与"太闷(0.05)"之间
    pluckMix: [0.06, 0.8], // 位移波形里锯齿成分 β：0=纯三角（暗）/1=纯锯齿（亮），力度插值
    noiseMix: 0.3, // 拨片噪声相对位移波形的幅度
    toneCutoff: [900, 9000], // 末端两级低通截止（对数插值）：力度→亮度的总闸
    decayT60: 2.9, // 220Hz 处 T60=2.9s
    decayRefHz: 220,
    decayExponent: 0.35, // 高音衰减更快（真弦的物理趋势）
    subMix: 0,
    body: [
      { type: 'peaking', freq: 260, q: 0.9, gainDb: 3.5 }, // 琴体低中频共振
      { type: 'peaking', freq: 1450, q: 1.1, gainDb: 1.5 },
      { type: 'highshelf', freq: 3200, gainDb: -4.5 }, // 压掉"塑料味"的高频
    ],
  },
  // 低音：更暗更长的拨弦 + 同频正弦支撑（小音箱也能听出根音）
  bass: {
    kind: 'karplus',
    damping: [0.80, 0.55],
    excitationLowpass: [0.92, 0.68],
    pickPosition: 0.34,
    pluckMix: [0.2, 0.85], // 低音也要有"轻拨/重拨"的亮度差
    noiseMix: 0.25,
    toneCutoff: [400, 4200], // 低音整体更暗：截止整体下移
    decayT60: 3.6,
    decayRefHz: 110,
    decayExponent: 0.3,
    subMix: 0.3,
    body: [
      { type: 'peaking', freq: 110, q: 0.8, gainDb: 4.5 },
      { type: 'highshelf', freq: 1800, gainDb: -7 },
    ],
  },
  // 铺底：慢起音、慢颤音、高次泛音少而稳定
  pad: {
    kind: 'additive',
    partials: [1, 0.45, 0.28, 0.17, 0.11, 0.07],
    detuneCents: [0, -4, 5, -7, 8, -10],
    attackMs: 150,
    decayT60: 3.0,
    vibratoHz: 4.4,
    vibratoCents: 3.5,
    brightnessVel: [0.45, 1.0],
    cutoff: [1200, 4200],
  },
  // 钟琴：非谐分音、拍频、"叮"的槌击噪声
  bell: {
    kind: 'modal',
    ratios: [0.5, 1, 1.19, 1.56, 2, 2.66, 3.01],
    amps: [0.22, 1, 0.62, 0.45, 0.33, 0.24, 0.15],
    t60: [2.2, 2.6, 2.0, 1.7, 1.4, 1.15, 1.0],
    beatCents: [1.0, 1.4, 1.2, 1.0, 0.9, 0.8, 0.7],
    strikeMs: 3,
    strikeGainDb: -18,
    strikeBand: [1500, 6000],
    topRolloff: [0.45, 1.0],
  },
};

/** 音域半音数（测试与报告都用它：要求 ≥37 = 3 个八度） */
export const registerSize = (timbre) => {
  const r = REGISTERS[timbre];
  if (!r) throw new Error(`未知音色：${timbre}`);
  return r[1] - r[0] + 1;
};

/** 该音色是否渲染了这个音高（事件存在性） */
export const hasEvent = (timbre, midi) => {
  const r = REGISTERS[timbre];
  return !!r && midi >= r[0] && midi <= r[1];
};

/** 机器行 → 实际发声音高（midi）。bass 比 harp 低两个八度，与原版音符盒一致。 */
export const midiFromRow = (instr, row) => (instr === 'bass' ? row + 18 : row + 42);

/** 采样时长：低音长、高音短（自然衰减的物理趋势），并夹在 [min,max] 内控制包体积 */
export function durationSecOf(timbre, freq) {
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
  switch (timbre) {
    case 'strings': return clamp(2.9 * (220 / freq) ** 0.35, 0.8, 2.2);
    case 'bass': return clamp(3.6 * (110 / freq) ** 0.3, 0.9, 2.4);
    case 'pad': return 2.6;
    case 'bell': return 2.4;
    case 'piano': return 2.9;   // 尾巴由 schroederReverb 再延长 ~1.3s
    default: throw new Error(`未知音色：${timbre}`);
  }
}

/** 文件名用 "音名+八度" 的降号写法：C#4 → cs4（资源包路径只允许 [a-z0-9_/.-]，# 不合法） */
export function noteFileName(midi) {
  const name = midiName(midi).toLowerCase();
  return name.replace('#', 's');
}

/** 资源包事件 id：nbforge:strings_fs4 */
export const eventIdOf = (timbre, midi) => `${SOUND_NAMESPACE}:${timbre}_${noteFileName(midi)}`;

/** sounds.json 里的采样名（相对 assets/<ns>/sounds/，不含扩展名） */
export const soundPathOf = (timbre, midi) => `${timbre}/${noteFileName(midi)}`;

const seedOf = (timbre, midi) => {
  let h = 2166136261;
  for (const ch of timbre) h = (Math.imul(h ^ ch.charCodeAt(0), 16777619)) >>> 0;
  return (Math.imul(h ^ midi, 2654435761) >>> 0) || 1;
};

/** 渲染一个音（返回 [-1,1] 的 Float64Array）。vel 只影响音色/响度，不改变音高。 */
export function renderVoice(timbre, midi, { vel = REFERENCE_VEL, sampleRate = SAMPLE_RATE } = {}) {
  if (!hasEvent(timbre, midi)) {
    throw new Error(`${timbre} 未渲染 midi ${midi}（音域 ${REGISTERS[timbre].join('..')}）`);
  }
  const params = VOICE_PARAMS[timbre];
  const freq = midiToFreq(midi);
  const durationSec = durationSecOf(timbre, freq);
  const seed = seedOf(timbre, midi);
  if (params.kind === 'karplus') {
    return karplusStrong({ ...params, freq, sampleRate, durationSec, vel, seed });
  }
  if (params.kind === 'additive') return fmPad({ ...params, freq, sampleRate, durationSec, vel });
  if (params.kind === 'modal') return modalBell({ ...params, freq, sampleRate, durationSec, vel, seed });
  if (params.kind === 'piano') return pianoVoice({ ...params, freq, sampleRate, durationSec, vel, seed });
  throw new Error(`未知合成算法：${params.kind}`);
}

/** 渲染任务清单（render-all.mjs 与测试共用，保证"包里有什么"与"报了什么"一致） */
export function listRenderJobs({ timbres = TIMBRES, vel = REFERENCE_VEL } = {}) {
  const jobs = [];
  for (const timbre of timbres) {
    const [lo, hi] = REGISTERS[timbre];
    for (let midi = lo; midi <= hi; midi++) {
      jobs.push({
        timbre,
        midi,
        vel,
        note: noteFileName(midi),
        event: eventIdOf(timbre, midi),
        soundPath: soundPathOf(timbre, midi),
        freq: midiToFreq(midi),
        durationSec: durationSecOf(timbre, midiToFreq(midi)),
      });
    }
  }
  return jobs;
}
