// M2-1 · 把自研采样打成 Minecraft 资源包（1.21.10）
//
// 产物：
//   build/nbforge_resources/pack.mcmeta                      ← pack_format 69 + min_format/max_format 69
//   build/nbforge_resources/assets/nbforge/sounds.json       ← 148 条事件 nbforge:strings_fs4 …
//   build/nbforge_resources/assets/nbforge/sounds/<音色>/<音名>.ogg
//   build/nbforge_resources.zip                              ← 同一个包的可分发 zip（可复现）
//   若 testserver/ 存在：再复制一份到 testserver/resourcepacks/nbforge_resources/
//   若存在客户端实例的 resourcepacks/（PCL2 实例）：把 **zip** 复制进去 —— 这是"真的能听到"的唯一途径
//   （专用服不会给玩家放音；音色永远由客户端资源包决定）
//
// 为什么是 69：读的是 version.json 里的 pack_version.resource_major（1.21.10 → 69），不是猜的；
// tests/synth.test.mjs 有一条断言拿 jar 复核这个常量。
//
// 为什么还要 min_format/max_format（2026-09-14 实测，客户端日志原文）：
//   Couldn't load file/nbforge_resources.zip pack metadata:
//   Pack declares support for version newer than 64, but is missing mandatory fields min_format and max_format
// → 1.21.9+ 的格式号进到"主/次"两段版本后，声明 >64 的包**必须**同时给 min_format/max_format。
//   vanilla 自己的内置数据包就是这么写的（客户端 jar 里 data/minecraft/datapacks/redstone_experiments/pack.mcmeta：
//   {"pack":{"description":{...},"max_format":88,"min_format":88}}，88 正是它的 data_major）。
//   这里三件套都给：pack_format 照顾老读取器，min/max 满足新校验，三者取值一致不会自相矛盾。
//
// 用法：node src/emit/resource-pack.mjs [--audio <dir>] [--out <dir>] [--zip <file>] [--no-copy]
// 相对路径按 minecraft 工程根解析（`--audio build/audio_nbforge`、`testserver/resourcepacks/...`）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildZip } from './zip-writer.mjs';
import {
  REGISTERS, SOUND_NAMESPACE, TIMBRES, noteFileName, registerSize, soundPathOf,
} from '../synth/voices.mjs';
import { resolvePaths } from '../core/paths.mjs';

export const PACK_FORMAT = 69;
export const PACK_DESCRIPTION = 'nbforge 自研音色（零第三方采样：Karplus–Strong 拨弦 / 加法铺底 / 模态钟琴）';

// M2-3：build 目录走 paths.mjs
const P = resolvePaths();
const BUILD = P.build;
// minecraft 工程根 = build 目录的上一级（过去写死成 C:/Users/hiliang/Documents/minecraft，可用 NBFORGE_MC 覆盖）
const MINECRAFT = process.env.NBFORGE_MC ?? path.dirname(BUILD);

/** 客户端资源包目录候选（PCL2 实例；可用 NBFORGE_CLIENT_RESOURCEPACKS 覆盖） */
export const CLIENT_PACK_DIRS = [
  process.env.NBFORGE_CLIENT_RESOURCEPACKS,
  'C:/Program Files/PCL2/.minecraft/resourcepacks',
  'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5/resourcepacks',
].filter(Boolean);

/** 把资源包 zip 复制到第一个存在的客户端 resourcepacks 目录（失败不抛：返回原因） */
export function copyClientPack(zipPath, dirs = CLIENT_PACK_DIRS) {
  const tried = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) { tried.push(`${dir}（不存在）`); continue; }
    try {
      const dest = path.join(dir, path.basename(zipPath));
      fs.copyFileSync(zipPath, dest);
      return { dest, tried };
    } catch (e) {
      tried.push(`${dir}（失败：${e.code ?? e.message}）`);
    }
  }
  return { dest: null, tried };
}

/** 收集采样清单：每个音色的每个半音一个文件（缺文件会在 buildResourcePack 里报出来） */
export function collectSamples(audioDir, { ext = 'ogg' } = {}) {
  const entries = [];
  const missing = [];
  for (const timbre of TIMBRES) {
    // 音域常量只有 voices.mjs 一处来源（REGISTERS），这里不重写一份，避免两处漂移
    const [lo, hi] = REGISTERS[timbre];
    for (let midi = lo; midi <= hi; midi++) {
      const file = path.join(audioDir, ext, timbre, `${noteFileName(midi)}.${ext}`);
      if (fs.existsSync(file)) entries.push({ timbre, midi, file });
      else missing.push({ timbre, midi, file });
    }
  }
  return { entries, missing };
}

