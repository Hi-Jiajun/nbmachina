#!/usr/bin/env node
// M3-16（P2）· 把我们的真乐器库导出成 mod 用的 `instruments.json`
//
// mod 侧（Java 的 NbforgeInstruments）读这个 JSON，把（乐器, midi, 力度）解析成
// "哪个采样文件 + 变调比 + 增益"，再用自己的 OpenAL 引擎无损播放。
//
// 关键约束：**离线渲染与游戏内必须是同一套映射**——所以这里直接复用 `src/sample/sfz.mjs`
// 的 loadSfz（与 tools/render-ensemble.mjs 同一个解析器、同一条过滤规则），
// 只是把区域表原样导出成 JSON。
//
// 用法：
//   node tools/export-mod-instruments.mjs                     # 写 build/nbforge_instruments.json
//   node tools/export-mod-instruments.mjs --deploy            # 顺带部署到客户端 config/nbforge/
//   node tools/export-mod-instruments.mjs --only salamander48 # 只导一个乐器
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';
import { loadSfz } from '../src/sample/sfz.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);
const TC = 'C:/Users/hiliang/Documents/minecraft/_toolchain';
/** PCL2 开了版本隔离：客户端 gameDir 就是版本目录 */
const CLIENT_GAME_DIR = 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5';

const OUT = opt('out', path.join(P.build, 'nbforge_instruments.json'));
const DEPLOY = has('deploy');

/** 乐器清单：id → SFZ 与署名（顺序即 `/nbfc instruments` 的显示顺序） */
const INSTRUMENTS = [
  {
    id: 'salamander48',
    name: 'Salamander Grand Piano V3（48kHz/24bit 母版）',
    license: 'CC-BY 3.0 · Alexander Holm',
    isDefault: true,
    sfz: `${TC}/piano/salamander48/SalamanderGrandPianoV3_48khz24bit/SalamanderGrandPianoV3.sfz`,
  },
  {
    id: 'disklavier',
    name: 'Yamaha Disklavier Pro（OLPC 完整合集）',
    license: 'CC-BY 3.0 · Zenph Studios / OLPC',
    sfz: `${TC}/olpc/x/yamahaGrandPiano44/yamaha_disklavier_olpc.sfz`,
  },
  {
    id: 'vsco_upright',
    name: 'VSCO 2 CE Upright Piano',
    license: 'CC0 1.0 · Versilian Studios',
    sfz: `${TC}/piano/vsco2ce/VSCO-2-CE-SFZ/UprightPiano.sfz`,
  },
  {
    id: 'disklavier_sf2',
    name: 'Yamaha Disklavier Pro（SF2 子集 · 对照）',
    license: 'CC-BY 3.0 · Zenph Studios / R. G. Saez',
    sfz: `${TC}/piano/disklavier_sfz/acoustic_grand_piano_ydp_20080910.sfz`,
  },
  // ---- 下面三件来自 VSCO 2 CE（CC0）：把贝斯/内声部/打击乐从"钢琴顶替"换成真乐器 ----
  {
    id: 'vsco_harp',
    name: 'VSCO 2 CE Harp（竖琴）',
    license: 'CC0 1.0 · Versilian Studios',
    sfz: `${TC}/piano/vsco2ce/VSCO-2-CE-SFZ/Harp.sfz`,
  },
  {
    id: 'vsco_contrabass_pizz',
    name: 'VSCO 2 CE Solo Contrabass Pizzicato（低音提琴拨弦）',
    license: 'CC0 1.0 · Versilian Studios',
    sfz: `${TC}/piano/vsco2ce/VSCO-2-CE-SFZ/ContrabassPizz.sfz`,
  },
  {
    id: 'vsco_perc',
    name: 'VSCO 2 CE 打击乐（底鼓 + 铃鼓代踩镲）',
    license: 'CC0 1.0 · Versilian Studios',
    // 非音高乐器：键位是我们自己的声部键（basedrum=36 / hat=42），不做八度折叠
    pitched: false,
    custom: () => percussionRegions(`${TC}/piano/vsco2ce/VSCO-2-CE-SFZ/GM-StylePerc.sfz`),
  },
];

