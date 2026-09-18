#!/usr/bin/env node
// M3-11 · 全真乐器整曲渲染（ensemble）：旋律=真钢琴、内声部=真竖琴、贝斯=真低音提琴拨弦、打击乐=真鼓
//
// 与 tools/audition-piano.mjs 的分工：那是"单层音色挑耳朵"，这是"整曲成品"。
// 四层的采样来源（全部逐条核过许可，见 docs/M3-11-ensemble.md）：
//   旋律   Salamander Grand Piano V3 **48kHz/24bit 完整母版**（CC-BY 3.0）或 VSCO Upright Piano（CC0）
//   内声部 VSCO 2 CE Harp（CC0）
//   贝斯   VSCO 2 CE Solo Contrabass Pizzicato（CC0）
//   打击乐 VSCO 2 CE 鼓组：basedrum → GM 36 的 BDrumNewhit（多层力度 × rr），
//          hat → 铃鼓 Tamb1-Hit（VSCO 2 CE **没有**闭合踩镲；如实标注为替代品）
//
// 混音口径（这条是听感关键）：
//   · 持续层（旋律/内声部/贝斯）按 **RMS** 定标 —— 它们几乎铺满全曲，RMS 才代表响度；
//   · 打击乐按 **峰值** 定标 —— 96 颗鼓散在 290 秒里，按 RMS 定标会把它抬成爆音；
//   · 层内力度：SFZ 的 lovel/hivel 选层（`velMidi`，M3-14 的实测力度归一值）
//     + 同一把尺子的增益（1..127 ≈ -16.7dB..0dB）；老谱面没有 velMidi 时退回 0.55 + 0.45·volume；
//   · 最后整体归一 -18dBFS + tanh 软限幅（与 audition 同一套），再转 48k/24bit 母版。
//
// 用法：
//   node tools/render-ensemble.mjs --full --segments 0,226,150
//   node tools/render-ensemble.mjs --melody upright --segments 0,150
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readWav } from '../src/analyze/dsp.mjs';
import { resolvePaths } from '../src/core/paths.mjs';
import { STEP_SECONDS } from '../src/emit/tick-map.mjs';
import { parseScoreCsv, planHifi } from '../src/emit/playsound-hifi.mjs';
import { loadSfz, pickRegion } from '../src/sample/sfz.mjs';
import { interpretVelMidi, phraseVelMidi, velMidiToAmplitude } from '../src/arrange/dynamics.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const SR = 48000;                                  // 母版采样率（hi-res 投稿口径）
const P = resolvePaths();
const B = P.build;
const LIB = opt('lib', 'C:/Users/hiliang/Documents/minecraft/_toolchain/piano');
const VSCO = `${LIB}/vsco2ce/VSCO-2-CE-SFZ`;
const OUT = opt('out', path.join(B, 'ensemble'));
const NAME = opt('name', 'styx_ensemble');
const SEC = Number(opt('sec', '30'));
const SEGS = String(opt('segments', '')).split(',').filter(Boolean).map(Number);
const ONLY = String(opt('only', '')).split(',').filter(Boolean);
// 谱面来源与力度口径：
//   · 默认用 machine 谱面（只有 volume 一列，全曲恒定 0.35 → 所有音同一力度层）；
//   · `--score build/pipeline_6_merged.csv --dynamics measured` 用 M0 T5b 从参考演奏里
//     量出来的**实测力度**（逐音不同），这才是"真力度"；实测里有 2172 这种野值，统一夹到 [0.3,1]。
const SCORE = opt('score', P.machineScore);
const DYNAMICS = String(opt('dynamics', 'flat'));
if (!['flat', 'measured', 'phrase', 'interpret'].includes(DYNAMICS)) {
  throw new Error('--dynamics 只支持 flat/measured/phrase/interpret');
}
const SECTIONS_JSON = opt('sections', path.join(P.build, 'dynamics-sections.json'));
// M3-22：`durMs`（每颗音的实际发声时长）→ 渲染时在"该放音"的时刻加一段放音包络。
//   钢琴上"声音什么时候停"由两件事决定：手指松开（键释放）与踏板抬起（制音器落下），
//   这两个量由 tools/calibrate-from-reference.mjs 从参考演奏里量出来，写进谱面的 `durMs` 列。
//   `--no-lengths` 可退回旧行为（让采样自然衰减到底），用于 A/B。
const LENGTHS = !argv.includes('--no-lengths');
// M3-22 第二轮（用户反馈"低音之间污染太严重、像一直踩着踏板"）：
//   `--hpf <Hz>`       总线高通：参考演奏 60Hz 以下几乎没能量（0.01%），我们却有 0.14%+ 的隆隆声
//   `--bass-hpf <Hz>`  只给左手层高通：把 80–150Hz 的堆积削掉（参考那一带只占 8%，我们 27%）
//   `--bass-cap <sec>` 左手发声时长上限：不给低音无限延长，避免十几颗音叠在一起
const HPF = Number(opt('hpf', '0'));
const BASS_HPF = Number(opt('bass-hpf', '0'));
const BASS_CAP = Number(opt('bass-cap', '0'));
// `--bass-key`：左手只按"手指松开"收（不继承踏板延长）——用于判断低音糊是不是踏板拖出来的
const BASS_KEY = argv.includes('--bass-key');
/** 制音器放音时长：低音弦重、放音慢；高音弦轻、放音快（听感上等价于真实制音器） */
const releaseMsOf = (midi) => (midi >= 60 ? 140 : midi >= 45 ? 200 : 300);

