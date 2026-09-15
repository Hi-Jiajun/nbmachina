#!/usr/bin/env node
// 半音阶对比（M3-12）：同一架钢琴库，
//   A) 变调版：midi 21..108 逐个半音，每个音取**最近录音 + 变调**（= 游戏内采样库的常规做法）
//   B) 原始版：只弹库里**真正录过**的那些音，完全不变调
// 目的：让你直接听"变调"到底听不听得出、以及听到什么程度。
//   node tools/audition-scale.mjs --lib <ogg目录> --gap 0.75 --hold 1.0
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { encodeWav } from '../src/analyze/dsp.mjs';
import { SAMPLE_RATE } from '../src/synth/synth.mjs';
import { parseSfz } from './import-sfz.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const LIB = opt('lib', 'C:/Users/hiliang/Documents/minecraft/_toolchain/piano/SalamanderGrandPianoV3_OggVorbis/ogg');
const SFZ = opt('sfz', null);              // VSCO 这类库走 SFZ 索引（文件名不规律）
const OUT = opt('out', 'C:/Users/hiliang/Documents/minecraft/build/audition_scale');
const GAP = Number(opt('gap', '0.75'));      // 每个音间隔（秒）
const HOLD = Number(opt('hold', '1.0'));     // 每个音保留时长（秒）
const VEL = Number(opt('vel', '0.8'));       // 取哪一档力度层