/**
 * 打击乐是**非音高乐器**：直接复用 GM-StylePerc.sfz 的两件，按我们的声部键位重映射
 *   · BDrumNewhit（GM36 底鼓）→ 我们的 `basedrum` 键 36
 *   · Tamb1-Hit（GM54 铃鼓）→ 我们的 `hat` 键 42（VSCO 2 CE **没有**闭合踩镲，用铃鼓替代；与离线渲染同一处理）
 * 只取 rr1（round robin 一号），避免同一力度层两个文件争抢。
 */
function percussionRegions(sfzPath) {
  const { regions } = loadSfz(sfzPath);
  const out = [];
  for (const r of regions) {
    const base = r.file.replace(/\\/g, '/').split('/').pop();
    if (base.startsWith('BDrumNewhit') && base.includes('rr1')) {
      out.push({ ...r, loKey: 36, hiKey: 36, root: 36 });
    } else if (base.startsWith('Tamb1-Hit') && base.includes('rr1')) {
      out.push({ ...r, loKey: 42, hiKey: 42, root: 42 });
    }
  }
  return out;
}

const only = opt('only');
const list = only ? INSTRUMENTS.filter((i) => i.id === only) : INSTRUMENTS;
if (only && !list.length) throw new Error(`没有这个乐器：${only}（可选 ${INSTRUMENTS.map((i) => i.id).join('/')}）`);

const out = { generatedAt: new Date().toISOString(), instruments: [] };
const summary = [];
for (const def of list) {
  if (!def.custom && !fs.existsSync(def.sfz)) {
    console.warn(`  跳过 ${def.id}：找不到 ${def.sfz}`);
    continue;
  }
  const loaded = def.custom ? { regions: def.custom(), droppedTrigger: 0, droppedRange: 0 } : loadSfz(def.sfz);
  const { regions, droppedTrigger, droppedRange } = loaded;
  const missing = regions.filter((r) => !fs.existsSync(r.file));
  if (missing.length) {
    console.warn(`  跳过 ${def.id}：${missing.length} 个采样文件不存在（例：${missing[0].file}）`);
    continue;
  }
  out.instruments.push({
    id: def.id,
    name: def.name,
    license: def.license,
    isDefault: !!def.isDefault,
    pitched: def.pitched !== false,
    regions: regions.map((r) => ({
      file: r.file.replace(/\\/g, '/'),
      loKey: r.loKey,
      hiKey: r.hiKey,
      root: r.root,
      loVel: r.loVel,
      hiVel: r.hiVel,
      gainDb: Number((r.gainDb ?? 0).toFixed(3)),
      tuneCents: Number((r.tuneCents ?? 0).toFixed(3)),
    })),
  });
  const roots = new Set(regions.map((r) => r.root));
  summary.push(`${def.id.padEnd(16)} ${String(regions.length).padStart(4)} 区域 / ${String(roots.size).padStart(2)} 根音`
    + `${droppedTrigger ? `（丢松键 ${droppedTrigger}` : ''}${droppedRange ? `，丢 CC ${droppedRange}` : ''}`
    + `${droppedTrigger || droppedRange ? '）' : ''}`);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
const sizeMb = (fs.statSync(OUT).size / 1048576).toFixed(2);
console.log(`写出 ${OUT}（${out.instruments.length} 个乐器，${sizeMb}MB）`);
for (const s of summary) console.log('  ' + s);

if (DEPLOY) {
  const dst = path.join(CLIENT_GAME_DIR, 'config', 'nbforge', 'instruments.json');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(OUT, dst);
  console.log(`已部署 → ${dst}`);
}
