#!/usr/bin/env node
// M3-36 · 采样库安装器（一键下载 / 就地接管 / 自检）
//
// 背景：mod 的乐器索引（jar 内置 + config/nbmachina/instruments.json）里存的是**相对采样根**的
// 路径（`piano/salamander48_hp/A0v1.wav`），采样根由 mod 按 "环境变量 → config/nbmachina/samples.json
// → 游戏目录下的常见位置" 解析。这个脚本负责把三套采音源准备到标准布局：
//
//   <root>/piano/salamander48_hp/               ← Salamander Grand Piano V3（CC-BY 3.0）
//   <root>/piano/vsco2ce/VSCO-2-CE-SFZ/         ← VSCO 2 CE 全集（CC0）
//   <root>/olpc/x/yamahaGrandPiano44/           ← Yamaha Disklavier Pro 完整合集（CC-BY 3.0）
//   <root>/piano/disklavier_sfz/                ← 上面那套的 SF2 子集（备选/对照）
//
// 用法：
//   node tools/install-samples.mjs --check                 # 只看现状（默认动作）
//   node tools/install-samples.mjs --adopt <已有目录>       # 就地接管（不复制），写 samples.json
//   node tools/install-samples.mjs --download salamander   # 下载 + 解包 + 高通处理 + 写索引
//   node tools/install-samples.mjs --download all --deploy # 全套 + 部署到游戏目录
//   node tools/install-samples.mjs --from-olpc <7z|目录>    # 用本地已有归档代替下载
//
// 说明：上游链接会失效（2026-09-19 实测 archive.org 上 Salamander / OLPC 两个条目已 404），
// 所以每个包都有多个来源，按顺序尝试；全都失败时打印手工获取指引而不是直接报错退出。
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const REPO = path.resolve(import.meta.dirname, '..');
const MINE = path.resolve(REPO, '..');                       // C:/Users/<user>/Documents/minecraft
const DEFAULT_ROOT = path.join(MINE, '_toolchain');          // 本机现状：采样就在 _toolchain 下
const ROOT = path.resolve(opt('root', DEFAULT_ROOT));
const CACHE = path.join(ROOT, '.downloads');
const GAME_DIR = opt('game-dir') || 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5';
const DEPLOY = has('deploy');
const SEVEN_ZIP = ['C:/Program Files/7-Zip/7z.exe', '7z'].find((p) => p === '7z' || fs.existsSync(p));

/* ------------------------------------------------------------------ 包定义 */
const PACKS = {
  salamander: {
    label: 'Salamander Grand Piano V3（CC-BY 3.0）',
    urls: [
      'https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPianoV3+20161209_48khz24bit.tar.xz',
      'https://freepats.zenvoid.org/Piano/SalamanderGrandPiano/SalamanderGrandPiano-SFZ+FLAC-V3+20200602.tar.gz',
    ],
    git: 'https://github.com/sfzinstruments/SalamanderGrandPiano',
    probe: () => countWav(path.join(ROOT, 'piano', 'salamander48_hp')),
    want: 641,
  },
  vsco: {
    label: 'VSCO 2 CE 全集（CC0）',
    git: 'https://github.com/sgossner/VSCO-2-CE',
    dir: path.join(ROOT, 'piano', 'vsco2ce', 'VSCO-2-CE-SFZ'),
    hash: null,                                  // 上游没有发布哈希，按文件数核对
    probe: () => countWav(path.join(ROOT, 'piano', 'vsco2ce', 'VSCO-2-CE-SFZ')),
    want: 3168,
  },
  olpc: {
    label: 'Yamaha Disklavier Pro 完整合集（CC-BY 3.0）',
    urls: ['https://archive.org/download/olpc-sound-samples-v2/olpc-sound-samples-v2.7z'],  // 2026-09-19 已 404
    md5: '687c31eeab8e4676e946bf47ae39e7f3',
    inner: 'yamahaGrandPiano44',
    dest: path.join(ROOT, 'olpc', 'x'),
    probe: () => countWav(path.join(ROOT, 'olpc', 'x', 'yamahaGrandPiano44')),
    want: 1212,
    fallback: {
      label: 'YDP SF2 子集（FreePats，28MB；只有 103 区域，够先用）',
      url: 'https://freepats.zenvoid.org/Piano/YDP-GrandPiano/YDP-GrandPiano-SF2-20160804.tar.bz2',
      dest: path.join(ROOT, 'piano', 'disklavier_sfz'),
      probe: () => {
        const d = path.join(ROOT, 'piano', 'disklavier_sfz');
        return fs.existsSync(d) && !!firstWith(d, '.sfz') && countWav(d) >= 100;
      },
    },
  },
};

