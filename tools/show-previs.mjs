#!/usr/bin/env node
/**
 * STYX HELIX · 视效预演渲染器（离线 animatic，M5 设计评审用）
 *
 * 它把 docs/M5-show-design.md 里的动效设计用**真实数据**跑一遍：
 *   · 真实坐标/音高/力度/声部（build/nbmachina_machine_map.csv）
 *   · 真实时间轴与段落（nbmachina/show/styx_helix.show.json）
 *   · 真实母版音轨（build/master_v2/styx_master_v2_48k24bit.wav）
 *
 * 用途 = **动效 / 构图 / 同步**的可视化对拍，**不是**成品观感预览：
 * 粒子用程序化光斑代替 MC 的贴图与光影 bloom，颜色也只是 5 色系的近似。
 * 成型后的真实观感以游戏内 ExParticle 为准。
 *
 * 用法：
 *   node tools/show-previs.mjs --from 0 --to 26 --out ../_scratch-m3-80/out/s1.mp4
 *   （--w --h --fps --no-audio 可调；--still <sec> 只出一张 PNG 便于快速看构图）
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');

// ─────────────────────────── 命令行 ───────────────────────────
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const FROM = parseFloat(arg('from', '0'));
const TO = parseFloat(arg('to', '20'));
const W = parseInt(arg('w', '960'), 10);
const H = parseInt(arg('h', '540'), 10);
const FPS = parseInt(arg('fps', '30'), 10);
const OUT = arg('out', path.join(ROOT, '_scratch-m3-80', 'out', 'previs.mp4'));
const AUDIO = arg('audio', path.join(ROOT, 'build', 'master_v2', 'styx_master_v2_48k24bit.wav'));
const NO_AUDIO = argv.includes('--no-audio');
const STILL = arg('still', null);
const SCALE = parseFloat(arg('scale', '1'));
const w = Math.round(W * SCALE), h = Math.round(H * SCALE);

// ─────────────────────────── 素材 ───────────────────────────
const show = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'show', 'styx_helix.show.json'), 'utf8'));
// —— 逐字歌词（母版时间轴，AMLL 口径的逐字时间）+ 开场封面 ——
const LYRICS = (() => {
  const p = path.join(HERE, '..', '..', 'nbaurora', 'lyrics', 'styx_helix.final.master.json');
  if (!fs.existsSync(p)) return null;
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return j.lines.map((l) => ({
    text: l.text, start: l.start, end: l.end, lang: l.lang, translation: l.translation, romaji: l.romaji,
    chars: (l.chars ?? []).filter((c) => c.k !== 'translation').map((c) => ({ c: c.c, s: c.s, e: c.e })),
  }));
})();
const COVER = (() => {
  const p = path.join(ROOT, '_scratch-m3-80', 'cover-64.raw');
  if (!fs.existsSync(p)) return null;
  const b = fs.readFileSync(p);
  return { n: 64, buf: b };
})();
const csv = fs.readFileSync(path.join(ROOT, 'build', 'nbmachina_machine_map.csv'), 'utf8').trim().split(/\r?\n/);
const HEAD = csv[0].split(',');
const IX = HEAD.indexOf('x'), IZ = HEAD.indexOf('z'), IM = HEAD.indexOf('midi');
const IV = HEAD.indexOf('velocity'), IVO = HEAD.indexOf('voice'), IT = HEAD.indexOf('time_sec');
const NOTES = csv.slice(1).map((l) => {
  const f = l.split(',');
  return { x: +f[IX], z: +f[IZ], midi: +f[IM], vel: +f[IV], bass: f[IVO] === 'bass', t: +f[IT] };
}).sort((a, b) => a.t - b.t);

const { a: PH_A, b: PH_B } = show.meta.playhead;                 // x = a·t + b
const playheadX = (t) => PH_A * t + PH_B;
const DECK_Z0 = -12, DECK_Z1 = 16, DECK_CZ = (DECK_Z0 + DECK_Z1) / 2;
const ZC = 2.5;                                                  // 机器音轨轴（河心）
const PAL = show.palette;
const mix = (c1, c2, k) => [c1[0] + (c2[0] - c1[0]) * k, c1[1] + (c2[1] - c1[1]) * k, c1[2] + (c2[2] - c1[2]) * k];
const mul = (c, k) => [c[0] * k, c[1] * k, c[2] * k];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// 场次：按时间取样（场次连续、不重叠）
function sceneAt(t) {
  let s = show.scenes[0];
  for (const sc of show.scenes) if (t >= sc.t0) s = sc;
  return s;
}
function sceneProgress(sc, t) { return clamp((t - sc.t0) / Math.max(1e-6, sc.t1 - sc.t0), 0, 1); }

// 段落响度（由原曲测得）→ 强度
function levelAt(t) {
  const arr = show.levels;
  for (const l of arr) if (t >= l.t0 && t < l.t1) return 0.25 + 0.75 * l.level;
  return 0.5;
}

// 镜头：关键帧之间用 smootherstep 插值（保证速度连续、没有“顿”）
const smoother = (x) => x * x * x * (x * (x * 6 - 15) + 10);
function cameraAt(sc, t) {
  const ks = sc.cam;
  let i = 0;
  while (i < ks.length - 2 && t >= ks[i + 1].t) i++;
  const k0 = ks[i], k1 = ks[Math.min(i + 1, ks.length - 1)];
  const u = k1.t === k0.t ? 0 : clamp((t - k0.t) / (k1.t - k0.t), 0, 1);
  const k = smoother(u);
  const px = playheadX(t);
  const lerp = (f) => k0[f] + (k1[f] - k0[f]) * k;
  return {
    pos: [px + lerp('dx'), lerp('y'), lerp('dz')],
    target: [px + lerp('lx'), lerp('ly'), lerp('lz')],
    fov: lerp('fov') * Math.PI / 180,
  };
}

// ─────────────────────────── 缓冲 ───────────────────────────
const buf = new Float32Array(w * h * 3);
const bw = Math.max(1, w >> 2), bh = Math.max(1, h >> 2);
const bright = new Float32Array(bw * bh * 3);
const tmp = new Float32Array(bw * bh * 3);
const rgb = Buffer.allocUnsafe(w * h * 3);

function clearBufs() { buf.fill(0); bright.fill(0); }

// 加性光斑：平方衰减，半径 clamp（预演够用，且不会把帧时间拉爆）
function splat(cx, cy, r, cr, cg, cb, alpha, maxR = 26) {
  if (alpha <= 0.002 || r <= 0.25) return;
  if (r > maxR) r = maxR;
  const x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
  if (x1 < x0 || y1 < y0) return;
  const inv = 1 / (r * r);
  for (let y = y0; y <= y1; y++) {
    const dy = y - cy, dy2 = dy * dy;
    let o = (y * w + x0) * 3;
    for (let x = x0; x <= x1; x++, o += 3) {
      const dx = x - cx;
      const d2 = (dx * dx + dy2) * inv;
      if (d2 >= 1) continue;
      const f = (1 - d2) * (1 - d2) * alpha;
      buf[o] += cr * f; buf[o + 1] += cg * f; buf[o + 2] += cb * f;
    }
  }
}

// 加性四边形（画机器方块/河面）
function quad(p0, p1, p2, p3, cr, cg, cb, alpha) {
  if (alpha <= 0.002) return;
  const xs = [p0[0], p1[0], p2[0], p3[0]], ys = [p0[1], p1[1], p2[1], p3[1]];
  const x0 = Math.max(0, Math.floor(Math.min(...xs))), x1 = Math.min(w - 1, Math.ceil(Math.max(...xs)));
  const y0 = Math.max(0, Math.floor(Math.min(...ys))), y1 = Math.min(h - 1, Math.ceil(Math.max(...ys)));
  if (x1 < x0 || y1 < y0) return;
  if ((x1 - x0) * (y1 - y0) > 400000) return;
  const inside = (px, py, A, B) => (B[0] - A[0]) * (py - A[1]) - (B[1] - A[1]) * (px - A[0]);
  for (let y = y0; y <= y1; y++) {
    let o = (y * w + x0) * 3;
    for (let x = x0; x <= x1; x++, o += 3) {
      const d0 = inside(x, y, p0, p1), d1 = inside(x, y, p1, p2);
      const d2 = inside(x, y, p2, p3), d3 = inside(x, y, p3, p0);
      const neg = d0 < 0 || d1 < 0 || d2 < 0 || d3 < 0;
      const pos = d0 > 0 || d1 > 0 || d2 > 0 || d3 > 0;
      if (neg && pos) continue;
      const r = Math.hypot(x, y);
      buf[o] += cr * alpha; buf[o + 1] += cg * alpha; buf[o + 2] += cb * alpha;
    }
  }
}

// ─────────────────────────── 相机 ───────────────────────────
let cam = null;
function buildCam(c) {
  const [px, py, pz] = c.pos, [tx, ty, tz] = c.target;
  let fx = tx - px, fy = ty - py, fz = tz - pz;
  const fl = Math.hypot(fx, fy, fz) || 1; fx /= fl; fy /= fl; fz /= fl;
  let rx = fz * 1 - fy * 0, ry = 0, rz = -fx;          // cross(f, up=(0,1,0))
  rx = fz; ry = 0; rz = -fx;
  const rl = Math.hypot(rx, ry, rz) || 1; rx /= rl; ry /= rl; rz /= rl;
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const f = (h / 2) / Math.tan(c.fov / 2);
  cam = { px, py, pz, fx, fy, fz, rx, ry, rz, ux, uy, uz, f };
}
function proj(x, y, z, out) {
  const dx = x - cam.px, dy = y - cam.py, dz = z - cam.pz;
  const vz = dx * cam.fx + dy * cam.fy + dz * cam.fz;
  if (vz <= 0.25) return null;
  const vx = dx * cam.rx + dy * cam.ry + dz * cam.rz;
  const vy = dx * cam.ux + dy * cam.uy + dz * cam.uz;
  out[0] = w / 2 + vx * cam.f / vz;
  out[1] = h / 2 - vy * cam.f / vz;
  out[2] = vz;
  return out;
}

// ─────────────────────────── 5×7 点阵字（HUD 用，英文/数字） ───────────────────────────
const FONT = {
  A: [0x0e, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11], B: [0x1e, 0x11, 0x11, 0x1e, 0x11, 0x11, 0x1e],
  C: [0x0e, 0x11, 0x10, 0x10, 0x10, 0x11, 0x0e], D: [0x1e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1e],
  E: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x1f], F: [0x1f, 0x10, 0x10, 0x1e, 0x10, 0x10, 0x10],
  G: [0x0e, 0x11, 0x10, 0x17, 0x11, 0x11, 0x0f], H: [0x11, 0x11, 0x11, 0x1f, 0x11, 0x11, 0x11],
  I: [0x0e, 0x04, 0x04, 0x04, 0x04, 0x04, 0x0e], J: [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0c],
  K: [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11], L: [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1f],
  M: [0x11, 0x1b, 0x15, 0x15, 0x11, 0x11, 0x11], N: [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  O: [0x0e, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], P: [0x1e, 0x11, 0x11, 0x1e, 0x10, 0x10, 0x10],
  Q: [0x0e, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0d], R: [0x1e, 0x11, 0x11, 0x1e, 0x14, 0x12, 0x11],
  S: [0x0f, 0x10, 0x10, 0x0e, 0x01, 0x01, 0x1e], T: [0x1f, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  U: [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0e], V: [0x11, 0x11, 0x11, 0x11, 0x11, 0x0a, 0x04],
  W: [0x11, 0x11, 0x11, 0x15, 0x15, 0x1b, 0x11], X: [0x11, 0x11, 0x0a, 0x04, 0x0a, 0x11, 0x11],
  Y: [0x11, 0x11, 0x0a, 0x04, 0x04, 0x04, 0x04], Z: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1f],
  0: [0x0e, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0e], 1: [0x04, 0x0c, 0x04, 0x04, 0x04, 0x04, 0x0e],
  2: [0x0e, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1f], 3: [0x1f, 0x02, 0x04, 0x02, 0x01, 0x11, 0x0e],
  4: [0x02, 0x06, 0x0a, 0x12, 0x1f, 0x02, 0x02], 5: [0x1f, 0x10, 0x1e, 0x01, 0x01, 0x11, 0x0e],
  6: [0x06, 0x08, 0x10, 0x1e, 0x11, 0x11, 0x0e], 7: [0x1f, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  8: [0x0e, 0x11, 0x11, 0x0e, 0x11, 0x11, 0x0e], 9: [0x0e, 0x11, 0x11, 0x0f, 0x01, 0x02, 0x0c],
  ' ': [0, 0, 0, 0, 0, 0, 0], '.': [0, 0, 0, 0, 0, 0x0c, 0x0c], ',': [0, 0, 0, 0, 0x0c, 0x04, 0x08],
  ':': [0, 0x0c, 0x0c, 0, 0x0c, 0x0c, 0], '!': [0x04, 0x04, 0x04, 0x04, 0x04, 0, 0x04],
  '?': [0x0e, 0x11, 0x01, 0x06, 0x04, 0, 0x04], "'": [0x04, 0x04, 0, 0, 0, 0, 0],
  '-': [0, 0, 0, 0x1f, 0, 0, 0], '/': [0x01, 0x02, 0x02, 0x04, 0x08, 0x08, 0x10],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02], ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
  '&': [0x0c, 0x12, 0x14, 0x08, 0x15, 0x12, 0x0d], '+': [0, 0x04, 0x04, 0x1f, 0x04, 0x04, 0],
  '"': [0x0a, 0x0a, 0, 0, 0, 0, 0], '=': [0, 0, 0x1f, 0, 0x1f, 0, 0],
};
function text(str, x, y, px, cr, cg, cb, alpha = 1) {
  const s = String(str).toUpperCase().replace(/[^\x20-\x7e]/g, ' ');
  let cx = x;
  for (const ch of s) {
    const g = FONT[ch] || FONT['?'];
    for (let r = 0; r < 7; r++) {
      const row = g[r];
      for (let c = 0; c < 5; c++) if (row & (1 << (4 - c))) {
        const o = ((y + r * px) * w + (cx + c * px)) * 3;
        if (o >= 0 && o < buf.length) {
          buf[o] += cr * alpha; buf[o + 1] += cg * alpha; buf[o + 2] += cb * alpha;
        }
      }
    }
    cx += 6 * px;
  }
}
const textWidth = (s, px) => String(s).length * 6 * px;
function hline(x0, x1, y, cr, cg, cb, alpha) {
  for (let x = Math.max(0, x0 | 0); x <= Math.min(w - 1, x1 | 0); x++) {
    const o = (y * w + x) * 3;
    buf[o] += cr * alpha; buf[o + 1] += cg * alpha; buf[o + 2] += cb * alpha;
  }
}

// ─────────────────────────── 每帧绘制 ───────────────────────────
const P = [0, 0, 0];

// —— 开场卡（封面 + 标题）与逐字歌词：M5 §4.8 / §4.9 的预演实现 ——
/** 非 ASCII 字在预演里用「确定性笔画」占位（真机由 MC 字体光栅化，见 §4.8） */
const cjkCache = new Map();
function cjkGlyph(ch) {
  if (cjkCache.has(ch)) return cjkCache.get(ch);
  const code = ch.codePointAt(0);
  const G = 12, g = Array.from({ length: G }, () => new Array(G).fill(false));
  let h = code * 2654435761 % 4294967296;
  const rnd = () => ((h = (h * 1103515245 + 12345) % 2147483648) / 2147483648);
  const line = (x0, y0, x1, y1) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + (x1 - x0) * i / n), y = Math.round(y0 + (y1 - y0) * i / n);
      if (x >= 0 && x < G && y >= 0 && y < G) g[y][x] = true;
    }
  };
  const H = 1 + Math.floor(rnd() * 3);                 // 1~3 条横
  for (let i = 0; i < H; i++) { const y = 1 + Math.floor(rnd() * (G - 2)); line(0 + Math.floor(rnd() * 3), y, G - 1 - Math.floor(rnd() * 3), y); }
  const V = 1 + Math.floor(rnd() * 3);                 // 1~3 条竖
  for (let i = 0; i < V; i++) { const x = 1 + Math.floor(rnd() * (G - 2)); line(x, 0 + Math.floor(rnd() * 3), x, G - 1 - Math.floor(rnd() * 3)); }
  line(1 + Math.floor(rnd() * 3), 1 + Math.floor(rnd() * 3), G - 2 - Math.floor(rnd() * 3), G - 2 - Math.floor(rnd() * 3)); // 一撇
  const out = [];
  for (let y = 0; y < G; y++) for (let x = 0; x < G; x++) if (g[y][x]) out.push([x, y]);
  cjkCache.set(ch, { size: G, pts: out });
  return cjkCache.get(ch);
}

