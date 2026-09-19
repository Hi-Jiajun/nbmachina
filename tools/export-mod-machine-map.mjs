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
import { buildTriggerMap } from '../src/emit/trigger-map.mjs';
import { STEP_SECONDS } from '../src/emit/tick-map.mjs';

const P = resolvePaths();
const B = P.build;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const IN = opt('in', path.join(B, 'machine_pipeline_video_phrase.csv'));
const PROFILE = opt('profile', P.profile);
const OUT = opt('out', path.join(B, 'nbmachina_machine_map.csv'));
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

// M3-39：新增三组列，供 **mod 自己驱动机器**（不依赖数据包、不受服务器刻率影响）：
//   time_sec  该音的**真实时间**（来自参考演奏，缺列时用 step×0.12）
//   tx,ty,tz  该音符盒的**水平触发位**（放红石块 → 音符盒响 → mixin 接管音色）
const out = ['x,y,z,instrument,voice,midi,velocity,dur_ms,time_sec,tx,ty,tz'];
let written = 0, skipped = 0;
let withDur = 0;
const byVoice = {};

// 逐行解析（保留行序，触发位索引与数据包同一套规则）
const allRows = lines.slice(1).filter((l) => l.trim()).map((l) => {
  const c = l.split(',');
  return { step: Number(c[idx.step]), pitch: Number(c[idx.row]), c };
});
// 触发位：与数据包共用 src/emit/trigger-map.mjs，保证"mod 驱动"与"数据包驱动"落在同一格
const trig = buildTriggerMap(allRows, pos);
let trigMissing = 0;

allRows.forEach((row, i) => {
  const c = row.c;
  const voice = c[idx.instrument];
  const target = VOICE_MAP[voice] ?? 'salamander48';
  if (target === 'skip') { skipped++; return; }
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
  const p = pos(row.step, row.pitch);
  // 真实时间（M3-24 的视频时间轴）；没有 time_seconds 列就退回格位时间
  const timeSec = idx.time_seconds !== undefined && c[idx.time_seconds] !== undefined && c[idx.time_seconds] !== ''
    ? Number(c[idx.time_seconds])
    : row.step * STEP_SECONDS;
  const cell = trig.cells[i];
  if (!cell || !cell.strict) trigMissing++;
  // 没有严格触发位的那几颗音，触发位写成"音符盒上方"（mod 驱动时会改用引擎兜底，见 NbmachinaMachine）
  const t = cell && cell.strict ? cell : { x: p.x, y: p.y + 2, z: p.z };
  out.push(`${p.x},${p.y},${p.z},${target},${voice},${midi},${velocity},${durMs},`
    + `${timeSec.toFixed(3)},${t.x},${t.y},${t.z}`);
  written++;
  byVoice[voice] = (byVoice[voice] ?? 0) + 1;
});
console.log(`  触发位：${written - trigMissing}/${written} 颗有严格水平触发位（其余 ${trigMissing} 颗走 mod 引擎兜底）`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log(`写出 ${OUT}：${written} 个音符盒位置（跳过 ${skipped} 颗打击乐）`);
console.log(`  声部：${JSON.stringify(byVoice)}`);
console.log(`  时值：${withDur}/${written} 颗带 dur_ms（其余按采样自然衰减）`);
console.log(`  坐标示例：${out[1]}`);

if (DEPLOY) {
  for (const [label, dir] of [['客户端', CLIENT_GAME_DIR], ['测试服', TEST_SERVER_DIR]]) {
    const dst = path.join(dir, 'nbmachina', 'machine_map.csv');
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(OUT, dst);
      console.log(`  已部署（${label}）→ ${dst}`);
    } catch (e) {
      console.warn(`  部署失败（${label}）${dst}：${e.message}`);
    }
  }
}
