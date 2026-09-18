#!/usr/bin/env node
// M3-17（P2-2）· 把机器谱面导出成 mod 直接读的 `score.csv`
//
// mod 侧（nbmachinaScorePlayer）按时间把每颗音派发给客户端，客户端用无损引擎播。
// 表头固定五列：`time_seconds,instrument,midi,velocity,voice`
//   · instrument = `config/nbm/instruments.json` 里的乐器 id（声部→乐器由这里的映射决定）
//   · velocity   = 1..127（优先用谱面的 `velMidi`；没有就用 `volume × 127` = 现行的恒定口径）
//   · voice      = 原声部名（只用于诊断）
//
// 预设（`--preset`）：
//   piano（默认）  = 全钢琴：旋律与贝斯都用同一架琴，打击乐跳过
//                    —— 本曲 STYX HELIX 的参考就是 Animenz 的**钢琴改编**（用户 2026-09-16 拍板"全钢琴最好"），
//                    原曲里的鼓不属于钢琴改编，硬塞进去反而破坏"一个演奏者"的听感。
//   ensemble       = 小编制：贝斯→VSCO 低音提琴拨弦、打击乐→VSCO 底鼓/铃鼓（给"不是钢琴改编"的曲子用）
//
// 用法：
//   node tools/export-mod-score.mjs                                    # 默认 = 全钢琴
//   node tools/export-mod-score.mjs --preset ensemble                   # 低音提琴+打击乐版
//   node tools/export-mod-score.mjs --melody disklavier --bass skip     # 逐项覆盖
//   node tools/export-mod-score.mjs --deploy                            # 顺带写到客户端与测试服的游戏目录
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths } from '../src/core/paths.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const SRC = opt('in', P.machineScore);
const OUT = opt('out', path.join(P.build, 'nbmachina_score.csv'));
const PRESET = opt('preset', 'piano');
if (!['piano', 'ensemble'].includes(PRESET)) throw new Error('--preset 只支持 piano/ensemble');
const MELODY = opt('melody', 'salamander48');
// 默认（piano 预设）：贝斯也用同一架琴（左手弹），打击乐跳过
const BASS = opt('bass', PRESET === 'ensemble' ? 'vsco_contrabass_pizz' : MELODY);
const PERC = opt('perc', PRESET === 'ensemble' ? 'vsco_perc' : 'skip');
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

// 第 6 列 `dur_ms`（M3-22）：实际发声时长（毫秒，来自参考演奏校准）；没有时值写 0
const out = ['time_seconds,instrument,midi,velocity,voice,dur_ms'];
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
  const durMs = idx.durMs !== undefined && c[idx.durMs] !== undefined && c[idx.durMs] !== ''
    ? Math.max(0, Math.round(Number(c[idx.durMs])))
    : 0;
  if (durMs > 0) stats.withDur = (stats.withDur ?? 0) + 1;
  out.push(`${t.toFixed(3)},${target},${midi},${velocity},${voice},${durMs}`);
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
console.log(`  时值：${stats.withDur ?? 0}/${stats.written} 颗带 dur_ms`);
console.log(`  时长：${(Number(lines.at(-1).split(',')[idx.time_seconds])).toFixed(1)}s`);

if (DEPLOY) {
  for (const [label, dir] of [['客户端', CLIENT_GAME_DIR], ['测试服', TEST_SERVER_DIR]]) {
    const dst = path.join(dir, 'nbmachina', 'score.csv');
    try {
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(OUT, dst);
      console.log(`  已部署（${label}）→ ${dst}`);
    } catch (e) {
      console.warn(`  部署失败（${label}）${dst}：${e.message}`);
    }
  }
}