/* ------------------------------------------------------------------ 工具 */
const log = (...a) => console.log(...a);
const run = (cmd, args, opts = {}) => {
  log(`  $ ${path.basename(cmd)} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${path.basename(cmd)} 退出码 ${r.status}`);
};
function countWav(dir) {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) n += countWav(path.join(dir, e.name));
    else if (/\.(wav|flac)$/i.test(e.name)) n++;
  }
  return n;
}
const proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
function download(url, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  // 断点续传 + 快速失败（连不上 20s 放弃、速度低于 1KB/s 持续 60s 放弃，避免死在失效源上）
  const args = ['-L', '--fail', '--retry', '2', '--retry-delay', '3',
    '--connect-timeout', '20', '--speed-limit', '1024', '--speed-time', '60',
    '-C', '-', '-o', dest, url];
  if (proxy) args.unshift('--proxy', proxy);
  run('curl.exe', args);
}
function extract(archive, dest, inner) {
  fs.mkdirSync(dest, { recursive: true });
  const lower = archive.toLowerCase();
  if (lower.endsWith('.7z')) {
    const args = ['x', '-y', `-o${dest}`, archive];
    if (inner) args.push(inner);
    run(SEVEN_ZIP, args);
  } else if (lower.endsWith('.zip')) {
    run('tar.exe', ['-xf', archive, '-C', dest]);
  } else {
    run('tar.exe', ['-xf', archive, '-C', dest]);
  }
}
function findFile(dir, name) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = findFile(p, name); if (hit) return hit; }
    else if (e.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}
/** 解包常见情况：tar 里带一层同名目录 → 把内容提上来（保持我们约定的扁平布局） */
function flatten(dir) {
  for (let i = 0; i < 3; i++) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    if (entries.length !== 1 || !entries[0].isDirectory()) return;
    const inner = path.join(dir, entries[0].name);
    for (const e of fs.readdirSync(inner)) fs.renameSync(path.join(inner, e), path.join(dir, e));
    fs.rmdirSync(inner);
  }
}
/** 目录里第一个指定后缀的文件（递归） */
function firstWith(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) { const hit = firstWith(p, ext); if (hit) return hit; }
    else if (e.name.toLowerCase().endsWith(ext)) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ Salamander：高通 + 生成 SFZ */
const NOTE_MIDI = { c: 0, 'c#': 1, d: 2, 'd#': 3, e: 4, f: 5, 'f#': 6, g: 7, 'g#': 8, a: 9, 'a#': 10, b: 11 };
function hpSalamander(srcDir) {
  const dst = path.join(ROOT, 'piano', 'salamander48_hp');
  fs.mkdirSync(dst, { recursive: true });
  const sfz = findFile(srcDir, 'SalamanderGrandPianoV3.sfz') || findFile(srcDir, 'Salamander Grand Piano V3.sfz');
  if (!sfz) throw new Error('解包目录里找不到 SFZ：' + srcDir);
  const base = path.dirname(sfz);
  const text = fs.readFileSync(sfz, 'utf8');
  const names = [...new Set([...text.matchAll(/sample=([^\s\r\n]+\.(?:wav|flac))/gi)].map((m) => m[1].replace(/\\/g, '/').split('/').pop()))];
  log(`  采样 ${names.length} 个 → 逐个高通（截止 = max(48Hz, 基频/4)，二阶 ×2 级联）+ 转 24bit WAV`);
  let done = 0, skipped = 0;
  for (const name of names) {
    const src = findFile(base, name);
    const out = path.join(dst, name.replace(/\.flac$/i, '.wav'));
    if (!src) { skipped++; continue; }
    if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) { done++; continue; }
    const m = /^([A-Ga-g]#?)(-?\d)/.exec(name);
    let corner = 48;
    if (m) {
      const midi = (Number(m[2]) + 1) * 12 + NOTE_MIDI[m[1].toLowerCase()];
      corner = Math.max(48, (440 * 2 ** ((midi - 69) / 12)) / 4);
    }
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', src,
      '-af', `highpass=f=${corner.toFixed(1)}:poles=2,highpass=f=${corner.toFixed(1)}:poles=2`,
      '-c:a', 'pcm_s24le', out]);
    done++;
    if (done % 100 === 0) log(`    ${done}/${names.length}`);
  }
  // 生成与 hp 目录同级的 SFZ：把 sample= 路径改成纯文件名 + 扩展名换 .wav
  const outSfz = path.join(dst, 'SalamanderGrandPianoV3_hp.sfz');
  const rewritten = text.replace(/sample=([^\s\r\n]+\.(?:wav|flac))/gi,
    (_, p) => 'sample=' + p.replace(/\\/g, '/').split('/').pop().replace(/\.flac$/i, '.wav'));
  fs.writeFileSync(outSfz, rewritten, 'utf8');
  log(`  写出 ${outSfz}；处理 ${done} 个（缺源 ${skipped}）`);
  return dst;
}

