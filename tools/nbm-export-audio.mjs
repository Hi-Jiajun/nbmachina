#!/usr/bin/env node
// M5-41 · 一条命令把"无损音轨 + 它在回放时间轴上的起点"写进 mod 的导出音轨配置。
//
// 背景（2026-09-25 实测）：Flashback 的 `Record Audio` 抓的是**原版 SoundEngine 设备**上的
// SOFTLoopback，而 nbmachina 的引擎走自有 OpenAL 设备 —— 直接导出得到的音轨是**静音**
// （StyxHelix.mkv：pcm_s24le 48k/2ch，volumedetect -91 dB）。修法是补丁版 Flashback 里的
// `exporting/NbmAudioBridge`：导出每一帧时问 mod 要样本。这个脚本负责把两件事配好：
//
//   1) `audio`     = 用哪条无损音轨（母版 WAV，或 /nbmc rec 录下来的那一份）
//   2) `offsetSec` = **音乐第 0 秒落在回放时间轴的第几秒**（回放是从"按下录制"开始算的，
//                    音乐是之后才起的，所以要这个偏移。脚本不需要你手量：它扫回放里的
//                    nbmachina payload，用"服务器触发刻 + payload 里的谱面时间"反解出来）
//
// 用法：
//   node tools/nbm-export-audio.mjs --replay <回放.zip> --audio <母版.wav>          # 自动算 offset 并写配置
//   node tools/nbm-export-audio.mjs --replay <回放.zip> --audio <wav> --offset 3.35  # 手给 offset（跳过扫描）
//   node tools/nbm-export-audio.mjs --list                                          # 列出可选回放
//   node tools/nbm-export-audio.mjs --off                                           # 关掉导出音轨
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

const DEFAULT_GAME = 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const GAME = opt('game', DEFAULT_GAME).replace(/\\/g, '/');
const REPLAY_DIR = path.join(GAME, 'flashback', 'replays');
const CONFIG = path.join(GAME, 'nbmachina', 'export_audio.json');

