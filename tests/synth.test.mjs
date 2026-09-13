// M2-1 · 自研音色 MVP：零依赖合成器（strings/pad/bell/bass）+ 资源包 + playsound 高保真后端
//
// 红→绿顺序（TDD）：本文件先写（全部红）→ 实现 src/synth/{synth,spectrum,voices,ogg,render-all}.mjs
// → 实现 src/emit/{zip-writer,resource-pack,playsound-hifi}.mjs。
// 验收口径（任务书 nbforge-m2-1.md）：
//   ① 基频误差 ≤1%（FFT 自查）—— 用**全局最强谱峰**与标称频率比，不做"只在目标附近找峰"的自证
//   ② ≥3 个音色 × ≥12 个半音（本实现 4 个音色 × 3 个八度 = 37 个半音，每半音一个采样）
//   ③ zip 体积 <15 MB（真实产物在"资源包构建"一条里量）
//   ④ 零第三方采样：所有采样都由本仓库代码合成（NOTICE.md 登记）
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { fmPad, karplusStrong, modalBell, mulberry32, peak, rms, sine } from '../src/synth/synth.mjs';
import { dominantPeak, spectralCentroid } from '../src/synth/spectrum.mjs';
import { decodeOggSamples, ffmpegAvailable } from '../src/synth/ogg.mjs';
import {
  REGISTERS, SOUND_NAMESPACE, TIMBRES, VOICE_PARAMS, durationSecOf, eventIdOf, hasEvent, midiFromRow,
  noteFileName, registerSize, renderVoice, soundPathOf,
} from '../src/synth/voices.mjs';
import { buildZip, crc32, listZipEntries } from '../src/emit/zip-writer.mjs';
import { PACK_FORMAT, buildResourcePack, buildSoundsJson } from '../src/emit/resource-pack.mjs';
import { HIFI_SYNC_STEPS, buildHifiFunctions, parseScoreCsv, planHifi } from '../src/emit/playsound-hifi.mjs';

const BUILD = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const AUDIO = path.join(BUILD, 'audio_nbforge');
const NOTES_CSV = path.join(BUILD, 'machine_pipeline.csv');
const tmpDir = (name) => fs.mkdtempSync(path.join(process.env.TEMP ?? '/tmp', `nbforge-${name}-`));
const freqOf = (midi) => 440 * 2 ** ((midi - 69) / 12);
const errPct = (measured, target) => Math.abs(measured - target) / target * 100;

/* ============================================================ 1. 合成器契约 */

test('契约：4 个音色、每个 ≥3 个八度（37 个半音）、每半音一个采样', () => {
  assert.ok(TIMBRES.length >= 3, `音色数 ${TIMBRES.length} < 3`);
  assert.deepEqual([...TIMBRES].sort(), ['bass', 'bell', 'pad', 'strings']);
  for (const t of TIMBRES) {
    const [lo, hi] = REGISTERS[t];
    const n = registerSize(t);
    assert.ok(n >= 37, `${t} 只有 ${n} 个半音（要求 ≥37 = 3 个八度）`);
    assert.equal(n, hi - lo + 1, `${t} 音域 ${lo}..${hi} 与计数 ${n} 不自洽`);
    assert.ok(VOICE_PARAMS[t], `${t} 缺参数表`);
  }
  // 机器谱面用到的两个音高映射：harp 行 r → midi r+42，bass 行 r → midi r+18（与原版定调一致）
  assert.equal(midiFromRow('harp', 0), 42);
  assert.equal(midiFromRow('harp', 24), 66);
  assert.equal(midiFromRow('bass', 1), 19);
  assert.equal(midiFromRow('bass', 24), 42);
  // strings/bell/pad 必须覆盖整条 harp 音轨，bass 必须覆盖整条 bass 音轨
  for (const t of ['strings', 'bell', 'pad']) {
    for (let r = 0; r <= 24; r++) assert.ok(hasEvent(t, midiFromRow('harp', r)), `${t} 缺 harp row ${r}`);
  }
  for (let r = 1; r <= 24; r++) assert.ok(hasEvent('bass', midiFromRow('bass', r)), `bass 缺 row ${r}`);
});