/** 二阶 Butterworth 高通（bilinear 变换），用于削掉多余的极低频 rumble */
function highpass(buf, sr, fc) {
  if (!(fc > 0)) return buf;
  const w0 = 2 * Math.PI * fc / sr;
  const cos0 = Math.cos(w0), sin0 = Math.sin(w0);
  const alpha = sin0 / (2 * Math.SQRT1_2);
  const b0 = (1 + cos0) / 2, b1 = -(1 + cos0), b2 = (1 + cos0) / 2;
  const a0 = 1 + alpha, a1 = -2 * cos0, a2 = 1 - alpha;
  const out = new Float32Array(buf.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < buf.length; i++) {
    const x0 = buf[i];
    const y0 = (b0 / a0) * x0 + (b1 / a0) * x1 + (b2 / a0) * x2 - (a1 / a0) * y1 - (a2 / a0) * y2;
    out[i] = y0;
    x2 = x1; x1 = x0; y2 = y1; y1 = y0;
  }
  return out;
}

const MELODIES = {
  // 默认 = 48kHz/24bit 完整母版（30 个录音点 / 16 层力度，最大 1 半音微调）。
  // Ogg 包只留作对照：16 个录音点、最大 4 半音变调、且是有损编码（用户明确否掉过它）。
  salamander: { sfz: `${LIB}/salamander48/SalamanderGrandPianoV3_48khz24bit/SalamanderGrandPianoV3.sfz`, label: 'Salamander V3 48k/24bit 母版 / CC-BY 3.0' },
  salamander_ogg: { sfz: `${LIB}/SalamanderGrandPianoV3_OggVorbis/SalamanderGrandPianoV3.sfz`, label: 'Salamander V3 Ogg 精简包（有损 / 16 录音点）/ CC-BY 3.0' },
  upright: { sfz: `${VSCO}/UprightPiano.sfz`, label: 'VSCO 直立钢琴 / CC0' },
  // OLPC 完整合集（30 根音 A0..C8、每根音 12~33 层 leg 力度）——Yamaha 这条线能拿到的最完整母版
  disklavier: { sfz: 'C:/Users/hiliang/Documents/minecraft/_toolchain/olpc/x/yamahaGrandPiano44/yamaha_disklavier_olpc.sfz', label: 'Yamaha Disklavier Pro 完整合集（Zenph / OLPC v2.7 / CC-BY 3.0）' },
  // 旧的 SF2 编译版（26 根音、3~4 层力度）：只作对照，顶音区要变调 6 个半音
  disklavier_sf2: { sfz: `${LIB}/disklavier_sfz/acoustic_grand_piano_ydp_20080910.sfz`, label: 'Yamaha Disklavier Pro SF2 子集（Zenph / CC-BY 3.0）' },
};
const MELODY = opt('melody', 'salamander');
if (!MELODIES[MELODY]) throw new Error(`--melody 只支持 ${Object.keys(MELODIES).join('/')}`);
// M3-22：`--preset piano` = 与 mod 的 `--preset piano` 同一套编制（旋律/内声部/左手都是同一架琴，
// 打击乐跳过）。用户 2026-09-16 拍板"这首歌就该全钢琴"，离线成品与游戏内必须用同一套口径。
const PRESET = opt('preset', 'ensemble');
if (!['ensemble', 'piano'].includes(PRESET)) throw new Error('--preset 只支持 ensemble/piano');

