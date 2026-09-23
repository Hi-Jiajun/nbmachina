#!/usr/bin/env node
/**
 * STYX HELIX · 视效时间轴生成器（M5 设计 → 机器可读产物）
 *
 * 输入（都是既有的真实产物，不手写）：
 *   ../build/nbmachina_machine_map.csv      3044 颗音的真实坐标/音高/力度/声部/时间
 *   ../build/lyrics/styx_helix_master.lrc   逐字歌词（母版时间轴，含句首时间）
 *   ../build/dynamics-sections.json         19 段响度曲线（来自原曲）
 * 输出：
 *   show/styx_helix.show.json   场次 / 镜头关键帧 / 歌词提示 / 重音 / 播放头曲线
 *
 * 设计口径见 docs/M5-show-design.md。本脚本只做“把设计写死进数据”，不做任何观感发明。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');          // Documents/minecraft
const OUT = path.resolve(HERE, '..', 'show', 'styx_helix.show.json');

// ─────────────────────────── 设计常量（唯一来源） ───────────────────────────

/** 5 色系：冥河青 / 螺旋紫 / 苍白白 / 血朱 / 暖金（其余一律不许出现） */
const PALETTE = {
  styx: [0.15, 0.86, 0.80],   // 冥河青 —— 河面、水流、涟漪主体
  helix: [0.47, 0.36, 1.00],   // 螺旋紫 —— 双螺旋、低频、巫女雾
  pale: [0.90, 0.95, 1.00],   // 苍白白 —— 旋律本体、钢琴、描边
  blood: [1.00, 0.22, 0.34],   // 血朱 —— 只给"死"与重击，全曲 < 8% 占比
  dawn: [1.00, 0.79, 0.53],   // 暖金 —— 只在尾段（"新的一天"）之后出现
};