/**
 * 后端 A（Fabric mod）自带的 `sounds.json` 里定义了 `demo_bell/demo_pad/demo_strings/demo_bass`
 * 四个演示音色，它们与资源包**同属 `nbforge` 命名空间**。Minecraft 的 SoundManager 会按键合并
 * 各资源包的 sounds.json（同键高优先级覆盖），所以正常情况下两者共存；但"万一某版本/某加载器
 * 按整文件覆盖"，mod 的四个 demo_* 就会解析不到 → 装好 mod 却听不见声。
 * 这里在资源包里补四个**别名**（指向同一批采样，不新增文件），把这种不确定性消掉。
 */
export const DEMO_ALIASES = {
  demo_bell: { path: 'bell/a3', attenuation: 32 },
  demo_pad: { path: 'pad/c4', attenuation: 32 },
  demo_strings: { path: 'strings/e4', attenuation: 32 },
  demo_bass: { path: 'bass/a1', attenuation: 32 },
};

/**
 * 静音采样（后端 A 用）：`minecraft:sounds.json` 里没有 `intentionally_empty` 这种现成静音事件
 * （实测 1.21.10 的 1770 个键里没有它，用它只会刷 "Unable to play empty soundEvent" 警告），
 * 所以这里随包发一个 0.05 秒的静音 ogg。mod 在 `#hifi=1`（自研音色模式）时把音符盒的声音
 * 替换成 `nbforge:silent` —— 粒子/动画照旧，但不再有原版 harp/bass 声音跟自研音色叠在一起。
 */
export const SILENT_EVENT = 'silent';
const SILENT_OGG = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'synth', 'assets', 'silent.ogg');

/** sounds.json：一个采样一条事件；name 用相对路径（命名空间 = sounds.json 所在目录的命名空间 nbforge） */
export function buildSoundsJson(entries) {
  const out = {};
  for (const e of entries) {
    out[`${e.timbre}_${noteFileName(e.midi)}`] = {
      // ⚠️ `name` 必须**写全命名空间**：不带命名空间时客户端按 `minecraft:` 解析，
      // 于是去找 `minecraft:sounds/strings/g3.ogg` → 找不到 → 事件变成"零采样"
      // → 每个音都报 `Unable to play empty soundEvent`（就是"自研音色一直听不到"的真根因，
      //    2026-09-14 15:36 客户端日志实测）。
      sounds: [{ name: `${SOUND_NAMESPACE}:${soundPathOf(e.timbre, e.midi)}`, stream: false, attenuation_distance: 16 }],
    };
  }
  for (const [key, a] of Object.entries(DEMO_ALIASES)) {
    out[key] = { sounds: [{ name: `${SOUND_NAMESPACE}:${a.path}`, stream: false, attenuation_distance: a.attenuation }] };
  }
  out[SILENT_EVENT] = { sounds: [{ name: `${SOUND_NAMESPACE}:${SILENT_EVENT}`, stream: false }] };
  return out;
}

/**
 * 打包资源包。
 * @returns {{sounds:number, bytes:number, zipBytes:number, outDir:string, zipPath:string,
 *            copiedTo:string|null, missing:Array, packFormat:number}}
 */
