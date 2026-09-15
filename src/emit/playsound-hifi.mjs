// M2-1 · 高保真监听后端：把机器谱面用**自研音色**（资源包 nbforge:*）播给玩家，而不是原版音符盒音色
//
// 与 src/emit/datapack-playback.mjs 的关系：**一行都不改它**（任务书硬要求）。
// 本文件生成一套独立函数，接线由根代理做（两种都行）：
//   a) 在 styx:play/tick 里加一行 `function styx:play/hifi/tick`
//   b) 把 styx:play/hifi/tick 加进 minecraft:tick 标签
// 注意：play/ 目录是 datapack-playback.mjs 生成时**整个重建**的，所以重跑 emit:playback 之后
// 必须再跑一次本文件（否则 play/hifi/* 与 monitor_hifi_* 会被删掉）。
//
// 生成物：
//   styx:play/monitor_hifi_on / monitor_hifi_off   开关（#hifi 标志）
//   styx:play/hifi/tick                            每刻入口（自带开关 + 自己的计数器）
//   styx:play/hifi/lo|hi/{tick,binNN,bNNN}         20tps / 100tps 两套分层派发表（与 datapack-playback 同口径）
//   styx:play/hifi/stop / report                   收尾与计数
//
// 计数器口径：#ht styx.t 是 hifi 自己的刻计数器；**机器播放中**（#on=1）时每刻与 #t 对齐，
// 所以既能在机器演奏时叠着听（A/B 对比原版音色），也能单独试听（不动机器）。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  buildTickGroups, callsPerTick, pad, planBins, planBuckets,
} from './tick-map.mjs';
import {
  REFERENCE_VEL, REGISTERS, TIMBRES, eventIdOf, hasEvent, midiFromRow, noteFileName,
} from '../synth/voices.mjs';
import { makePos } from './layout-pos.mjs';
import { resolvePaths } from '../core/paths.mjs';
import { velMidiToAmplitude } from '../arrange/dynamics.mjs';

// M2-3：build 目录与数据包目录都走 paths.mjs
const P = resolvePaths();
const BUILD = P.build;
const DP = P.datapackDir;

/** 计数口径的自述（报告与测试都引用它）：独立自增 + 播放中同步 #t */
export const HIFI_SYNC_STEPS = [
  'hifi 自己的刻计数 #ht：单独试听时每刻 +1（不依赖机器播放）',
  '机器播放中（#on=1）每刻执行 #ht = #t：两边永远同刻，方便与原版音色 A/B',
];

/** 内声部可用音色（--inner），默认 bell */
export const INNER_CHOICES = ['bell', 'pad', 'strings'];

// 乐器名归一化：机器谱面现在只产出 harp/bass/basedrum/hat，但编排层以后会加内声部/钟琴/铺底，
// 这里先把别名收拢，未知乐器一律退回 strings 并计入 stats（不静默丢弃）。
const INSTRUMENT_ALIAS = {
  harp: 'harp', strings: 'harp', violin: 'harp', piano: 'harp', guitar: 'harp', flute: 'harp',
  // M3-1：内声部层（arrange 的 `--inner on` 会产出 `instrument=inner` + `voiceRole` 列）；
  // 显式标签优先于"最高行=旋律"的启发式，见 planHifi
  inner: 'inner',
  bass: 'bass', bass_guitar: 'bass', cello: 'bass',
  bell: 'bell', chime: 'bell', glockenspiel: 'bell', xylophone: 'bell',
  pad: 'pad', synth_pad: 'pad',
  basedrum: 'basedrum', hat: 'hat', snare: 'snare',
};
const VANILLA_SOUND = {
  basedrum: 'minecraft:block.note_block.basedrum',
  hat: 'minecraft:block.note_block.hat',
  snare: 'minecraft:block.note_block.snare',
};
const TIMBRE_COUNTER = {
  strings: '#hifiStr', bell: '#hifiBell', pad: '#hifiPad', bass: '#hifiBass', piano: '#hifiPiano',
};
const pitchMul = (row) => (2 ** ((row - 12) / 12)).toFixed(4);
const vol2 = (v) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1).toFixed(2);