/** 十场：母版时间轴（t=0 = 母版开头；机器时间 = 母版 − 3.917s） */
const SCENES = [
  {
    id: 'S0', name: '序 · 空河', nameEn: 'S0 PROLOGUE / EMPTY RIVER', role: 'prologue',
    t0: 0.00, t1: 22.94, level: 0.15, palette: 'styx',
    cam: [
      { t: 0.0, dx: -12, y: 40, dz: 3, lx: 34, ly: 0.0, lz: 3, fov: 42 },
      { t: 12.0, dx: -22, y: 24, dz: 14, lx: 30, ly: 0.6, lz: 2, fov: 40 },
      { t: 22.9, dx: -18, y: 8, dz: 8, lx: 26, ly: 1.2, lz: 0, fov: 40 },
    ],
    elements: { river: 0.55, helix: 0.0, flare: 0.85, playhead: 0.6, ring: 0.0, sparks: 0.5, sand: 0.0 },
  },
  {
    id: 'S1', name: 'A① · 人声首句', nameEn: 'S1 VERSE 1', role: 'verse',
    t0: 22.94, t1: 39.67, level: 0.60, palette: 'styx',
    cam: [
      { t: 22.94, dx: -16, y: 6.0, dz: 6.5, lx: 26, ly: 1.6, lz: -1, fov: 42 },
      { t: 31.0, dx: -15, y: 5.2, dz: 7.5, lx: 28, ly: 1.4, lz: -2, fov: 42 },
      { t: 39.67, dx: -17, y: 6.4, dz: 5.0, lx: 24, ly: 1.8, lz: 0, fov: 42 },
    ],
    elements: { river: 0.7, helix: 0.15, flare: 1.0, playhead: 1.0, ring: 0.35, sparks: 0.7, sand: 0.0 },
  },
  {
    id: 'S2', name: 'B① · 乱掉的钟', nameEn: 'S2 VERSE 2 / BROKEN CLOCK', role: 'verse2',
    t0: 39.67, t1: 65.50, level: 0.45, palette: 'styx',
    cam: [
      { t: 39.67, dx: -7.0, y: 2.6, dz: 2.0, lx: 14, ly: 1.0, lz: 0, fov: 32 },
      { t: 50.0, dx: -5.0, y: 2.0, dz: 1.6, lx: 10, ly: 0.9, lz: 0, fov: 28 },
      { t: 58.0, dx: -7.5, y: 3.2, dz: 2.6, lx: 14, ly: 1.2, lz: 0, fov: 30 },
      { t: 65.50, dx: -20, y: 8.0, dz: 8.0, lx: 26, ly: 1.6, lz: 0, fov: 38 },
    ],
    elements: { river: 0.55, helix: 0.25, flare: 1.0, playhead: 0.9, ring: 0.4, sparks: 0.55, sand: 0.15 },
  },
  {
    id: 'S3', name: '副歌①', nameEn: 'S3 CHORUS 1', role: 'chorus',
    t0: 65.50, t1: 94.80, level: 0.95, palette: 'styx',
    cam: [
      { t: 65.50, dx: -18, y: 7.0, dz: 8.0, lx: 28, ly: 1.4, lz: 0, fov: 40 },
      { t: 74.0, dx: -34, y: 21.0, dz: 28.0, lx: 26, ly: 2.0, lz: 2, fov: 40 },
      { t: 80.47, dx: -30, y: 18.0, dz: 22.0, lx: 30, ly: 1.6, lz: 0, fov: 42 },
      { t: 88.0, dx: -26, y: 12.0, dz: 14.0, lx: 30, ly: 1.6, lz: 0, fov: 42 },
      { t: 94.80, dx: -20, y: 8.0, dz: 9.0, lx: 28, ly: 1.6, lz: 0, fov: 42 },
    ],
    elements: { river: 0.9, helix: 1.0, flare: 1.0, playhead: 1.0, ring: 0.8, sparks: 0.9, sand: 0.0 },
  },
  {
    id: 'S4', name: '间奏 · 落砂', nameEn: 'S4 INTERLUDE / SAND', role: 'interlude',
    t0: 94.80, t1: 116.40, level: 0.50, palette: 'styx',
    cam: [
      { t: 94.80, dx: -14, y: 7.0, dz: 10.0, lx: -30, ly: 1.2, lz: 2, fov: 38 },
      { t: 105.0, dx: 12.0, y: 9.0, dz: 12.0, lx: -34, ly: 1.0, lz: 2, fov: 36 },
      { t: 116.40, dx: 16.0, y: 10.0, dz: 14.0, lx: -30, ly: 1.2, lz: 2, fov: 36 },
    ],
    elements: { river: 0.7, helix: 0.3, flare: 0.9, playhead: 0.9, ring: 0.5, sparks: 0.6, sand: 1.0 },
  },
  {
    id: 'S5', name: 'A②B② · 追忆的圈套', nameEn: 'S5 VERSE 3 / TRAP OF MEMORY', role: 'verse3',
    t0: 116.40, t1: 141.50, level: 0.50, palette: 'styx',
    cam: [
      { t: 116.40, dx: -9.0, y: 6.0, dz: 30.0, lx: 16, ly: 1.2, lz: 4, fov: 34 },
      { t: 129.0, dx: -16.0, y: 5.5, dz: 7.0, lx: 24, ly: 1.4, lz: 0, fov: 38 },
      { t: 141.50, dx: -18.0, y: 6.5, dz: 7.0, lx: 24, ly: 1.6, lz: 0, fov: 38 },
    ],
    elements: { river: 0.65, helix: 0.35, flare: 1.0, playhead: 0.95, ring: 0.5, sparks: 0.6, sand: 0.5 },
  },
  {
    id: 'S6', name: '副歌② · 空环', nameEn: 'S6 CHORUS 2 / EMPTY RING', role: 'chorus2',
    t0: 141.50, t1: 170.10, level: 1.00, palette: 'styx',
    cam: [
      { t: 141.50, dx: -24, y: 10.0, dz: 12.0, lx: 30, ly: 1.6, lz: 0, fov: 42 },
      { t: 152.0, dx: -40, y: 23.0, dz: 32.0, lx: 30, ly: 2.2, lz: 2, fov: 40 },
      { t: 165.21, dx: -12, y: 34.0, dz: 3.0, lx: 34, ly: 0.0, lz: 3, fov: 46 },
      { t: 170.10, dx: -26, y: 13.0, dz: 16.0, lx: 28, ly: 1.8, lz: 0, fov: 42 },
    ],
    elements: { river: 1.0, helix: 1.0, flare: 1.0, playhead: 1.0, ring: 1.0, sparks: 1.0, sand: 0.0 },
  },
  {
    id: 'S7', name: 'C · 淡入淡出', nameEn: 'S7 BRIDGE / FADE', role: 'bridge',
    t0: 170.10, t1: 199.80, level: 0.35, palette: 'helix',
    cam: [
      { t: 170.10, dx: 14.0, y: 10.0, dz: 12.0, lx: -32, ly: 1.4, lz: 2, fov: 36 },
      { t: 183.0, dx: -9.0, y: 7.0, dz: 28.0, lx: 16, ly: 1.2, lz: 4, fov: 34 },
      { t: 192.0, dx: -22, y: 10.0, dz: 12.0, lx: 28, ly: 1.6, lz: 0, fov: 40 },
      { t: 199.80, dx: -20, y: 8.0, dz: 9.0, lx: 28, ly: 1.6, lz: 0, fov: 42 },
    ],
    elements: { river: 0.4, helix: 0.6, flare: 0.85, playhead: 1.0, ring: 0.4, sparks: 0.5, sand: 0.7 },
  },
  {
    id: 'S8', name: '大副歌 · 顶点', nameEn: 'S8 FINAL CHORUS', role: 'final-chorus',
    t0: 199.80, t1: 239.80, level: 1.00, palette: 'styx',
    cam: [
      { t: 199.80, dx: -22, y: 9.0, dz: 11.0, lx: 28, ly: 1.6, lz: 0, fov: 42 },
      { t: 210.0, dx: -36, y: 20.0, dz: 30.0, lx: 30, ly: 2.0, lz: 2, fov: 40 },
      { t: 216.95, dx: -34, y: 17.0, dz: 24.0, lx: 30, ly: 1.8, lz: 0, fov: 42 },
      { t: 231.53, dx: 20.0, y: 15.0, dz: 15.0, lx: -34, ly: 1.2, lz: 2, fov: 36 },
      { t: 239.80, dx: 18.0, y: 13.0, dz: 13.0, lx: -34, ly: 1.4, lz: 2, fov: 36 },
    ],
    elements: { river: 1.0, helix: 1.0, flare: 1.0, playhead: 1.0, ring: 1.0, sparks: 1.0, sand: 0.2 },
  },
  {
    id: 'S9', name: '终 · 新的一天', nameEn: 'S9 OUTRO / DAWN', role: 'outro',
    t0: 239.80, t1: 285.00, level: 0.50, palette: 'dawn',
    cam: [
      { t: 239.80, dx: 18.0, y: 13.0, dz: 13.0, lx: -34, ly: 1.4, lz: 2, fov: 36 },
      { t: 249.30, dx: 14.0, y: 15.0, dz: 20.0, lx: -32, ly: 1.6, lz: 2, fov: 36 },
      { t: 261.01, dx: -18, y: 8.0, dz: 9.0, lx: 26, ly: 1.4, lz: 0, fov: 40 },
      { t: 274.0, dx: -16, y: 6.0, dz: 6.5, lx: 26, ly: 1.3, lz: 0, fov: 40 },
      { t: 284.5, dx: -13, y: 4.0, dz: 4.0, lx: 30, ly: 1.2, lz: 0, fov: 38 },
    ],
    elements: { river: 0.55, helix: 0.25, flare: 0.95, playhead: 0.9, ring: 0.7, sparks: 0.7, sand: 0.3 },
  },
];

