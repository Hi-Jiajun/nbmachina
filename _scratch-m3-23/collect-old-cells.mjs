// M3-23 · 收集"历史上可能摆过音符盒的全部 (step,row)"，供 note-blocks.mjs --old 清场。
// 为什么：机器换谱面时旧坐标必须清掉，否则世界里会剩下一堆永不触发的装饰方块。
// 做法：把历次部署过的谱面 CSV 的 step/row 并集写成一个只含 step,row,instrument 的 CSV。
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const FILES = [
  'machine_pipeline_video_phrase.csv',   // M3-20/21/22 部署过（力度乐句级）
  'machine_pipeline_video_measured.csv', // 逐音档（同期部署过）
  'machine_pipeline_video.csv',
  'machine_pipeline.csv',
  'machine_pipeline_velocity.csv',
  'machine_final.csv',
  'machine_from_reference.csv',          // M3-23（本次）
  'machine_ref_dyn.csv',                 // M3-25（实测力度版）
  'machine_ref_vel.csv',
  'machine_nocap.csv',
  'machine_nocap_dyn.csv',
];
const cells = new Set();
for (const f of FILES) {
  const p = `${B}/${f}`;
  if (!fs.existsSync(p)) { console.log(`跳过（不存在）${f}`); continue; }
  const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const h = lines[0].split(',');
  const iStep = h.indexOf('step'), iRow = h.indexOf('row');
  let n = 0;
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    const step = Number(c[iStep]), row = Number(c[iRow]);
    if (!Number.isFinite(step) || !Number.isFinite(row)) continue;
    cells.add(`${step},${row}`);
    n++;
  }
  console.log(`${f}: ${n} 行`);
}
const out = [`step,row,instrument`, ...[...cells].map((k) => `${k},harp`)];
fs.writeFileSync(`${B}/old_cells_union.csv`, out.join('\n') + '\n', 'utf8');
console.log(`写出 ${B}/old_cells_union.csv：${cells.size} 个去重格位`);
