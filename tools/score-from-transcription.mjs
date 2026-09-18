#!/usr/bin/env node
// M3-22 · 把**参考演奏的转谱**直接当谱面用（不是红石谱）
//
// 用途：用户说"低音完全不一样"。要判断问题到底出在
//   ① 我们用的谱面（红石谱的左手）  还是 ② 采样/混音，
// 最干净的做法是把 ① 换成"从视频里听出来的音"再渲染一遍：
//   · 同一个转谱模型（piano_transcription_inference，note F1 0.9677）
//   · 同一架琴（Salamander 48k/24bit）、同一套时值规则（键释放 + 踏板）
// 于是唯一的变量就是"弹的是哪些音、什么时候弹"。
//
// 输出格式与 `machine_pipeline_*.csv` 兼容（`render-ensemble.mjs` 与 emit 链都能直接吃）：
//   step,row,instrument,midi,volume,velMidi,keyMs,durMs,refMatched,src
// 时间量化到机器的 0.12s 网格（step = round(t/0.12)）——即"机器真能弹出来的最好精度"。
//   · `row` = midi % 24（机器布局的 z 轴就是"音高行"，撞格时顺延到最近的空格）
//   · `instrument` 按音区分两色（<60 = 左手用 oak_planks 甲板，其余 sand），与旧机器观感一致
//     —— 声音一律由 mod 用钢琴采样播，甲板/音符盒只是外观与降级路径。
//
// 用法：
//   node tools/score-from-transcription.mjs                     # → build/score_from_reference.csv
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';
import { STEP_SECONDS } from '../src/emit/tick-map.mjs';

const P = resolvePaths();
const B = P.build;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const TR = opt('transcription', path.join(B, 'ref_transcription.json'));
const OUT = opt('out', path.join(B, 'score_from_reference.csv'));
const MAX_SOUND = Number(opt('max', '9.0'));

const tr = JSON.parse(fs.readFileSync(TR, 'utf8'));
const notes = tr.note_events.slice().sort((a, b) => a.onset - b.onset);
const pedals = tr.pedal_events.slice().sort((a, b) => a.on - b.on);

function pedalOffAt(t) {
  for (const p of pedals) {
    if (t >= p.on && t < p.off) return p.off;
    if (p.on > t) break;
  }
  return t;
}

const rows = ['step,tick,time_seconds,instrument,midi,row,volume,velocity,velMidi,keyMs,durMs,refMatched,src'];
let quantized = 0;
let collisions = 0;
const used = new Set();
for (const n of notes) {
  const key = Math.max(0.05, n.offset - n.onset);
  const end = Math.max(n.offset, pedalOffAt(n.offset));
  const dur = Math.min(MAX_SOUND, Math.max(0.08, end - n.onset));
  const step = Math.round(n.onset / STEP_SECONDS);
  if (Math.abs(step * STEP_SECONDS - n.onset) > 0.03) quantized++;
  // 撞格处理：同一 step 上同 row（= 同一个音高类，相差整八度）极少见，顺延到最近的空行
  let row = n.midi % 24;
  if (used.has(`${step},${row}`)) {
    collisions++;
    for (let d = 1; d <= 12; d++) {
      for (const cand of [row + d, row - d]) {
        if (cand >= 0 && cand <= 24 && !used.has(`${step},${cand}`)) { row = cand; d = 99; break; }
      }
    }
  }
  used.add(`${step},${row}`);
  rows.push([
    step, Math.round(n.onset * 20), n.onset.toFixed(3), n.midi < 60 ? 'bass' : 'harp',
    n.midi, row, '0.35', (n.velocity / 127).toFixed(4),
    Math.max(1, Math.min(127, Math.round(n.velocity))),
    Math.round(key * 1000), Math.round(dur * 1000), 1, 'ref',
  ].join(','));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, rows.join('\n') + '\n', 'utf8');
console.log(`写出 ${OUT}：${notes.length} 颗音（参考转谱，量化到 ${STEP_SECONDS}s 网格，`
  + `偏移 >30ms 的 ${quantized} 颗 = ${(quantized / notes.length * 100).toFixed(1)}%）`);
console.log(`  撞格顺延 ${collisions} 颗；实际占用格位 ${used.size}；`
  + `x 范围 ${Math.min(...rows.slice(1).map((r) => +r.split(',')[0]))}..${Math.max(...rows.slice(1).map((r) => +r.split(',')[0]))} step`);
console.log(`  踏板 ${pedals.length} 段；力度中位 ${notes.map((n) => n.velocity).sort((a, b) => a - b)[notes.length >> 1].toFixed(0)}`);