/** 歌词触发的“大动作”（设计里的戏剧节点，逐条对应歌词） */
const CUES = [
  { t: 3.917, kind: 'first-note', text: '第一颗音：河面第一滴水' },
  { t: 22.94, kind: 'lyric', text: '首句人声进入（逐字歌词开始）' },
  { t: 33.22, kind: 'endless', text: '长句 —— 河道拉到地平线' },
  { t: 39.67, kind: 'clock', text: '钟面动机 —— 乱转的钟面' },
  { t: 44.55, kind: 'sand', text: '落砂动机 —— 细砂开始落' },
  { t: 80.47, kind: 'restart', text: 'Restart ① —— 回退重来（全场熄灭 → 反向重亮）' },
  { t: 94.80, kind: 'lyric', text: '目送句 —— 落砂段开始' },
  { t: 154.54, kind: 'restart', text: 'Restart ②' },
  { t: 165.21, kind: 'ring', text: '空环动机 —— 描一个空环再散' },
  { t: 174.17, kind: 'fade', text: '淡入' },
  { t: 182.21, kind: 'fade', text: '淡出' },
  { t: 216.95, kind: 'restart', text: 'Restart ③' },
  { t: 231.53, kind: 'withdraw', text: '退潮动机 —— 光开始退潮' },
  { t: 249.30, kind: 'start', text: '软重置（尾段）' },
  { t: 261.01, kind: 'lyric', text: '尾句 —— 余辉不许灭' },
  { t: 271.0, kind: 'dawn', text: '暖金接管（新的一天）' },
  { t: 283.86, kind: 'last-note', text: '最后一颗音' },
];

