#!/usr/bin/env node
// M3-28 · 数据包 ↔ 谱面 一致性校验（纯离线，不需要进游戏）
//
// 为什么需要：SPEC 的成功标准里写着"触发计数差 0"。以前靠副本服自检跑一遍才知道，
// 现在直接从**生成好的数据包**里把派发解出来，逐颗对谱面：
//   ① 每颗谱面音在 datapack 里恰好有一条 `nbforge playat <x> <y> <z>`（坐标同一套 makePos）；
//   ② 触发的 tick = round(time_seconds × tps)（20 / 100 两套表都要对）；
//   ③ 顺带量一下"精确时刻触发"比"格位触发"（step × 0.12s）好多少——这是 M3-24 之后的核心改动。
//
// 用法：
//   node tools/verify-pack-vs-score.mjs
//   node tools/verify-pack-vs-score.mjs --notes build/machine_from_reference.csv --pack build/styx_build
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';
import { makePos } from '../src/emit/layout-pos.mjs';
import { STEP_SECONDS } from '../src/emit/tick-map.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const NOTES = opt('notes', path.join(P.build, 'machine_from_reference.csv'));
const PACK = opt('pack', path.join(P.build, 'styx_build'));
const REPORT = opt('report', path.join(P.build, 'verify_pack_report.json'));

/* ---------------------------------------------------------------- 谱面 → 期望的 (tick, 坐标) */
const lines = fs.readFileSync(NOTES, 'utf8').trim().split(/\r?\n/);
const idx = Object.fromEntries(lines[0].split(',').map((h, i) => [h, i]));
const profile = JSON.parse(fs.readFileSync(P.profile, 'utf8'));
const pos = makePos(profile);
const notes = lines.slice(1).filter((l) => l.trim()).map((l) => {
  const c = l.split(',');
  const step = Number(c[idx.step]);
  const row = Number(c[idx.row]);
  const t = idx.time_seconds !== undefined && `${c[idx.time_seconds]}`.trim() !== ''
    ? Number(c[idx.time_seconds]) : step * STEP_SECONDS;
  const p = pos(step, row);
  return { step, row, t, cell: `${p.x},${p.y},${p.z}` };
});

/* ---------------------------------------------------------------- 数据包 → 实际派发 */
const readMode = (mode, tps) => {
  const dir = path.join(PACK, 'data', 'styx', 'function', 'play', mode);
  if (!fs.existsSync(dir)) throw new Error(`没有这个模式的函数目录：${dir}（先跑 src/emit/datapack-playback.mjs）`);
  const dispatches = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.mcfunction'))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      // 发声行可能带一层 "只做视觉" 守卫（M3-29，`#snd 0` 时静音），这里容忍两种写法
      const m = line.match(/^execute if score #t styx\.t matches (\d+) run (?:execute unless score #snd styx\.flag matches 0 run )?nbforge playat (-?\d+) (-?\d+) (-?\d+)$/);
      if (m) dispatches.push({ tick: Number(m[1]), cell: `${m[2]},${m[3]},${m[4]}`, file: f });
    }
  }
  const want = new Map();       // cell -> {tick, t}
  for (const n of notes) {
    const tick = Math.round(n.t * tps);
    const prev = want.get(n.cell);
    if (prev && prev.tick !== tick) {
      // 同一格位在同一模式下被两颗音共用（撞格顺延后不该发生）——记下来但不崩
      prev.conflict = true;
    }
    want.set(n.cell, { tick, t: n.t });
  }
  const got = new Map();
  for (const d of dispatches) {
    if (!got.has(d.cell)) got.set(d.cell, d);
    else got.get(d.cell).dup = true;
  }
  const missing = [...want.keys()].filter((c) => !got.has(c));
  const extra = [...got.keys()].filter((c) => !want.has(c));
  let tickMismatch = 0;
  const slotErrMs = [];
  for (const [cell, w] of want) {
    const g = got.get(cell);
    if (g && g.tick !== w.tick) tickMismatch++;
    const slotTick = Math.round(Math.round(w.t / STEP_SECONDS) * STEP_SECONDS * tps);
    slotErrMs.push(Math.abs(slotTick - w.tick) / tps * 1000);
  }
  const maxSlot = slotErrMs.length ? Math.max(...slotErrMs) : 0;
  const meanSlot = slotErrMs.length ? slotErrMs.reduce((a, b) => a + b, 0) / slotErrMs.length : 0;
  return {
    notes: notes.length,
    dispatches: dispatches.length,
    cellsWanted: want.size,
    missing: missing.length,
    extra: extra.length,
    tickMismatch,
    duplicateCells: [...got.values()].filter((g) => g.dup).length,
    exactVsSlot: {
      maxMs: +maxSlot.toFixed(1),
      meanMs: +meanSlot.toFixed(1),
      note: '精确时刻触发 vs 0.12s 格位触发的偏差；这条就是 M3-24 之后不用再被格位量化卡住的原因',
    },
    missingExamples: missing.slice(0, 5),
    extraExamples: extra.slice(0, 5),
  };
};

const report = { notes: path.basename(NOTES), pack: path.basename(PACK), modes: {} };
for (const [mode, tps] of [['lo', 20], ['hi', 100]]) report.modes[mode] = readMode(mode, tps);
fs.writeFileSync(REPORT, JSON.stringify(report, null, 1), 'utf8');

let bad = 0;
for (const [mode, r] of Object.entries(report.modes)) {
  const ok = r.missing === 0 && r.extra === 0 && r.tickMismatch === 0;
  if (!ok) bad++;
  console.log(`${mode}（${mode === 'lo' ? '20' : '100'} tps）：谱面 ${r.notes} 颗 / 派发 ${r.dispatches} 条 / `
    + `缺失 ${r.missing} / 多余 ${r.extra} / tick 不符 ${r.tickMismatch} → ${ok ? '通过' : '不通过'}`);
  console.log(`   精确时刻 vs 0.12s 格位：平均差 ${r.exactVsSlot.meanMs}ms、最大 ${r.exactVsSlot.maxMs}ms`);
  if (!ok) {
    if (r.missingExamples.length) console.log(`   缺失示例：${r.missingExamples.join('  ')}`);
    if (r.extraExamples.length) console.log(`   多余示例：${r.extraExamples.join('  ')}`);
  }
}
console.log(`报告 → ${REPORT}`);
process.exit(bad ? 1 : 0);