/** 3D 点：投影 + 加性光斑 */
function dot3(x, y, z, rBlocks, cr, cg, cb, alpha, maxR = 14) {
  const o = proj(x, y, z, P);
  if (!o) return;
  splat(o[0], o[1], clamp(rBlocks * cam.f / o[2], 0.55, maxR), cr, cg, cb, alpha, maxR);
}

/** 平躺在水面上的字（开场标题用）：读向 = −z，字上 = −x —— 与 S0 俯视机位对齐 */
function flatText(str, xTop, zStart, pxSize, cr, cg, cb, alpha) {
  let z = zStart;
  for (const ch of String(str)) {
    const isAscii = ch.codePointAt(0) <= 0x7e;
    if (ch === ' ') { z -= pxSize * 3; continue; }
    const adv = isAscii ? pxSize * 6 : pxSize * 7;
    if (isAscii) {
      const g = FONT[ch.toUpperCase()] || FONT['?'];
      for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
        if (g[r] & (1 << (4 - c))) dot3(xTop + r * pxSize, 0.06, z - c * pxSize, pxSize * 0.5, cr, cg, cb, alpha, 8);
      }
    } else {
      const g = cjkGlyph(ch);
      for (const [c, r] of g.pts) dot3(xTop + r * pxSize * 0.6, 0.06, z - c * pxSize * 0.6, pxSize * 0.3, cr, cg, cb, alpha, 8);
    }
    z -= adv;
  }
}

