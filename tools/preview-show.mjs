#!/usr/bin/env node
// STYX HELIX 视效”几何预演”（2026-09-24 用户提的流程：先出渲染视频，再和游戏实拍对齐）
//
// 只重演**几何与节奏**：音符盒 12 棱 / 柔光圆晕 / 顶面涟漪 / 余辉 / 逐字格 / 开场三件套平面。
// 点用软点画，不还原 end_rod 精灵纹理——目的是在不开游戏的情况下就能看出”位置挪了一格、面歪了、
// 字错位、尺寸不对”这类问题（这轮踩的全是这些）。参数与 StyxShow.java 一一对应，改一边要改另一边。
//
// 用法：node tools/preview-show.mjs --json "<gamedir>\nbmachina\styxshow.json" --from 0 --to 6 --out out.mp4

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf("--" + n); return i >= 0 ? argv[i + 1] : d; };
const JSON_IN = arg("json", null);
if (!JSON_IN) { console.error("需要 --json <gamedir>/nbmachina/styxshow.json"); process.exit(1); }
const MAP_IN = arg("map", "build/nbmachina_machine_map.csv");
const OUT = arg("out", "build/preview.mp4");
const FROM = +arg("from", 0), TO = +arg("to", 6), FPS = +arg("fps", 20);
const W = +arg("w", 960), H = +arg("h", 540);
const CAMY = +arg("camy", 116.5), CAMZ = +arg("camz", 2.5), PITCH = +arg("pitch", 0);
const FLY_FROM = +arg("fly-from", 0);     // 开场这段时间镜头钉在起点（音乐起才跟拍，贴近用户实际操作）

// ── 与 StyxShow.java 同步的常量 ──────────────────────────────
const PH_A = 8.3341, PH_B = -32.784, ZC = 2.5, TICK = 0.05;
const LYRIC_Y = 114.1, ADV = 1.25, LINE_MAX = 26, RING_R = 0.8, GLOW_R = 1.0, OPEN_DIST = 13.5;
const phX = (t) => PH_A * t + PH_B;

const doc = JSON.parse(fs.readFileSync(JSON_IN, "utf8"));
const csv = fs.readFileSync(MAP_IN, "utf8").trim().split(/\r?\n/);
const hd = csv[0].split(","), ix = (n) => hd.indexOf(n);
const NOTES = csv.slice(1).map((l) => {
  const f = l.split(",");
  return { x: +f[ix("x")], y: +f[ix("y")], z: +f[ix("z")], midi: +f[ix("midi")], t: +f[ix("time_sec")], bass: f[ix("voice")] === "bass" };
});
function hue(midi, bass) {
  const pc = ((midi % 12) + 12) % 12;
  let h = pc / 12 + (bass ? 0.58 : 0); h -= Math.floor(h);
  const sat = bass ? 0.85 : 0.62, val = 0.75 + 0.25 * Math.min(1, (midi - 40) / 60);
  const c = val * sat, x = c * (1 - Math.abs(((h * 6) % 2) - 1)), m = val - c, k = Math.floor(h * 6);
  const rgb = k === 0 ? [c, x, 0] : k === 1 ? [x, c, 0] : k === 2 ? [0, c, x] : k === 3 ? [0, x, c] : k === 4 ? [x, 0, c] : [c, 0, x];
  return [rgb[0] + m, rgb[1] + m, rgb[2] + m];
}

