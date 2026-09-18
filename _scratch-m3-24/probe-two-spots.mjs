// 用户点名的两处：2:47（=167s，若按视频时间则是机器 163s）与 4:37（=277s / 273s）
// 目标：找出"双击"（同音高近距离重复 / 八度重复）与"不该出现的低音"到底对应谱面里哪几颗音
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const OFF = 3.904;
const j = JSON.parse(fs.readFileSync(`${B}/ref_video_transcription.json`, 'utf8'));
const n = j.note_events.map((x) => ({ ...x, t: x.onset - OFF }));

const win = (a, b, label) => {
  const w = n.filter((x) => x.t >= a && x.t < b).sort((p, q) => p.t - q.t);
  console.log(`\n=== ${label}（机器 ${a}–${b}s，视频 ${(a + OFF).toFixed(1)}–${(b + OFF).toFixed(1)}s）共 ${w.length} 颗`);
  for (const x of w) console.log(`   t=${x.t.toFixed(3)} midi=${x.midi} 键按=${(x.offset - x.onset).toFixed(3)}s vel=${x.velocity.toFixed(0)}`);
};

for (const [a, b, label] of [
  [165.0, 170.0, '机器 165–170s（文件里的 2:45–2:50）'],
  [161.0, 166.0, '机器 161–166s（视频 2:45–2:50 对应）'],
  [273.0, 279.5, '机器 273–279.5s（视频 4:37 附近）'],
  [275.5, 279.0, '机器 275.5–279s（文件里的 4:37 附近）'],
]) win(a, b, label);

console.log('\n=== 近距离重复 / 八度重复（全曲扫描，间隔 ≤80ms）');
const byPitch = [];
for (let i = 0; i < n.length; i++) {
  for (let k = i + 1; k < n.length; k++) {
    const dt = n[k].t - n[i].t;
    if (dt > 0.08) break;
    const d = Math.abs(n[i].midi - n[k].midi);
    if (d === 0) byPitch.push(['同音', n[i], n[k], dt]);
    else if (d === 12) byPitch.push(['八度', n[i], n[k], dt]);
  }
}
const near = (x, ts) => ts.some((t) => Math.abs(x - t) < 3);
const interesting = byPitch.filter(([, a]) => near(a.t, [167, 163, 277, 273]));
console.log(`  全曲 ${byPitch.length} 对；落在两处时间窗附近的：${interesting.length} 对`);
for (const [kind, a, b, dt] of interesting) {
  console.log(`   ${kind} ${a.midi}+${b.midi} @机器 ${a.t.toFixed(3)}（间隔 ${(dt * 1000).toFixed(0)}ms）vel=${a.velocity.toFixed(0)}/${b.velocity.toFixed(0)}`);
}