// 每层的响度目标与声像（pan：-1 全左 / 0 中 / +1 全右）
const LAYER_GAIN = PRESET === 'piano'
  // 同一架琴的三层不各自定标：让谱面里的力度自己决定强弱（与 mod 引擎一致），只做总线归一
  ? { melody: { gain: 1, pan: 0 }, inner: { gain: 1, pan: 0 }, bass: { gain: 1, pan: 0 } }
  : {
    melody: { rms: -20, pan: -0.08 },
    inner: { rms: -26, pan: 0.22 },
    bass: { rms: -21, pan: 0 },
    kick: { peak: -6, pan: 0 },
    hat: { peak: -15, pan: 0.12 },
  };
// 全钢琴预设：打击乐不属于钢琴改编（与 mod 的 --preset piano 同一口径：basedrum/hat 直接跳过）
const keep = (layer) => (PRESET === 'piano' && (layer === 'kick' || layer === 'hat'))
  ? false
  : (!ONLY.length || ONLY.includes(layer));

/* ------------------------------------------------------------------ 采样来源 */
const sources = {};
const loadPiano = () => ({ ...loadSfz(MELODIES[MELODY].sfz), label: MELODIES[MELODY].label });
if (keep('melody')) sources.melody = loadPiano();
if (PRESET === 'piano') {
  if (keep('inner')) sources.inner = loadPiano();
  if (keep('bass')) sources.bass = loadPiano();
} else {
  if (keep('inner')) sources.inner = { ...loadSfz(`${VSCO}/Harp.sfz`), label: 'VSCO 竖琴 / CC0' };
  if (keep('bass')) sources.bass = { ...loadSfz(`${VSCO}/ContrabassPizz.sfz`), label: 'VSCO 低音提琴拨弦 / CC0' };
}
if (keep('kick')) sources.kick = { ...loadSfz(`${VSCO}/GM-StylePerc.sfz`), label: 'VSCO 贝斯鼓（GM36）/ CC0' };
if (keep('hat')) {
  // 铃鼓：VSCO 2 CE 无闭合踩镲（全库无 hi-hat），用两档力度的铃鼓击打做替代，如实标注
  const dir = `${VSCO}/Percussion`;
  const mk = (f, lo, hi) => ({ file: `${dir}/${f}`, loKey: 0, hiKey: 127, root: 42, loVel: lo, hiVel: hi, gainDb: 0, tuneCents: 0 });
  sources.hat = {
    label: 'VSCO 铃鼓（代替闭合踩镲）/ CC0',
    regions: [mk('Tamb1-Hit_v1_rr1_Sum.wav', 0, 79), mk('Tamb1-Hit_v2_rr1_Sum.wav', 80, 127)],
  };
}
for (const [name, src] of Object.entries(sources)) {
  const keys = src.regions.flatMap((r) => [r.loKey, r.hiKey]);
  console.log(`${name}: ${src.regions.length} 区域（音域 ${Math.min(...keys)}..${Math.max(...keys)}）`
    + `${src.droppedTrigger ? `，丢弃松键层 ${src.droppedTrigger}` : ''}`
    + `${src.droppedRange ? `，丢弃 CC 控制层 ${src.droppedRange}` : ''} — ${src.label}`);
  for (const r of src.regions) {
    if (!fs.existsSync(r.file)) throw new Error(`采样文件不存在：${r.file}（SFZ 解析出的路径）`);
  }
}