test('契约：资源包事件名只含 [a-z0-9_/]，且事件 id / 文件路径可互推', () => {
  assert.equal(SOUND_NAMESPACE, 'nbforge');
  assert.equal(eventIdOf('strings', 66), 'nbforge:strings_fs4');
  assert.equal(soundPathOf('strings', 66), 'strings/fs4');
  assert.equal(noteFileName(61), 'cs4');
  assert.equal(noteFileName(27), 'ds1');
  assert.equal(eventIdOf('bell', 61), 'nbforge:bell_cs4');
  const legal = /^[a-z0-9_/]+$/;
  for (const t of TIMBRES) {
    for (let m = REGISTERS[t][0]; m <= REGISTERS[t][1]; m++) {
      assert.ok(legal.test(eventIdOf(t, m).split(':')[1]), `事件名非法：${eventIdOf(t, m)}`);
      assert.ok(legal.test(soundPathOf(t, m)), `文件路径非法：${soundPathOf(t, m)}`);
    }
  }
});

test('确定论：同一音色/音高两次渲染逐样本相同（含噪声激励）', () => {
  const a = renderVoice('strings', 57, { vel: 0.8 });
  const b = renderVoice('strings', 57, { vel: 0.8 });
  assert.equal(a.length, b.length);
  for (let i = 0; i < a.length; i += 97) assert.equal(a[i], b[i], `样本 ${i} 不同`);
  assert.ok(rms(a) > 0.02, `渲染结果近乎静音：rms=${rms(a)}`);
  assert.ok(peak(a) <= 1, `削波：peak=${peak(a)}`);
  assert.equal(mulberry32(7)(), mulberry32(7)());
  assert.notEqual(mulberry32(7)(), mulberry32(8)());
});

/* ===================================================== 2. 基频误差（FFT 自查） */

test('正弦：基频误差 ≤1%（FFT 最强谱峰，四个音高）', () => {
  for (const f of [110, 220, 440, 880]) {
    const { freq } = dominantPeak(sine({ freq: f, durationSec: 1.0 }));
    assert.ok(errPct(freq, f) <= 1, `正弦 ${f}Hz → 测得 ${freq.toFixed(3)}Hz（误差 ${errPct(freq, f).toFixed(3)}%）`);
  }
});

test('拨弦（Karplus–Strong）：5 个音高基频误差 ≤1%，含最低与最高音', () => {
  for (const midi of [19, 42, 54, 66, 78]) {
    const freq = freqOf(midi);
    const s = karplusStrong({ freq, durationSec: durationSecOf('strings', freq), vel: 0.8 });
    const { freq: got } = dominantPeak(s);
    assert.ok(errPct(got, freq) <= 1, `midi ${midi}（${freq.toFixed(2)}Hz）→ ${got.toFixed(2)}Hz，误差 ${errPct(got, freq).toFixed(3)}%`);
  }
});

test('pad（加法/FM 铺底）与 bell（模态钟琴）：基频误差 ≤1%', () => {
  for (const t of ['pad', 'bell']) {
    for (const midi of [45, 57, 69, 78]) {
      const freq = freqOf(midi);
      const s = renderVoice(t, midi, { vel: 0.8 });
      const { freq: got } = dominantPeak(s);
      assert.ok(errPct(got, freq) <= 1, `${t} midi ${midi}（${freq.toFixed(2)}Hz）→ ${got.toFixed(2)}Hz，误差 ${errPct(got, freq).toFixed(3)}%`);
    }
  }
});

test('bell 是模态（非谐）音色：存在 2.66× 分音，且最强分音仍是基频', () => {
  const freq = 440;
  const s = modalBell({ freq, durationSec: 2.4, vel: 0.9 });
  const { freq: dom, magnitude } = dominantPeak(s);
  assert.ok(errPct(dom, freq) <= 1, `最强峰 ${dom.toFixed(2)}Hz 不是基频 ${freq}Hz`);
  // 2.66×（钟的典型非谐分音）处必须有可测能量 —— 证明不是纯谐波合成
  const inharmonic = dominantPeak(s, { minHz: freq * 2.5, maxHz: freq * 2.9 });
  assert.ok(inharmonic.magnitude >= magnitude * 0.05,
    `2.66× 分音太弱：${inharmonic.magnitude.toFixed(4)} vs 基频 ${magnitude.toFixed(4)}`);
});

