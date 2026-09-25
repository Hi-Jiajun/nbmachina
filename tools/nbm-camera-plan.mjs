#!/usr/bin/env node
// M5-42 · 相机关键帧打点：把"跟着歌走"的运镜直接写进 Flashback 的回放编辑态。
//
// 为什么要工具而不是手打：相机在回放里是**按 tick 的关键帧**，而歌是**按秒的段落**；
// 手打就是拿秒去猜 tick（还要加"回放起点 ≠ 音乐起点"的偏移），必然对不齐。
// 这里：① 从 `export_audio.json` 读回放↔音乐的偏移（工具 `nbm-export-audio.mjs` 已算好）；
//       ② 按谱面秒生成 keyframe tick；③ 位置由"播放头 − 滞后"给出（播放头 x = 8.3341·t − 32.784）；
//       ④ 写进 `flashback/editor_states/<uuid>.json` 的 CAMERA 轨（先备份 `.nbm-bak`）。
//
// 用法：
//   node tools/nbm-camera-plan.mjs                 # 用内置方案，写最新那条 Styx 回放的编辑态
//   node tools/nbm-camera-plan.mjs --dry           # 只打印方案表，不写文件
//   node tools/nbm-camera-plan.mjs --state <json>  # 指定编辑态
//   node tools/nbm-camera-plan.mjs --offset 3.3458 # 手给偏移（默认读 export_audio.json）
//
// 方案的每个点：{ sec: 谱面秒, lag: 相机落后播放头几格, y, z, yaw, pitch, label }
// 相机 x = clamp(8.3341·sec − 32.784, −60, 2333) − lag（谱面末尾之后播放头钉在 2333）；
// 想写死某个 x（例如开场"完全静止"）就直接给 `x`，想硬静止就给 `hold: true`（插值类型 HOLD）。
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_GAME = 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5';
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const GAME = (opt('game', DEFAULT_GAME)).replace(/\\/g, '/');
const STATE_DIR = path.join(GAME, 'flashback', 'editor_states');
const REPLAY_DIR = path.join(GAME, 'flashback', 'replays');
const CONFIG = path.join(GAME, 'nbmachina', 'export_audio.json');

const SPEED = 8.3341;          // 格/秒（谱面播放头速度）
const X0 = -32.784;            // 播放头 x = SPEED·t + X0
const X_END = 2333;            // 机器末端
const LAST_NOTE_SEC = 283.858; // 最后一颗音

