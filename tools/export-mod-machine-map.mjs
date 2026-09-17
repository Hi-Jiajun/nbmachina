#!/usr/bin/env node
// M3-21 · 导出"音符盒位置 → 谱面音符"映射（mod 用它把**红石触发**翻译成"哪颗音、多大力"）
//
// 为什么需要它：mod 通过 mixin 拦到了音符盒被触发的时机，但**方块本身只有乐器+音高**，
// 没有力度；而力度（乐句级/逐音）只存在于谱面里。把 (step,row) → 世界坐标 这份映射交给 mod，
// 它就能在方块响的那一瞬间查到"这是谱面第几颗音、该用多大力度"，于是机器与引擎真正合一。
//
// 坐标规则与数据包完全同源：`src/emit/layout-pos.mjs` 的 `makePos(profile)`（播放器与摆块共用）。
//
// M3-22 增补：第 8 列 `dur_ms` = 这颗音的**实际发声时长**（毫秒，来自参考演奏校准）。
// mod 到点就把声音放掉（制音器落下），这才是钢琴"该响多久"的真相——不再靠低音单声部硬掐。
//
// 用法：
//   node tools/export-mod-machine-map.mjs                     # 用默认（视频力度·乐句级）谱面
//   node tools/export-mod-machine-map.mjs --in build/machine_pipeline_calibrated.csv --deploy
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';
import { makePos } from '../src/emit/layout-pos.mjs';

const P = resolvePaths();
const B = P.build;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const IN = opt('in', path.join(B, 'machine_pipeline_video_phrase.csv'));
const PROFILE = opt('profile', P.profile);
const OUT = opt('out', path.join(B, 'nbforge_machine_map.csv'));
const DEPLOY = has('deploy');
const CLIENT_GAME_DIR = 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5';
const TEST_SERVER_DIR = 'C:/Users/hiliang/Documents/minecraft/_toolchain/spike-testserver';

/** 与 tools/export-mod-score.mjs 的 piano 预设保持同一套声部→乐器映射 */
const VOICE_MAP = { harp: 'salamander48', bell: 'salamander48', bass: 'salamander48', basedrum: 'skip', hat: 'skip' };

const lines = fs.readFileSync(IN, 'utf8').trim().split(/\r?\n/);
const header = lines[0].split(',');
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['step', 'row', 'instrument', 'midi']) {
  if (idx[need] === undefined) throw new Error(`谱面缺列 ${need}：${header.join(',')}`);
}
const profile = JSON.parse(fs.readFileSync(PROFILE, 'utf8'));
const pos = makePos(profile);

const out = ['x,y,z,instrument,voice,midi,velocity,dur_ms'];
let written = 0, skipped = 0;
let withDur = 0;
const byVoice = {};
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const c = line.split(',');
  const voice = c[idx.instrument];
  const target = VOICE_MAP[voice] ?? 'salamander48';
  if (target === 'skip') { skipped++; continue; }
  const step = Number(c[idx.step]);
  const row = Number(c[idx.row]);
  const midi = Number(c[idx.midi]);
  // 力度：优先用谱面的 velMidi（有力度档时），否则 volume × 127
  const velMidi = idx.velMidi !== undefined && c[idx.velMidi] !== undefined && c[idx.velMidi] !== ''
    ? Number(c[idx.velMidi])
    : Math.round(Number(c[idx.volume]) * 127);
  const velocity = Math.max(1, Math.min(127, Number.isFinite(velMidi) ? velMidi : 100));
  // 实际发声时长（毫秒）：M3-22 校准谱面里有 durMs 列（键释放 + 踏板抬起）；没有就写 0
  const durMs = idx.durMs !== undefined && c[idx.durMs] !== undefined && c[idx.durMs] !== ''
    ? Math.max(0, Math.round(Number(c[idx.durMs])))
    : 0;
  if (durMs > 0) withDur++;
  const p = pos(step, row);
  out.push(`${p.x},${p.y},${p.z},${target},${voice},${midi},${velocity},${durMs}`);
  written++;
  byVoice[voice] = (byVoice[voice] ?? 0) + 1;
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log(`写出 ${OUT}：${written} 个音符盒位置（跳过 ${skipped} 颗打击乐）`);
console.log(`  声部：${JSON.stringify(byVoice)}`);
console.log(`  时值：${withDur}/${written} 颗带 dur_ms（其余按采样自然衰减）`);
console.log(`  坐标示例：${out[1]}`);

if (DEPLOY) {
  for (const [label, dir] of [['客户端', CLIENT_GAME_DIR], ['测试服', TEST_SERVER_DIR]]) {
    const dst = path.join(dir, 'nbforge', 'machine_map.csv');
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(OUT, dst);
      console.log(`  已部署（${label}）→ ${dst}`);
    } catch (e) {
      console.warn(`  部署失败（${label}）${dst}：${e.message}`);
    }
  }
}