/** 谱面 CSV → 音符表（按表头取列；缺列直接报错，不猜列序） */
export function parseScoreCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const idx = (n) => header.indexOf(n);
  const iStep = idx('step');
  const iInstr = idx('instrument');
  const iRow = idx('row');
  const iVol = idx('volume');
  // 谱面的**真实音高**（`midi` 列，T3 用音频逐音标定过）：后端 A 没有 2 个八度限制，
  // 应当按它播音高；`row` 只是"折叠到音符盒音域"的结果，给机器（后端 B）用。
  const iMidi = idx('midi');
  // M0 T5b 的**实测力度**（从参考演奏里逐音量出来的，`pipeline_*.csv` 里有，machine 谱面没有）。
  // 可选列：解析出来但没有列时就给 null，让调用方决定要不要退回 volume。
  const iVel = idx('velocity');
  // M3-14 的**归一力度**（1..127）：由 src/arrange/dynamics.mjs 写入谱面，是"采样层 + 音量"的共用尺子
  const iVelMidi = idx('velMidi');
  // M3-1 的可选溯源列：有就用，没有就按老口径（启发式）判定声部
  const iRole = idx('voiceRole');
  if ([iStep, iInstr, iRow, iVol].some((i) => i < 0)) throw new Error(`谱面 CSV 缺列：${header.join(',')}`);
  const notes = lines.slice(1).filter((l) => l.trim()).map((l) => {
    const c = l.split(',');
    return {
      step: +c[iStep], instr: c[iInstr], row: +c[iRow], vol: +c[iVol],
      midi: iMidi >= 0 ? +c[iMidi] : null,
      role: iRole >= 0 ? (c[iRole] ?? '') : '',
      velocity: iVel >= 0 ? +c[iVel] : null,
      velMidi: iVelMidi >= 0 && `${c[iVelMidi] ?? ''}`.trim() !== '' ? +c[iVelMidi] : null,
    };
  });
  const byInstrument = {};
  for (const n of notes) byInstrument[n.instr] = (byInstrument[n.instr] ?? 0) + 1;
  return {
    notes,
    stats: {
      notes: notes.length,
      byInstrument,
      minStep: Math.min(...notes.map((n) => n.step)),
      maxStep: Math.max(...notes.map((n) => n.step)),
    },
  };
}

/**
 * 谱面 → 播放事件（音色映射的唯一入口）。
 * @param {Array<{step:number,instr:string,row:number,vol:number}>} notes
 * @param {{bassOctave?:number, inner?:string, melody?:string}} [opts] bassOctave 默认 0（**原曲音高，不做任何升降**；
 *   旧默认 +1 是为了"小音箱放不出 25Hz 基频"，2026-09-14 按用户要求取消："音高全部按原曲"）
 *   melody = 旋律层音色（默认 piano；可用 strings 回到 M2-1 的拨弦音色做 A/B）
 */
