#!/usr/bin/env node
// M3-17（P2-2）· 把机器谱面导出成 mod 直接读的 `score.csv`
//
// mod 侧（NbforgeScorePlayer）按时间把每颗音派发给客户端，客户端用无损引擎播。
// 表头固定五列：`time_seconds,instrument,midi,velocity,voice`
//   · instrument = `config/nbforge/instruments.json` 里的乐器 id（声部→乐器由这里的映射决定）
//   · velocity   = 1..127（优先用谱面的 `velMidi`；没有就用 `volume × 127` = 现行的恒定口径）
//   · voice      = 原声部名（只用于诊断）
//
// 用法：
//   node tools/export-mod-score.mjs                                   # 默认：旋律&贝斯→salamander48，打击乐跳过
//   node tools/export-mod-score.mjs --melody disklavier --bass skip    # 换琴 / 只留旋律
//   node tools/export-mod-score.mjs --deploy                           # 顺带写到客户端与测试服的游戏目录
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const SRC = opt('in', P.machineScore);
const OUT = opt('out', path.join(P.build, 'nbforge_score.csv'));
const MELODY = opt('melody', 'salamander48');
const BASS = opt('bass', 'vsco_contrabass_pizz');   // VSCO 低音提琴拨弦（M3-18 起）
const PERC = opt('perc', 'vsco_perc');              // VSCO 打击乐：底鼓 + 铃鼓（VSCO 无闭合踩镲，用铃鼓替代）
const DEPLOY = has('deploy');
const CLIENT_GAME_DIR = 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5';
const TEST_SERVER_DIR = 'C:/Users/hiliang/Documents/minecraft/_toolchain/spike-testserver';

const VOICE_MAP = { harp: MELODY, bell: MELODY, bass: BASS, basedrum: PERC, hat: PERC };
/**
 * 打击乐的键位修正：机器谱面里 basedrum/hat 的 `midi` 列其实是**音符盒行号**（0 与 24），
 * 不是 GM 键位（实测：basedrum midi=0 row=0、hat midi=24 row=24）。
 * 离线渲染 `render-ensemble` 也是按声部名映射到 GM（basedrum=36 / hat=42），这里保持同一口径。
 */
const PERC_KEY = { basedrum: 36, hat: 42 };

const lines = fs.readFileSync(SRC, 'utf8').trim().split(/\r?\n/);
const header = lines[0].split(',');
const idx = Object.fromEntries(header.map((h, i) => [h, i]));
for (const need of ['time_seconds', 'instrument', 'midi', 'volume']) {
  if (idx[need] === undefined) throw new Error(`谱面缺列 ${need}：${header.join(',')}`);
}

const out = ['time_seconds,instrument,midi,velocity,voice'];
const stats = { total: 0, written: 0, skipped: 0, byVoice: {}, byInstrument: {} };
const keyRange = {};
for (const line of lines.slice(1)) {
  if (!line.trim()) continue;
  const c = line.split(',');
  stats.total++;
  const voice = c[idx.instrument];
  const target = VOICE_MAP[voice] ?? MELODY;
  if (target === 'skip') {
    stats.skipped++;
    continue;
  }
  const t = Number(c[idx.time_seconds]);
  let midi = Number(c[idx.midi]);
  if (PERC_KEY[voice] !== undefined) midi = PERC_KEY[voice];
  if (!Number.isFinite(t) || !Number.isFinite(midi)) {
    stats.skipped++;
    continue;
  }
  // 力度：优先 velMidi（实测/乐句/段落口径），否则退回 volume × 127（= 现在的恒定口径）
  const velMidi = idx.velMidi !== undefined && c[idx.velMidi] !== undefined && c[idx.velMidi] !== ''
    ? Number(c[idx.velMidi])
    : Math.round(Number(c[idx.volume]) * 127);
  const velocity = Math.max(1, Math.min(127, Number.isFinite(velMidi) ? velMidi : 100));
  out.push(`${t.toFixed(3)},${target},${midi},${velocity},${voice}`);
  stats.written++;
  stats.byVoice[voice] = (stats.byVoice[voice] ?? 0) + 1;
  stats.byInstrument[target] = (stats.byInstrument[target] ?? 0) + 1;
  const kr = keyRange[target] ?? (keyRange[target] = { lo: midi, hi: midi });
  kr.lo = Math.min(kr.lo, midi);
  kr.hi = Math.max(kr.hi, midi);
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, out.join('\n') + '\n', 'utf8');
console.log(`写出 ${OUT}：${stats.written} 颗音（源 ${stats.total} 行，跳过 ${stats.skipped}）`);
console.log(`  声部：${JSON.stringify(stats.byVoice)}`);
console.log(`  乐器：${JSON.stringify(stats.byInstrument)}`);
console.log(`  键位：${Object.entries(keyRange).map(([k, v]) => `${k}=${v.lo}..${v.hi}`).join('  ')}`);
console.log(`  时长：${(Number(lines.at(-1).split(',')[idx.time_seconds])).toFixed(1)}s`);

if (DEPLOY) {
  for (const [label, dir] of [['客户端', CLIENT_GAME_DIR], ['测试服', TEST_SERVER_DIR]]) {
    const dst = path.join(dir, 'nbforge', 'score.csv');
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(OUT, dst);
      console.log(`  已部署（${label}）→ ${dst}`);
    } catch (e) {
      console.warn(`  部署失败（${label}）${dst}：${e.message}`);
    }
  }
}
