#!/usr/bin/env node
// M3-14 · 钢琴采样库总表
//
// 用户 2026-09-15："把所有钢琴采样和力度采样信息列个表给我瞅瞅"。
// 这个工具扫本机的真钢琴库，输出：
//   · docs/M3-14-piano-inventory.md —— 给人看的表（每库一行 + 许可表）
//   · build/piano_inventory.csv      —— 机器可读（每个"根音"一行，含力度分层边界）
// 数据全部来自 SFZ 索引 + WAV 头（不采样、不渲染），可随时重跑。
//
// 用法：node tools/piano-inventory.mjs
import fs from 'node:fs';
import path from 'node:path';

import { parseSfzText } from '../src/sample/sfz.mjs';
import { resolvePaths } from '../src/core/paths.mjs';

const P = resolvePaths();
const TOOLCHAIN = 'C:/Users/hiliang/Documents/minecraft/_toolchain';
const OUT_MD = path.resolve('docs/M3-14-piano-inventory.md');
const OUT_CSV = path.join(P.build, 'piano_inventory.csv');

const LIBS = [
  {
    id: 'salamander48',
    name: 'Salamander Grand Piano V3（48kHz/24bit 完整母版）',
    license: 'CC-BY 3.0',
    author: 'Alexander Holm',
    sfz: `${TOOLCHAIN}/piano/salamander48/SalamanderGrandPianoV3_48khz24bit/SalamanderGrandPianoV3.sfz`,
    role: '旋律默认（离线渲染 + 数据包 hifi）',
  },
  {
    id: 'salamander_ogg',
    name: 'Salamander Grand Piano V3（Ogg 有损包）',
    license: 'CC-BY 3.0',
    author: 'Alexander Holm',
    sfz: `${TOOLCHAIN}/piano/SalamanderGrandPianoV3_OggVorbis/SalamanderGrandPianoV3.sfz`,
    role: '对照用（同一套映射，只是有损编码）',
  },
  {
    id: 'ydp_olpc_leg',
    name: 'Yamaha Disklavier Pro（OLPC 完整合集 · legato）',
    license: 'CC-BY 3.0',
    author: 'Zenph Studios 录 / OLPC 合集 v2.7',
    sfz: `${TOOLCHAIN}/olpc/x/yamahaGrandPiano44/yamaha_disklavier_olpc.sfz`,
    role: 'Yamaha 主用（30 根音 A0..C8、最多 33 层力度）',
  },
  {
    id: 'ydp_sf2',
    name: 'Yamaha Disklavier Pro（SF2 子集）',
    license: 'CC-BY 3.0',
    author: 'Zenph Studios 录 / Roberto Gordo Saez 编译',
    sfz: `${TOOLCHAIN}/piano/disklavier_sfz/acoustic_grand_piano_ydp_20080910.sfz`,
    role: '对照用（26 根音 A0..C7、3~4 层；顶音区要变调）',
  },
  {
    id: 'vsco_upright',
    name: 'VSCO 2 CE Upright Piano',
    license: 'CC0 1.0',
    author: 'Ivy Audio / Versilian Studios（VSCO 2 CE）',
    sfz: `${TOOLCHAIN}/piano/vsco2ce/VSCO-2-CE-SFZ/UprightPiano.sfz`,
    role: '第三架钢琴（CC0，无署名义务）',
  },
  {
    id: 'vsco_upright1',
    name: 'VSCO 2 CE Upright Nr.1（直出采样）',
    license: 'CC0 1.0',
    author: 'Versilian Studios（VSCO 2 CE）',
    sfz: `${TOOLCHAIN}/piano/vsco2ce/VSCO-2-CE-SFZ/VSUpright1.sfz`,
    role: '备用（同一架琴的另一套采样）',
  },
];

/** 只读 WAV 头里的 fmt 块（不加载音频） */
export function wavFormat(file) {
  if (!fs.existsSync(file)) return null;
  const fd = fs.openSync(file, 'r');
  // 读 4KB：OLPC 的 wav 带 BWF `bext` 块（602 字节），fmt 在 622 字节处，512 字节会读不到。
  const buf = Buffer.alloc(4096);
  const n = fs.readSync(fd, buf, 0, buf.length, 0);
  fs.closeSync(fd);
  if (n < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  let pos = 12;
  while (pos + 8 <= n) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      return {
        format: buf.readUInt16LE(pos + 8),
        channels: buf.readUInt16LE(pos + 10),
        sampleRate: buf.readUInt32LE(pos + 12),
        bits: buf.readUInt16LE(pos + 22),
      };
    }
    pos += 8 + size + (size % 2);
  }
  return null;
}