/** 开场 0–4.6s：水面上摊开封面 + 标题，第一颗音（3.917s）时被冲散成粒子 */
function drawOpeningCard(t) {
  if (t > 4.6) return;
  const fadeIn = clamp(t / 0.8, 0, 1);
  const dissolve = clamp((t - 3.30) / 1.20, 0, 1);
  const alive = 1 - dissolve;
  if (alive <= 0.01) return;
  // ① 封面：64×64 点阵平铺在水面上（真机 = image-matrix + 预先缩好的 64×64 PNG）
  if (COVER) {
    const span = 18, step = span / COVER.n;
    const x0 = 11 - span / 2, z0 = ZC - span / 2;
    for (let j = 0; j < COVER.n; j++) {
      for (let i = 0; i < COVER.n; i++) {
        const o = (j * COVER.n + i) * 3;
        const r = COVER.buf[o] / 255, g = COVER.buf[o + 1] / 255, b = COVER.buf[o + 2] / 255;
        const lum = 0.25 + 0.75 * (0.3 * r + 0.5 * g + 0.2 * b);
        const dx = i - COVER.n / 2, dz = j - COVER.n / 2;
        const rr = Math.hypot(dx, dz) / (COVER.n / 2);
        const a = fadeIn * alive * lum * (1 - 0.35 * rr * rr);
        const dv = dissolve * 1.6;
        dot3(x0 + (i + 0.5) * step + dv * (0.5 + 0.5 * Math.sin(i * 1.7)),
          0.06 + dv * 0.35 * (0.4 + 0.6 * Math.cos(j * 2.3)),
          z0 + (j + 0.5) * step + dv * 0.4 * Math.sin(i * 0.7 + j * 1.3),
          step * 0.52, r * 1.1, g * 1.1, b * 1.1, a * 0.95, 12);
      }
    }
  }
  // ② 标题 / 副标题（真机 = text 命令，平面朝下坡方向）
  const titleA = clamp((t - 0.55) / 0.7, 0, 1) * alive;
  if (titleA > 0.01) {
    flatText('STYX HELIX', 15.5, ZC + 7.0, 0.24, PAL.pale[0], PAL.pale[1], PAL.pale[2], titleA * 0.95);
    flatText('MYTH & ROID', 20.5, ZC + 4.6, 0.105, PAL.styx[0], PAL.styx[1], PAL.styx[2], titleA * 0.8);
    // ③ 划线：从左向右拉开（AMLL 的进场节奏）
    const sweep = clamp((t - 0.9) / 1.3, 0, 1);
    for (let k = 0; k <= 120 * sweep; k++) {
      dot3(18.0, 0.06, ZC + 7.4 - k * 0.13, 0.045, PAL.styx[0], PAL.styx[1], PAL.styx[2], titleA * 0.7, 6);
    }
  }
}