// ─────────────────────────── 读取真实素材 ───────────────────────────

const csvPath = path.join(ROOT, 'build', 'nbmachina_machine_map.csv');
const lrcPath = path.join(ROOT, 'build', 'lyrics', 'styx_helix_master.lrc');
const dynPath = path.join(ROOT, 'build', 'dynamics-sections.json');

function readNotes(file) {
  const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
  const head = rows[0].split(',');
  const col = (n) => head.indexOf(n);
  const [IX, IY, IZ, IINS, IVOC, IMID, IVEL, IDUR, ITIME] = [
    col('x'), col('y'), col('z'), col('instrument'), col('voice'),
    col('midi'), col('velocity'), col('dur_ms'), col('time_sec'),
  ];
  return rows.slice(1).map((line) => {
    const f = line.split(',');
    return {
      x: +f[IX], y: +f[IY], z: +f[IZ], inst: f[IINS], voice: f[IVOC],
      midi: +f[IMID], vel: +f[IVEL], durMs: +f[IDUR], t: +f[ITIME],
    };
  });
}

function parseLrc(file) {
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = raw.match(/^\[(\d+):(\d+\.\d+)\](.*)$/);
    if (!m) continue;
    const t0 = (+m[1]) * 60 + parseFloat(m[2]);
    const text = m[3].replace(/<\d+:\d+\.\d+>/g, '').trim();
    if (text) out.push({ t0, text });
  }
  out.sort((a, b) => a.t0 - b.t0);
  out.forEach((l, i) => { l.t1 = i + 1 < out.length ? out[i + 1].t0 : 285; });
  return out;
}

/** 重音：按 0.12s 桶聚力度，取局部极大值（最小间隔 1.7s）——驱动“冲击环” */
function findAccents(notes, from, to, minGap = 1.7) {
  const dt = 0.12;
  const n = Math.ceil((to - from) / dt) + 1;
  const strength = new Float64Array(n);
  for (const note of notes) {
    const k = Math.round((note.t - from) / dt);
    if (k < 0 || k >= n) continue;
    const v = (note.vel - 70) / 45;                 // 力度归一
    const low = note.midi < 55 ? 1.35 : 1.0;        // 低音当鼓用
    strength[k] += Math.max(0.1, v) * low;
  }
  // 3 点平滑
  const sm = new Float64Array(n);
  for (let i = 0; i < n; i++) sm[i] = (strength[Math.max(0, i - 1)] + strength[i] + strength[Math.min(n - 1, i + 1)]) / 3;
  const peaks = [];
  let last = -1e9;
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] >= sm[i - 1] && sm[i] > sm[i + 1]) {
      const t = from + i * dt;
      if (t - last >= minGap) { peaks.push({ t: +t.toFixed(3), s: +sm[i].toFixed(3) }); last = t; }
    }
  }
  return peaks;
}

