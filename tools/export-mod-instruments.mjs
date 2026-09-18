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
    // M3-26：改用 **高通版**（48Hz 四阶）—— 原始采样自带 20–40Hz 的隆隆声（-32.6dB，
    // 而原视频同频带只有 -55.6dB），用户听到的"不该出现的低音"就是它；60Hz 以上几乎无损。
    name: 'Salamander Grand Piano V3（48kHz/24bit 母版 · 48Hz 高通）',
    license: 'CC-BY 3.0 · Alexander Holm',
    isDefault: true,
    sfz: `${TC}/piano/salamander48_hp/SalamanderGrandPianoV3_hp.sfz`,
  },
  {
    id: 'disklavier',
    name: 'Yamaha Disklavier Pro（OLPC 完整合集）',
    license: 'CC-BY 3.0 · Zenph Studios / OLPC',
    sfz: `${TC}/olpc/x/yamahaGrandPiano44/yamaha_disklavier_olpc.sfz`,
    // M3-31：把同目录的 **sta（断奏）采样**也收进来（SFZ 里只有 leg）——短音优先用 sta。
    // 376 个文件 / 25 个根音 / 86 档力度，命名 `pno<midi><v>v<vel>sta.wav`（另有 pno27 / pno27v85 这类少写前导零的）。
    extra: () => staccatoRegions(`${TC}/olpc/x/yamahaGrandPiano44`),
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

/**
 * M3-31 · 扫描 OLPC 目录里的 **sta（断奏）采样**，生成 region 列表。
 * 命名两种写法都认：`pno021v106sta.wav`（补零）与 `pno27v75sta.wav`（不补零）。
 * 键位区间按"根音一对一"（loKey=hiKey=root），其余键交给引擎的"最近键位 + 变调"兜底；
 * 力度区间取相邻两层的中间值（与 SFZ 的 loVel/hiVel 同口径）。
 */
function staccatoRegions(dir) {
  const files = fs.readdirSync(dir).filter((f) => /^pno\d+v\d+sta\.wav$/i.test(f));
  const byRoot = new Map();
  for (const f of files) {
    const m = f.match(/^pno(\d+)v(\d+)sta\.wav$/i);
    const root = Number(m[1]);
    const vel = Number(m[2]);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push({ vel, file: path.join(dir, f).replace(/\\/g, '/') });
  }
  const out = [];
  for (const [root, list] of byRoot) {
    list.sort((a, b) => a.vel - b.vel);
    for (let i = 0; i < list.length; i++) {
      const loVel = i === 0 ? 1 : Math.floor((list[i - 1].vel + list[i].vel) / 2) + 1;
      const hiVel = i === list.length - 1 ? 127 : Math.floor((list[i].vel + list[i + 1].vel) / 2);
      out.push({
        file: list[i].file, loKey: root, hiKey: root, root,
        loVel, hiVel, gainDb: 0, tuneCents: 0, staccato: true,
      });
    }
  }
  console.log(`  sta 断奏采样：${files.length} 个文件 / ${byRoot.size} 个根音 → ${out.length} 个 region`);
  return out;
}

/**
 * M3-33 · VSCO 2 CE 全集（CC0）—— 用户："把所有乐器的无损采样可商用的都可以装进我们的mod使用，
 * 后期创作各类歌曲就不存在音色音源的瓶颈了。" 目录里 75 个 SFZ（弦乐/铜管/木管/键盘/打击乐），
 * 这里自动生成条目；已经在清单里的 4 件（竖琴/低音提琴拨弦/打击乐/直立钢琴）跳过，避免重复。
 */
const VSCO_DIR = `${TC}/piano/vsco2ce/VSCO-2-CE-SFZ`;
const VSCO_SKIP = new Set(['Harp.sfz', 'ContrabassPizz.sfz', 'GM-StylePerc.sfz', 'UprightPiano.sfz']);

function vscoExtraInstruments() {
  const files = fs.readdirSync(VSCO_DIR).filter((f) => f.toLowerCase().endsWith('.sfz')).sort();
  const out = [];
  for (const f of files) {
    if (VSCO_SKIP.has(f)) continue;
    const base = f.replace(/\.sfz$/i, '');
    const id = 'vsco_' + base.replace(/[^A-Za-z0-9]+/g, '_').replace(/_+$/g, '').toLowerCase();
    const group = fs.statSync(path.join(VSCO_DIR, f)).isFile() ? '' : '';
    out.push({
      id,
      name: `VSCO 2 CE ${base}（${vscoGroupOf(base)}）`,
      license: 'CC0 1.0 · Versilian Studios',
      sfz: path.join(VSCO_DIR, f),
      _group: group,
    });
  }
  return out;
}

/** 按名字猜组别，只用于显示（Strings / Brass / Woodwinds / Keys / Percussion） */
function vscoGroupOf(base) {
  if (/Violin|Viola|Cello|Contrabass|VSUpright/.test(base)) return 'Strings';
  if (/Trumpet|FHorn|Trombone|Tuba/.test(base)) return 'Brass';
  if (/Flute|Oboe|Clarinet|Bassoon|Piccolo/.test(base)) return 'Woodwinds';
  if (/Organ|Piano/.test(base)) return 'Keys';
  if (/Timpani|Glockenspiel|Marimba|Xylophone|TubularBells|Perc/.test(base)) return 'Percussion';
  return 'Misc';
}

INSTRUMENTS.push(...vscoExtraInstruments());

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
  if (def.extra) loaded.regions = [...loaded.regions, ...def.extra()];   // M3-31：附加采样（如 sta 断奏）
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
      staccato: !!r.staccato,
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
