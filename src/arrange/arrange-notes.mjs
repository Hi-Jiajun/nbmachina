// v3 音符数据：
//  ① 音高：按声部整体折叠（保留音程、保留原调），贝斯用 0..12 行、旋律用 13..25 行
//  ② 时间：step → tick = step×2（150 BPM，正好是 MC 的整数刻网格）——修掉 2.4 刻的抖动
//  ③ 力度：从原曲 WAV 的对应位置取响度（0.35~1.0）——监听/后续模组用
import fs from 'node:fs';
import { resolvePaths } from '../core/paths.mjs';

// M2-3：路径走 paths.mjs
const P = resolvePaths();
const B = P.build;
const DP = P.functionsDir;

/* ---------- 读旧 CSV ---------- */
const rows = fs.readFileSync(P.notes, 'utf8').trim().split(/\r?\n/).slice(1)
  .map((l) => { const [step, time, instr, midi, pitch, shift] = l.split(','); return { step: +step, t: +time, instr, midi: +midi, oldPitch: +pitch, shift: +(shift ?? 0) }; });
console.log('原始音符:', rows.length);

/* ---------- ① 音高：按声部分别折叠（保留音程 + 原调） ---------- */
// 全音域 0..25 贪心折叠：每个音取"离同声部上一个音最近"的八度（保留旋律走向），音级保持原调
const cursors = { bass: 8, harp: 18 };     // 各声部的起始参考位置
for (const r of rows.sort((a, b) => a.step - b.step || a.midi - b.midi)) {
  const voice = r.instr === 'bass' ? 'bass' : 'harp';
  const pc = ((r.midi % 12) + 12) % 12;
  const cands = [];
  for (let p = pc; p <= 24; p += 12) cands.push(p);   // 音符盒 note 属性上限 24（不是 25！）
  if (!cands.length) cands.push(pc);
  const prev = cursors[voice];
  const pick = prev === null ? cands.reduce((a, b) => Math.abs(b - cursors[voice]) < Math.abs(a - cursors[voice]) ? b : a)
                             : cands.reduce((a, b) => Math.abs(b - prev) < Math.abs(a - prev) ? b : a);
  cursors[voice] = pick;
  r.pitch = pick; r.voice = voice;
}

/* ---------- ② 时间：按原曲（125 BPM，0.12 秒/步），播放时把刻率提到 100 → 0.12 秒 = 12 刻（精确） ---------- */
const PLAY_TPS = 100;                      // 播放期间的刻率（/tick rate 100）
const SEC_PER_STEP = 0.12;                 // 原曲：0.12 秒 = 一个十六分音符（125 BPM）
for (const r of rows) {
  r.tick = Math.round(r.step * SEC_PER_STEP * PLAY_TPS);   // 100 tps 下 = 每步 12 刻，完全精确
  r.time150 = r.tick / PLAY_TPS;
}
const lastTick = Math.max(...rows.map((r) => r.tick));
console.log(`时间轴: 原曲 ${SEC_PER_STEP} 秒/步（125 BPM），播放刻率 ${PLAY_TPS} tps（每步 12 刻，精确）`);
console.log(`         全长 ${(lastTick / PLAY_TPS / 60).toFixed(2)} 分钟（原曲 4:41），总刻数 ${lastTick}`);