// ─────────────────────────── 组装 ───────────────────────────

const notes = readNotes(csvPath);
const lyricLines = parseLrc(lrcPath);
const dyn = JSON.parse(fs.readFileSync(dynPath, 'utf8'));

notes.sort((a, b) => a.t - b.t);
const firstNote = notes[0].t;
const lastNote = notes[notes.length - 1].t;

// 播放头：x = a·t + b（用真实音位做最小二乘拟合，同时给出残差作为可信度）
const N = notes.length;
let sx = 0, st = 0, sxt = 0, stt = 0;
for (const p of notes) { sx += p.x; st += p.t; sxt += p.x * p.t; stt += p.t * p.t; }
const A = (N * sxt - sx * st) / (N * stt - st * st);
const B = (sx - A * st) / N;
let maxRes = 0, rms = 0;
for (const p of notes) { const r = p.x - (A * p.t + B); maxRes = Math.max(maxRes, Math.abs(r)); rms += r * r; }
rms = Math.sqrt(rms / N);

// 场次覆盖检查
for (let i = 1; i < SCENES.length; i++) {
  if (Math.abs(SCENES[i].t0 - SCENES[i - 1].t1) > 1e-6) throw new Error(`场次 ${SCENES[i].id} 与上一场不连续`);
}
if (SCENES[0].t0 !== 0) throw new Error('第一场必须从 0 开始');
if (SCENES[SCENES.length - 1].t1 < lastNote) throw new Error('最后一场必须覆盖最后一颗音');

const accents = [];
for (const s of SCENES) accents.push(...findAccents(notes, s.t0, s.t1));

const doc = {
  meta: {
    title: 'STYX HELIX',
    song: 'MYTH & ROID（Re:Zero ED1）· 钢琴改编 Animenz',
    generatedBy: 'nbmachina/tools/show-build.mjs',
    generatedAt: new Date().toISOString(),
    timebase: 'master',
    timebaseNote: 't=0 = 母版开头；机器时间 = 母版 − 3.917s；第一颗音 3.917s，最后一颗 283.858s',
    noteCount: N,
    firstNoteSec: +firstNote.toFixed(3),
    lastNoteSec: +lastNote.toFixed(3),
    machineY: notes[0].y,
    noteZRange: [Math.min(...notes.map((n) => n.z)), Math.max(...notes.map((n) => n.z))],
    xRange: [Math.min(...notes.map((n) => n.x)), Math.max(...notes.map((n) => n.x))],
    playhead: {
      formula: 'x = a*t + b',
      a: +A.toFixed(4),
      b: +B.toFixed(3),
      blocksPerSec: +A.toFixed(4),
      blocksPerTick: +(A / 20).toFixed(4),
      maxResidualBlocks: +maxRes.toFixed(3),
      rmsResidualBlocks: +rms.toFixed(3),
    },
  },
  palette: PALETTE,
  scenes: SCENES,
  cues: CUES,
  accents,
  // 版权：公开仓库里**不放歌词原文**，只留每句的时间窗（t0/t1）。
  // 需要文字的场合（预演/生成视效数据）由 show-previs.mjs / show-pack.mjs 直接从本机
  // `nbaurora/lyrics/*.json` 读，不走本文件。
  lyricLines: lyricLines.map((l) => ({ t0: +l.t0.toFixed(3), t1: +l.t1.toFixed(3) })),
  levels: dyn.sections.map((s) => ({ t0: s.start, t1: s.end, level: s.level, db: s.loudnessDb, label: s.label })),
};

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(doc, null, 1), 'utf8');

console.log(`notes=${N} lyricLines=${lyricLines.length} scenes=${SCENES.length} accents=${accents.length} cues=${CUES.length}`);
console.log(`playhead x=${A.toFixed(4)}t${B >= 0 ? '+' : ''}${B.toFixed(3)} | maxres=${maxRes.toFixed(3)} rms=${rms.toFixed(3)}`);
console.log(`accents/min = ${(accents.length / ((lastNote - 0) / 60)).toFixed(1)}`);
console.log(`-> ${path.relative(ROOT, OUT)}`);