export function planHifi(notes, { bassOctave = 0, inner = 'bell', melody = 'strings' } = {}) {
  if (!INNER_CHOICES.includes(inner)) throw new Error(`--inner 只支持 ${INNER_CHOICES.join('/')}，收到 ${inner}`);
  if (!TIMBRES.includes(melody)) throw new Error(`--melody 只支持 ${TIMBRES.join('/')}，收到 ${melody}`);
  const fam = (instr) => INSTRUMENT_ALIAS[String(instr ?? '').toLowerCase()] ?? null;
  /** 显式内声部标签（M3-1）：`instrument=inner` 或 `voiceRole=inner` 都认 */
  const isInnerLabel = (n) => String(n.instr ?? '').toLowerCase() === 'inner'
    || String(n.role ?? '').toLowerCase() === 'inner';

  // 旋律判定（两种口径，显式标签优先）：
  //   ① 有 M3-1 标签的谱面：标了 inner 的就是内声部，旋律 = 其余 harp 家族音
  //   ② 没有标签的谱面（老口径）：同一 step 上"harp 家族"里行号最高的那颗 = 旋律，其余 = 内声部
  // 未知乐器也按 harp 家族参与旋律判定（它们最终退回 strings，不该被当成内声部）
  const melodyIdx = new Set();
  const best = new Map();
  notes.forEach((n, i) => {
    if ((fam(n.instr) ?? 'harp') !== 'harp') return;
    if (isInnerLabel(n)) return; // 显式内声部不参与"谁是旋律"的竞争
    const cur = best.get(n.step);
    if (!cur || n.row > cur.row) best.set(n.step, { row: n.row, idx: i });
  });
  for (const { idx } of best.values()) melodyIdx.add(idx);

  const stats = {
    notes: notes.length, synth: 0, vanilla: 0, inner: 0, innerExplicit: 0, innerHeuristic: 0,
    // 真实音高没有对应采样、退回"折叠 row"的音数（正常应为 0；>0 说明音域要再扩）
    octaveFallback: 0, bassOctaveSkipped: 0,
    strings: 0, pad: 0, bell: 0, bass: 0, piano: 0, bassOctaveUp: 0, unknownInstrument: 0, fallback: 0,
    byTimbre: {}, byInstrument: {},
    withDynamics: 0,   // 有多少颗音用上了 M3-14 的实测力度（velMidi）
  };
  // 音量口径（M3-14）：有 `velMidi` 就用它（实测力度 → 振幅；1..127 ≈ -16.7dB..0dB），
  // 没有（老谱面、打击乐）就退回原来的 `volume` 列。0.35 那套恒定音量是"没有强弱"的根因。
  const volumeOf = (n) => (Number.isFinite(n.velMidi) ? velMidiToAmplitude(n.velMidi).toFixed(2) : vol2(n.vol));
  const events = [];
  notes.forEach((n, i) => {
    const instr = String(n.instr ?? '').toLowerCase();
    stats.byInstrument[instr] = (stats.byInstrument[instr] ?? 0) + 1;
    let family = fam(instr);
    if (!family) {
      stats.unknownInstrument++;
      stats.fallback++;
      family = 'harp'; // 未知乐器按旋律声部处理（音高仍可用 row→midi 映射）
    }
    // `velocity` = M0 T5b 从参考演奏量出来的实测力度（可选列；没有就是 null）。
    // 只做透传，不在这里改音量口径——要不要用它做"真力度"由调用方（离线渲染/emit）决定。
    const base = {
      step: n.step, instr: n.instr, row: n.row, vol: n.vol,
      velocity: n.velocity ?? null, velMidi: n.velMidi ?? null,
    };
    if (VANILLA_SOUND[family]) {
      stats.vanilla++;
      events.push({
        ...base, kind: 'vanilla', timbre: null, midi: null, event: VANILLA_SOUND[family],
        volume: volumeOf(n), pitch: pitchMul(n.row),
      });
      return;
    }
    let timbre;
    let midi;
    // 采样音高：**优先用谱面的真实音高**（`midi` 列，T3 用音频逐音标定过），
    // 只有该音高没有对应采样时才退回"折叠到音符盒音域"的老口径（并计数，便于发现覆盖率问题）。
    const sampleMidi = (timbreName, n) => {
      if (Number.isFinite(n.midi) && hasEvent(timbreName, n.midi)) {
        return n.midi;
      }
      stats.octaveFallback++;
      return midiFromRow(timbreName === 'bass' ? 'bass' : 'harp', n.row);
    };
    if (family === 'bass') {
      timbre = 'bass';
      const base = sampleMidi('bass', n);
      const lifted = base + 12 * bassOctave;
      // 升八度是为了小音箱听得见；但提升后若超出采样音域就**不提升**（否则整个渲染直接报错）
      if (bassOctave && hasEvent('bass', lifted)) {
        midi = lifted;
        stats.bassOctaveUp++;
      } else {
        midi = base;
        if (bassOctave) stats.bassOctaveSkipped++;
      }
    } else if (family === 'bell') {
      timbre = 'bell';
      midi = sampleMidi('bell', n);
    } else if (family === 'pad') {
      timbre = 'pad';
      midi = sampleMidi('pad', n);
    } else if (melodyIdx.has(i)) {
      timbre = melody;
      midi = sampleMidi(melody, n);
    } else {
      // 内声部：音色由 --inner 决定（默认 bell），音高同样优先取谱面真实音高。
      // 来源分两种并分别计数：M3-1 的显式标签（instrument=inner / voiceRole=inner），
      // 或老口径的"同刻非最高音"启发式（没有标签的谱面）。
      timbre = inner;
      midi = sampleMidi(inner, n);
      stats.inner++;
      if (isInnerLabel(n)) stats.innerExplicit++;
      else stats.innerHeuristic++;
    }
    if (!hasEvent(timbre, midi)) {
      throw new Error(`${timbre} 未渲染 midi ${midi}（row ${n.row}，音域 ${REGISTERS[timbre].join('..')}）—— `
        + '请调整 src/synth/voices.mjs 的 REGISTERS 后重跑 render-all');
    }
    stats.synth++;
    if (Number.isFinite(n.velMidi)) stats.withDynamics++;
    stats[timbre]++;
    stats.byTimbre[timbre] = (stats.byTimbre[timbre] ?? 0) + 1;
    events.push({
      ...base, kind: 'synth', timbre, midi, note: noteFileName(midi),
      event: eventIdOf(timbre, midi), volume: volumeOf(n), pitch: '1',
    });
  });

  // 两套刻率表（与 datapack-playback 同口径：20 tps 默认、100 tps 精确模式）
  const modes = [];
  for (const [mode, tps] of [['lo', 20], ['hi', 100]]) {
    const groups = buildTickGroups(events, tps);
    const ticks = [...groups.keys()];
    const buckets = planBuckets(ticks, 100);
    const bins = planBins(buckets, 15);
    const maxPerBin = Math.max(...bins.map((b) => b.buckets.length));
    modes.push({
      mode, tps, ticks: ticks.length, buckets: buckets.length, bins: bins.length,
      callsPerTick: callsPerTick(bins.length, maxPerBin),
      lastTick: ticks.length ? ticks[ticks.length - 1] : 0,
      plays: events.length,
    });
  }
  const plan = {
    modes,
    callsPerTick: Math.max(...modes.map((m) => m.callsPerTick)),
    plays: events.length,
    lastTick: Math.max(...modes.map((m) => m.lastTick)),
  };
  return { events, stats, plan };
}