/* ------------------------------------------------------------------ 解码缓存 */
const TMP = path.join(OUT, '_samples');
fs.mkdirSync(TMP, { recursive: true });
const pcm = new Map();
function pcmOf(file) {
  if (pcm.has(file)) return pcm.get(file);
  const tag = path.relative(LIB, file).replace(/[^A-Za-z0-9._-]/g, '_');
  const wav = path.join(TMP, tag.replace(/\.[^.]+$/, '') + '.wav');
  if (!fs.existsSync(wav)) {
    execFileSync('ffmpeg', ['-y', '-i', file, '-ac', '1', '-ar', String(SR), '-c:a', 'pcm_s16le', wav], { stdio: 'ignore' });
  }
  const samples = readWav(wav).samples;
  pcm.set(file, samples);
  return samples;
}

/** 线性插值变速（ratio>1 变高，<1 变低）：真乐器库"最近采样 + 小幅变调"就靠它 */
function resample(src, ratio) {
  if (Math.abs(ratio - 1) < 1e-6) return src;
  const n = Math.max(1, Math.floor(src.length / ratio));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    const w = x - i0;
    out[i] = (src[i0] ?? 0) * (1 - w) + (src[i0 + 1] ?? 0) * w;
  }
  return out;
}

/** 把音高整八度移进 [lo, hi]（真乐器音域窄于钢琴；八度移位不改和声） */
function foldIntoRange(midi, lo, hi) {
  let m = midi;
  while (m < lo) m += 12;
  while (m > hi) m -= 12;
  return m;
}