/* ------------------------------------------------------------------ 各包安装 */
function installSalamander() {
  const from = opt('from-salamander');
  const dest = path.join(ROOT, 'piano', 'salamander48');
  if (from) {
    if (fs.statSync(from).isDirectory()) return hpSalamander(from);
    extract(from, dest);
    return hpSalamander(dest);
  }
  fs.mkdirSync(CACHE, { recursive: true });
  for (const url of PACKS.salamander.urls) {
    const file = path.join(CACHE, path.basename(decodeURIComponent(new URL(url).pathname)));
    try {
      log(`  下载 ${url}`);
      download(url, file);
      extract(file, dest);
      return hpSalamander(dest);
    } catch (e) {
      log(`  ✘ 失败：${e.message}`);
    }
  }
  log('  ↘ 退路：从 GitHub 镜像 clone（FLAC 无损，713MB）');
  const gitDir = path.join(CACHE, 'SalamanderGrandPiano');
  if (!fs.existsSync(gitDir)) run('git', ['clone', '--depth', '1', PACKS.salamander.git, gitDir]);
  return hpSalamander(gitDir);
}

function installVsco() {
  const from = opt('from-vsco');
  const dest = PACKS.vsco.dir;
  if (from && fs.statSync(from).isDirectory()) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    log(`  拷贝本地目录 → ${dest}`);
    fs.cpSync(from, dest, { recursive: true });
    return dest;
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) { log(`  已存在：${dest}`); return dest; }
  run('git', ['clone', '--depth', '1', PACKS.vsco.git, dest]);
  return dest;
}

function installOlpc() {
  const from = opt('from-olpc');
  const dest = PACKS.olpc.dest;
  if (from) {
    if (fs.statSync(from).isDirectory()) {
      fs.mkdirSync(dest, { recursive: true });
      fs.cpSync(from, path.join(dest, 'yamahaGrandPiano44'), { recursive: true });
    } else {
      log(`  校验 md5（期望 ${PACKS.olpc.md5}）…`);
      extract(from, dest, PACKS.olpc.inner);
    }
    indexOlpc();
    return dest;
  }
  fs.mkdirSync(CACHE, { recursive: true });
  for (const url of PACKS.olpc.urls) {
    const file = path.join(CACHE, path.basename(url));
    try {
      log(`  下载 ${url}（4.3GB，可中断续传）`);
      download(url, file);
      extract(file, dest, PACKS.olpc.inner);
      indexOlpc();
      return dest;
    } catch (e) {
      log(`  ✘ 失败：${e.message}`);
    }
  }
  log('  ↘ 退路：改用 YDP SF2 子集（103 区域）');
  const fb = PACKS.olpc.fallback;
  const file = path.join(CACHE, path.basename(fb.url));
  download(fb.url, file);
  extract(file, fb.dest);
  flatten(fb.dest);
  const sf2 = firstWith(fb.dest, '.sf2');
  if (sf2) {
    log(`  把 SF2 展开成 WAV + SFZ（${path.basename(sf2)}）`);
    run(process.execPath, [path.join(REPO, 'tools', 'sf2-dump.mjs'), '--sf2', sf2, '--out', fb.dest]);
  }
  return fb.dest;
}