const score = (name, objective) => `{"score":{"name":"${name}","objective":"${objective}"},"color":"yellow"}`;
const tell = (text, color = 'aqua', extra = '') => `tellraw @a {"text":${JSON.stringify(text)},"color":"${color}"${extra ? `,"extra":[${extra}]` : ''}}`;

/**
 * 生成全部函数文本（纯函数：不碰磁盘，测试直接查表）。
 * @returns {Map<string,string>} 键 = 函数路径（相对 data/styx/function，不含 .mcfunction）
 */
export function buildHifiFunctions(notes, opts = {}) {
  const { events, stats, plan } = planHifi(notes, opts);
  const fn = new Map();
  const counters = Object.values(TIMBRE_COUNTER);
  // 音符粒子的坐标：`#hifi=1` 时数据包不再触发音符盒（否则原版声音会叠上来），
  // 所以视觉上由这里补一发 `particle minecraft:note`（位置与 vanilla 的 addParticle 一致）
  const profile = opts.profile ?? JSON.parse(fs.readFileSync(P.profile, 'utf8'));
  const pos = makePos(profile);

  fn.set('play/monitor_hifi_on', [
    '# 由 src/emit/playsound-hifi.mjs 生成：高保真监听开（自研音色，需要 nbforge 资源包）',
    'scoreboard objectives add styx.flag dummy',
    'scoreboard objectives add styx.t dummy',
    'scoreboard objectives add styx.hifi dummy',
    '# 三个"存在性"占位：scoreboard players add X 0 只在不存在时创建（不覆盖已有值）',
    'scoreboard players add #hi styx.flag 0',
    'scoreboard players add #on styx.flag 0',
    'scoreboard players add #t styx.t 0',
    'scoreboard players set #hifi styx.flag 1',
    'scoreboard players set #hifiPlays styx.hifi 0',
    ...counters.map((c) => `scoreboard players set ${c} styx.hifi 0`),
    '# 机器正在播放 → 立刻对齐机器刻号；没在播 → 从第 0 刻开始（下一刻 +1 后正好播 step 0）',
    'execute if score #on styx.flag matches 1 run scoreboard players operation #ht styx.t = #t styx.t',
    'execute unless score #on styx.flag matches 1 run scoreboard players set #ht styx.t -1',
    tell(`[Styx] 高保真监听：开（${Object.keys(stats.byTimbre).join('/') || 'strings'} 等自研音色，需装 nbforge 资源包；贝斯升八度 +1）`, 'gold'),
  ].join('\n') + '\n');

  fn.set('play/monitor_hifi_off', [
    'scoreboard players set #hifi styx.flag 0',
    'scoreboard players set #ht styx.t -1',
    tell('[Styx] 高保真监听：关（恢复原版音符盒音色）', 'gray'),
  ].join('\n') + '\n');

  fn.set('play/hifi/tick', [
    '# 每刻入口（自带 #hifi 开关）：接线 = 把它挂进 minecraft:tick 或 play/tick',
    ...HIFI_SYNC_STEPS.map((s) => `# ${s}`),
    'execute if score #hifi styx.flag matches 1 run scoreboard players add #ht styx.t 1',
    'execute if score #hifi styx.flag matches 1 if score #on styx.flag matches 1 run scoreboard players operation #ht styx.t = #t styx.t',
    'execute if score #hifi styx.flag matches 1 if score #hi styx.flag matches 1 run function styx:play/hifi/hi/tick',
    'execute if score #hifi styx.flag matches 1 unless score #hi styx.flag matches 1 run function styx:play/hifi/lo/tick',
  ].join('\n') + '\n');

  fn.set('play/hifi/stop', [
    'scoreboard players set #hifi styx.flag 0',
    'scoreboard players set #ht styx.t -1',
    tell('[Styx] 高保真监听：播放结束（或已停止）', 'gray'),
  ].join('\n') + '\n');

  fn.set('play/hifi/report', [
    `tellraw @s {"text":"[Styx/hifi] 已发播放指令：","color":"aqua","extra":[${score('#hifiPlays', 'styx.hifi')}`
    + `,{"text":"（strings ","color":"gray"},${score('#hifiStr', 'styx.hifi')}`
    + `,{"text":" / bell ","color":"gray"},${score('#hifiBell', 'styx.hifi')}`
    + `,{"text":" / pad ","color":"gray"},${score('#hifiPad', 'styx.hifi')}`
    + `,{"text":" / bass ","color":"gray"},${score('#hifiBass', 'styx.hifi')}`
    + `,{"text":"）  当前 #ht=","color":"aqua"},${score('#ht', 'styx.t')}`
    + `,{"text":"  开=","color":"aqua"},${score('#hifi', 'styx.flag')}`
    + `,{"text":"  刻率模式 #hi=","color":"aqua"},${score('#hi', 'styx.flag')}]}`,
    `tellraw @s {"text":"[Styx/hifi] 提示：函数无法读服务器刻率，20tps 会按 20tps 表播放（抖 ±50ms）；精确请先 /tick rate 100 再用 styx:play/start_hi","color":"gray"}`,
  ].join('\n') + '\n');

  for (const m of plan.modes) {
    const groups = buildTickGroups(events, m.tps);
    const buckets = planBuckets([...groups.keys()], 100);
    const bins = planBins(buckets, 15);
    for (const bucket of buckets) {
      const out = [];
      for (const tick of bucket.ticks) {
        const guard = `execute if score #ht styx.t matches ${tick}`;
        const plays = groups.get(tick);
        out.push(`${guard} run scoreboard players add #hifiPlays styx.hifi ${plays.length}`);
        for (const e of plays) {
          if (e.timbre) out.push(`${guard} run scoreboard players add ${TIMBRE_COUNTER[e.timbre]} styx.hifi 1`);
          const p = pos(e.step, e.row);
          // 语法：particle <name> <pos> <delta> <speed> <count> [mode]（漏写 count 会让整个函数加载失败）
          out.push(`${guard} run particle minecraft:note ${p.x + 0.5} ${p.y + 1.2} ${p.z + 0.5} `
            + `${(e.row / 24).toFixed(3)} 0 0 1 1 normal`);
          out.push(`${guard} as @a at @s run playsound ${e.event} master @s ~ ~ ~ ${e.volume} ${e.pitch}`);
        }
      }
      fn.set(`play/hifi/${m.mode}/b${pad(bucket.index)}`, out.join('\n') + '\n');
    }
    for (const bin of bins) {
      fn.set(`play/hifi/${m.mode}/bin${pad(bin.index, 2)}`,
        bin.buckets.map((b) => `execute if score #ht styx.t matches ${b.startTick}..${b.endTick} run function styx:play/hifi/${m.mode}/b${pad(b.index)}`).join('\n') + '\n');
    }
    fn.set(`play/hifi/${m.mode}/tick`, [
      ...bins.map((bin) => `execute if score #ht styx.t matches ${bin.fromTick}..${bin.toTick} run function styx:play/hifi/${m.mode}/bin${pad(bin.index, 2)}`),
      `execute if score #ht styx.t matches ${m.lastTick + 1}.. run function styx:play/hifi/stop`,
    ].join('\n') + '\n');
  }
  return fn;
}