// ── 粒子 ────────────────────────────────────────────────────
const P = [];
function noteFx(n) {
  const cx = n.x + 0.5, cz = n.z + 0.5, cy = n.y + 0.5, top = n.y + 1.0;
  const col = hue(n.midi, n.bass);
  for (const [ax, ay, az] of [[1,1,0],[1,-1,0],[-1,1,0],[-1,-1,0],[1,0,1],[1,0,-1],[-1,0,1],[-1,0,-1],[0,1,1],[0,1,-1],[0,-1,1],[0,-1,-1]])
    for (let s = -0.5; s <= 0.5001; s += 0.1)
      P.push({ k: "edge", x: cx + ax*s, y: cy + ay*s, z: cz + az*s, dx: ax*s, dy: ay*s, dz: az*s, col, age: 0, life: 24 });
  for (let i = 0; i < 26; i++) {           // 柔光：顶面上方 0.45 格的竖立圆晕
    const a = i / 26 * Math.PI * 2, r = (i % 3) / 3;
    P.push({ k: "glow", x: cx + Math.cos(a)*r*GLOW_R, y: top + 0.45 + Math.sin(a)*r*GLOW_R, z: cz, dx: Math.cos(a)*r*GLOW_R, dy: Math.sin(a)*r*GLOW_R, dz: 0, col, age: 0, life: 15 });
  }
  for (let i = 0; i < 40; i++) {           // 涟漪：顶面圆环
    const a = i / 40 * Math.PI * 2, r = 0.65;
    P.push({ k: "ring", x: cx + Math.cos(a)*r, y: top, z: cz + Math.sin(a)*r, dx: Math.cos(a)*r, dy: 0, dz: Math.sin(a)*r, col, age: 0, life: 26 });
  }
  P.push({ k: "trail", x: cx, y: top + 0.02, z: cz, dx: 0, dy: 0, dz: 0, col, age: 0, life: 50 });
}
function lyricLine(line) {
  const fit = Math.min(1, LINE_MAX / Math.max(1, line.w));
  for (const c of line.chars) {
    if (!c.c || !c.c.trim()) continue;
    const z0 = ZC + (c.z - line.w / 2) * fit, x0 = phX(c.t) + 5.0;
    const life = Math.max(1, Math.round((line.end - c.t + 0.8) * 20)), d = Math.max(1, Math.round(c.dur * 20));
    for (let gx = 0; gx < 5; gx++) for (let gy = 0; gy < 5; gy++)   // 字格：5×5 代表点（ADV×ADV 的方格）
      P.push({ k: "lyric", x: x0 + (gx / 4) * ADV * fit, y: LYRIC_Y + (gy / 4) * ADV * fit, z: z0,
        dx: 0, dy: 0, dz: 0, col: [1, 1, 1], age: 0, life, d });
  }
}
function opening(EYE, yaw) {
  const fx = -Math.sin(yaw), fz = Math.cos(yaw), rx = -fz, rz = fx;
  const ax = EYE[0] + fx * OPEN_DIST, ay = EYE[1] + 0.5, az = EYE[2] + fz * OPEN_DIST;
  const plane = (cx, w, h, tag) => {
    for (let i = 0; i <= 40; i++) {          // 只画四边，够看位置与朝向
      const us = -w / 2 + (i / 40) * w, vs = -h / 2 + (i / 40) * h;
      for (const [du, dv] of [[us, -h/2], [us, h/2], [-w/2, vs], [w/2, vs]])
        P.push({ k: tag, x: cx[0] + rx*du, y: cx[1] + dv, z: cx[2] + rz*du, dx: 0, dy: 0, dz: 0,
          col: tag === "cover" ? [0.9, 0.9, 0.9] : [1, 1, 1], age: 0, life: 90, d: 1 });
    }
  };
  plane([ax, ay, az], 8, 8, "cover");
  plane([ax + 0, ay + 4.8, az], 8, 64/48, "title");
  plane([ax, ay - 5.1, az], 256/48, 1, "sub");
  if (DEBUG) console.error(`[debug] opening 锚点=(${ax.toFixed(1)},${ay.toFixed(1)},${az.toFixed(1)}) 新增=${P.length}`);
}