/** 内置方案：段落边界（来自 build/dynamics-sections.json + M5 十场表）与音乐节点。 */
const PLAN = [
  // 开场：卡片 0.00 淡入（封面 0.35s / 文字 0.70s）→ 2.30s 起淡出 → **3.00s 完全消失**。
  // 用户在 2026-09-25 明确要求"封面和文字消失之前不要前进"（锚屏卡片跟着眼位重算，镜头一动就抖），
  // 所以 0 → 3.20s 机位**完全不动**（HOLD），之后再缓加速追回巡航滞后。
  { sec: 0.00, x: -58.784, y: 119.0, z: 2.5, yaw: -90, pitch: 0.0, hold: true, label: '开场·静止（卡片淡入→淡出）' },
  { sec: 3.20, x: -58.784, y: 119.0, z: 2.5, yaw: -90, pitch: 0.0, label: '卡片已消失·起步' },
  { sec: 6.00, lag: 45, y: 119.5, z: 2.5, yaw: -90, pitch: 3.0, label: '加速追回（约 11 格/秒）' },
  { sec: 10.00, lag: 34, y: 118.2, z: 2.5, yaw: -90, pitch: 2.5, label: '继续收拢滞后' },
  { sec: 14.00, lag: 27, y: 117.4, z: 2.5, yaw: -90, pitch: 2.0, label: '进入巡航' },
  { sec: 18.00, lag: 23, y: 117.0, z: 2.5, yaw: -90, pitch: 1.8, label: '巡航稳定' },
  { sec: 22.94, lag: 21, y: 116.8, z: 2.5, yaw: -90, pitch: 1.6, label: 'S1 首句' },
  { sec: 29.00, lag: 20, y: 116.6, z: -2.5, yaw: -90, pitch: 1.4, label: 'A① 内侧偏航' },
  { sec: 34.00, lag: 19, y: 117.0, z: -4.0, yaw: -93, pitch: 1.6, label: '长句·微转' },
  { sec: 39.67, lag: 19, y: 117.4, z: -3.0, yaw: -90, pitch: 1.8, label: 'S2 乱钟' },
  { sec: 47.00, lag: 17, y: 116.0, z: 4.5, yaw: -90, pitch: 4.0, label: 'B① 低近' },
  { sec: 55.00, lag: 15, y: 115.4, z: 3.0, yaw: -87, pitch: 6.0, label: '落砂·贴面' },
  { sec: 61.00, lag: 15, y: 115.8, z: 2.5, yaw: -90, pitch: 1.2, label: '副歌前收' },
  { sec: 65.50, lag: 18, y: 116.6, z: 2.5, yaw: -90, pitch: 1.6, label: 'S3 副歌① 起' },
  { sec: 72.00, lag: 32, y: 120.0, z: 2.5, yaw: -90, pitch: 3.0, label: '副歌① 拉开' },
  { sec: 80.47, lag: 44, y: 122.5, z: 2.5, yaw: -90, pitch: 3.8, label: 'Restart① 最宽' },
  { sec: 86.00, lag: 30, y: 119.0, z: 2.5, yaw: -90, pitch: 2.6, label: '高点 推近' },
  { sec: 92.25, lag: 16, y: 115.9, z: 2.5, yaw: -90, pitch: 7.5, label: '高点收·俯看和弦' },
  { sec: 98.00, lag: 17, y: 116.9, z: 2.0, yaw: -90, pitch: 1.4, label: 'S4 间奏回稳' },
  { sec: 106.00, lag: 20, y: 117.4, z: 0.0, yaw: -90, pitch: 1.8, label: '间奏·外移' },
  { sec: 116.40, lag: 21, y: 117.8, z: 2.5, yaw: -90, pitch: 2.0, label: 'S5 A②B②' },
  { sec: 124.00, lag: 18, y: 117.0, z: -3.5, yaw: -90, pitch: 1.5, label: '陷阱动机·横移' },
  { sec: 132.00, lag: 16, y: 116.4, z: 6.0, yaw: -90, pitch: 1.3, label: 'B② 另一侧' },
  { sec: 141.50, lag: 20, y: 117.6, z: 2.5, yaw: -90, pitch: 2.0, label: 'S6 副歌② 起' },
  { sec: 148.00, lag: 44, y: 124.0, z: 2.5, yaw: -90, pitch: 4.2, label: '副歌② 大远景' },
  { sec: 154.54, lag: 54, y: 126.5, z: 2.5, yaw: -90, pitch: 4.9, label: 'Restart② 最高' },
  { sec: 162.00, lag: 24, y: 118.5, z: 2.5, yaw: -90, pitch: 2.0, label: '空环前 下降' },
  { sec: 165.21, lag: 15, y: 115.8, z: 2.5, yaw: -90, pitch: 8.5, label: '空环动机·俯看和弦' },
  { sec: 170.10, lag: 17, y: 116.6, z: 2.5, yaw: -90, pitch: 1.6, label: 'S7 淡入淡出' },
  { sec: 178.00, lag: 22, y: 117.8, z: 8.0, yaw: -90, pitch: 2.2, label: 'C 段·右侧漂移' },
  { sec: 188.00, lag: 19, y: 116.9, z: -5.0, yaw: -90, pitch: 1.5, label: 'C 段·横越回左' },
  { sec: 199.80, lag: 26, y: 118.8, z: 2.5, yaw: -90, pitch: 2.6, label: 'S8 大副歌 起' },
  { sec: 206.00, lag: 52, y: 125.0, z: 2.5, yaw: -90, pitch: 4.6, label: '顶点 拉开' },
  { sec: 216.95, lag: 78, y: 131.0, z: 2.5, yaw: -90, pitch: 6.2, label: 'Restart③ 全曲最宽' },
  { sec: 223.00, lag: 50, y: 125.5, z: 2.5, yaw: -90, pitch: 4.6, label: '顶点 收' },
  { sec: 229.00, lag: 26, y: 119.0, z: 2.5, yaw: -90, pitch: 2.6, label: '退潮前 降' },
  { sec: 231.53, lag: 14, y: 115.4, z: 2.5, yaw: -90, pitch: 9.0, label: '退潮动机·俯看和弦' },
  { sec: 239.80, lag: 13, y: 116.0, z: 2.5, yaw: -90, pitch: 3.2, label: 'S9 终·新的一天' },
  { sec: 249.30, lag: 22, y: 118.2, z: 2.5, yaw: -90, pitch: 2.4, label: '软重置' },
  { sec: 261.01, lag: 30, y: 120.6, z: 2.5, yaw: -90, pitch: 3.0, label: '尾句' },
  { sec: 271.00, lag: 42, y: 124.2, z: 2.5, yaw: -90, pitch: 3.8, label: '暖金接管' },
  { sec: 283.86, lag: 52, y: 127.6, z: 2.5, yaw: -90, pitch: 4.4, label: '最后一颗音' },
  { sec: 288.05, lag: 62, y: 131.5, z: 2.5, yaw: -90, pitch: 5.0, label: '尾奏·缓慢上升（回放末尾 5828）' },
];

function playheadX(sec) {
  const t = Math.min(sec, LAST_NOTE_SEC);
  return Math.max(-60, Math.min(X_END, SPEED * t + X0));
}

let offset = opt('offset', null);
if (offset === null) {
  if (fs.existsSync(CONFIG)) {
    offset = JSON.parse(fs.readFileSync(CONFIG, 'utf8')).offsetSec;
    console.log(`偏移取自 ${path.basename(CONFIG)}：${offset}s（音乐 0s = 回放 ${offset}s）`);
  } else {
    offset = 0;
    console.log('⚠ 没找到 export_audio.json，按 offset=0 处理（tick = 秒×20）');
  }
} else {
  offset = Number(offset);
}

