// M2-1 · 把自研采样打成 Minecraft 资源包（1.21.10）
//
// 产物：
//   build/nbforge_resources/pack.mcmeta                      ← pack_format 69
//   build/nbforge_resources/assets/nbforge/sounds.json       ← 148 条事件 nbforge:strings_fs4 …
//   build/nbforge_resources/assets/nbforge/sounds/<音色>/<音名>.ogg
//   build/nbforge_resources.zip                              ← 同一个包的可分发 zip（可复现）
//   若 testserver/ 存在：再复制一份到 testserver/resourcepacks/nbforge_resources/
//
// 为什么 pack_format = 69：读的是 testserver/server.jar 里的 version.json（1.21.10 → resource_major 69），
// 不是猜的；tests/synth.test.mjs 里有一条断言会拿 jar 复核这个常量。
//
// 用法：node src/emit/resource-pack.mjs [--audio <dir>] [--out <dir>] [--zip <file>] [--no-copy]
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { buildZip } from './zip-writer.mjs';
import {
  REGISTERS, TIMBRES, noteFileName, registerSize, soundPathOf,
} from '../synth/voices.mjs';

export const PACK_FORMAT = 69;
export const PACK_DESCRIPTION = 'nbforge 自研音色（零第三方采样：Karplus–Strong 拨弦 / 加法铺底 / 模态钟琴）';

const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const MINECRAFT = process.env.NBFORGE_MC ?? 'C:/Users/hiliang/Documents/minecraft';

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

/** sounds.json：一个采样一条事件；name 用相对路径（命名空间 = sounds.json 所在目录的命名空间 nbforge） */
export function buildSoundsJson(entries) {
  const out = {};
  for (const e of entries) {
    out[`${e.timbre}_${noteFileName(e.midi)}`] = {
      sounds: [{ name: soundPathOf(e.timbre, e.midi), stream: false, attenuation_distance: 16 }],
    };
  }
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

  const mcmeta = { pack: { pack_format: PACK_FORMAT, description } };
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
    sounds: entries.length, bytes, zipBytes: zip.length, outDir, zipPath, copiedTo, missing,
    packFormat: PACK_FORMAT,
    perTimbre: TIMBRES.map((t) => ({ timbre: t, semitones: registerSize(t) })),
  };
}

/* ------------------------------------------------------------------- CLI */

function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const noCopy = argv.includes('--no-copy');
  const audioDir = opt('audio', path.join(BUILD, 'audio_nbforge'));
  const outDir = opt('out', path.join(BUILD, 'nbforge_resources'));
  const zipPath = opt('zip', path.join(BUILD, 'nbforge_resources.zip'));
  const copyTo = noCopy ? null : opt('copy-to', path.join(MINECRAFT, 'testserver', 'resourcepacks', 'nbforge_resources'));
  const ext = opt('ext', fs.existsSync(path.join(audioDir, 'ogg')) ? 'ogg' : 'wav');
  if (ext !== 'ogg') {
    console.warn('[警告] 没有找到 ogg（本机可能缺 ffmpeg）：Minecraft 只支持 ogg/vorbis，这个包装上不会出声，'
      + '只当"合成器已验证、编码器缺失"的证据。');
  }
  const res = buildResourcePack({ audioDir, outDir, zipPath, copyTo, ext });
  console.log(`资源包（pack_format=${res.packFormat}）：${res.sounds} 条事件 = `
    + res.perTimbre.map((t) => `${t.timbre}×${t.semitones}`).join(' + '));
  console.log(`  目录：${res.outDir}（${(res.bytes / 1048576).toFixed(2)}MB 采样）`);
  console.log(`  zip ：${res.zipPath}（${(res.zipBytes / 1048576).toFixed(2)}MB）`);
  console.log(res.copiedTo ? `  已复制到：${res.copiedTo}` : `  未复制到 testserver（目录不存在或 --no-copy）`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