const near = (midi, roots) => roots.reduce((b, r) => (Math.abs(r - midi) < Math.abs(b - midi) ? r : b), roots[0]);

export function inspectLibrary(lib) {
  if (!fs.existsSync(lib.sfz)) return { ...lib, missing: true };
  const text = fs.readFileSync(lib.sfz, 'utf8');
  const base = path.dirname(lib.sfz);
  // 逐行取 default_path（**别用 `.` 跨行正则**：`default_path=`（空值）后面跟 `<global>` 时，
  // 跨行匹配会把 "<global>" 当成目录，实测导致整库采样全部解析到不存在的路径）。
  const ctrlLine = text.split(/\r?\n/).find((l) => /^\s*default_path\s*=/i.test(l));
  const ctrlVal = ctrlLine ? ctrlLine.replace(/^\s*default_path\s*=\s*/i, '').trim() : '';
  const dir = ctrlVal ? path.resolve(base, ctrlVal.replace(/\\/g, '/')) : base;
  const { regions } = parseSfzText(text);
  const playable = regions.filter((r) => r.trigger === 'attack' && r.hiKey >= 0 && r.loKey <= 127 && r.hiKey >= r.loKey);
  const dropped = regions.length - playable.length;

  const byRoot = new Map();
  const files = new Set();
  for (const r of playable) {
    const file = path.resolve(dir, String(r.sample).replace(/\\/g, '/'));
    files.add(file);
    if (!byRoot.has(r.root)) byRoot.set(r.root, []);
    byRoot.get(r.root).push({ lo: r.loVel, hi: r.hiVel, loKey: r.loKey, hiKey: r.hiKey, file, gainDb: r.gainDb });
  }
  const roots = [...byRoot.keys()].sort((a, b) => a - b);
  const keyLo = Math.min(...playable.map((r) => r.loKey));
  const keyHi = Math.max(...playable.map((r) => r.hiKey));
  const layers = roots.map((r) => byRoot.get(r).length);
  const spacings = [...new Set(roots.slice(1).map((r, i) => r - roots[i]))].sort((a, b) => a - b);

  // 力度分层边界（取第一个根音为例，输出完整边界，给人看清"层是怎么切的"）
  const first = byRoot.get(roots[0]).slice().sort((a, b) => a.lo - b.lo);
  const boundaries = first.map((x) => `${x.lo}-${x.hi}`);

  let bytes = 0;
  for (const f of files) { try { bytes += fs.statSync(f).size; } catch { /* 忽略缺失 */ } }
  const fmt = wavFormat(first[0]?.file);

  // 用最近根音演奏 21..108 时的最大变调
  let maxShift = 0;
  for (let m = 21; m <= 108; m++) maxShift = Math.max(maxShift, Math.abs(m - near(m, roots)));

  return {
    ...lib,
    roots,
    layers,
    layersMin: Math.min(...layers),
    layersMax: Math.max(...layers),
    regions: playable.length,
    dropped,
    keyLo,
    keyHi,
    spacings,
    boundaries,
    fmt,
    files: files.size,
    bytes,
    maxShift,
    byRoot,
  };
}

