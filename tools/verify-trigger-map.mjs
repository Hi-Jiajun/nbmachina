#!/usr/bin/env node
// M3-37 · 纯离线校验：数据包里的"红石块触发位"与 machine 谱面算出来的触发位是否逐条一致。
//
// 为什么需要：触发位是**算出来**的（src/emit/trigger-map.mjs），一旦数据包和谱面对不上，
// 机器就会出现"某些音不响"或"红石块残留"。这条检查不看游戏，直接把两边对起来：
//   ① 每颗音在 lo/hi 两套表里各有一行放红石块；
//   ② 放的位置 = 该音符的水平相邻空格；
//   ③ 下一刻有对应的拆除行；
//   ④ 触发位没有重复（同一格被两颗音共用在"放置/清除"上会打架）。
//
// 用法：node tools/verify-trigger-map.mjs [--score build/machine_from_reference.csv] [--pack build/styx_build]
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';
import { makePos } from '../src/emit/layout-pos.mjs';
import { buildTriggerMap } from '../src/emit/trigger-map.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();
const SCORE = opt('score', path.join(P.build, 'machine_from_reference.csv'));
const PACK = opt('pack', path.join(P.build, 'styx_build'));

const rows = fs.readFileSync(SCORE, 'utf8').trim().split(/\r?\n/);
const header = rows[0].split(',');
const iStep = header.indexOf('step'), iRow = header.indexOf('row');
if (iStep < 0 || iRow < 0) throw new Error(`谱面缺 step/row 列：${header.join(',')}`);
const notes = rows.slice(1).map((l) => {
  const c = l.split(',');
  return { step: +c[iStep], pitch: +c[iRow] };
});

const profile = JSON.parse(fs.readFileSync(P.profile, 'utf8'));
const pos = makePos(profile);
const { cells, missing } = buildTriggerMap(notes, pos);
if (missing) throw new Error(`有 ${missing} 颗音算不出触发位`);

const placeRe = /execute if score #t styx\.t matches (\d+) run execute if score #nb styx\.flag matches 1 run setblock (-?\d+) (-?\d+) (-?\d+) minecraft:redstone_block/;
const clearRe = /execute if score #t styx\.t matches (\d+) run setblock (-?\d+) (-?\d+) (-?\d+) minecraft:air/;

const problems = [];
const seenCell = new Map();
let checked = 0;
let engineOnly = 0;
// 兜底清理：落在"没有音符的窗口"里的拆除行不在 bNNN 里，而是统一进 stop / clear_triggers
const globalClears = new Set();
for (const f of ['stop', 'clear_triggers', 'reset']) {
  const p = path.join(PACK, 'data', 'styx', 'function', 'play', `${f}.mcfunction`);
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    const m = /setblock (-?\d+) (-?\d+) (-?\d+) minecraft:air/.exec(line);
    if (m) globalClears.add(`${m[1]},${m[2]},${m[3]}`);
  }
}
for (const mode of ['lo', 'hi']) {
  const dir = path.join(PACK, 'data', 'styx', 'function', 'play', mode);
  if (!fs.existsSync(dir)) { problems.push(`缺目录：${dir}`); continue; }
  const places = new Map();   // "x,y,z" -> tick
  const clears = new Set();   // "tick:x,y,z"
  for (const f of fs.readdirSync(dir).filter((n) => /^b\d+\.mcfunction$/.test(n))) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split(/\r?\n/)) {
      const p = placeRe.exec(line);
      if (p) {
        const key = `${p[2]},${p[3]},${p[4]}`;
        if (places.has(key)) problems.push(`${mode}: 同一触发位被放两次 ${key}`);
        places.set(key, +p[1]);
        continue;
      }
      const c = clearRe.exec(line);
      if (c && line.includes('run setblock')) clears.add(`${c[1]}:${c[2]},${c[3]},${c[4]}`);
    }
  }
  // ① 每颗音的触发位都要出现，且与算出来的一致
  let ok = 0;
  for (let i = 0; i < notes.length; i++) {
    const cell = cells[i];
    const key = `${cell.x},${cell.y},${cell.z}`;
    if (!cell.strict) {
      // 非严格触发位 → 这一颗音固定走 mod 引擎（`if #nb matches 1 run nbm playat`）
      engineOnly++;
      const p = pos(notes[i].step, notes[i].pitch);
      const want = `${p.x} ${p.y} ${p.z}`;
      const dir = path.join(PACK, 'data', 'styx', 'function', 'play', mode);
      const hit = fs.readdirSync(dir).filter((n) => /^b\d+\.mcfunction$/.test(n))
        .some((n) => fs.readFileSync(path.join(dir, n), 'utf8')
          .includes(`if score #nb styx.flag matches 1 run nbm playat ${want}`));
      if (!hit) problems.push(`${mode}: 第 ${i} 颗音既没有严格触发位、也没有引擎兜底行`);
      continue;
    }
    if (!places.has(key)) { problems.push(`${mode}: 缺 ${key}（第 ${i} 颗音）`); continue; }
    ok++;
    // ③ 下一刻必须有拆除
    const tick = places.get(key);
    if (!clears.has(`${tick + 1}:${key}`) && !clears.has(`${tick}:${key}`) && !globalClears.has(key)) {
      problems.push(`${mode}: ${key} 放在第 ${tick} 刻但没有拆除行`);
    }
    if (mode === 'lo') seenCell.set(key, (seenCell.get(key) ?? 0) + 1);
  }
  checked += ok;
  console.log(`${mode}：放红石块 ${places.size} 处，命中谱面触发位 ${ok}/${notes.length}，拆除行 ${clears.size}`);
}
const dup = [...seenCell.entries()].filter(([, n]) => n > 1);
if (dup.length) problems.push(`有 ${dup.length} 个触发位被多颗音共用：${dup.slice(0, 3).map(([k]) => k).join(' ')}`);

console.log(`谱面 ${notes.length} 颗音；lo/hi 合计校验 ${checked} 条；引擎兜底 ${engineOnly} 条`);
if (problems.length) {
  console.log(`✘ 不通过，${problems.length} 个问题：`);
  for (const p of problems.slice(0, 10)) console.log('  - ' + p);
  process.exit(1);
}
console.log('✔ 触发位校验通过：位置一致、无重复、放/拆成对');