/* ------------------------------------------------------------------ 谱面 → 触发表 */
const { notes } = parseScoreCsv(fs.readFileSync(SCORE, 'utf8'));
// phrase 模式在渲染器内部算：不依赖谱面里的 velMidi 是哪一档（只要谱面有 velocity 列）
let scoreNotes = notes;
if (DYNAMICS === 'phrase') {
  const phraseOpts = {};
  if (opt('dyn-floor') !== undefined) phraseOpts.floor = Number(opt('dyn-floor'));
  if (opt('dyn-ceiling') !== undefined) phraseOpts.ceiling = Number(opt('dyn-ceiling'));
  const phrase = phraseVelMidi(notes.map((n) => ({ ...n, timeSec: n.step * STEP_SECONDS })), phraseOpts);
  scoreNotes = notes.map((n, i) => ({ ...n, velMidi: phrase[i].velMidi }));
} else if (DYNAMICS === 'interpret') {
  if (!fs.existsSync(SECTIONS_JSON)) {
    throw new Error(`缺少段落表 ${SECTIONS_JSON} —— 先跑 node tools/dynamics-report.mjs 生成（可用 --sections 指定别的文件）`);
  }
  const { sections } = JSON.parse(fs.readFileSync(SECTIONS_JSON, 'utf8'));
  const out = interpretVelMidi(notes.map((n) => ({ ...n, timeSec: n.step * STEP_SECONDS })), sections);
  scoreNotes = notes.map((n, i) => ({ ...n, velMidi: out[i].velMidi }));
}
const { events } = planHifi(scoreNotes);     // 与数据包同一套声部判定/音高口径
const GM = { basedrum: 36, hat: 42 };
const triggers = [];
// 力度 → (采样层, 增益)：
//   measured：用 M3-14 的 velMidi（1..127）——既决定选哪一层采样，也决定增益（-16.7dB..0dB）；
//   flat：维持原状（volume × 127 选层 + 0.55+0.45·volume 的微调）——所以 flat 输出与改造前逐字节一致。
const dynOf = (e) => {
  if (DYNAMICS !== 'flat') {
    const v = Number(e.velMidi);
    if (Number.isFinite(v) && v > 0) {
      return { vel127: Math.max(1, Math.min(127, Math.round(v))), gain: velMidiToAmplitude(v) };
    }
  }
  // 注意用 `e.vol`（谱面原始 volume 列）：`e.volume` 已经是 planHifi 按 velMidi 算出来的播放音量，
  // 拿它当"flat"会变成"二次应用力度"（实测这会悄悄改变 flat 的输出）。
  const vol = Number.isFinite(Number(e.vol)) ? Number(e.vol) : 0.8;
  return { vel127: Math.max(1, Math.min(127, Math.round(vol * 127))), gain: 0.55 + 0.45 * vol };
};
for (const e of events) {
    // M3-24：优先用谱面里的精确时刻（参考演奏的真实时间），否则退回格位时间
    const t = Number.isFinite(e.timeSec) ? e.timeSec : e.step * STEP_SECONDS;
  const { vel127, gain } = dynOf(e);
    if (e.kind === 'vanilla') {
      const layer = e.instr === 'basedrum' ? 'kick' : 'hat';
      if (keep(layer)) triggers.push({ layer, midi: GM[e.instr] ?? 36, vel127, gain, t, durMs: e.durMs, keyMs: e.keyMs });
    } else if (e.timbre === 'strings' && keep('melody')) triggers.push({ layer: 'melody', midi: e.midi, vel127, gain, t, durMs: e.durMs, keyMs: e.keyMs });
    else if (e.timbre === 'bell' && keep('inner')) triggers.push({ layer: 'inner', midi: e.midi, vel127, gain, t, durMs: e.durMs, keyMs: e.keyMs });
    else if (e.timbre === 'bass' && keep('bass')) triggers.push({ layer: 'bass', midi: e.midi, vel127, gain, t, durMs: e.durMs, keyMs: e.keyMs });
}
const dur = Math.max(...triggers.map((x) => x.t), 0) + 8;   // 尾巴留 8 秒（钢琴/竖琴自然衰减）
{
  const vels = triggers.map((x) => x.vel127).sort((a, b) => a - b);
  const q = (p) => vels[Math.floor((vels.length - 1) * p)];
  const layers = new Set(triggers.map((x) => x.vel127));
  const gains = triggers.map((x) => x.gain);
  console.log(`力度口径：${DYNAMICS}（谱面 ${path.basename(SCORE)}）→ `
    + `velMidi min ${vels[0]} / 中位 ${q(0.5)} / p90 ${q(0.9)} / max ${vels.at(-1)}；`
    + `用到 ${layers.size} 个力度层；增益 ${Math.min(...gains).toFixed(3)}..${Math.max(...gains).toFixed(3)}`
    + `（${(20 * Math.log10(Math.max(...gains) / Math.max(1e-9, Math.min(...gains)))).toFixed(1)}dB 动态）`);
}
const N = Math.round(dur * SR);
console.log(`触发合计 ${triggers.length} 条 → 时长 ${dur.toFixed(1)}s（${N} 帧 @${SR}）`);