/** 逐字歌词：字随河流前进（vx = 播放头速度），唱到哪亮到哪 + AMLL 式弹性缩放 */
const LYRIC_ADV = 1.15;                   // 每个字占的河宽（格）
function drawLyrics(t) {
  if (!LYRICS) return;
  const px = playheadX(t);
  const y0 = 8.0, xSign = px + 6.0;
  let cur = null, prev = null;
  for (const l of LYRICS) {
    if (t >= l.start - 0.45) { prev = cur; cur = l; }
  }
  const drawLine = (line, alpha, sizeK, yOff, dim) => {
    if (!line || alpha <= 0.01) return;
    const chars = line.chars.length ? line.chars : [{ c: line.text, s: line.start, e: line.end }];
    const total = chars.reduce((n, ch) => n + (ch.c.codePointAt(0) > 0x7e ? 1 : 0.62), 0) * LYRIC_ADV;
    let z = ZC + total / 2 + 0.6;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const isAscii = ch.c.codePointAt(0) <= 0x7e;
      const adv = (isAscii ? 0.62 : 1.0) * LYRIC_ADV;
      const p = clamp((t - ch.s) / Math.max(0.05, ch.e - ch.s), 0, 1);
      const lit = clamp((t - ch.s) / 0.25, 0, 1);            // 唱到的瞬间点亮
      const pop = Math.exp(-Math.max(0, t - ch.s) / 0.13) * 0.22 * lit;  // AMLL 弹性
      const k = sizeK * (1 + pop);
      const col = mix(mul(PAL.styx, 0.45), PAL.pale, lit);
      const a = alpha * (0.34 + 0.66 * lit) * (dim ? 0.5 : 1);
      const floatY = 0.07 * Math.sin(t * 1.15 + i * 1.7);
      const dot = (dx, dy, dz, r) => dot3(xSign + dx * k, y0 + yOff + floatY + dy * k, z + dz * k, r, col[0], col[1], col[2], a, 12);
      if (isAscii) {
        const g = FONT[ch.c.toUpperCase()] || FONT['?'];
        for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) if (g[r] & (1 << (4 - c))) dot(-r * 0.215, c * 0.215, 0, 0.135);
      } else {
        const g = cjkGlyph(ch.c);
        for (const [c, r] of g.pts) dot(-r * 0.215, c * 0.215, 0, 0.115);
      }
      z -= adv;
    }
  };
  const curA = cur ? clamp((t - cur.start + 0.45) / 0.35, 0, 1) * clamp((cur.end + 0.6 - t) / 0.6, 0, 1) : 0;
  drawLine(cur, Math.max(0, curA), 1.0, 0, false);
  if (prev && prev !== cur) {
    const pA = clamp((prev.end + 0.9 - t) / 0.9, 0, 1) * 0.5;
    drawLine(prev, pA, 0.72, 1.5, true);
  }
}