/* ---------- ③ 力度：从原曲 WAV 取响度 ---------- */
const wav = fs.readFileSync(P.audio);
let q = 12, fmt = null, dataOff = 0, dataLen = 0;
while (q + 8 <= wav.length) {
  const id = wav.toString('ascii', q, q + 4), size = wav.readUInt32LE(q + 4);
  if (id === 'fmt ') fmt = { ch: wav.readUInt16LE(q + 10), sr: wav.readUInt32LE(q + 12), bits: wav.readUInt16LE(q + 22) };
  if (id === 'data') { dataOff = q + 8; dataLen = size; }
  q += 8 + size + (size % 2);
}
function rmsAt(t) {
  const n = Math.floor(fmt.sr * 0.12);
  let sum = 0, cnt = 0;
  const base = dataOff + Math.floor(t * fmt.sr) * fmt.ch * (fmt.bits / 8);
  for (let i = 0; i < n; i++) {
    const idx = base + i * fmt.ch * (fmt.bits / 8);
    if (idx + 1 >= dataOff + dataLen) break;
    const v = wav.readInt16LE(idx) / 32768;
    sum += v * v; cnt++;
  }
  return cnt ? Math.sqrt(sum / cnt) : 0;
}
const raw = rows.map((r) => rmsAt(r.t));                 // 用原曲时间（0.12s/步）取样
const sorted = raw.slice().sort((a, b) => a - b);
const p10 = sorted[Math.floor(sorted.length * 0.1)], p90 = sorted[Math.floor(sorted.length * 0.9)];
for (let i = 0; i < rows.length; i++) {
  const v = (raw[i] - p10) / Math.max(1e-6, p90 - p10);
  rows[i].vol = Math.max(0.35, Math.min(1.0, 0.35 + v * 0.65));
}
console.log(`力度: p10=${p10.toFixed(3)} p90=${p90.toFixed(3)} → 映射到 0.35~1.0`);
console.log('力度分布示例:', rows.slice(0, 8).map((r) => r.vol.toFixed(2)).join(' '));

/* ---------- 写 v3 CSV ---------- */
rows.sort((a, b) => a.tick - b.tick || a.pitch - b.pitch);
fs.writeFileSync(P.notesV3,
  'step,tick,time_seconds,instrument,midi,row,volume\n' +
  rows.map((r) => `${r.step},${r.tick},${r.time150.toFixed(3)},${r.voice},${r.midi},${r.pitch},${r.vol.toFixed(3)}`).join('\n') + '\n', 'utf8');

/* ---------- 抽查：开头几个音 ---------- */
console.log('\n开头 8 个音（旧 → 新）:');
for (const r of rows.slice(0, 8)) console.log(`  midi ${r.midi} (${r.voice}) 旧音高 ${r.oldPitch} → 新音高 ${r.pitch}  力度 ${r.vol.toFixed(2)}`);
console.log('\n前两个贝斯音的音程检查: midi 33→35 应仍相差 2 个半音');
const b0 = rows.filter((r) => r.voice === 'bass').slice(0, 2);
console.log(`  新音高 ${b0[0].pitch} → ${b0[1].pitch}（差 ${Math.abs(b0[1].pitch - b0[0].pitch)} 个半音）`);

/* ---------- 生成"改写音符层"的函数 ---------- */
const profile = JSON.parse(fs.readFileSync(P.profile, 'utf8'));
const lines = ['# 把机器上的音符按 v3 数据重排（移动到新音高行 + 更新音色/音高，清掉旧位置）'];
let moved = 0;
for (const r of rows) {
  const k = Math.floor(r.step / 48), lx = r.step % 48;
  if (k > 48) continue;
  const pr = profile[k];
  const x = pr.x0 + lx, y = pr.y;
  const zNew = -172 + r.pitch + 3;
  const zOld = -172 + r.oldPitch + 3;
  if (zOld !== zNew) {
    lines.push(`setblock ${x} 85 ${zOld} minecraft:air`);
    lines.push(`setblock ${x} ${y - 1} ${zOld} minecraft:air`);            // 旧灯位清掉
  }
  lines.push(`setblock ${x} 84 ${zNew} ${r.voice === 'bass' ? 'minecraft:oak_planks' : 'minecraft:sand'}`);
  lines.push(`setblock ${x} 85 ${zNew} minecraft:note_block[instrument=${r.voice},note=${r.pitch},powered=false]`);
  lines.push(`setblock ${x} ${y - 1} ${zNew} minecraft:redstone_lamp[lit=false]`);   // 灯跟着新音高走
  moved++;
}
fs.writeFileSync(`${DP}/apply_notes_v3.mcfunction`, lines.join('\n') + '\n', 'utf8');
console.log(`\napply_notes_v3.mcfunction: ${moved} 个音符，${lines.length - 1} 条指令`);