/* ------------------------------------------------------------------ 逐层渲染（先分层，才能各层独立定标） */
const layerBuf = new Map();
const seqOf = new Map();
for (const layer of Object.keys(sources)) {
  const buf = new Float32Array(N);
  const src = sources[layer];
  const lo = Math.min(...src.regions.map((r) => r.loKey));
  const hi = Math.max(...src.regions.map((r) => r.hiKey));
  let shifted = 0, maxShift = 0, missed = 0, folded = 0, lenApplied = 0, lenMissing = 0;
  for (const trig of triggers) {
    if (trig.layer !== layer) continue;
    // 音域折叠：真乐器音域比钢琴窄（低音提琴最低就到不了 A0），超出部分一律**整八度**移进音域。
    // 八度移位不改和声、也是编曲标准做法；比硬变调 7 个半音（会把拨弦变成"吱吱声")好得多。
    let midi = trig.midi;
    if (midi < lo || midi > hi) { midi = foldIntoRange(midi, lo, hi); folded++; }
    const vel127 = trig.vel127;
    const key = `${layer}:${midi}`;
    const seq = seqOf.get(key) ?? 0;
    seqOf.set(key, seq + 1);
    const region = pickRegion(src.regions, midi, vel127, seq);
    if (!region) { missed++; continue; }
    const shift = midi - region.root + region.tuneCents / 100;
    if (Math.abs(shift) > 1e-6) { shifted++; maxShift = Math.max(maxShift, Math.abs(shift)); }
    const s = resample(pcmOf(region.file), 2 ** (shift / 12));
    const gain = 10 ** (region.gainDb / 20) * trig.gain;
    const off = Math.round(trig.t * SR);
    // 发声时长：有 durMs 就按它放音（+ 一段制音器包络），没有就照旧让采样自然衰减
    let stop = s.length;
    let rel = 0;
    if (LENGTHS && Number.isFinite(trig.durMs) && trig.durMs > 0) {
      let durMs = layer === 'bass' && BASS_KEY && Number.isFinite(trig.keyMs) ? trig.keyMs : trig.durMs;
      if (layer === 'bass' && BASS_CAP > 0 && durMs > BASS_CAP * 1000) durMs = BASS_CAP * 1000;
      const d = Math.round((durMs / 1000) * SR);
      rel = Math.round((releaseMsOf(midi) / 1000) * SR);
      stop = Math.min(s.length, d + rel);
      lenApplied++;
    } else if (Number.isFinite(trig.durMs)) {
      lenMissing++;
    }
    for (let i = 0; i < stop; i++) {
      const j = off + i;
      if (j >= N) break;
      let g = 1;
      if (rel > 0 && i > stop - rel) {
        // raised-cosine 放音（1 → 0），比线性更接近制音器的实际衰减
        g = 0.5 * (1 + Math.cos(Math.PI * (i - (stop - rel)) / rel));
      }
      buf[j] += s[i] * gain * g;
    }
  }
  layerBuf.set(layer, layer === 'bass' && BASS_HPF > 0 ? highpass(buf, SR, BASS_HPF) : buf);
  console.log(`  ${layer}: 触发 ${triggers.filter((x) => x.layer === layer).length} 条；`
    + `整八度折叠 ${folded} 条（音域 ${lo}..${hi}）；变调 ${shifted} 条（最大 ${maxShift.toFixed(2)} 半音）；缺区域 ${missed}`
    + `；按谱面时值放音 ${lenApplied} 条${lenMissing ? `（${lenMissing} 条没有时值，自然衰减）` : ''}`);
}

/* ------------------------------------------------------------------ 定标 + 声像 + 求和 */
const stat = (buf) => {
  let peak = 0, acc = 0;
  for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; acc += v * v; }
  return { peak, rms: Math.sqrt(acc / Math.max(1, buf.length)) };
};
const L = new Float64Array(N);
const R = new Float64Array(N);
for (const [layer, buf] of layerBuf) {
  const cfg = LAYER_GAIN[layer] ?? { rms: -20, pan: 0 };
  const s = stat(buf);
  const target = cfg.gain !== undefined
    ? cfg.gain
    : cfg.rms !== undefined
      ? (s.rms > 0 ? 10 ** (cfg.rms / 20) / s.rms : 0)
      : (s.peak > 0 ? 10 ** (cfg.peak / 20) / s.peak : 0);
  const gl = target * Math.cos((cfg.pan + 1) * Math.PI / 4);
  const gr = target * Math.sin((cfg.pan + 1) * Math.PI / 4);
  for (let i = 0; i < N; i++) { L[i] += buf[i] * gl; R[i] += buf[i] * gr; }
  console.log(`  ${layer} 定标 ${cfg.gain !== undefined ? `固定 ×${cfg.gain}`
    : cfg.rms !== undefined ? `RMS ${cfg.rms}dB` : `峰值 ${cfg.peak}dB`}`
    + `：原始峰值 ${s.peak.toFixed(3)} / RMS ${(20 * Math.log10(s.rms + 1e-12)).toFixed(1)}dBFS → 增益 ×${target.toFixed(2)}`);
}