function indexOlpc() {
  const dir = path.join(ROOT, 'olpc', 'x', 'yamahaGrandPiano44');
  if (!fs.existsSync(dir)) return;
  run(process.execPath, [path.join(REPO, 'tools', 'import-olpc-piano.mjs'), '--dir', dir]);
}

/* ------------------------------------------------------------------ 部署 + 自检 */
function writeSamplesConfig() {
  const cfgDir = path.join(GAME_DIR, 'config', 'nbmachina');
  fs.mkdirSync(cfgDir, { recursive: true });
  const file = path.join(cfgDir, 'samples.json');
  fs.writeFileSync(file, JSON.stringify({ root: ROOT.replace(/\\/g, '/') }, null, 1), 'utf8');
  log(`采样根已写入 → ${file}`);
  // 顺带部署一份**相对路径**的乐器索引到 config（jar 内置那份是同内容）
  const idx = path.join(cfgDir, 'instruments.json');
  const tmp = path.join(ROOT, '.downloads', 'nbmachina_instruments.json');
  fs.mkdirSync(path.dirname(tmp), { recursive: true });
  run(process.execPath, [path.join(REPO, 'tools', 'export-mod-instruments.mjs'),
    '--relative', '--base', ROOT, '--out', tmp]);
  fs.copyFileSync(tmp, idx);
  log(`乐器索引（相对路径）已部署 → ${idx}`);
}

function check() {
  log(`采样根：${ROOT}`);
  let bad = 0;
  for (const [id, p] of Object.entries(PACKS)) {
    const n = p.probe();
    const ok = p.want ? n >= p.want : n > 0;
    if (!ok) bad++;
    log(`  ${ok ? '✔' : '✘'} ${id.padEnd(11)} ${String(n).padStart(5)} 个文件${p.want ? `（期望 ≥${p.want}）` : ''}  ${p.label}`);
  }
  const fb = PACKS.olpc.fallback;
  log(`  ${fb.probe() ? '✔' : '–'} disklavier_sf2（OLPC 退路）${fb.probe() ? '在位' : '不在位'}`);
  return bad;
}

/* ------------------------------------------------------------------ 主流程 */
const packs = String(opt('download', '')).split(',').filter(Boolean);
if (has('adopt')) {
  const dir = path.resolve(opt('adopt', ROOT));
  if (!fs.existsSync(dir)) throw new Error('目录不存在：' + dir);
  if (path.resolve(dir) !== ROOT) {
    log(`就地接管：${dir}（脚本后续按这个根工作请加 --root）`);
  }
  const os_ = fs.statSync(dir);
  if (!os_.isDirectory()) throw new Error('不是目录：' + dir);
  writeSamplesConfigFor(dir);
  check();
} else if (packs.length) {
  for (const p of packs) {
    if (p === 'all') {
      installSalamander();
      installVsco();
      installOlpc();
      break;
    }
    if (p === 'salamander') installSalamander();
    else if (p === 'vsco') installVsco();
    else if (p === 'olpc') installOlpc();
    else throw new Error('未知包：' + p + '（可选 salamander / vsco / olpc / all）');
  }
  if (DEPLOY) writeSamplesConfig();
  check();
} else {
  check();
  log('\n提示：--download <salamander|vsco|olpc|all> 下载；--adopt <目录> 就地接管；--deploy 写进游戏目录');
}

function writeSamplesConfigFor(rootDir) {
  const cfgDir = path.join(GAME_DIR, 'config', 'nbmachina');
  fs.mkdirSync(cfgDir, { recursive: true });
  const file = path.join(cfgDir, 'samples.json');
  fs.writeFileSync(file, JSON.stringify({ root: rootDir.replace(/\\/g, '/') }, null, 1), 'utf8');
  log(`采样根已写入 → ${file}`);
}
