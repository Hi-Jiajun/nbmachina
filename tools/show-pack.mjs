#!/usr/bin/env node
/**
 * M5 视效 · 游戏内 v1 数据包生成器（ExParticle `particlex` 命令，服务端函数直接发）
 * 用法：node tools/show-pack.mjs --tps 100 --out "<存档>/datapacks/styxshow"
 * v1 内容：开场标题 / 河 / 逐音心跳（描边方块+涟漪+火花） / 重音冲击环 / 逐字歌词
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const TPS = +arg('tps', '100');
const OUT = arg('out', path.join(ROOT, 'nbmachina', 'build', 'styxshow'));
const JSON_OUT = arg('json', null);          // 只写 mod 用的 show.json（方案 A：/nbm machine start 一条命令）
const TTML_DATA = arg('ttml', path.join(ROOT, '_scratch-m3-80', 'styx_ttml_master.json'));   // TTML 基座（对齐后的逐字）
const TEXT_MATRIX = '(0,1,0,0,,0,0,0,0,,-1,0,0,0,,0,0,0,1)';   // 平铺在水面：读向=+x、字上=−z（与预演里验证过的朝向一致）
const DPB = 8;        // text 的 dpb = 每格几个字体像素
const LINE_W = 20;    // 一行最多占几格（机器那条水面宽 25 格）
const D = path.join(OUT, 'data', 'styxshow', 'function');
const TAG = path.join(OUT, 'data', 'minecraft', 'tags', 'function');
const MODE = TPS >= 50 ? 'hi' : 'lo';

const csv = fs.readFileSync(path.join(ROOT, 'build', 'nbmachina_machine_map.csv'), 'utf8').trim().split(/\r?\n/);
const H = csv[0].split(','), I = (k) => H.indexOf(k);
const NOTE = csv.slice(1).map((l) => { const f = l.split(','); return { x: +f[I('x')], y: +f[I('y')], z: +f[I('z')], midi: +f[I('midi')], vel: +f[I('velocity')], bass: f[I('voice')] === 'bass', t: +f[I('time_sec')] }; });
const SHOW = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'show', 'styx_helix.show.json'), 'utf8'));
const LY = JSON.parse(fs.readFileSync(path.join(ROOT, 'nbaurora', 'lyrics', 'styx_helix.final.master.json'), 'utf8')).lines;
const PH = (t) => SHOW.meta.playhead.a * t + SHOW.meta.playhead.b;
const T = (sec) => Math.round(sec * TPS);
const col = (n) => (n.bass ? '0.47,0.36,1.00' : n.midi > 78 ? '0.90,0.95,1.00' : '0.55,0.90,0.92');

const byTick = new Map();
const push = (tick, line) => { if (tick < 0) return; if (!byTick.has(tick)) byTick.set(tick, []); byTick.get(tick).push(line); };
const esc = (s) => s.replace(/"/g, '\\\\"');

// ① 河：一条恒速光流（前沿 = cpt×step = 0.4167 格/客户端刻 = 播放头速度）
// ⚠ 语法坑（2026-09-24 实测）：color4 / speed3 / range3 是**空格分隔**（源码 examples: "0 0 0 1" / "0 0 0" / "1 1 0"）；
//   写成逗号会被 Brigadier 拒掉，而且 silent source 会把它吞掉（日志看着"失败 0 条"却一个粒子都没有）。
//   表达式内部的元组（cr,cg,cb=...）仍然是逗号。
push(0, `particlex tick-parameter end_rod 2 110.2 2.5 0.15 0.86 0.80 0.30 0 0 0 0 2400 "x,y,z=t,0.15*sin(t/4),sin(t/9)*1.2" 0.0833 5 26`);
// ② 螺旋：两条反向缠绕的光带（绕机器轴，半径 5.5，轴高 117）
for (const ph of [0, 3.1416]) {
  push(0, `particlex tick-polar-parameter end_rod 2 117 2.5 0.47 0.36 1.0 0.45 0 0 0 0 2400 "s1=t*0.62+${ph}; s2=1.5708; dis=5.5" 0.12 3 40`);
}
// ③ 开场标题 + 下划线（3.917s 之前）
push(0, `particlex text end_rod 14 116.5 2.5 "STYX HELIX" 5.0 "(x,y,z)=(x,y,z,1)*rotate(0,PI/2,0)" 8.0 0 0 0 120`);
push(T(1.0), `particlex text end_rod 20 115.2 2.0 "MYTH & ROID" 3.0 "(x,y,z)=(x,y,z,1)*rotate(0,PI/2,0)" 8.0 0 0 0 110`);

// ④ 逐音心跳：描边方块（12 棱，等比放大）+ 表面涟漪 + 火花（力度 ≥ 90）
for (const n of NOTE) {
  const t = T(n.t), cx = n.x + 0.5, cy = n.y + 1.5, cz = n.z + 0.5, c = col(n);
  push(t, `particlex custom-conditional end_rod ${cx} ${cy} ${cz} "size=6; cr,cg,cb=${c}; alpha=0.92; age=28; light=1.0" 0.5 0.5 0.5 "abs(abs(x)-0.5)<0.01&abs(abs(y)-0.5)<0.01|abs(abs(x)-0.5)<0.01&abs(abs(z)-0.5)<0.01|abs(abs(y)-0.5)<0.01&abs(abs(z)-0.5)<0.01" 0.25 "(vx,vy,vz)=(dx,dy,dz)*0.11/(1+t/9); alpha=0.92*(1-t/27)" 1.0 nbs`);
  push(t, `particlex custom-polar-parameter end_rod ${cx} ${cy - 0.5} ${cz} 0 6.2832 "s1=t; s2=0; dis=0.5; size=5; cr,cg,cb=0.15,0.86,0.80; alpha=0.9; age=30; light=1.0" 0.1 "(vx,vy,vz)=(dx,dy,dz)*0.12/(1+t/10); alpha=0.9*(1-t/29)" 1.0 nbs`);
  if (n.vel >= 90) push(t, `particlex custom-normal end_rod ${cx} ${cy} ${cz} "size=2.5; cr,cg,cb=0.92,0.96,1.0; alpha=0.95; age=26; light=1.0; vx=(random()-0.5)*0.16; vy=random()*0.22; vz=(random()-0.5)*0.16; gravity=0.06; friction=0.96" 0.15 0.15 0.15 14`);
}
// ⑤ 重音冲击环（横向铺开）
for (const a of SHOW.accents) {
  push(T(a.t), `particlex custom-polar-parameter end_rod ${PH(a.t) + 0.5} 110.05 2.5 0 6.2832 "s1=t; s2=0; dis=0.6; size=4; cr,cg,cb=0.15,0.86,0.80; alpha=0.5; age=32; light=1.0" 0.08 "(vx,vy,vz)=(dx,dy,dz)*0.42/(1+t/6); alpha=0.5*(1-t/31)" 1.0 nbs`);
}
// ⑥ 逐字歌词（每字一条；骑流 vx=0.4167；唱到哪亮到哪 = AMLL 的填充）
const jchars = [];
for (const l of LY) {
  let z = 2.5 + 3.0;
  for (const ch of l.chars ?? []) {
    if (ch.k === 'translation') continue;
    const isA = ch.c.codePointAt(0) <= 0x7e;
    const dur = Math.max(0.12, ch.e - ch.s), age = Math.ceil((l.end - ch.s + 0.7) * 20);
    const dz = `${(z).toFixed(2)}`;
    jchars.push({ t: +ch.s.toFixed(3), c: ch.c, z: +z.toFixed(2), age, dur: +dur.toFixed(3), scale: isA ? 2.6 : 3.4 });
    push(T(ch.s), `particlex text end_rod ${(PH(ch.s) + 6).toFixed(2)} 118.5 ${dz} "${esc(ch.c)}" 2.6 "(x,y,z)=(x,y,z,1)*rotate(0,PI/2,0)*scale(${isA ? 1 : 1.6},${isA ? 1 : 1.6},1)" 8.0 0 0 0 ${age} "vx=0.4167; cr,cg,cb=lerp(clamp(t/${Math.round(dur * 20)},0,1),0.30,1.0),lerp(clamp(t/${Math.round(dur * 20)},0,1),0.45,0.96),lerp(clamp(t/${Math.round(dur * 20)},0,1),0.50,1.0); alpha=0.5+0.5*clamp(t/${Math.round(dur * 20)},0,1)" 1.0 nblyr`);
    z -= (isA ? 0.62 : 1.0) * 1.9;
  }
}

// mod 侧（方案 A）用：重音时间 + 逐字歌词（v2：TTML 基座 + 每行翻译 + 平铺矩阵）
if (JSON_OUT) {
  const ttml = JSON.parse(fs.readFileSync(TTML_DATA, 'utf8'));
  const lines = ttml.lines.map((l) => {
    // 一行最多占 LINE_W 格：用字体像素宽度估总宽，超了就整体缩小
    const wpx = l.chars.reduce((a, c) => a + (c.c.codePointAt(0) > 0x7e ? 5.2 : 3.0) * 3.0, 0);
    const scale = Math.min(3.0, (LINE_W * DPB) / Math.max(1, wpx) * 3.0);
    let z = 0;
    const chars = l.chars.map((c) => {
      const advPx = (c.c.codePointAt(0) > 0x7e ? 5.2 : 3.0) * scale;
      const w = +((advPx + (c.c.codePointAt(0) > 0x7e ? 3.5 : 2.5)) / DPB).toFixed(3);   // 字宽 + 字距
      const o = { t: +c.s.toFixed(3), c: c.c, w, dur: +Math.max(0.12, c.e - c.s).toFixed(3), z: +z.toFixed(3) };
      z += w;
      return o;
    });
    return { t: +l.start.toFixed(3), end: +l.end.toFixed(3), scale: +scale.toFixed(2), tr: l.translation ?? null, w: +z.toFixed(2), chars };
  });
  const doc = {
    version: 2,
    note: 'v2：逐字时间来自官方 TTML（span）+ 整体平移；含每行中文翻译；文字平铺在水面上（matrix 见 textMatrix）。由 tools/show-pack.mjs --json 生成',
    shiftSec: ttml.shiftSec,
    textMatrix: TEXT_MATRIX,
    dpb: DPB,
    lineWidthBlocks: LINE_W,
    accents: SHOW.accents.map((a) => +a.t.toFixed(3)),
    lines,
    title: { text: 'STYX HELIX', sub: 'MYTH & ROID', x: 14, y: 116.5, z: 2.5, scale: 5.0 },
  };
  fs.mkdirSync(path.dirname(JSON_OUT), { recursive: true });
  fs.writeFileSync(JSON_OUT, JSON.stringify(doc), 'utf8');
  const nChars = lines.reduce((a, l) => a + l.chars.length, 0);
  console.log(`show.json v2 -> ${JSON_OUT}（重音 ${doc.accents.length} / 行 ${lines.length} / 字 ${nChars} / 平移 ${ttml.shiftSec}s，${(fs.statSync(JSON_OUT).size / 1024).toFixed(0)} KB）`);
  if (argv.includes('--json-only')) process.exit(0);
}

// 写包
fs.rmSync(path.join(D, MODE), { recursive: true, force: true });
fs.mkdirSync(path.join(D, MODE), { recursive: true });
fs.mkdirSync(TAG, { recursive: true });
const ticks = [...byTick.keys()].sort((a, b) => a - b);
const BUCKET = 1000, bins = [];
for (const tk of ticks) { const b = Math.floor(tk / BUCKET); if (bins[b] === undefined) bins[b] = []; bins[b].push(tk); }
bins.forEach((list, b) => {
  if (!list) return;
  const out = [];
  for (const tk of list) for (const cmd of byTick.get(tk)) out.push(`execute if score #t styxshow.t matches ${tk} run ${cmd}`);
  fs.writeFileSync(path.join(D, MODE, `b${String(b).padStart(3, '0')}.mcfunction`), out.join('\n') + '\n', 'utf8');
});
const maxT = ticks.length ? ticks[ticks.length - 1] : 0;
const dispatch = bins.map((l, b) => l && `execute if score #t styxshow.t matches ${b * BUCKET}..${(b + 1) * BUCKET - 1} run function styxshow:${MODE}/b${String(b).padStart(3, '0')}`);
dispatch.push(`execute if score #t styxshow.t matches ${maxT + 1}.. run function styxshow:stop`);
fs.writeFileSync(path.join(D, MODE, 'tick.mcfunction'), dispatch.filter(Boolean).join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(D, 'tick.mcfunction'), `execute if score #on styxshow.flag matches 1 run scoreboard players add #t styxshow.t 1\nexecute if score #on styxshow.flag matches 1 run function styxshow:${MODE}/tick\n`, 'utf8');
fs.writeFileSync(path.join(D, 'start.mcfunction'), [
  'scoreboard objectives add styxshow.t dummy', 'scoreboard objectives add styxshow.flag dummy',
  'scoreboard players set #t styxshow.t -1', 'scoreboard players set #on styxshow.flag 1',
  `tellraw @a {"text":"[StyxShow] 视效 v1 启动（${TPS} tps 表）——若在 20 tps 下播放会与音乐错位，请先 /tick rate 100","color":"gold"}`,
  'nbm machine start',
].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(D, 'stop.mcfunction'), [
  'scoreboard players set #on styxshow.flag 0', 'scoreboard players set #t styxshow.t -1',
  'particlex clear-particle', 'nbm machine stop',
  'tellraw @a {"text":"[StyxShow] 已停止","color":"aqua"}',
].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(D, 'demo.mcfunction'), [
  'particlex custom-conditional end_rod ~ ~2 ~ "size=6; cr,cg,cb=0.9,0.95,1.0; alpha=0.92; age=28; light=1.0" 0.5 0.5 0.5 "abs(abs(x)-0.5)<0.01&abs(abs(y)-0.5)<0.01|abs(abs(x)-0.5)<0.01&abs(abs(z)-0.5)<0.01|abs(abs(y)-0.5)<0.01&abs(abs(z)-0.5)<0.01" 0.25 "(vx,vy,vz)=(dx,dy,dz)*0.11/(1+t/9); alpha=0.92*(1-t/27)" 1.0 nbs',
  'particlex custom-polar-parameter end_rod ~ ~2 ~ 0 6.2832 "s1=t; s2=0; dis=0.5; size=5; cr,cg,cb=0.15,0.86,0.80; alpha=0.9; age=30; light=1.0" 0.1 "(vx,vy,vz)=(dx,dy,dz)*0.12/(1+t/10); alpha=0.9*(1-t/29)" 1.0 nbs',
  'particlex text end_rod ~ ~4 ~ "字形测试 AB要" 3.0 "(x,y,z)=(x,y,z,1)*scale(1,1,1)" 8.0 0 0 0 100',
  'tellraw @a {"text":"[StyxShow] 自检：三段粒子（描边方块/涟漪/文字）","color":"gold"}',
].join('\n') + '\n', 'utf8');
fs.writeFileSync(path.join(TAG, 'tick.json'), JSON.stringify({ values: ['styxshow:tick'] }), 'utf8');
fs.writeFileSync(path.join(OUT, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 88, min_format: 88, max_format: 88, description: 'StyxHelix M5 show v1' } }), 'utf8');
console.log(`mode=${MODE} tps=${TPS} notes=${NOTE.length} lyricChars=${LY.reduce((n, l) => n + (l.chars?.length ?? 0), 0)} accents=${SHOW.accents.length}`);
console.log(`ticks=${ticks.length} bins=${bins.filter(Boolean).length} lastTick=${maxT} -> ${OUT}`);