function listReplays() {
  if (!fs.existsSync(REPLAY_DIR)) return [];
  return fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.zip'))
    .map((f) => ({ f, p: path.join(REPLAY_DIR, f), t: fs.statSync(path.join(REPLAY_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
}

if (has('list')) {
  const all = listReplays();
  console.log(`${all.length} 个回放（${REPLAY_DIR}）：`);
  for (const r of all) console.log(`  ${r.f}   ${new Date(r.t).toLocaleString()}`);
  process.exit(0);
}

fs.mkdirSync(path.dirname(CONFIG), { recursive: true });

if (has('off')) {
  fs.writeFileSync(CONFIG, JSON.stringify({ enabled: false }, null, 2) + '\n');
  console.log(`已关闭导出音轨：${CONFIG}`);
  process.exit(0);
}

/** 读出 zip 里第一个 .flashback 条目（deflate） */
function readReplayStream(zipPath) {
  const b = fs.readFileSync(zipPath);
  let eocd = b.length - 22;
  while (eocd > 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (b.readUInt32LE(eocd) !== 0x06054b50) throw new Error('不是 zip：' + zipPath);
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const name = b.toString('utf8', off + 46, off + 46 + nameLen);
    const method = b.readUInt16LE(off + 10);
    const csize = b.readUInt32LE(off + 20);
    const lho = b.readUInt32LE(off + 42);
    if (name.endsWith('.flashback')) {
      const lName = b.readUInt16LE(lho + 26);
      const lExtra = b.readUInt16LE(lho + 28);
      const start = lho + 30 + lName + lExtra;
      const raw = b.subarray(start, start + csize);
      return method === 8 ? zlib.inflateRawSync(raw) : raw;
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('回放里没有 .flashback 条目：' + zipPath);
}

/**
 * 扫回放动作流，取所有 `nbmachina:play` payload 的 (tick, 谱面时间)，反解
 * offset = tick/20 − scoreTimeSec（= 音乐第 0 秒在回放时间轴上的位置）。
 */
function scanOffset(zipPath) {
  const d = readReplayStream(zipPath);
  const readVar = (b, o) => { let v = 0, s = 0, x; do { x = b[o++]; v |= (x & 0x7f) << s; s += 7; } while (x & 0x80); return [v >>> 0, o]; };
  const readStr = (b, o) => { const [n, o1] = readVar(b, o); return [b.toString('utf8', o1, o1 + n), o1 + n]; };

  let p = 4;                                  // magic
  let nActions; [nActions, p] = readVar(d, p);
  const names = [];
  for (let i = 0; i < nActions; i++) { let s; [s, p] = readStr(d, p); names.push(s); }
  const snapshotSize = d.readInt32BE(p); p += 4 + snapshotSize;
  const nextTickId = names.indexOf('flashback:action/next_tick');

  const rows = [];
  let tick = 0;
  while (p + 5 <= d.length) {
    let id; [id, p] = readVar(d, p);
    const size = d.readInt32BE(p); p += 4;
    if (size < 0 || p + size > d.length) break;
    const seg = d.subarray(p, p + size);
    const marker = Buffer.from('nbmachina:play');
    const at = seg.indexOf(marker);
    if (at >= 0 && id !== nextTickId) {
      let o = at + marker.length;
      try {
        let s; [s, o] = readStr(seg, o);       // instrument
        [s, o] = readStr(seg, o);              // voice
        let v; [v, o] = readVar(seg, o);       // midi
        [v, o] = readVar(seg, o);              // velocity
        [v, o] = readVar(seg, o);              // durMs
        if (o + 32 > seg.length) throw new Error('short payload');
        const score = seg.readDoubleBE(o + 24); // x/y/z 三个 double 之后
        if (Number.isFinite(score)) rows.push({ tick, score });
      } catch (e) {
        // 不是我们认识的 payload 布局（比如别的 mod 复用了同一个通道名）——跳过
      }
    }
    if (id === nextTickId) tick++;
    p += size;
  }
  if (!rows.length) throw new Error('这条回放里没有 nbmachina:play payload（不是这个机器录的？）');
  const offsets = rows.map((r) => r.tick / 20 - r.score).sort((a, b) => a - b);
  const mean = offsets.reduce((a, b) => a + b, 0) / offsets.length;
  const sd = Math.sqrt(offsets.reduce((a, b) => a + (b - mean) ** 2, 0) / offsets.length);
  return {
    notes: rows.length,
    firstScore: rows[0].score,
    lastScore: rows[rows.length - 1].score,
    offset: mean,
    sdMs: sd * 1000,
    min: offsets[0],
    max: offsets[offsets.length - 1],
  };
}

const AUDIO = opt('audio');
let replayArg = opt('replay');
if (!replayArg) {
  const newest = listReplays()[0];
  if (!newest) throw new Error(`找不到回放：${REPLAY_DIR}`);
  replayArg = newest.p;
  console.log(`未指定 --replay，用最新一条：${newest.f}`);
}
const replayPath = replayArg.includes('/') || replayArg.includes('\\')
  ? replayArg : path.join(REPLAY_DIR, replayArg.endsWith('.zip') ? replayArg : `${replayArg}.zip`);
if (!fs.existsSync(replayPath)) throw new Error('找不到回放：' + replayPath);

let offset = opt('offset', null);
if (offset === null) {
  const scan = scanOffset(replayPath);
  offset = scan.offset;
  console.log(`扫描回放：${scan.notes} 颗音，谱面 ${scan.firstScore.toFixed(3)}..${scan.lastScore.toFixed(3)}s`);
  console.log(`反解偏移：音乐 0s = 回放 ${offset.toFixed(4)}s（σ ${scan.sdMs.toFixed(1)}ms，范围 ${scan.min.toFixed(3)}..${scan.max.toFixed(3)}）`);
} else {
  offset = Number(offset);
  console.log(`使用手给偏移：${offset}s`);
}

if (!AUDIO) throw new Error('缺少 --audio <无损 WAV>（母版或 /nbmc rec 录下来的那一份）');
if (!fs.existsSync(AUDIO)) throw new Error('找不到音轨：' + AUDIO);

const cfg = {
  enabled: true,
  audio: AUDIO.replace(/\\/g, '/'),
  offsetSec: Number(offset.toFixed(6)),
  gain: Number(opt('gain', '1.0')),
  notes: `由 tools/nbm-export-audio.mjs 生成（回放 ${path.basename(replayPath)}）`,
};
fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n');
console.log(`已写入 ${CONFIG}`);
console.log('游戏内 `/nbmc exportaudio reload` 即可生效；导出（Record Audio 打开）时音轨就是这条文件本身。');
