#!/usr/bin/env node
// 钢琴音色试听渲染器（M3-9）：把**采样库里的真钢琴**按谱面渲成对照 wav，供人耳挑选音色。
//
// 与游戏内路径的区别（有意保留）：
//   · 游戏内：数据包 `/playsound nbforge:<voice>_<note>`（每半音一采样 + 音量当力度）
//   · 这里：真钢琴库是"每小三度一采样 × 16 层力度"= 取**最近采样 + 小幅变调** + **按力度选层**
//     （这正是采样库该有的用法；单层会有"机关枪感"）
//
// 用法：
//   node tools/audition-piano.mjs --voice salamander --lib <库目录> --segments 0,226,284
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { readWav, encodeWav } from '../src/analyze/dsp.mjs';
import { resolvePaths } from '../src/core/paths.mjs';
import { STEP_SECONDS } from '../src/emit/tick-map.mjs';
import { parseScoreCsv, planHifi } from '../src/emit/playsound-hifi.mjs';
import { SAMPLE_RATE } from '../src/synth/synth.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();
const B = P.build;

const VOICE = opt('voice', 'salamander');
const LIB = opt('lib', path.join('C:/Users/hiliang/Documents/minecraft/_toolchain/piano/SalamanderGrandPianoV3_OggVorbis/ogg'));
const SEGS = opt('segments', '0,226,284').split(',').map(Number);
const SEC = Number(opt('sec', '30'));
const OUTDIR = opt('out', path.join(B, 'audition'));

/* ---------------- 采样库索引：<音名><八度>v<层>.ogg → {midi: [层1..层N]} ---------------- */
const NAMES = { c: 0, cs: 1, d: 2, ds: 3, e: 4, f: 5, fs: 6, g: 7, gs: 8, a: 9, as: 10, b: 11 };
const midiOfName = (s) => {
  const m = /^([a-g]s?)(-?\d)$/i.exec(s);
  if (!m) return null;
  const base = NAMES[m[1].toLowerCase()];
  if (base === undefined) return null;
  return base + (parseInt(m[2], 10) + 1) * 12;
};
// 自家合成音色（对比基准）：走同一套混合代码，只换采样来源 → 对比才公平
const SYNTH = VOICE === 'strings' || VOICE === 'bell' || VOICE === 'bass' || VOICE === 'piano';
const index = new Map();                       // midi → [ {layer, file} ]
if (SYNTH) {
  const dir = path.join(B, 'audio_nbforge', 'wav', VOICE);
  for (const f of fs.readdirSync(dir)) {
    const m = /^([a-g]s?-?\d)\.wav$/i.exec(f);
    if (!m) continue;
    const midi = midiOfName(m[1]);
    if (midi === null) continue;
    index.set(midi, [{ layer: 1, file: path.join(dir, f) }]);
  }
}
for (const f of (SYNTH ? [] : fs.readdirSync(LIB))) {
  const m = /^([a-g]s?-?\d)v(\d+)\.(ogg|wav|flac)$/i.exec(f);
  if (!m) continue;
  const midi = midiOfName(m[1]);
  if (midi === null) continue;
  if (!index.has(midi)) index.set(midi, []);
  index.get(midi).push({ layer: +m[2], file: path.join(LIB, f) });
}
for (const [, v] of index) v.sort((a, b) => a.layer - b.layer);
const sampled = [...index.keys()].sort((a, b) => a - b);
console.log(`库索引：${VOICE}  采样音数=${sampled.length}  范围 midi ${sampled[0]}..${sampled.at(-1)}  层数=${[...index.values()][0].length}`);

/* ---------------- 解码缓存（ogg → 单声道 PCM，44.1k） ---------------- */
const TMP = path.join(B, '_audition_tmp');
fs.mkdirSync(TMP, { recursive: true });
const pcmCache = new Map();
function pcmOf(file) {
  if (pcmCache.has(file)) return pcmCache.get(file);
  const wav = path.join(TMP, `${path.basename(file).replace(/\.[^.]+$/, '')}.wav`);
  if (!fs.existsSync(wav)) {
    execFileSync('ffmpeg', ['-y', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', wav], { stdio: 'ignore' });
  }
  const data = readWav(wav).samples;
  pcmCache.set(file, data);
  return data;
}
/** 按 ratio 变速（线性插值）= 模拟 /playsound 的 pitch */
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
const nearest = (midi) => sampled.reduce((best, m) => (Math.abs(m - midi) < Math.abs(best - midi) ? m : best), sampled[0]);
const layerOf = (layers, vol) => {
  const i = Math.min(layers.length - 1, Math.max(0, Math.round((vol - 0.2) / 0.8 * (layers.length - 1))));
  return layers[i];
};

/* ---------------- 谱面：旋律用真钢琴，其余层保持现有合成音色（便于同编曲对比） ---------------- */
const { notes } = parseScoreCsv(fs.readFileSync(P.machineScore, 'utf8'));
const { events } = planHifi(notes);            // 用同一套声部判定/音高口径
const melody = events.filter((e) => e.kind === 'synth' && e.timbre === 'strings');   // = 旋律层
console.log(`旋律层音符：${melody.length}（midi ${Math.min(...melody.map((e) => e.midi))}..${Math.max(...melody.map((e) => e.midi))}）`);

fs.mkdirSync(OUTDIR, { recursive: true });
const root = parseFloat(opt('shift', '0'));    // 整体变调（半音），默认 0 = 原曲音高
for (const start of SEGS) {
  const from = Math.round(start * SAMPLE_RATE);
  const to = Math.round((start + SEC) * SAMPLE_RATE);
  const out = new Float64Array(to - from);
  let mixed = 0;
  for (const e of melody) {
    const t = e.step * STEP_SECONDS;
    if (t < start || t > start + SEC) continue;
    const target = e.midi + root;
    const src = nearest(target);
    const layers = index.get(src);
    const ratio = 2 ** ((target - src) / 12);          // 变调比（±1.5 半音内）
    const s = resample(pcmOf(layerOf(layers, e.volume === undefined ? 0.8 : Number(e.volume)).file), ratio);
    const off = Math.round(t * SAMPLE_RATE) - from;
    const g = Number(e.volume);                        // 谱面力度：层已按力度选了，这里只做小幅微调
    for (let i = 0; i < s.length; i++) {
      const j = off + i;
      if (j >= out.length) break;
      out[j] += s[i] * (0.55 + 0.45 * g);
    }
    mixed++;
  }
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  const gain = peak > 0.99 ? 0.99 / peak : 1;
  if (gain !== 1) for (let i = 0; i < out.length; i++) out[i] *= gain;
  const file = path.join(OUTDIR, `ab_${VOICE}_${start}s.wav`);
  fs.writeFileSync(file, encodeWav({ samples: out, sampleRate: SAMPLE_RATE }));
  console.log(`  ${start}s：混入旋律 ${mixed} 颗（峰值 ${peak.toFixed(2)} → 增益 ${gain.toFixed(2)}）→ ${file.replace(/\\/g, '/')}`);
}
