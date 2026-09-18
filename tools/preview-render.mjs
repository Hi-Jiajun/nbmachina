#!/usr/bin/env node
// 离线混音预览（M3-5）：把谱面按**与资源包完全相同的采样 + 完全相同的映射**混成 wav，
// 用来在播放器里直接 A/B，不必进游戏、不受空间/音量/记忆影响。
//
//   node tools/preview-render.mjs --mode true     # 原曲音高（谱面 midi 列）
//   node tools/preview-render.mjs --mode folded   # 旧口径：折叠到音符盒音域的 row→midi
//   node tools/preview-render.mjs --from 40 --to 70 --out build/preview_40s.wav
//
// 与游戏内一致性：直接用 src/emit/playsound-hifi.mjs 的 planHifi() 得到事件表（同一个函数、
// 同一批音色选择与音高判定），只是把 `/playsound` 换成"把采样读进来按 0.12s/step 累加"。
// 打击乐（basedrum/hat）在游戏里走原版音色，这里**不合成**（只统计），所以预览里没有鼓。
import fs from 'node:fs';
import path from 'node:path';

import { encodeWav, readWav } from '../src/analyze/dsp.mjs';
import { resolvePaths } from '../src/core/paths.mjs';
import { STEP_SECONDS } from '../src/emit/tick-map.mjs';
import { parseScoreCsv, planHifi } from '../src/emit/playsound-hifi.mjs';
import { SAMPLE_RATE } from '../src/synth/synth.mjs';
import { midiFromRow } from '../src/synth/voices.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();
const AUDIO = path.join(P.build, 'audio_nbmachina', 'wav');

const MODE = opt('mode', 'true');          // true = 原曲音高；folded = 折叠 row 口径
const MELODY = opt('melody', 'piano');     // 旋律层音色：piano（M3-6 新）| strings（M2-1 旧）
const FROM = Number(opt('from', 0));
const TO = Number(opt('to', 1e9));
const OUT = opt('out', path.join(P.build, `preview_${MODE}${FROM || TO < 1e9 ? `_${FROM}-${TO}s` : ''}.wav`));

const csv = fs.readFileSync(P.machineScore, 'utf8');
const { notes } = parseScoreCsv(csv);
if (MODE === 'folded') {
  for (const n of notes) n.midi = midiFromRow(n.instr === 'bass' ? 'bass' : 'harp', n.row);
}
const { events, stats } = planHifi(notes, { melody: MELODY });   // bassOctave 默认 0（不做任何升降）

const cache = new Map();
const sampleOf = (e) => {
  if (cache.has(e.note)) return cache.get(e.note);
  const file = path.join(AUDIO, e.timbre, `${e.note}.wav`);
  const data = fs.existsSync(file) ? readWav(file) : null;
  cache.set(e.note, data);
  return data;
};

const fromSample = Math.floor(FROM * SAMPLE_RATE);
const toSample = Math.min(
  Math.ceil(TO * SAMPLE_RATE),
  Math.ceil((Math.max(...notes.map((n) => n.step)) + 8) * STEP_SECONDS * SAMPLE_RATE),
);
const out = new Float64Array(toSample - fromSample);

let mixed = 0; let missing = 0;
for (const e of events) {
  if (e.kind !== 'synth') continue;
  const t = e.step * STEP_SECONDS;
  if (t < FROM || t > TO) continue;
  const s = sampleOf(e);
  if (!s) { missing++; continue; }
  const off = Math.round(t * SAMPLE_RATE) - fromSample;
  // 与游戏内一致：采样里烘死的是 REFERENCE_VEL，播放时用它当作音量；谱面 volume 直接乘上去
  for (let i = 0; i < s.samples.length; i++) {
    const j = off + i;
    if (j >= out.length) break;
    out[j] += s.samples[i] * e.volume;
  }
  mixed++;
}

// 简单软限幅，避免密集段削顶爆音
let peak = 0;
for (const v of out) peak = Math.max(peak, Math.abs(v));
const gain = peak > 0.99 ? 0.99 / peak : 1;
if (gain !== 1) for (let i = 0; i < out.length; i++) out[i] *= gain;

fs.writeFileSync(OUT, encodeWav({ samples: out, sampleRate: SAMPLE_RATE }));
console.log(`模式=${MODE}  旋律=${MELODY}  区间=${FROM}..${TO}s  混入音符=${mixed}（缺采样 ${missing}）  增益=${gain.toFixed(3)}`);
console.log(`音高：${JSON.stringify(stats.octaveFallback != null ? { octaveFallback: stats.octaveFallback } : {})}`
  + `  打击乐（未合成）=${stats.vanilla}  内声部=${stats.inner}`);
console.log(`产物：${OUT.replace(/\\/g, '/')}`);
