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

const TR = opt('transcription', path.join(B, 'ref_video_transcription.json'));
const OUT = opt('out', path.join(B, 'score_from_reference.csv'));
// 2026-09-18（用户反馈）：原来 9s 上限会把**低音的余韵**砍掉 —— 原曲结尾（261–285s）那一片低音
// 就是 261–265s 几颗低音在踏板下自然衰减出来的长尾（原视频 60–110Hz 包络从 -3dB 平滑掉到 -23dB）。
// 采样本身只有 8~15s，让它自然衰减才是对的，所以上限放宽到 25s（等于"一直响到采样自己结束"）。
const MAX_SOUND = Number(opt('max', '25.0'));
// 转谱偶尔会在同一位置吐出一颗"咔哒"（几毫秒的碎音）——听感上是双击/杂音，直接丢掉。
const MIN_KEY = Number(opt('min-key', '0.03'));
const CAP_LOW = Number(opt('cap-low', '20'));
const CAP_MID = Number(opt('cap-mid', '8'));
const CAP_HIGH = Number(opt('cap-high', '4'));
const CAP_VHIGH = Number(opt('cap-vhigh', '2.5'));
// M3-24：转谱现在直接用**原视频**（不切头、不做 atempo），所以时间是"视频时间"。
// `--offset` 把时间平移到"机器时间"（默认 auto = 第一颗音 = 机器的 0 时刻）。
const OFFSET_ARG = String(opt('offset', 'auto'));

const tr = JSON.parse(fs.readFileSync(TR, 'utf8'));
const notes = tr.note_events.slice().sort((a, b) => a.onset - b.onset);
const pedals = tr.pedal_events.slice().sort((a, b) => a.on - b.on);
const OFFSET = OFFSET_ARG === 'auto' ? notes[0].onset : Number(OFFSET_ARG);

function pedalOffAt(t) {
  for (const p of pedals) {
    if (t >= p.on && t < p.off) return p.off;
    if (p.on > t) break;
  }
  return t;
}

/**
 * 松键之后还能响多久（秒）——按音区给不同的上限。
 *
 * 为什么需要：转谱的踏板在结尾给了一段 **24.8s 的"一直踩着"**，于是 261–277s 的 200 颗音
 * 全被排成"响 10~25s"。实测原视频在 4:37 早已衰到 -30dBFS，而我们的成品是 -16dBFS ——
 * 一堵中音墙。真钢琴上低音弦能撑十几秒，中高音 2~4s 就衰没了，所以按音区设上限：
 * 低了不砍（保留原曲那片低音长尾），高了收紧（不留中音墙）。
 * `--cap-low/mid/high/veryhigh` 可覆盖；传 0 = 不设上限。
 */
function maxSustain(midi) {
  if (midi <= 40) return CAP_LOW;
  if (midi <= 52) return CAP_MID;
  if (midi <= 64) return CAP_HIGH;
  return CAP_VHIGH;
}

const rows = ['step,tick,time_seconds,instrument,midi,row,volume,velocity,velMidi,keyMs,durMs,refMatched,src'];
let quantized = 0;
let collisions = 0;
let dropped = 0;
const used = new Set();
for (const n of notes) {
  if (n.offset - n.onset < MIN_KEY) { dropped++; continue; }
  const t = n.onset - OFFSET;
  const key = Math.max(0.05, n.offset - n.onset);
  const cap = maxSustain(n.midi);
  const end = Math.min(Math.max(n.offset, pedalOffAt(n.offset)), cap > 0 ? n.offset + cap : Infinity);
  const dur = Math.min(MAX_SOUND, Math.max(0.08, end - n.onset));
  const step = Math.round(t / STEP_SECONDS);
  if (Math.abs(step * STEP_SECONDS - t) > 0.03) quantized++;
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
    step, Math.round(t * 20), t.toFixed(3), n.midi < 60 ? 'bass' : 'harp',
    n.midi, row, '0.35', (n.velocity / 127).toFixed(4),
    Math.max(1, Math.min(127, Math.round(n.velocity))),
    Math.round(key * 1000), Math.round(dur * 1000), 1, 'ref',
  ].join(','));
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, rows.join('\n') + '\n', 'utf8');
console.log(`写出 ${OUT}：${notes.length} 颗音（参考转谱，量化到 ${STEP_SECONDS}s 网格，`
  + `格位偏移 >30ms 的 ${quantized} 颗 = ${(quantized / notes.length * 100).toFixed(1)}%`
  + `；触发时刻按 time_seconds 精确到刻）`);
console.log(`  时间原点 offset=${OFFSET.toFixed(3)}s（视频里的演奏起点）；`
  + `机器时长 ${(notes.at(-1).onset - OFFSET).toFixed(1)}s`);
if (dropped) console.log(`  丢掉 ${dropped} 颗 <${(MIN_KEY * 1000).toFixed(0)}ms 的"咔哒"碎片`);
console.log(`  撞格顺延 ${collisions} 颗；实际占用格位 ${used.size}；`
  + `x 范围 ${Math.min(...rows.slice(1).map((r) => +r.split(',')[0]))}..${Math.max(...rows.slice(1).map((r) => +r.split(',')[0]))} step`);
console.log(`  踏板 ${pedals.length} 段；力度中位 ${notes.map((n) => n.velocity).sort((a, b) => a - b)[notes.length >> 1].toFixed(0)}`);