/* ================================================== 3. 力度 → 亮度 / 响度映射 */

test('strings：力度越大越亮（谱心单调上升）且越响', () => {
  const freq = freqOf(57);
  const rows = [0.35, 0.5, 0.65, 0.8, 1.0].map((vel) => {
    const s = karplusStrong({ freq, durationSec: 1.6, vel });
    return { vel, centroid: spectralCentroid(s), rms: rms(s) };
  });
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].centroid > rows[i - 1].centroid,
      `谱心非单调：vel ${rows[i].vel} → ${rows[i].centroid.toFixed(1)}Hz ≤ vel ${rows[i - 1].vel} → ${rows[i - 1].centroid.toFixed(1)}Hz`);
    assert.ok(rows[i].rms > rows[i - 1].rms * 0.98, `响度非单调：vel ${rows[i].vel}`);
  }
  const soft = rows[0];
  const hard = rows.at(-1);
  assert.ok(hard.centroid > soft.centroid * 1.25,
    `力度→亮度映射太弱：vel 0.35 谱心 ${soft.centroid.toFixed(1)}Hz，vel 1.0 谱心 ${hard.centroid.toFixed(1)}Hz`);
});

test('pad / bell：力度越大越亮（bell 的基频不随力度漂移）', () => {
  const freq = 523.25;
  const padSoft = fmPad({ freq, durationSec: 2.4, vel: 0.35 });
  const padHard = fmPad({ freq, durationSec: 2.4, vel: 1.0 });
  assert.ok(spectralCentroid(padHard) > spectralCentroid(padSoft), 'pad 力度未影响亮度');
  const bellSoft = modalBell({ freq, durationSec: 2.0, vel: 0.3 });
  const bellHard = modalBell({ freq, durationSec: 2.0, vel: 1.0 });
  assert.ok(spectralCentroid(bellHard) > spectralCentroid(bellSoft), 'bell 力度未影响亮度');
  assert.ok(errPct(dominantPeak(bellSoft).freq, freq) <= 1, 'bell 弱力度下基频漂移');
});

/* ============================================================ 4. 资源包 */

test('sounds.json：每个采样一条事件，名字与文件一一对应', () => {
  const entries = [
    { timbre: 'strings', midi: 66 }, { timbre: 'bell', midi: 61 }, { timbre: 'bass', midi: 19 },
  ];
  const json = buildSoundsJson(entries);
  assert.deepEqual(Object.keys(json).sort(), ['bass_fs0', 'bell_cs4', 'strings_fs4']);
  assert.deepEqual(json.strings_fs4.sounds, [
    { name: 'strings/fs4', stream: false, attenuation_distance: 16 },
  ]);
  assert.equal(json.bell_cs4.sounds[0].name, 'bell/cs4');
});

test('pack.mcmeta：pack_format 来自 testserver/server.jar 的 version.json（1.21.10 → 69）', (t) => {
  assert.equal(PACK_FORMAT, 69);
  const jar = 'C:/Users/hiliang/Documents/minecraft/testserver/server.jar';
  if (!fs.existsSync(jar)) return t.skip('没有 testserver/server.jar');
  let version;
  try {
    version = JSON.parse(execFileSync('tar', ['-xOf', jar, 'version.json'], { encoding: 'utf8' }));
  } catch (e) {
    return t.skip(`读不到 jar 里的 version.json：${e.message}`);
  }
  assert.equal(PACK_FORMAT, version.pack_version.resource_major,
    `pack_format ${PACK_FORMAT} ≠ 服务端 ${version.id} 的 resource_major ${version.pack_version.resource_major}`);
});

