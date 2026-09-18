// M3-24 探针：用户指出的两处 —— ① 2:47 双击感 ② 4:37 不该出现的低音
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const OFF = 3.904;
const j = JSON.parse(fs.readFileSync(`${B}/ref_video_transcription.json`, 'utf8'));

console.log('=== 踏板段（机器时间 > 250s）');
for (const p of j.pedal_events) {
  const on = p.on - OFF, off = p.off - OFF;
  if (off > 250) console.log(`   ${on.toFixed(2)} → ${off.toFixed(2)}  (${(off - on).toFixed(2)}s)`);
}

const n = j.note_events.map((x) => ({ ...x, t: x.onset - OFF }));
const low = n.filter((x) => x.midi <= 40);
console.log(`\n=== midi<=40（G#2 以下）的音：${low.length} 颗 / 共 ${n.length}`);
const byM = {};
for (const x of low) byM[x.midi] = (byM[x.midi] ?? 0) + 1;
console.log('   按音高：' + Object.entries(byM).sort((a, b) => +a[0] - +b[0]).map(([k, v]) => `${k}:${v}`).join('  '));
console.log('   出现位置：' + low.map((x) => `${x.midi}@${x.t.toFixed(1)}`).join(' '));

// 八度重复（模型常把一颗低音听成基频 + 八度）
const dup = [];
for (let a = 0; a < n.length; a++) {
  for (let b = a + 1; b < n.length; b++) {
    const d = n[b].t - n[a].t;
    if (d > 0.08) break;
    if (Math.abs(n[a].midi - n[b].midi) === 12) dup.push([n[a], n[b]]);
  }
}
console.log(`\n=== 80ms 内的"八度重复"对：${dup.length}`);
console.log('   例：' + dup.slice(0, 10).map(([a, b]) => `${a.midi}+${b.midi}@${a.t.toFixed(2)}`).join('  '));
const dupLow = dup.filter(([a, b]) => Math.min(a.midi, b.midi) <= 45);
console.log(`   其中含 midi<=45 低音的：${dupLow.length} 对`);
console.log('   ' + dupLow.slice(0, 15).map(([a, b]) => `${a.midi}+${b.midi}@${a.t.toFixed(2)}`).join('  '));

// 结束段：每颗音的"键按"vs"实际发声"
console.log('\n=== 261s 之后每颗音的 键按 / 发声（只列前 12 颗）');
for (const x of n.filter((y) => y.t > 261).slice(0, 12)) {
  const key = x.offset - x.onset;
  const po = (() => {
    for (const p of j.pedal_events) if (x.offset >= p.on && x.offset < p.off) return p.off - OFF;
    return null;
  })();
  console.log(`   t=${x.t.toFixed(2)} midi=${x.midi} 键按=${key.toFixed(2)}s 松键时踏板抬起=${po === null ? '（没踩）' : po.toFixed(2) + 's'}`);
}