/* ------------------------------------------------------------------ 总线：归一 + 软限幅 */
if (HPF > 0) {
  const Lh = highpass(L, SR, HPF);
  const Rh = highpass(R, SR, HPF);
  L.set(Lh); R.set(Rh);
}
if (HPF > 0 || BASS_HPF > 0 || BASS_CAP > 0) {
  console.log(`低音处理：总线高通 ${HPF || '关'}Hz（参考演奏 60Hz 以下几乎没能量）；`
    + `左手层高通 ${BASS_HPF || '关'}Hz；左手时值上限 ${BASS_CAP > 0 ? `${BASS_CAP}s` : '不限'}`);
}
let peak = 0, acc = 0;
for (let i = 0; i < N; i++) {
  const a = Math.max(Math.abs(L[i]), Math.abs(R[i]));
  if (a > peak) peak = a;
  acc += (L[i] * L[i] + R[i] * R[i]) / 2;
}
const busRms = Math.sqrt(acc / Math.max(1, N));
const norm = busRms > 0 ? 10 ** (-18 / 20) / busRms : 1;
const knee = 0.75;
const lim = (x) => {
  const y = x * norm;
  const a = Math.abs(y);
  return a <= knee ? y : Math.sign(y) * (knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee)));
};
for (let i = 0; i < N; i++) { L[i] = lim(L[i]); R[i] = lim(R[i]); }
let peak2 = 0;
for (let i = 0; i < N; i++) peak2 = Math.max(peak2, Math.abs(L[i]), Math.abs(R[i]));
console.log(`总线：原始峰值 ${peak.toFixed(2)} / RMS ${(20 * Math.log10(busRms + 1e-12)).toFixed(1)}dBFS`
  + ` → 归一 -18dBFS + 软限幅 → 峰值 ${peak2.toFixed(3)}`);

/* ------------------------------------------------------------------ 输出 */
fs.mkdirSync(OUT, { recursive: true });
const mixF32 = path.join(OUT, `${NAME}_mix_48k_f32.wav`);
fs.writeFileSync(mixF32, encodeWav32fStereo(L, R, SR));
const master = path.join(OUT, `${NAME}_48k24bit.wav`);
execFileSync('ffmpeg', ['-y', '-i', mixF32, '-c:a', 'pcm_s24le', '-ar', String(SR), master], { stdio: 'ignore' });
console.log(`整曲母版（48k/24bit 立体声）→ ${master.replace(/\\/g, '/')}`);
for (const start of SEGS) {
  const a = Math.round(start * SR);
  const b = Math.min(N, a + Math.round(SEC * SR));
  const file = path.join(OUT, `${NAME}_${start}s.wav`);
  fs.writeFileSync(file, encodeWav32fStereo(L.subarray(a, b), R.subarray(a, b), SR));
  console.log(`试听片段 ${start}..${start + SEC}s → ${file.replace(/\\/g, '/')}`);
}

/** 32bit float 立体声 WAV（混音精度保留；转 24bit 母版时不二次丢位） */
function encodeWav32fStereo(l, r, sampleRate) {
  const n = l.length;
  const data = Buffer.alloc(n * 8);
  for (let i = 0; i < n; i++) { data.writeFloatLE(l[i], i * 8); data.writeFloatLE(r[i], i * 8 + 4); }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(3, 20);        // 3 = IEEE float
  head.writeUInt16LE(2, 22);        // 2 = 立体声
  head.writeUInt32LE(sampleRate, 24);
  head.writeUInt32LE(sampleRate * 8, 28);
  head.writeUInt16LE(8, 32);
  head.writeUInt16LE(32, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}
