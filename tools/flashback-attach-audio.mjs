#!/usr/bin/env node
// M3-77 · 把 nbmachina 录下的无损音频挂成 **Flashback 的一条音频轨道**（按 Flashback 自己的数据格式）。
//
// 依据（2026-09-22 从真实文件反解，不是猜）：Flashback 的回放编辑态存在
//   <gameDir>/flashback/editor_states/<uuid>.json
// 里，结构（节选）：
//   { "scenes": [ { "keyframeTracks": [ { "keyframeType": "AUDIO",
//         "keyframesByTick": { "0": { "path": "D:/x.flac", "type": "audio" } },
//         "enabled": true, "customColour": 0 } ], ... } ],
//     "usedByPaths": [ "<gameDir>/flashback/replays/2026-09-22T20_08_37.zip" ], ... }
// 也就是说：**音频轨 = keyframeType "AUDIO" 的轨道 + keyframesByTick 里一条 {"path","type":"audio"}**。
// 挂上去之后它在回放中心就是可拖、可剪的对象，导出时由 Flashback 的时间轴驱动（裁剪/变速自动跟随）。
//
// 用法：
//   node tools/flashback-attach-audio.mjs --list
//   node tools/flashback-attach-audio.mjs --replay 2026-09-22T20_08_37.zip --audio "<wav/flac 路径>" [--tick 0]
//   node tools/flashback-attach-audio.mjs --replay <replay> --recording "<nbm-XXXX.json>" [--tick 0]
//      （--recording 直接读我们录音器写的锚点 json，取里面的 audio 文件与 replayOffsetSec → 换算成 tick）
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const GAME_DIR = opt('game', 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5');
const STATE_DIR = path.join(GAME_DIR, 'flashback', 'editor_states');
const REPLAY_DIR = path.join(GAME_DIR, 'flashback', 'replays');
const TICK_HZ = 20;

const norm = (p) => path.resolve(p).replace(/\\/g, '/').toLowerCase();

function loadStates() {
  if (!fs.existsSync(STATE_DIR)) throw new Error(`找不到 Flashback 编辑态目录：${STATE_DIR}`);
  return fs.readdirSync(STATE_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const full = path.join(STATE_DIR, f);
      try {
        return { file: full, name: f, json: JSON.parse(fs.readFileSync(full, 'utf8')) };
      } catch (e) {
        console.warn(`  ⚠ 跳过读不动的 ${f}：${e.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function audioTracks(state) {
  const out = [];
  for (const scene of state.json.scenes ?? []) {
    for (const t of scene.keyframeTracks ?? []) {
      if (t.keyframeType !== 'AUDIO') continue;
      out.push({ scene: scene.name, track: t, keys: Object.keys(t.keyframesByTick ?? {}) });
    }
  }
  return out;
}

const states = loadStates();
if (has('list') || !opt('replay')) {
  console.log(`Flashback 编辑态 ${states.length} 份（${STATE_DIR}）：`);
  for (const s of states) {
    const used = (s.json.usedByPaths ?? []).map((p) => path.basename(String(p))).join(', ');
    console.log(`  ${s.name}  回放=${used || '(未关联)'}`);
    for (const a of audioTracks(s)) {
      for (const k of a.keys) {
        const kf = a.track.keyframesByTick[k];
        console.log(`      音频轨[${a.scene}] tick=${k} → ${kf.path}`);
      }
      if (!a.keys.length) console.log(`      音频轨[${a.scene}]（空）`);
    }
  }
  process.exit(0);
}

const replayArg = opt('replay');
const replayPath = norm(replayArg.includes('/') || replayArg.includes('\\')
  ? replayArg : path.join(REPLAY_DIR, replayArg.endsWith('.zip') ? replayArg : `${replayArg}.zip`));
const target = states.find((s) => (s.json.usedByPaths ?? []).some((p) => norm(String(p)) === replayPath));
if (!target) {
  console.error(`没找到关联到 ${replayArg} 的编辑态。先跑 --list 看看有哪些；`);
  console.error('若还没在回放中心保存过，请在 Flashback 里保存一次回放（编辑态是那时写出来的）。');
  process.exit(1);
}

let audioPath = opt('audio', null);
let tick = Number(opt('tick', '0'));
const recording = opt('recording', null);
if (recording) {
  const j = JSON.parse(fs.readFileSync(recording, 'utf8'));
  audioPath = path.join(path.dirname(recording), j.audio);
  if (!has('tick')) tick = Math.round((j.replayOffsetSec ?? 0) * TICK_HZ);
}
if (!audioPath) {
  console.error('要给 --audio <音频文件> 或 --recording <录音锚点 json>');
  process.exit(1);
}
audioPath = path.resolve(audioPath);
if (!fs.existsSync(audioPath)) {
  console.error(`音频文件不存在：${audioPath}`);
  process.exit(1);
}

const json = target.json;
json.scenes = json.scenes ?? [{ name: 'Scene 1', keyframeTracks: [] }];
const scene = json.scenes[Math.min(json.sceneIndex ?? 0, json.scenes.length - 1)] ?? json.scenes[0];
scene.keyframeTracks = scene.keyframeTracks ?? [];
let track = scene.keyframeTracks.find((t) => t.keyframeType === 'AUDIO');
if (!track) {
  track = { keyframeType: 'AUDIO', keyframesByTick: {}, enabled: true, customColour: 0 };
  scene.keyframeTracks.push(track);
  console.log('  （该场景原本没有音频轨，已新建一条）');
}
track.keyframesByTick = track.keyframesByTick ?? {};
track.keyframesByTick[String(tick)] = { path: audioPath.replace(/\\/g, '\\\\'), type: 'audio' };
track.enabled = true;

const backup = `${target.file}.nbm-bak`;
if (!fs.existsSync(backup)) fs.copyFileSync(target.file, backup);
fs.writeFileSync(target.file, JSON.stringify(json), 'utf8');
console.log(`✔ 已挂上音频轨：${path.basename(target.name)} 场景「${scene.name}」tick=${tick}`);
console.log(`  音频：${audioPath}`);
console.log(`  备份：${backup}（原文件已备份，回退只需覆盖回去）`);