/** 把函数写进数据包（只动 play/hifi/** 与两个 monitor 文件；play/ 的其它函数是 datapack-playback 的） */
export function writeHifiFunctions(functions, datapackDir = DP) {
  const fnDir = path.join(datapackDir, 'function');
  fs.rmSync(path.join(fnDir, 'play', 'hifi'), { recursive: true, force: true });
  const written = [];
  for (const [rel, text] of functions) {
    const file = path.join(fnDir, `${rel}.mcfunction`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    written.push(file);
  }
  return written;
}

/** 接线自检：play/tick 或 minecraft:tick 标签里有没有 styx:play/hifi/tick */
export function wiringState(datapackDir = DP) {
  const dataDir = path.resolve(datapackDir, '..', '..');
  const playTick = path.join(datapackDir, 'function', 'play', 'tick.mcfunction');
  const tag = path.join(dataDir, 'minecraft', 'tags', 'function', 'tick.json');
  const inPlayTick = fs.existsSync(playTick) && fs.readFileSync(playTick, 'utf8').includes('styx:play/hifi/tick');
  const inTag = fs.existsSync(tag) && fs.readFileSync(tag, 'utf8').includes('styx:play/hifi/tick');
  return {
    wired: inPlayTick || inTag,
    inPlayTick,
    inTag,
    hint: '接线（二选一）：在 styx:play/tick 里加一行 `function styx:play/hifi/tick`，'
      + '或把 styx:play/hifi/tick 加进 data/minecraft/tags/function/tick.json',
  };
}

/**
 * **自己接线**（M3-4）：在 `styx:play/tick` 末尾追加一行
 * `execute if score #hifi styx.flag matches 1 run function styx:play/hifi/tick`。
 *
 * 为什么必须自己接：M2-1 交付时只生成了函数、把接线留给"根代理"，结果一直没接——
 * 玩家开监听后没有任何自研音色（2026-09-14 15:10 实测：`Unable to play empty soundEvent` 之后
 * 就是完全没声音，因为每刻根本没调用 hifi/tick）。
 *
 * 安全性：这一行**带 #hifi 开关**，而 #hifi 只有 `styx:play/monitor_hifi_on` 会置 1，
 * `monitor_hifi_off` 与 `play/reset` 都会清 0 → 默认路径（没开监听）行为不变。
 * 幂等：已经接过就不再追加。
 *
 * 注意顺序：`play/` 整个目录是 `datapack-playback.mjs` 生成时重建的，所以**本文件必须后跑**
 * （流水线顺序：emit:playback → … → emit:hifi）。重跑 playback 之后要再跑一次本文件。
 */
export function wireHifiTick(datapackDir = DP) {
  const file = path.join(datapackDir, 'function', 'play', 'tick.mcfunction');
  if (!fs.existsSync(file)) {
    return { wired: false, added: false, reason: 'play/tick.mcfunction 不存在（先跑 node src/emit/datapack-playback.mjs）' };
  }
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('styx:play/hifi/tick')) {
    return { wired: true, added: false, reason: '已经接过（幂等跳过）' };
  }
  const line = '# hifi（自研音色）每刻入口：只在 #hifi=1（monitor_hifi_on）时生效（M3-4 自动接线）\n'
    + 'execute if score #hifi styx.flag matches 1 run function styx:play/hifi/tick\n';
  fs.writeFileSync(file, text.replace(/\n*$/, '\n') + line, 'utf8');
  return { wired: true, added: true, reason: '已追加到 styx:play/tick 末尾' };
}