const NAMES = { c: 0, cs: 1, d: 2, ds: 3, e: 4, f: 5, fs: 6, g: 7, gs: 8, a: 9, as: 10, b: 11 };
/** 音名（含 `#`/`s`/`b` 三种写法）→ midi。完整母版用 `D#1` 这种写法，必须支持 `#`。 */
function midiOfName(tok) {
  const m = /^([a-g])([#sb]?)(-?\d)$/i.exec(tok);
  if (!m) return null;
  let semi = NAMES[m[1].toLowerCase()];
  if (semi === undefined) return null;
  if (m[2] === '#' || m[2].toLowerCase() === 's') semi += 1;
  if (m[2].toLowerCase() === 'b') semi -= 1;
  return semi + (parseInt(m[3], 10) + 1) * 12;
}
const index = new Map();
for (const f of fs.readdirSync(LIB)) {
  const m = /^([a-g][#sb]?-?\d)v(\d+)\.(ogg|wav|flac)$/i.exec(f);
  if (!m) continue;
  const midi = midiOfName(m[1]);
  if (midi === null) continue;
  if (!index.has(midi)) index.set(midi, []);
  index.get(midi).push({ layer: +m[2], file: path.join(LIB, f), center: midi });
}
if (SFZ) {
  // 口径（2026-09-15 修正）：SFZ 的 lokey/hikey 是"这段采样负责的键位范围"，
  // 真正录下来的音高是 pitch_keycenter。旧实现把覆盖键位当录音点 →
  // 「变调版」永远选中同键位采样、统计恒为 0 半音，等于没测（实测 VSCO 报 0/88）。
  // 现在每个键位条目都记住它的录音根音，变调幅度 = 播放键 − 根音。
  const { regions } = parseSfz(SFZ);
  for (const r of regions) {
    if (!fs.existsSync(r.file)) continue;
    for (let m = r.lo; m <= r.hi && m <= 127; m++) {
      if (!index.has(m)) index.set(m, []);
      index.get(m).push({ layer: r.lovel, file: r.file, center: r.center });
    }
  }
  const ns = new Set(regions.filter((r) => fs.existsSync(r.file)).map((r) => r.center)).size;
  console.log(`（SFZ 模式：${path.basename(SFZ)} → 覆盖 ${index.size} 个键位 / ${ns} 个录音根音）`);
}
for (const [, v] of index) v.sort((a, b) => a.layer - b.layer);
const centers = [...index.keys()].sort((a, b) => a - b);
// 真正"录过"的音高：文件名模式 = 文件名里的音名；SFZ 模式 = 各 region 的 pitch_keycenter
const roots = SFZ
  ? [...new Set([...index.values()].flat().map((e) => e.center))].sort((a, b) => a - b)
  : centers;
console.log(`库：${roots.length} 个录音点  midi ${roots[0]}..${roots.at(-1)}  每音层数 ${index.get(roots[0]).length}`);
console.log(`录音点列表：${roots.join(' ')}`);

const TMP = path.join(OUT, '_tmp');
fs.mkdirSync(TMP, { recursive: true });
const cache = new Map();
function pcm(file) {
  if (cache.has(file)) return cache.get(file);
  // 一律经 ffmpeg 解码成 44.1k/16bit 临时文件：完整母版是 **48kHz/24bit WAV**，
  // 直接用下面的 16bit 读取器会读出垃圾（前缀 dec_ 避免与源文件同名冲突）。
  const wav = path.join(TMP, 'dec_' + path.basename(file).replace(/\.(ogg|flac|wav)$/i, '.wav'));
  if (!fs.existsSync(wav)) {
    execFileSync('ffmpeg', ['-y', '-i', file, '-ac', '1', '-ar', String(SAMPLE_RATE), '-c:a', 'pcm_s16le', wav], { stdio: 'ignore' });
  }
  const buf = fs.readFileSync(wav);
  // 极简 16bit PCM 读取（此处只要数据，不用完整 WAV 解析）
  const off = buf.indexOf(Buffer.from('data')) + 8;
  const n = (buf.length - off) >> 1;
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = buf.readInt16LE(off + i * 2) / 32768;
  cache.set(file, s);
  return s;
}
function shift(src, ratio) {
  if (Math.abs(ratio - 1) < 1e-9) return src;
  const n = Math.max(1, Math.floor(src.length / ratio));
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = Math.floor(x), w = x - i0;
    o[i] = (src[i0] ?? 0) * (1 - w) + (src[i0 + 1] ?? 0) * w;
  }
  return o;
}
const layerOf = (layers) => layers[Math.min(layers.length - 1, Math.max(0, Math.round((VEL - 0.2) / 0.8 * (layers.length - 1))))];
const nearest = (list, midi) => list.reduce((b, m) => (Math.abs(m - midi) < Math.abs(b - midi) ? m : b), list[0]);
const holdN = Math.round(HOLD * SAMPLE_RATE);
const fadeN = Math.round(0.06 * SAMPLE_RATE);
function render(list, file) {
  const gapN = Math.round(GAP * SAMPLE_RATE);
  const out = new Float64Array(gapN * list.length + holdN);
  let peak = 0;
  list.forEach((item, i) => {
    const s = item.samples;
    const off = i * gapN;
    for (let k = 0; k < Math.min(holdN, s.length); k++) {
      let g = 1;
      if (k > holdN - fadeN) g = Math.max(0, (holdN - k) / fadeN);     // 尾部淡出
      const v = s[k] * g;
      out[off + k] += v;
      peak = Math.max(peak, Math.abs(out[off + k]));
    }
  });
  const g = peak > 0.9 ? 0.9 / peak : 1;
  for (let i = 0; i < out.length; i++) out[i] *= g;
  fs.writeFileSync(file, encodeWav({ samples: out, sampleRate: SAMPLE_RATE }));
  console.log(`  ${list.length} 个音 → ${file.replace(/\\/g, '/')}（增益 ${g.toFixed(2)}）`);
}

// A) 变调版：midi 21..108 逐半音（取覆盖该键位的采样，按 播放键 − 录音根音 变调）
const a = [];
for (let midi = 21; midi <= 108; midi++) {
  const entry = layerOf(index.get(midi) ?? index.get(nearest(centers, midi)));
  const semis = midi - entry.center;
  a.push({ midi, shift: semis, samples: shift(pcm(entry.file), 2 ** (semis / 12)) });
}
// B) 原始版：只弹真正录过的音（根音自己），完全不变调
const b = roots.map((root) => ({ midi: root, shift: 0, samples: pcm(layerOf(index.get(root)).file) }));
console.log(`变调幅度分布：${a.filter((x) => x.shift !== 0).length}/${a.length} 个音需要变调，最大 ${Math.max(...a.map((x) => Math.abs(x.shift)))} 半音`);
render(a, path.join(OUT, 'scale_shifted.wav'));
render(b, path.join(OUT, 'scale_native.wav'));

