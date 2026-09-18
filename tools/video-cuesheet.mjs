#!/usr/bin/env node
// M3-32 · 出片用的"时间轴小抄"：把段落表 + 已知关键点导出成 csv/md，剪辑时对着用
//   node tools/video-cuesheet.mjs            # → build/video_cuesheet.md + .csv
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';

const P = resolvePaths();
const SECTIONS = JSON.parse(fs.readFileSync(path.join(P.build, 'dynamics-sections.json'), 'utf8'));
const score = fs.readFileSync(path.join(P.build, 'machine_from_reference.csv'), 'utf8')
  .trim().split(/\r?\n/).slice(1).map((l) => l.split(','));
const head = fs.readFileSync(path.join(P.build, 'machine_from_reference.csv'), 'utf8').split(/\r?\n/)[0].split(',');
const idx = Object.fromEntries(head.map((h, i) => [h, i]));

const mmss = (sec) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// 关键点：最大声段、最密段、尾奏颤音（midi>102）
const notes = score.map((c) => ({ t: Number(c[idx.time_seconds]), midi: Number(c[idx.midi]) }));
const density = [];
for (let t = 0; t < 280; t += 5) density.push([t, notes.filter((n) => n.t >= t && n.t < t + 5).length]);
density.sort((a, b) => b[1] - a[1]);
const trill = notes.filter((n) => n.midi > 102);

const lines = ['# STYX HELIX 出片时间轴小抄（机器时间轴：0:00 = 视频里的第一颗音）', ''];
const csv = ['start_sec,end_sec,start_mmss,end_mmss,label,loudness_dB'];
lines.push('## 段落（来自 build/dynamics-sections.json，共 ' + SECTIONS.sections.length + ' 段）', '');
lines.push('| 时间 | 段落 | 响度 |');
lines.push('|---|---|---|');
for (const s of SECTIONS.sections) {
  lines.push(`| ${mmss(s.start)}–${mmss(s.end)} | ${s.label} | ${s.loudnessDb} dB |`);
  csv.push(`${s.start},${s.end},${mmss(s.start)},${mmss(s.end)},${s.label},${s.loudnessDb}`);
}
lines.push('', '## 关键点', '');
lines.push(`- 音符总数：${notes.length}（最后一声在 ${mmss(notes.at(-1).t)}）`);
lines.push(`- 最密的 5 秒窗口：${density.slice(0, 3).map(([t, n]) => `${mmss(t)}（${n} 颗）`).join('、')}`);
if (trill.length) {
  lines.push(`- 尾奏高音颤音（midi>102 的 ${trill.length} 颗）：${mmss(trill[0].t)}–${mmss(trill.at(-1).t)}`
    + `（这一段以前因为"高音区行号回退"被弹成低音，M3-27 修好了）`);
}
lines.push('', '## 出片参数建议', '');
lines.push('- 视频：2560×1440 / 60fps（本机原生分辨率），渲染码率 40–80 Mbps 或直接 ProRes 再压');
lines.push('- 音轨：`build/master/styx_master_48k24bit.wav`（48k/24bit 无损）');
lines.push('- 合成：`node tools/mux-video.mjs --video <渲染.mp4> --offset <音乐起始秒> --out build/final/styx_final.mkv`');
lines.push('- 录制前先 `/tick rate 100`，灯/粒子的视觉误差能压到 ±5ms（声音已经是 ~1ms 级）');

fs.mkdirSync(P.build, { recursive: true });
fs.writeFileSync(path.join(P.build, 'video_cuesheet.md'), lines.join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(P.build, 'video_cuesheet.csv'), csv.join('\n') + '\n', 'utf8');
console.log(`写出 ${path.join(P.build, 'video_cuesheet.md')} 与 .csv（${SECTIONS.sections.length} 段）`);