/* ------------------------------------------------------------------- CLI */

function main() {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const resolvePath = (p) => (path.isAbsolute(p) ? p : path.resolve(BUILD, '..', p));
  const notesCsv = resolvePath(opt('notes', fs.existsSync(`${BUILD}/machine_pipeline.csv`)
    ? `${BUILD}/machine_pipeline.csv`
    : P.machine));
  // 原曲音高：默认不升八度（用户 2026-09-14："音高全部按原曲，不要单独去升降八度"）
  const bassOctave = Number(opt('bass-octave', 0));
  const inner = opt('inner', 'bell');
  // 旋律层音色：2026-09-14 用户听感判定 —— 新的 piano（非谐加性+混响）"电子味重、高频刺耳、整体不如旧音色"，
  // 所以默认回到 M2-1 的 strings（Karplus–Strong 拨弦，用户认可），piano 保留为 --melody piano 实验项。
  const melody = opt('melody', 'strings');
  const vel = Number(opt('vel', REFERENCE_VEL));
  void vel;

  const { notes, stats: scoreStats } = parseScoreCsv(fs.readFileSync(notesCsv, 'utf8'));
  const { events, stats, plan } = planHifi(notes, { bassOctave, inner, melody });
  if (stats.unknownInstrument) {
    console.warn(`[警告] ${stats.unknownInstrument} 颗音的乐器名不在映射表里，已退回 strings（见 stats.fallback）`);
  }
  const functions = buildHifiFunctions(notes, { bassOctave, inner, melody });
  const written = writeHifiFunctions(functions);
  const wired = wireHifiTick();   // M3-4：自己接上每刻入口（只在 #hifi=1 时生效）
  const wiring = wiringState();

  const byTimbre = Object.entries(stats.byTimbre).map(([k, v]) => `${k} ${v}`).join(' / ');
  const innerSrc = stats.inner
    ? `（显式标签 ${stats.innerExplicit} / 启发式 ${stats.innerHeuristic}）`
    : '';
  console.log(`谱面：${notesCsv}（${scoreStats.notes} 颗音，step ${scoreStats.minStep}..${scoreStats.maxStep}）`);
  console.log(`音色映射：${byTimbre || '（无）'}；原版打击乐 ${stats.vanilla}；内声部 ${stats.inner}${innerSrc}（--inner=${inner}）`);
  if (stats.octaveFallback) {
    console.warn(`[警告] ${stats.octaveFallback} 颗音的**真实音高没有对应采样**，已退回折叠 row 的老口径`
      + `（音域 ${REGISTERS.strings.join('..')} / bass ${REGISTERS.bass.join('..')}）—— 需要扩 REGISTERS 后重跑 render-all`);
  } else {
    console.log('音高口径：全部按谱面真实 midi 播（后端 A 不受 2 个八度限制）');
  }
  console.log(`贝斯升八度：+${bassOctave}（${stats.bassOctaveUp} 颗；--bass-octave 0 可关闭）`);
  for (const m of plan.modes) {
    console.log(`  ${m.mode}（${m.tps} tps）：${m.ticks} 个时刻 / ${m.buckets} 桶 / ${m.bins} 组 / 单刻 ${m.callsPerTick} 次调用 / 末刻 ${m.lastTick}`);
  }
  console.log(`播放指令合计 ${events.length} 条/套表（两种刻率各一套）；写出函数 ${written.length} 个 → ${path.join(DP, 'function', 'play', 'hifi')}`);
  if (wiring.wired) {
    console.log(`接线：已接（${wiring.inPlayTick ? 'play/tick' : ''}${wiring.inTag ? ' minecraft:tick 标签' : ''}）`
      + `${wired.added ? '—— 本次自动追加（M3-4）' : ''}`);
  } else {
    console.warn(`[警告] 未接线：styx:play/hifi/tick 还没有被每刻调用。${wiring.hint}`);
  }
  console.log('用法：装 nbforge 资源包 → /function styx:play/monitor_hifi_on → /function styx:play/start（或单独试听由 tick 驱动）');
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) main();