const accs = show.accents.map((p) => p.t);
const cueList = show.cues.slice().sort((p, q) => p.t - q.t);
const RNG = (() => { let s = 1337; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
const SPARK = Array.from({ length: 24 }, () => {
  const a = RNG() * Math.PI * 2, r = 0.08 + RNG() * 0.28;
  return { dx: Math.cos(a) * r, dz: Math.sin(a) * r, vy: 0.20 + RNG() * 0.42, w: 0.6 + RNG() * 0.8 };
});
const EDGE = (() => {                       // 12 条棱 × 每棱 4 点（模拟“棱边恒定细描边”）
  const pts = [];
  const corners = [];
  for (const sx of [-1, 1]) for (const sy of [-1, 1]) for (const sz of [-1, 1]) corners.push([sx, sy, sz]);
  const edges = [];
  for (const p of corners) for (const q of corners) {
    let diff = 0;
    for (let k = 0; k < 3; k++) if (p[k] !== q[k]) diff++;
    if (diff === 1 && (p[0] + p[1] + p[2]) < (q[0] + q[1] + q[2])) edges.push([p, q]);
  }
  for (const [p, q] of edges) for (let i = 0; i <= 6; i++) {
    const k = i / 6;
    pts.push([(p[0] + (q[0] - p[0]) * k) * 0.5, (p[1] + (q[1] - p[1]) * k) * 0.5, (p[2] + (q[2] - p[2]) * k) * 0.5]);
  }
  return pts;
})();
const RING_N = 64;

// 重击冲击环（由真实重音驱动）
const shockAt = (t) => {
  for (let i = accs.length - 1; i >= 0; i--) {
    const age = t - accs[i];
    if (age >= 0) return age < 1.5 ? { age, i } : null;
  }
  return null;
};

function drawFrame(t) {
  const sc = sceneAt(t);
  const el = sc.elements;
  const lvl = levelAt(t);
  const palKey = sc.palette;
  const base = PAL[palKey] || PAL.styx;
  const px = playheadX(t);
  buildCam(cameraAt(sc, t));

  // 全局重置（Restart 节点）：先暗一下，再从机器起点反向重亮
  let resetDim = 1, relightX = -1e9;
  for (const c of cueList) {
    if (c.kind !== 'restart' && c.kind !== 'start') continue;
    const dt = t - c.t;
    if (dt > -0.45 && dt < 0.30) resetDim = Math.min(resetDim, clamp(Math.abs(dt) / 0.30, 0.06, 1));
    if (dt >= 0 && dt < 1.6) relightX = px - (1 - dt / 1.6) * (px + 40);
  }
  if (relightX > -1e8) resetDim = Math.min(resetDim, 0.85);

  // 地面/河床：机器所在的长条 + 两岸
  const dir = cam.fx >= 0 ? 1 : -1;        // 镜头朝向：+x = 顺流看未来，-x = 逆流看“已弹过的河”
  const cx = cam.px + dir * 45;
  const x0 = cx - dir * 70, x1 = cx + dir * 150;
  const p = (x, y, z) => { const o = [0, 0, 0]; return proj(x, y, z, o) ? o : null; };
  const corners = [p(x0, 0, DECK_Z0), p(x1, 0, DECK_Z0), p(x1, 0, DECK_Z1), p(x0, 0, DECK_Z1)];
  if (corners.every(Boolean)) quad(corners[0], corners[1], corners[2], corners[3], 0.050, 0.110, 0.150, 1.0);
  for (const z of [DECK_Z0, DECK_Z1]) {                       // 两岸细线
    const A = p(x0, 0.02, z), B = p(x1, 0.02, z);
    if (A && B) {
      const n = 160;
      for (let i = 0; i < n; i++) {
        const u = i / n;
        splat(A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u, 1.1, base[0] * 0.6, base[1] * 0.6, base[2] * 0.6, 0.10 * el.river * resetDim, 3);
      }
    }
  }

  // 地平线：河下游的微光（沿河道铺开的一条淡光带，不让机器远端掉进纯黑）
  for (let i = 0; i < 26; i++) {
    const xb = cx + dir * (55 + i * 5.0);
    for (const dz of [-9, -3, 3, 9, 15]) {
      const o = proj(xb, 0.6, dz, P);
      if (!o) continue;
      const k = 1 - i / 26;
      splat(o[0], o[1], clamp(1.6 * cam.f / o[2], 1.5, 40), base[0], base[1], base[2], 0.018 * k * k * (0.5 + lvl) * resetDim, 40);
    }
  }

  // 河：5 条水线 + 一层雾，速度严格 = 播放头速度（0.4167 格/刻）
  const flow = (t * 20) * show.meta.playhead.blocksPerTick;
  for (let lane = 0; lane < 6; lane++) {
    const z = DECK_Z0 + 1.5 + lane * ((DECK_Z1 - DECK_Z0 - 3) / 5);
    const sway = Math.sin(t * 0.5 + lane) * 1.4;
    for (let i = 0; i < 90; i++) {
      const xb = cx + dir * (((i * 1.7 + flow * (1 + 0.04 * lane)) % 220) - 70);
      const o2 = proj(xb, 0.06, z + sway, P);
      if (!o2) continue;
      const near = 1 - clamp(Math.abs(xb - px) / 90, 0, 1);
      const a = el.river * resetDim * (0.16 + 0.8 * near * near) * (0.6 + 0.4 * Math.sin(t * 2 + i));
      splat(o2[0], o2[1], clamp(0.09 * cam.f / o2[2], 0.8, 9), base[0], base[1], base[2], a, 9);
    }
  }
  for (let i = 0; i < 60; i++) {                              // 河面薄雾（在机器上方 1.5 格）
    const xb = cx + dir * (((i * 2.6 + flow * 0.35) % 220) - 70);
    const o = proj(xb, 1.5 + 0.5 * Math.sin(i + t), DECK_Z0 + 3 + (i * 3.1) % (DECK_Z1 - DECK_Z0 - 6), P);
    if (!o) continue;
    splat(o[0], o[1], clamp(0.5 * cam.f / o[2], 2, 34), base[0], base[1], base[2], el.river * 0.055 * resetDim, 34);
  }

  // 螺旋：两条反向缠绕的光带（绕机器轴），随段落收紧/放松
  if (el.helix > 0.02) {
    const axisY = 6.5 - 2.5 * el.helix;
    const rad = 5.0 + 3.0 * el.helix;
    const turn = 0.30 + 0.12 * el.helix;
    const ph = (t * 2.0) * (0.6 + 0.8 * el.helix);
    for (let strand = 0; strand < 2; strand++) {
      const off = strand * Math.PI;
      for (let i = 0; i < 190; i++) {
        const xb = px - 44 + i * 0.5;
        const th = (xb - px) * turn + ph + off;
        const rad2 = rad * 0.82;
        const o = proj(xb, axisY + Math.sin(th) * rad2, ZC + Math.cos(th) * rad2, P);
        if (!o) continue;
        const near = 1 - clamp(Math.abs(xb - px) / 46, 0, 1);
        const a = el.helix * resetDim * (0.10 + 1.0 * near * near) * 0.9;
        splat(o[0], o[1], clamp(0.19 * cam.f / o[2], 1.0, 12), PAL.helix[0], PAL.helix[1], PAL.helix[2], a, 12);
      }
    }
  }

  // 播放头（“现在线”）：河面上的一道光幕 + 甲板处亮核
  {
    const pl = el.playhead * resetDim;
    for (let z = DECK_Z0; z <= DECK_Z1; z += 0.9) {
      for (let y = 0; y < 7; y += 0.7) {
        const o = proj(px, y, z, P);
        if (!o) continue;
        const fall = Math.exp(-y / 2.2) * Math.exp(-Math.abs(z - ZC) / 12);
        const a = pl * fall * (0.22 + 1.1 * lvl);
        splat(o[0], o[1], clamp(0.16 * cam.f / o[2], 1.0, 14), PAL.pale[0], PAL.pale[1], PAL.pale[2], a, 14);
      }
    }
    const o = proj(px, 0.10, ZC, P);
    if (o) splat(o[0], o[1], clamp(1.1 * cam.f / o[2], 3, 46), PAL.pale[0], PAL.pale[1], PAL.pale[2], 0.8 * pl, 46);
  }

  // 重音冲击环：从播放头横向铺开的圆环
  if (el.ring > 0.05) {
    const s = shockAt(t);
    if (s) {
      const r = 0.6 + 13 * (1 - Math.exp(-s.age / 0.5));
      const a = el.ring * resetDim * Math.pow(1 - s.age / 1.5, 2) * 0.5;
      for (let i = 0; i < RING_N; i++) {
        const th = (i / RING_N) * Math.PI * 2;
        const o = proj(px + Math.sin(th) * 0.6, 0.05, ZC + Math.cos(th) * r, P);
        if (!o) continue;
        splat(o[0], o[1], clamp(0.10 * cam.f / o[2], 0.9, 9), base[0], base[1], base[2], a, 9);
      }
    }
  }

  // 空环：在播放头处描一个竖着的空环（按时间逐渐描出，再散开）
  const ringCue = cueList.find((c) => c.kind === 'ring');
  if (ringCue) {
    const dt = t - ringCue.t;
    if (dt > 0 && dt < 5.0) {
      const trace = clamp(dt / 2.4, 0, 1);
      const fade = dt < 2.4 ? 1 : clamp(1 - (dt - 2.4) / 2.6, 0, 1);
      const R = 13.5;
      const segments = 120;
      for (let i = 0; i < segments * trace; i++) {
        const th = (i / segments) * Math.PI * 2 - Math.PI / 2;
        const o = proj(px + 0.3, 8 + Math.sin(th) * R, ZC + Math.cos(th) * R, P);
        if (!o) continue;
        splat(o[0], o[1], clamp(0.13 * cam.f / o[2], 1.0, 11), PAL.pale[0], PAL.pale[1], PAL.pale[2], 0.45 * fade, 11);
      }
    }
  }

  // 机器方块（钢琴卷）＋ 逐音心跳
  const view0 = cam.px - 90, view1 = cam.px + 170;
  const active = [];
  for (const n of NOTES) {
    if (n.t > t) { if (n.t - t > 0.02 && n.x > px + 130) break; continue; }
    const age = t - n.t;
    if (age < 1.5) active.push({ n, age });
    if (n.x < view0) continue;
    if (n.x > view1) break;
  }
  // 已弹过的方块：淡淡的余温（按“退潮”在终章逐渐熄灭）
  const wd = show.cues.find((c) => c.kind === 'withdraw');
  const withdraw = wd ? clamp((t - wd.t) / 40, 0, 1) : 0;
  for (const n of NOTES) {
    if (n.x < view0 || n.x > view1) continue;
    if (Math.abs(n.x - cam.px) < 7) continue;      // 贴着镜头的方块投影会糊满画面，跳过
    const age = t - n.t;
    let a;
    if (age < 0) {
      // 还没弹到：极暗的底图，让“钢琴卷”的形状在播放头前方就能读出来
      const ahead = n.x - px;
      if (ahead > 90) continue;
      a = 0.045 * (1 - ahead / 90) * (0.45 + 0.55 * n.vel / 110) * (0.5 + 0.5 * lvl);
    } else {
      a = 0.17 * Math.exp(-age / 2.6) * (n.vel / 110);
    }
    if (withdraw > 0 && n.x < px - 20 * (1 - withdraw)) a *= clamp(1 - withdraw * 1.4, 0, 1);
    if (relightX > -1e8 && n.x > relightX) a *= 0.25;
    if (a < 0.004) continue;
    const col = n.bass ? PAL.helix : (n.midi > 78 ? PAL.pale : mix(PAL.pale, base, 0.55));
    const c0 = p(n.x + 0.06, 0.04, n.z + 0.94), c1 = p(n.x + 0.94, 0.04, n.z + 0.94),
      c2 = p(n.x + 0.94, 0.04, n.z + 0.06), c3 = p(n.x + 0.06, 0.04, n.z + 0.06);
    if (c0 && c1 && c2 && c3) quad(c0, c1, c2, c3, col[0], col[1], col[2], a * resetDim);
  }
  // 逐音心跳：描边方块（等比放大）＋ 表面涟漪 ＋ 火花 ＋ 倒影
  for (const { n, age } of active) {
    const grow = 1 + 1.25 * (1 - Math.exp(-age / 0.42));       // 从 0.5 格半边长起步，等比放大到 ~2.25×
    const fade = clamp(1 - age / 1.35, 0, 1);
    if (fade <= 0) continue;
    const cxN = n.x + 0.5, czN = n.z + 0.5;
    const voiceCol = n.bass ? PAL.helix : mix(PAL.pale, base, 0.3);
    const accentN = clamp((n.vel - 88) / 26, 0, 1);
    const col = accentN > 0.72 ? mix(voiceCol, PAL.blood, (accentN - 0.72) / 0.28 * 0.55) : voiceCol;
    const ptsz = clamp(0.115 * cam.f / Math.max(1, cam.f / 60), 1, 7);

    // ① 方块描边（12 棱，恒定细描边：点尺寸不随扩散变粗）
    for (const e of EDGE) {
      const o = proj(cxN + e[0] * 2 * 0.5 * grow, 0.5 + e[1] * 0.5 * grow, czN + e[2] * 0.5 * grow, P);
      if (!o) continue;
      splat(o[0], o[1], clamp(0.085 * cam.f / o[2], 0.9, 11), col[0], col[1], col[2], fade * (0.42 + 0.6 * accentN) * el.flare * resetDim, 11);
    }
    // ② 表面涟漪（单条连贯环，先快后慢）
    const rr = 0.5 + 1.35 * (1 - Math.exp(-age / 0.55));
    const ra = Math.pow(fade, 1.5) * el.flare * (0.32 + 0.5 * accentN) * resetDim;
    for (let i = 0; i < RING_N; i++) {
      const th = (i / RING_N) * Math.PI * 2;
      const o = proj(cxN + Math.cos(th) * rr, 0.035, czN + Math.sin(th) * rr, P);
      if (!o) continue;
      splat(o[0], o[1], clamp(0.09 * cam.f / o[2], 0.8, 8), base[0], base[1], base[2], ra, 8);
    }
    // ③ 表面发光（与扩散同一条生命周期，不另加光斑）
    const o0 = proj(cxN, 0.5, czN, P);
    if (o0) splat(o0[0], o0[1], clamp(0.62 * cam.f / o0[2], 2, 42), col[0], col[1], col[2], fade * fade * 0.40 * el.flare * resetDim, 42);
    // ④ 火花（照搬烟花口径：随机方向 + 重力 + 淡出）
    if (el.sparks > 0.05) {
      for (let i = 0; i < SPARK.length; i++) {
        const s = SPARK[i];
        const life = clamp(age / (0.9 * s.w), 0, 1);
        if (life >= 1) continue;
        const y = 0.55 + s.vy * age - 0.55 * age * age;
        if (y < 0) continue;
        const o = proj(cxN + s.dx * age * 2.2, y, czN + s.dz * age * 2.2, P);
        if (!o) continue;
        const c = n.bass ? mix(PAL.helix, PAL.pale, 0.4) : PAL.pale;
        splat(o[0], o[1], clamp(0.075 * cam.f / o[2], 0.7, 7), c[0], c[1], c[2], (1 - life) * 0.5 * el.sparks * resetDim, 7);
      }
    }
    // ⑤ 水面倒影（只对最近的音做，保持干净）
    if (age < 0.9 && o0) {
      const o = proj(cxN, -0.55, czN, P);
      if (o) splat(o[0], o[1], clamp(0.6 * cam.f / o[2], 2, 34), base[0], base[1], base[2], fade * 0.16 * resetDim, 34);
    }
  }

  // “记忆之砂”：从高处落下的细粒（quiet 段专用）
  if (el.sand > 0.03) {
    for (let i = 0; i < 70; i++) {
      const xb = cx + dir * (((i * 3.7 + flow * 0.5) % 200) - 60);
      const y = ((1 - ((t * 0.5 + i * 0.13) % 1)) * 9) + 1;
      const o = proj(xb, y, DECK_Z0 + 2 + (i * 2.3) % (DECK_Z1 - DECK_Z0 - 4), P);
      if (!o) continue;
      splat(o[0], o[1], clamp(0.07 * cam.f / o[2], 0.7, 6), PAL.pale[0], PAL.pale[1], PAL.pale[2], el.sand * 0.16 * resetDim, 6);
    }
  }

  // ───────── HUD（只做“看板”，不参与观感评价） ─────────
  const tc = (v) => `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(Math.floor(v % 60)).padStart(2, '0')}`;
  // 开场卡 + 逐字歌词（世界内元素，先画，HUD 压在上层）
  drawOpeningCard(t);
  drawLyrics(t);
  const pxHud = Math.max(2, Math.round(h / 260));
  text(`STYX HELIX - ${sc.nameEn || sc.id}`, 14, 12, pxHud, 0.85, 0.92, 1.0, 0.75);
  text(`${tc(t)}  LV${(lvl * 4).toFixed(1)}  ${sc.role}`, 14, 12 + 9 * pxHud, pxHud, 0.55, 0.75, 0.8, 0.6);

  // 设计节点提示（±3s 内显示这条 cue 的中文说明的 ASCII 摘要）
  const cueNow = cueList.find((c) => Math.abs(t - c.t) < 3.0);
  if (cueNow) {
    const tag = cueNow.kind.toUpperCase() + (cueNow.text.includes('——') ? '' : '');
    text(`[${tag}]`, 14, 12 + 18 * pxHud, pxHud, 1.0, 0.55, 0.45, 0.85);
  }

  // 当前歌词行（"剪辑层字幕"的预演）——文字来自本机 nbaurora/lyrics，**不在仓库里**（show/*.json 只存时间窗）
  const line = (() => {
    let cur = null;
    for (const l of (LYRICS ?? [])) if (t >= l.start - 0.25) cur = { text: l.text };
    return cur;
  })();
  if (line) {
    const raw = line.text.replace(/[^\x20-\x7e]/g, ' ').replace(/\s+/g, ' ').trim();
    if (raw && raw.length / Math.max(1, line.text.trim().length) > 0.6) {
      const pxL = Math.max(3, Math.round(h / 150));
      const tw = textWidth(raw, pxL);
      text(raw, Math.max(10, (w - tw) / 2), h - 46, pxL, 0.95, 0.97, 1.0, 0.85);
    }
  }

  // 进度条：整条机器 + 场次刻度 + 播放头
  const barY = h - 18, barX0 = 16, barX1 = w - 16;
  hline(barX0, barX1, barY, 0.20, 0.30, 0.38, 1);
  const spanLo = show.meta.xRange[0], spanHi = show.meta.xRange[1];
  for (const s of show.scenes) {
    const xb = barX0 + (barX1 - barX0) * (playheadX((s.t0 + s.t1) / 2) - spanLo) / (spanHi - spanLo);
    hline(xb - 2, xb + 2, barY, 0.35, 0.5, 0.6, 1);
  }
  const phb = barX0 + (barX1 - barX0) * clamp((px - spanLo) / (spanHi - spanLo), 0, 1);
  hline(phb - 6, phb + 6, barY, 1.0, 1.0, 1.0, 1);
  // 重音刻度（真实重音，一眼看出“冲击环从哪来”）
  for (const a of show.accents) {
    const xb = barX0 + (barX1 - barX0) * (playheadX(a.t) - spanLo) / (spanHi - spanLo);
    hline(xb, xb, barY + 3, 0.30, 0.8, 0.75, 1);
    hline(xb, xb, barY - 3, 0.30, 0.8, 0.75, 1);
  }

  // 暗角（模拟镜头的自然衰减）
  const vg = 1 / (1 + 0.0007 * Math.pow(Math.hypot((w / 2), (h / 2)) / 1.0, 1.2));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot((x - w / 2) / (w / 2), (y - h / 2) / (h / 2));
      const f = 1 - 0.40 * Math.pow(clamp(d, 0, 1.4) / 1.4, 2.2);
      const o = (y * w + x) * 3;
      buf[o] *= f; buf[o + 1] *= f; buf[o + 2] *= f;
    }
  }

  // ───────── bloom（亮部降采样 → 两次盒式模糊 → 加回） ─────────
  bright.fill(0);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      let r = 0, g = 0, b = 0;
      for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
        const o = (((y * 4 + sy) * w) + (x * 4 + sx)) * 3;
        r += buf[o]; g += buf[o + 1]; b += buf[o + 2];
      }
      const wgt = 1 / 16;
      r *= wgt; g *= wgt; b *= wgt;
      const t0 = Math.max(0, r - 0.55), t1 = Math.max(0, g - 0.55), t2 = Math.max(0, b - 0.55);
      const o2 = (y * bw + x) * 3;
      bright[o2] = t0; bright[o2 + 1] = t1; bright[o2 + 2] = t2;
    }
  }
  for (const pass of [0, 1]) {                                  // 0=横向, 1=纵向, 半径 4
    tmp.set(bright);
    const R = 4;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        let r = 0, g = 0, b = 0, n = 0;
        for (let k = -R; k <= R; k++) {
          const xx = pass === 0 ? x + k : x, yy = pass === 0 ? y : y + k;
          if (xx < 0 || xx >= bw || yy < 0 || yy >= bh) continue;
          const o = (yy * bw + xx) * 3;
          r += tmp[o]; g += tmp[o + 1]; b += tmp[o + 2]; n++;
        }
        const o = (y * bw + x) * 3;
        bright[o] = r / n; bright[o + 1] = g / n; bright[o + 2] = b / n;
      }
    }
  }
  const bwgt = 0.85;
  for (let y = 0; y < h; y++) {
    const by = Math.min(bh - 1, y >> 2), fy = (y & 3) / 4;
    for (let x = 0; x < w; x++) {
      const bx = Math.min(bw - 1, x >> 2), fx = (x & 3) / 4;
      const b00 = (by * bw + bx) * 3, b01 = (by * bw + Math.min(bw - 1, bx + 1)) * 3;
      const b10 = (Math.min(bh - 1, by + 1) * bw + bx) * 3, b11 = (Math.min(bh - 1, by + 1) * bw + Math.min(bw - 1, bx + 1)) * 3;
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) {
        const top = bright[b00 + c] + (bright[b01 + c] - bright[b00 + c]) * fx;
        const bot = bright[b10 + c] + (bright[b11 + c] - bright[b10 + c]) * fx;
        buf[o + c] += (top + (bot - top) * fy) * bwgt;
      }
    }
  }

  // ───────── tonemap + gamma ─────────
  for (let i = 0, o = 0; i < w * h; i++, o += 3) {
    for (let c = 0; c < 3; c++) {
      let v = buf[o + c];
      if (v < 0) v = 0;
      v = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
      rgb[o + c] = (Math.pow(clamp(v, 0, 1), 1 / 2.2) * 255) | 0;
    }
  }
  return rgb;
}