// ── 相机（针孔）──────────────────────────────────────────────
const FOOT = Math.tan(35 * Math.PI / 180);
function camAt(t) {
  const yaw = -90 * Math.PI / 180, pitch = PITCH * Math.PI / 180;
  const f = [-Math.sin(yaw) * Math.cos(pitch), -Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
  const camX = t <= FLY_FROM ? phX(0) : phX(t - FLY_FROM);
  const pos = [camX, CAMY, CAMZ];
  const R = [-f[2], 0, f[0]];
  const rl = Math.hypot(R[0], R[2]) || 1; R[0] /= rl; R[2] /= rl;
  const U = [R[1]*f[2] - R[2]*f[1], R[2]*f[0] - R[0]*f[2], R[0]*f[1] - R[1]*f[0]];
  return { pos, f, R, U };
}

const buf = new Float32Array(W * H * 3);
const clear = () => { for (let i = 0; i < W * H; i++) { buf[i*3] = 0.45; buf[i*3+1] = 0.42; buf[i*3+2] = 0.38; } };
const DEBUG = argv.includes("--debug");
function dot(sx, sy, col, a) {
  for (let y = Math.floor(sy) - 1; y <= sy + 1; y++) for (let x = Math.floor(sx) - 1; x <= sx + 1; x++) {
    if (x < 0 || y < 0 || x >= W || y >= H || a <= 0) continue;
    const o = (y * W + x) * 3, k = Math.min(1, a);
    buf[o] = buf[o] * (1 - k) + col[0] * k; buf[o+1] = buf[o+1] * (1 - k) + col[1] * k; buf[o+2] = buf[o+2] * (1 - k) + col[2] * k;
  }
}

let nc = 0, lc = 0, opened = false;
const frames = [];
const ticks = Math.round((TO - FROM) / TICK);
for (let tick = 0; tick <= ticks; tick++) {
  const t = FROM + tick * TICK;
  while (nc < NOTES.length && NOTES[nc].t <= t) { const n = NOTES[nc++]; if (t - n.t < 0.3) noteFx(n); }
  while (lc < doc.lines.length && doc.lines[lc].t <= t) lyricLine(doc.lines[lc++]);
  const cam = camAt(t);
  if (!opened && tick === 1) { opening([cam.pos[0], cam.pos[1], cam.pos[2]], -90 * Math.PI / 180); opened = true; }
  clear();
  if (DEBUG && tick % 20 === 0) {
    const kinds = {};
    for (const q of P) kinds[q.k] = (kinds[q.k] ?? 0) + 1;
    console.error(`[debug] t=${t.toFixed(2)} 粒子=${P.length} ${JSON.stringify(kinds)} 相机=(${cam.pos.map((v) => v.toFixed(1)).join(",")})`);
  }
  // 音符盒本体（1×1×1 线框，棕色）：判断"特效贴在方块上还是在方块下/上"全靠它
  for (const n of NOTES) {
    if (Math.abs(n.x - cam.pos[0]) > 40 || Math.abs(n.z - cam.pos[2]) > 25) continue;
    const bx = n.x, by = n.y, bz = n.z;
    for (let i = 0; i <= 4; i++) {
      const s = i / 4;
      for (const [px_, py_, pz_] of [[s, 0, 0], [s, 1, 0], [0, s, 0], [1, s, 0], [0, 0, s], [1, 0, s], [0, 1, s], [1, 1, s], [s, 0, 1], [s, 1, 1], [0, s, 1], [1, s, 1]]) {
        const wx = bx + px_, wy = by + py_, wz = bz + pz_;
        const d = [wx - cam.pos[0], wy - cam.pos[1], wz - cam.pos[2]];
        const zc = d[0]*cam.f[0] + d[1]*cam.f[1] + d[2]*cam.f[2];
        if (zc <= 0.2) continue;
        const xc = d[0]*cam.R[0] + d[1]*cam.R[1] + d[2]*cam.R[2];
        const yc = d[0]*cam.U[0] + d[1]*cam.U[1] + d[2]*cam.U[2];
        const focal = (H / 2) / FOOT;
        dot(W/2 + xc/zc*focal, H/2 - yc/zc*focal, [0.55, 0.36, 0.22], 0.9);
      }
    }
  }
  for (let i = P.length - 1; i >= 0; i--) {
    const p = P[i], s = p.age * TICK;
    let a = 1;
    if (p.k === "edge") { p.x += p.dx * 0.03; p.y += p.dy * 0.03; p.z += p.dz * 0.03; a = 0.95 * (1 - p.age / 24); }
    else if (p.k === "glow") { const r2 = p.dx*p.dx + p.dy*p.dy; a = 0.55 * Math.min(1, s/0.1) * (1 - p.age/15) * Math.exp(-r2/0.6); }
    else if (p.k === "ring") { p.x += p.dx*0.055; p.z += p.dz*0.055; const r = Math.hypot(p.dx, p.dz); a = 0.9 * (1 - p.age/26) * Math.exp(-Math.pow(r - 0.65, 2)/0.03); }
    else if (p.k === "trail") a = 0.10 * (1 - p.age/49);
    else if (p.k === "lyric") { p.x += 0.4167 * TICK * 20; const pr = Math.min(1, p.age / p.d); p.col = [0.20 + 0.73*pr, 0.28 + 0.70*pr, 0.32 + 0.68*pr]; a = 0.34 + 0.66*pr; }
    else if (p.k === "cover") a = Math.min(1, s/0.45) * Math.max(0, 1 - Math.max(0, (s - 2 - (1 - (p.y % 8)/8) * 1.05)) / 0.65);
    else if (p.k === "title") a = Math.min(1, s/0.5) * Math.max(0, Math.min(1, 1 - (s - 2.9)/0.7));
    else if (p.k === "sub") a = Math.max(0, Math.min(1, (s - 0.45)/0.5)) * Math.max(0, Math.min(1, 1 - (s - 3.0)/0.7));
    p.age++;
    // ⚠ 只在活过寿命时删（游戏里 alpha=0 的粒子只是隐形、照样活在内存里并继续淡入）
    if (p.age > p.life) { P.splice(i, 1); continue; }
    if (a <= 0.004) continue;
    const d = [p.x - cam.pos[0], p.y - cam.pos[1], p.z - cam.pos[2]];
    const zc = d[0]*cam.f[0] + d[1]*cam.f[1] + d[2]*cam.f[2];
    if (zc <= 0.2) continue;
    const xc = d[0]*cam.R[0] + d[1]*cam.R[1] + d[2]*cam.R[2];
    const yc = d[0]*cam.U[0] + d[1]*cam.U[1] + d[2]*cam.U[2];
    const focal = (H / 2) / FOOT;
    if (DEBUG && tick === 20 && i === P.length - 1) {
      console.error(`[debug] t=${t.toFixed(2)} P=${P.length} kind=${p.k} alpha=${a.toFixed(2)} ` +
        `sx=${(W/2 + xc/zc*focal).toFixed(0)} sy=${(H/2 - yc/zc*focal).toFixed(0)} zc=${zc.toFixed(1)}`);
    }
    dot(W/2 + xc/zc*focal, H/2 - yc/zc*focal, p.col, a);
  }
  if (tick % Math.round(1 / (FPS * TICK)) === 0) {
    const out = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H * 3; i++) out[i] = Math.max(0, Math.min(255, Math.round(buf[i] * 255)));
    frames.push(out);
  }
}
const p = path.resolve(OUT);
fs.mkdirSync(path.dirname(p), { recursive: true });
// 走临时 raw 文件（管道送几百 MB 容易被截断，之前就踩到 moov atom not found）
const raw = p + ".raw";
fs.writeFileSync(raw, Buffer.concat(frames));
const enc = spawnSync("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24",
  "-s", `${W}x${H}`, "-r", String(FPS), "-i", raw, "-c:v", "libx264", "-pix_fmt", "yuv420p",
  "-crf", "20", p], { encoding: "utf8" });
if (enc.status !== 0) { console.error("ffmpeg 失败：", enc.stderr); process.exit(1); }
fs.rmSync(raw, { force: true });
console.log(`几何预演 → ${p}（${frames.length} 帧，${FROM}s–${TO}s，相机 y=${CAMY} 跟播放头）`);
