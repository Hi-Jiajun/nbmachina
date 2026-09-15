#!/usr/bin/env node
// M3-13 · 把 OLPC/Zenph 的 Yamaha Disklavier Pro 完整多奏法采样索引成 SFZ
//
// 为什么需要它：Salamander 发布页里附带的那只 SF2 只是这批采样的**子集**
// （26 根音 A0..C7、每根音 3~4 层力度）；OLPC 原始合集里是 30 根音（A0..C8）
// × 最多 33 层 leg 力度 + 16 层 sta，共 1212 个采样（862MB）。
// 核验过程见 docs/M3-13-audio-sources.md；SF2 版本保留为 `--artic leg` 的对照。
//
// 文件名规则：`pno<音高 2~3 位>v<力度 1~3 位><leg|sta>[-click].wav`
//   · leg      = legato（按住弹的完整时值）→ 默认用它
//   · sta      = staccato（短触）→ 暂不启用（谱面目前没有"音符时值"信息，等做断奏再开）
//   · -click   = 带机械杂音的重录 → 丢弃
// 键位区间 = 相邻音高的中点；力度区间 = 相邻力度的中点（与 tools/sf2-dump.mjs 同一套规则）。
//
// 用法：node tools/import-olpc-piano.mjs --dir <采样目录> [--out <sfz>] [--artic leg]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const DIR = opt('dir', 'C:/Users/hiliang/Documents/minecraft/_toolchain/olpc/x/yamahaGrandPiano44');
const ARTIC = String(opt('artic', 'leg')).toLowerCase();
const OUT = opt('out', path.join(DIR, 'yamaha_disklavier_olpc.sfz'));
if (!['leg', 'sta', 'both'].includes(ARTIC)) throw new Error('--artic 只支持 leg/sta/both');

const RE = /^pno(\d{2,3})v(\d{1,3})(leg|sta)(-click)?\.wav$/i;
const byPitch = new Map();
let scanned = 0, clicks = 0, otherArtic = 0;

for (const e of fs.readdirSync(DIR, { withFileTypes: true })) {
  if (!e.isFile()) continue;
  scanned++;
  const m = RE.exec(e.name);
  if (!m) continue;
  if (m[4]) { clicks++; continue; }                       // 带杂音的重录丢弃
  const artic = m[3].toLowerCase();
  if (ARTIC !== 'both' && artic !== ARTIC) { otherArtic++; continue; }
  const pitch = +m[1];
  const vel = +m[2];
  if (!byPitch.has(pitch)) byPitch.set(pitch, []);
  byPitch.get(pitch).push({ vel, file: e.name });
}
if (!byPitch.size) throw new Error(`目录里没有匹配的采样：${DIR}`);

const pitches = [...byPitch.keys()].sort((a, b) => a - b);
/** 相邻中点切分：返回 [lo, hi] 数组（第一段从 0 起、最后一段到 127） */
function splitRanges(keys) {
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const hi = i === keys.length - 1 ? 127 : Math.floor((keys[i] + keys[i + 1]) / 2);
    const lo = i === 0 ? 0 : out[i - 1].hi + 1;
    out.push({ key: keys[i], lo, hi });
  }
  return out;
}

const keyRanges = splitRanges(pitches);
const lines = [
  `// 由 tools/import-olpc-piano.mjs 生成 — Zenph Studios Yamaha Disklavier Pro（OLPC 完整合集）`,
  `// 许可：CC-BY 3.0（Zenph Studios 为 OLPC 录制；编译自 OLPC Sound Samples v2.7）`,
  `// 奏法：${ARTIC}；音高 ${pitches.length} 个（${pitches[0]}..${pitches.at(-1)}）；` +
    `键位区间 = 相邻音高中点，力度区间 = 相邻力度中点`,
  '<control>',
  'default_path=',
  '<global>',
  'ampeg_release=0.6',
];
let regions = 0;
let maxShift = 0;
let layersMin = Infinity, layersMax = 0;
for (const kr of keyRanges) {
  const list = byPitch.get(kr.key).sort((a, b) => a.vel - b.vel);
  layersMin = Math.min(layersMin, list.length);
  layersMax = Math.max(layersMax, list.length);
  const velRanges = splitRanges(list.map((x) => x.vel));
  for (const vr of velRanges) {
    const sample = list.find((x) => x.vel === vr.key).file;
    lines.push(`<region> sample=${sample} lokey=${kr.lo} hikey=${kr.hi} pitch_keycenter=${kr.key} lovel=${vr.lo} hivel=${vr.hi}`);
    regions++;
  }
  maxShift = Math.max(maxShift, kr.key - kr.lo, kr.hi - kr.key);
}
fs.writeFileSync(OUT, lines.join('\n') + '\n');

console.log(`扫描 ${scanned} 个文件 → 采用 ${regions} 个区域（丢弃 click ${clicks} / 非 ${ARTIC} 奏法 ${otherArtic}）`);
console.log(`音高 ${pitches.length} 个：${pitches.join(' ')}`);
console.log(`每根音力度层数：${layersMin}..${layersMax}；键位最大变调 ${maxShift} 半音`);
console.log(`SFZ → ${OUT.replace(/\\/g, '/')}`);