const rows = PLAN.map((k) => {
  const x = k.x !== undefined ? k.x : playheadX(k.sec) - k.lag;
  // 播放头相对画面中心的下移角（度）：半垂直 FOV ≈21.5°（FOV 70、16:9），>19° 就会掉出画面
  const lag = k.x !== undefined ? Math.max(1, playheadX(k.sec) - k.x) : k.lag;
  const theta = Math.atan2(k.y - 111.0, Math.max(1, lag)) * 180 / Math.PI;
  return { ...k, x, tick: Math.round((k.sec + offset) * 20), drop: theta - k.pitch };
});

console.log('\n谱面秒     回放tick   相机位置(x/y/z)                  yaw/pitch    播放头下移  说明');
for (const r of rows) {
  const warn = r.drop > 19 ? '⚠出画' : (r.drop > 16 ? '·偏下' : '');
  console.log(`${r.sec.toFixed(2).padStart(8)}  ${String(r.tick).padStart(8)}   ${r.x.toFixed(1).padStart(7)} / ${r.y.toFixed(2)} / ${r.z.toFixed(1).padStart(5)}   ${String(r.yaw).padStart(4)} / ${String(r.pitch).padStart(4)}   ${r.drop.toFixed(1).padStart(6)}°  ${warn.padEnd(6)} ${r.label}`);
}
let maxSpeed = 0, maxSeg = '';
for (let i = 1; i < rows.length; i++) {
  const dt = rows[i].sec - rows[i - 1].sec;
  const d = Math.hypot(rows[i].x - rows[i - 1].x, rows[i].y - rows[i - 1].y, rows[i].z - rows[i - 1].z);
  const v = d / dt;
  if (v > maxSpeed) { maxSpeed = v; maxSeg = `${rows[i - 1].sec}s→${rows[i].sec}s`; }
}
console.log(`\n播放头本身 ${SPEED} 格/秒；本方案最大机位速度 ${maxSpeed.toFixed(2)} 格/秒（${maxSeg}）—— 远低于飞行速度上限，不会糊。`);

if (has('dry')) process.exit(0);

// ---- 找到目标编辑态 ----------------------------------------------------------
function states() {
  if (!fs.existsSync(STATE_DIR)) throw new Error('找不到编辑态目录：' + STATE_DIR);
  return fs.readdirSync(STATE_DIR).filter((f) => f.endsWith('.json')).map((f) => ({
    file: path.join(STATE_DIR, f), name: f, json: JSON.parse(fs.readFileSync(path.join(STATE_DIR, f), 'utf8')),
  }));
}

let target = null;
const explicit = opt('state', null);
if (explicit) {
  const file = path.resolve(explicit);
  target = { file, name: path.basename(file), json: JSON.parse(fs.readFileSync(file, 'utf8')) };
} else {
  const replays = fs.existsSync(REPLAY_DIR)
    ? fs.readdirSync(REPLAY_DIR).filter((f) => f.endsWith('.zip'))
      .map((f) => ({ f, t: fs.statSync(path.join(REPLAY_DIR, f)).mtimeMs })).sort((a, b) => b.t - a.t)
    : [];
  const wanted = new Set(replays.map((r) => r.f));
  const all = states().filter((s) => (s.json.usedByPaths ?? []).some((p) => wanted.has(path.basename(String(p)))));
  if (!all.length) throw new Error('没有和回放关联的编辑态；用 --state 指定');
  target = all[0];
  console.log(`\n目标编辑态：${target.name}（回放 ${path.basename(String(target.json.usedByPaths[0]))}）`);
}

const scene = target.json.scenes[target.json.sceneIndex ?? 0];
const track = (scene.keyframeTracks ?? []).find((t) => t.keyframeType === 'CAMERA');
const before = track ? Object.keys(track.keyframesByTick ?? {}).length : 0;

fs.copyFileSync(target.file, target.file + '.nbm-bak');
const newTrack = {
  keyframeType: 'CAMERA',
  keyframesByTick: Object.fromEntries(rows.map((r) => [String(r.tick), {
    position: [Number(r.x.toFixed(6)), Number(r.y.toFixed(6)), Number(r.z.toFixed(6))],
    yaw: r.yaw, pitch: r.pitch, roll: 0, type: 'camera',
    interpolation_type: r.hold ? 'HOLD' : 'SMOOTH',
  }])),
  enabled: true,
  customColour: track?.customColour ?? 0,
};
if (track) {
  Object.assign(track, newTrack);
} else {
  scene.keyframeTracks = [...(scene.keyframeTracks ?? []), newTrack];
}
fs.writeFileSync(target.file, JSON.stringify(target.json));
console.log(`已写入：${target.name}  CAMERA 关键帧 ${before} → ${rows.length} 个（原文件备份 ${path.basename(target.file)}.nbm-bak）`);
console.log('进游戏打开这条回放即可在编辑器里拖时间轴预览；导出时相机自动按这套 keyframe 走。');