test('zip：条目可回读、两次构建字节相同（可复现）、crc32 与已知值一致', () => {
  assert.equal(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
  const entries = [
    { path: 'pack.mcmeta', data: Buffer.from('{"pack":{"pack_format":69}}') },
    { path: 'assets/nbforge/sounds.json', data: Buffer.from('{}') },
    { path: 'assets/nbforge/sounds/strings/fs4.ogg', data: Buffer.from([1, 2, 3, 4, 5]) },
  ];
  const a = buildZip(entries);
  const b = buildZip(entries);
  assert.ok(a.equals(b), 'zip 不确定（时间戳/顺序不稳定）');
  assert.deepEqual(listZipEntries(a), entries.map((e) => e.path));
});

test('资源包构建：目录结构 + zip 体积 <15MB（用真实采样目录，没有则跳过）', (t) => {
  if (!fs.existsSync(path.join(AUDIO, 'ogg', 'strings'))) return t.skip('尚未渲染采样（先跑 render-all）');
  const out = tmpDir('pack');
  const res = buildResourcePack({
    audioDir: AUDIO,
    outDir: path.join(out, 'nbforge_resources'),
    zipPath: path.join(out, 'nbforge_resources.zip'),
    copyTo: null,
  });
  assert.equal(res.sounds, TIMBRES.reduce((n, tt) => n + registerSize(tt), 0), '事件数应等于采样数');
  const mcmeta = JSON.parse(fs.readFileSync(path.join(out, 'nbforge_resources', 'pack.mcmeta'), 'utf8'));
  assert.equal(mcmeta.pack.pack_format, PACK_FORMAT);
  const zip = fs.readFileSync(path.join(out, 'nbforge_resources.zip'));
  assert.ok(zip.length < 15 * 1024 * 1024, `zip ${(zip.length / 1048576).toFixed(2)}MB ≥ 15MB`);
  const names = listZipEntries(zip);
  assert.equal(names.length, res.sounds + 2, `zip 条目 ${names.length} ≠ 采样 ${res.sounds} + pack.mcmeta + sounds.json`);
  assert.ok(names.includes('pack.mcmeta') && names.includes('assets/nbforge/sounds.json'));
  assert.ok(names.every((n) => n === 'pack.mcmeta' || n.startsWith('assets/nbforge/')));
  // sounds.json 里每个 name 都必须指向 zip 里真实存在的文件
  const sounds = JSON.parse(fs.readFileSync(path.join(out, 'nbforge_resources', 'assets/nbforge/sounds.json'), 'utf8'));
  for (const key of Object.keys(sounds)) {
    for (const s of sounds[key].sounds) {
      assert.ok(names.includes(`assets/nbforge/sounds/${s.name}.ogg`), `${key} → ${s.name}.ogg 不在 zip 里`);
    }
  }
});

test('采样回读：容器内的 ogg 基频与目标音高一致（每音色抽 3 个音，含音域两端）', (t) => {
  if (!ffmpegAvailable()) return t.skip('本机没有 ffmpeg（任务书允许只出 WAV）');
  if (!fs.existsSync(path.join(AUDIO, 'ogg', 'strings'))) return t.skip('尚未渲染采样（先跑 render-all）');
  for (const timbre of TIMBRES) {
    const [lo, hi] = REGISTERS[timbre];
    for (const midi of [lo, Math.round((lo + hi) / 2), hi]) {
      const file = path.join(AUDIO, 'ogg', timbre, `${noteFileName(midi)}.ogg`);
      const samples = decodeOggSamples(file);
      const want = freqOf(midi);
      const { freq } = dominantPeak(samples);
      assert.ok(errPct(freq, want) <= 1,
        `${timbre} midi ${midi}: ogg 回读 ${freq.toFixed(2)}Hz vs 目标 ${want.toFixed(2)}Hz（误差 ${errPct(freq, want).toFixed(3)}%）`);
    }
  }
});

/* ================================================ 5. playsound 高保真后端 */

test('映射：harp→strings（同刻最高音）／次高音→bell／bass→bass（+1 八度）／打击乐→原版', () => {
  const notes = [
    { step: 0, instr: 'harp', row: 15, vol: 0.9 },
    { step: 0, instr: 'harp', row: 12, vol: 0.6 },
    { step: 0, instr: 'bass', row: 9, vol: 0.35 },
    { step: 0, instr: 'basedrum', row: 0, vol: 1.0 },
    { step: 0, instr: 'hat', row: 24, vol: 0.8 },
    { step: 1, instr: 'harp', row: 20, vol: 0.7 },
  ];
  const { events, stats } = planHifi(notes);
  const at = (row) => events.find((e) => e.step === 0 && e.row === row);
  assert.equal(at(15).event, 'nbforge:strings_a3', 'harp row 15 = A3 是旋律');
  assert.equal(at(12).event, 'nbforge:bell_fs3', '同刻次高音 = 内声部');
  assert.equal(at(9).event, 'nbforge:bass_ds2', 'bass row 9 → midi 27，监听里升八度到 39');
  assert.equal(at(9).midi, 39);
  assert.equal(at(0).event, 'minecraft:block.note_block.basedrum');
  assert.equal(at(24).event, 'minecraft:block.note_block.hat');
  assert.equal(events.find((e) => e.step === 1).event, 'nbforge:strings_d4');
  assert.equal(stats.synth, 4);
  assert.equal(stats.vanilla, 2);
  assert.equal(stats.bell, 1);
  assert.equal(stats.bassOctaveUp, 1);
  // 打击乐保留原版音高语义（与 datapack-playback 的 pitchMul(row) 一致）
  assert.equal(at(0).pitch, '0.5000');
  assert.equal(at(24).pitch, '2.0000');
  // 自研音色一律 pitch=1（每半音一个采样，不受 /playsound 的 0.5..2.0 音高上限影响）
  assert.equal(at(15).pitch, '1');
  assert.equal(at(15).volume, 0.9);
});

test('映射：内声部可用 pad 替换 bell（--inner），未知乐器退回 strings 并计数', () => {
  const notes = [
    { step: 3, instr: 'harp', row: 14, vol: 0.5 },
    { step: 3, instr: 'harp', row: 10, vol: 0.5 },
    { step: 3, instr: 'chime', row: 8, vol: 0.4 },
  ];
  const withPad = planHifi(notes, { inner: 'pad' }).events.find((e) => e.step === 3 && e.row === 10);
  assert.equal(withPad.event, 'nbforge:pad_gs3');
  assert.equal(withPad.timbre, 'pad');
  const withBell = planHifi(notes, { inner: 'bell' }).events.find((e) => e.step === 3 && e.row === 10);
  assert.equal(withBell.event, 'nbforge:bell_gs3');
  const chime = planHifi([{ step: 1, instr: 'chime', row: 8, vol: 0.5 }]).events[0];
  assert.equal(chime.event, 'nbforge:bell_d3', '已知别名 chime→bell');
  const unknown = planHifi([{ step: 1, instr: 'theremin', row: 8, vol: 0.5 }]);
  assert.equal(unknown.stats.unknownInstrument, 1);
  assert.equal(unknown.stats.fallback, 1);
  assert.equal(unknown.events[0].event, 'nbforge:strings_d3');
});

test('贝斯升八度：默认 +1（小音箱放得出），可关', () => {
  const up = planHifi([{ step: 0, instr: 'bass', row: 9, vol: 0.5 }]).events[0];
  assert.equal(up.midi, 39);
  assert.equal(up.event, 'nbforge:bass_ds2');
  assert.equal(up.pitch, '1');
  const flat = planHifi([{ step: 0, instr: 'bass', row: 9, vol: 0.5 }], { bassOctave: 0 }).events[0];
  assert.equal(flat.midi, 27);
  assert.equal(flat.event, 'nbforge:bass_ds1');
  assert.equal(planHifi([{ step: 0, instr: 'bass', row: 9, vol: 0.5 }]).stats.bassOctaveUp, 1);
});

test('函数生成：monitor_hifi_on/off + 独立 hifi/tick（两种刻率表、无 tick rate 命令）', () => {
  const notes = [];
  for (let s = 0; s < 40; s++) notes.push({ step: s * 3, instr: 'harp', row: 12 + (s % 5), vol: 0.5 });
  const fn = buildHifiFunctions(notes, {});
  const on = fn.get('play/monitor_hifi_on');
  const off = fn.get('play/monitor_hifi_off');
  const tick = fn.get('play/hifi/tick');
  assert.ok(on.includes('scoreboard players set #hifi styx.flag 1'), 'on 必须打开 #hifi');
  assert.ok(off.includes('scoreboard players set #hifi styx.flag 0'), 'off 必须关闭 #hifi');
  for (const [name, text] of fn) {
    assert.ok(!/tick rate/.test(text), `${name} 含 /tick rate（权限等级 3，会让函数整文件加载失败）`);
    assert.ok(text.endsWith('\n'), `${name} 未以换行结尾`);
  }
  assert.ok(HIFI_SYNC_STEPS.length >= 2, 'HIFI_SYNC_STEPS 描述"独立计数 + 播放中同步 #t"');
  assert.ok(tick.includes('scoreboard players add #ht styx.t 1'), 'hifi 有自己的计数器');
  assert.ok(tick.includes('if score #on styx.flag matches 1'), '播放中要同步机器的 #t');
  assert.ok(tick.includes('function styx:play/hifi/hi/tick') && tick.includes('function styx:play/hifi/lo/tick'));
  assert.ok(fn.has('play/hifi/stop') && fn.has('play/hifi/report'));
  const buckets = [...fn].filter(([n]) => /^play\/hifi\/(lo|hi)\/b\d{3}$/.test(n)).map(([, t2]) => t2);
  const plays = buckets.join('\n').split('\n').filter((l) => l.includes('playsound'));
  assert.equal(plays.length, notes.length, `两套刻率表合计 playsound 行数 ${plays.length} ≠ 音符 ${notes.length}`);
  assert.ok(plays.every((l) => / master @s ~ ~ ~ 0\.50 1$/.test(l)), `playsound 参数形状不对：\n${plays[0]}`);
  assert.ok(plays.every((l) => /^execute if score #ht styx\.t matches \d+ as @a at @s run playsound /.test(l)),
    `playsound 行必须以 #ht 守卫开头：\n${plays[0]}`);
});

test('函数生成：每刻调用次数有上界（分层派发），函数名不重复', () => {
  const notes = [];
  for (let i = 0; i < 3000; i++) notes.push({ step: i, instr: 'harp', row: 12, vol: 0.5 });
  const { plan } = planHifi(notes);
  assert.ok(plan.callsPerTick <= 60, `单刻调用 ${plan.callsPerTick} 次，超过 60 的上界`);
  assert.equal(plan.plays, 3000);
  assert.deepEqual(plan.modes.map((m) => m.mode).sort(), ['hi', 'lo']);
  const fn = buildHifiFunctions(notes, {});
  const names = [...fn.keys()];
  assert.equal(new Set(names).size, names.length, '函数名重复');
});

test('真实谱面：整条机器谱面全部映射成功，事件都在渲染音域内（有资源包则交叉校验）', (t) => {
  if (!fs.existsSync(NOTES_CSV)) return t.skip(`缺少 ${NOTES_CSV}`);
  const { notes, stats } = parseScoreCsv(fs.readFileSync(NOTES_CSV, 'utf8'));
  assert.ok(notes.length > 3000, `谱面音符 ${notes.length}`);
  const { events, stats: hifi } = planHifi(notes);
  assert.equal(events.length, notes.length, '每颗音都要有一条事件');
  assert.equal(hifi.unknownInstrument, 0, '机器谱面里出现了未知乐器');
  const soundsFile = path.join(BUILD, 'nbforge_resources', 'assets', 'nbforge', 'sounds.json');
  const sounds = fs.existsSync(soundsFile) ? JSON.parse(fs.readFileSync(soundsFile, 'utf8')) : null;
  for (const e of events) {
    if (!e.event.startsWith('nbforge:')) continue;
    const [lo, hi] = REGISTERS[e.timbre];
    assert.ok(e.midi >= lo && e.midi <= hi, `${e.timbre} midi ${e.midi} 超出渲染音域 ${lo}..${hi}`);
    if (sounds) assert.ok(sounds[e.event.slice('nbforge:'.length)], `${e.event} 不在 sounds.json 里`);
  }
  const fn = buildHifiFunctions(notes, {});
  const bucketText = [...fn].filter(([n]) => /^play\/hifi\/(lo|hi)\/b\d{3}$/.test(n)).map(([, tt]) => tt).join('\n');
  assert.equal((bucketText.match(/playsound /g) ?? []).length, notes.length, '两套刻率表合计必须覆盖全部音符');
  assert.ok(stats.byInstrument.harp > 1000 && stats.byInstrument.bass > 1000, '真实谱面声部统计异常');
});