// ─────────────────────────── 主流程 ───────────────────────────
function writeRaw(frameBuf, stream) {
  if (!stream.write(Buffer.from(frameBuf))) {
    return new Promise((res) => stream.once('drain', res));
  }
  return Promise.resolve();
}

async function main() {
  const dur = TO - FROM;
  if (STILL !== null) {
    const t = parseFloat(STILL);
    const fb = drawFrame(t);
    const png = path.join(path.dirname(OUT), `still-${t.toFixed(2).replace('.', '_')}.ppm`);
    fs.writeFileSync(png, Buffer.concat([Buffer.from(`P6\n${w} ${h}\n255\n`), Buffer.from(fb)]));
    console.log('still ->', png);
    return;
  }
  const args = [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(FPS), '-i', '-',
  ];
  if (!NO_AUDIO && fs.existsSync(AUDIO)) {
    args.push('-ss', FROM.toFixed(3), '-t', dur.toFixed(3), '-i', AUDIO);
    args.push('-map', '0:v', '-map', '1:a', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  }
  args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-r', String(FPS), OUT);
  const ff = spawn('ffmpeg', args, { stdio: ['pipe', 'inherit', 'inherit'] });
  const total = Math.round(dur * FPS);
  const t0 = Date.now();
  for (let i = 0; i < total; i++) {
    const t = FROM + i / FPS;
    clearBufs();
    const fb = drawFrame(t);
    await writeRaw(fb, ff.stdin);
    if (i % 30 === 0 || i === total - 1) {
      const el = (Date.now() - t0) / 1000;
      process.stdout.write(`\r  ${((i + 1) / total * 100).toFixed(1)}%  frame ${i + 1}/${total}  ${(el).toFixed(1)}s  ${((i + 1) / Math.max(1e-6, el)).toFixed(1)} fps`);
    }
  }
  ff.stdin.end();
  await new Promise((res, rej) => ff.on('close', (code) => (code === 0 ? res() : rej(new Error('ffmpeg exit ' + code)))));
  console.log(`\n-> ${OUT}  (${(((Date.now() - t0) / 1000)).toFixed(1)}s, ${((Date.now() - t0) / total).toFixed(0)} ms/frame)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