export function buildResourcePack({
  audioDir = path.join(BUILD, 'audio_nbforge'),
  outDir = path.join(BUILD, 'nbforge_resources'),
  zipPath = path.join(BUILD, 'nbforge_resources.zip'),
  copyTo = path.join(MINECRAFT, 'testserver', 'resourcepacks', 'nbforge_resources'),
  ext = 'ogg',
  description = PACK_DESCRIPTION,
} = {}) {
  const { entries, missing } = collectSamples(audioDir, { ext });
  if (missing.length) {
    throw new Error(`有 ${missing.length} 个采样缺失（先跑 src/synth/render-all.mjs）：\n  `
      + missing.slice(0, 5).map((m) => m.file).join('\n  '));
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  const soundsDir = path.join(outDir, 'assets', 'nbforge', 'sounds');
  fs.mkdirSync(soundsDir, { recursive: true });

  const mcmeta = {
    pack: { pack_format: PACK_FORMAT, min_format: PACK_FORMAT, max_format: PACK_FORMAT, description },
  };
  const mcmetaBuf = Buffer.from(JSON.stringify(mcmeta, null, 2) + '\n', 'utf8');
  const sounds = buildSoundsJson(entries);
  const soundsBuf = Buffer.from(JSON.stringify(sounds, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(outDir, 'pack.mcmeta'), mcmetaBuf);
  fs.writeFileSync(path.join(outDir, 'assets', 'nbforge', 'sounds.json'), soundsBuf);

  const zipEntries = [
    { path: 'pack.mcmeta', data: mcmetaBuf },
    { path: 'assets/nbforge/sounds.json', data: soundsBuf },
  ];
  let bytes = 0;
  // 静音采样：与 148 个合成采样一起进包（mod 的 #hifi=1 模式用它替换原版音符盒声音）
  const silentData = fs.readFileSync(SILENT_OGG);
  fs.writeFileSync(path.join(soundsDir, `${SILENT_EVENT}.ogg`), silentData);
  zipEntries.push({ path: `assets/nbforge/sounds/${SILENT_EVENT}.ogg`, data: silentData });
  for (const e of entries) {
    const rel = `assets/nbforge/sounds/${e.timbre}/${noteFileName(e.midi)}.${ext}`;
    const dir = path.join(soundsDir, e.timbre);
    fs.mkdirSync(dir, { recursive: true });
    const data = fs.readFileSync(e.file);
    fs.writeFileSync(path.join(dir, `${noteFileName(e.midi)}.${ext}`), data);
    zipEntries.push({ path: rel, data });
    bytes += data.length;
  }
  const zip = buildZip(zipEntries);
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  fs.writeFileSync(zipPath, zip);

  let copiedTo = null;
  if (copyTo && fs.existsSync(path.dirname(copyTo))) {
    fs.rmSync(copyTo, { recursive: true, force: true });
    fs.cpSync(outDir, copyTo, { recursive: true });
    copiedTo = copyTo;
  }
  return {
    sounds: entries.length, extraSamples: 1, bytes, zipBytes: zip.length, outDir, zipPath, copiedTo, missing,
    packFormat: PACK_FORMAT,
    perTimbre: TIMBRES.map((t) => ({ timbre: t, semitones: registerSize(t) })),
  };
}

/* ------------------------------------------------------------------- CLI */

function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const noCopy = argv.includes('--no-copy');
  const resolvePath = (p) => (path.isAbsolute(p) ? p : path.resolve(MINECRAFT, p));
  const audioDir = resolvePath(opt('audio', path.join(BUILD, 'audio_nbforge')));
  const outDir = resolvePath(opt('out', path.join(BUILD, 'nbforge_resources')));
  const zipPath = resolvePath(opt('zip', path.join(BUILD, 'nbforge_resources.zip')));
  const copyTo = noCopy ? null : resolvePath(opt('copy-to', path.join(MINECRAFT, 'testserver', 'resourcepacks', 'nbforge_resources')));
  const ext = opt('ext', fs.existsSync(path.join(audioDir, 'ogg')) ? 'ogg' : 'wav');
  if (ext !== 'ogg') {
    console.warn('[警告] 没有找到 ogg（本机可能缺 ffmpeg）：Minecraft 只支持 ogg/vorbis，这个包装上不会出声，'
      + '只当"合成器已验证、编码器缺失"的证据。');
  }
  const res = buildResourcePack({ audioDir, outDir, zipPath, copyTo, ext });
  const client = argv.includes('--no-copy-client') ? { dest: null, tried: [] } : copyClientPack(zipPath);
  console.log(`资源包（pack_format=${res.packFormat}）：${res.sounds} 条事件 = `
    + res.perTimbre.map((t) => `${t.timbre}×${t.semitones}`).join(' + '));
  console.log(`  目录：${res.outDir}（${(res.bytes / 1048576).toFixed(2)}MB 采样）`);
  console.log(`  zip ：${res.zipPath}（${(res.zipBytes / 1048576).toFixed(2)}MB）`);
  console.log(res.copiedTo ? `  已复制到：${res.copiedTo}` : `  未复制到 testserver（目录不存在或 --no-copy）`);
  if (client.dest) {
    console.log(`  已复制到客户端资源包目录：${client.dest}（进游戏后在「选项→资源包」启用 nbforge）`);
  } else {
    console.log(`  未复制到客户端 resourcepacks（候选目录都不存在或不可写）：`
      + `${client.tried.join('；') || '已用 --no-copy-client 关闭'}；可手动把 zip 拖进 resourcepacks/`);
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