/* ---------------------------------------------------------------- 主流程 */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/piano-inventory.mjs');
if (!isMain) {
  // 作为模块被单测 import 时只导出两个纯函数（wavFormat / inspectLibrary），不写任何文件
} else {
const results = LIBS.map(inspectLibrary);

/* ---------------- CSV：每个根音一行 ---------------- */
const csv = [
  'library,name,license,root_midi,root_name,key_range,layers,velocity_boundaries,sample_rate,bits,channels,example_sample,gain_db,tune_cents',
];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const nameOf = (m) => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
for (const r of results) {
  if (r.missing) continue;
  for (const root of r.roots) {
    const g = r.byRoot.get(root).slice().sort((a, b) => a.lo - b.lo);
    const lo = Math.min(...g.map((x) => x.loKey));
    const hi = Math.max(...g.map((x) => x.hiKey));
    csv.push([
      r.id, `"${r.name}"`, r.license, root, nameOf(root), `${lo}-${hi}`, g.length,
      `"${g.map((x) => `${x.lo}-${x.hi}`).join(' ')}"`,
      r.fmt?.sampleRate ?? '', r.fmt?.bits ?? '', r.fmt?.channels ?? '',
      `"${path.basename(g[0].file)}"`, g[0].gainDb ?? 0, '',
    ].join(','));
  }
}
fs.writeFileSync(OUT_CSV, csv.join('\n') + '\n', 'utf8');

/* ---------------- Markdown ---------------- */
const mb = (b) => `${(b / 1048576).toFixed(0)}MB`;
const lines = [
  '# M3-14 · 钢琴采样库总表',
  '',
  `> 由 \`node tools/piano-inventory.mjs\` 生成（${new Date().toISOString().slice(0, 10)}）。明细逐根音见 \`build/piano_inventory.csv\`。`,
  '',
  '## 一览',
  '',
  '| 库 | 许可 | 格式 | 录音根音 | 录音音域 | 力度层/根音 | 区域数 | 采样体积 | 最近根音最大变调 |',
  '|---|---|---|---|---|---|---|---|---|',
];
for (const r of results) {
  if (r.missing) {
    lines.push(`| ${r.name} | ${r.license} | — | 采样缺失（${r.sfz}） | — | — | — | — | — |`);
    continue;
  }
  const fmt = r.fmt ? `${(r.fmt.sampleRate / 1000).toFixed(1)}kHz/${r.fmt.bits}bit/${r.fmt.channels}ch` : '—';
  lines.push(`| **${r.name}** | ${r.license} | ${fmt} | ${r.roots.length} 个（每 ${r.spacings.join('/')} 半音）`
    + ` | ${nameOf(r.roots[0])}..${nameOf(r.roots.at(-1))}（midi ${r.roots[0]}..${r.roots.at(-1)}）`
    + ` | ${r.layersMin === r.layersMax ? r.layersMin : `${r.layersMin}~${r.layersMax}`}`
    + ` | ${r.regions}（另丢 ${r.dropped} 层松键/CC） | ${mb(r.bytes)}（${r.files} 文件）`
    + ` | ${r.maxShift} 半音 |`);
}
lines.push('', '## 力度分层是怎么切的', '',
  'SFZ 的 `lovel/hivel` 是"这一层采样负责的力度区间"，区间边界 = **相邻力度采样值的中点**；',
  '力度值来自采样文件名里的实测力度（如 `pno057v43leg.wav` = 57 号音、力度 43、legato）。',
  '下面以每个库的**最低根音**为例，列出它完整的力度分层：', '');
for (const r of results) {
  if (r.missing) continue;
  lines.push(`- **${r.name}**（根音 ${r.roots[0]} = ${nameOf(r.roots[0])}）：${r.layersMin === r.layersMax ? r.layersMin : `${r.layersMin}~${r.layersMax}`} 层`
    + `　${r.boundaries.length > 40 ? `${r.boundaries.slice(0, 40).join(' ')} …（共 ${r.boundaries.length} 层）` : r.boundaries.join(' ')}`);
}
lines.push('', '## 用在什么地方', '');
for (const r of results) lines.push(`- ${r.name}：${r.role}`);
lines.push('', '## 许可与署名（发布成品时必须遵守）', '',
  '| 库 | 作者 | 许可 | 商用 | 署名 |',
  '|---|---|---|---|---|');
for (const r of results) {
  const by = r.license.startsWith('CC0') ? '不需要（CC0 无署名义务，仍鼓励）' : '必须：`Salamander Grand Piano V3 — Alexander Holm (CC-BY 3.0)` 类同';
  lines.push(`| ${r.name} | ${r.author} | ${r.license} | ✅ | ${by} |`);
}
lines.push('', '> 采样本体不进仓库（`_toolchain/` 已 gitignore）；本表只记录来源、规格与核验方式。',
  '> 上游核验过程见 `docs/M3-13-audio-sources.md`。', '');
fs.writeFileSync(OUT_MD, lines.join('\n') + '\n', 'utf8');

/* ---------------- 控制台 ---------------- */
for (const r of results) {
  if (r.missing) { console.log(`MISSING ${r.id}: ${r.sfz}`); continue; }
console.log(`${r.id.padEnd(18)} ${String(r.roots.length).padStart(2)} 根音（每 ${r.spacings.join('/')} 半音）`
    + ` 力度层 ${r.layersMin}~${r.layersMax} 区域 ${r.regions} ${mb(r.bytes)}`
    + ` ${r.fmt ? `${(r.fmt.sampleRate / 1000).toFixed(1)}k/${r.fmt.bits}bit` : ''} 最大变调 ${r.maxShift}`);
}
console.log(`\n写出：${OUT_MD}\n      ${OUT_CSV}`);
}
