// 一键回退（不依赖任何外部扫描）：用 /clone 把每条轨道"改之前的样子"复制到该轨道正上方 +40 格。
// 为什么这样最好：clone 在游戏内完成，任何存档都适用（包括用户的 1.65GB 世界），
// 也不用把前像存成 1 万条 setblock；每条轨道 48×4×25 = 4800 格（< /clone 上限 32768），49 条共 49 条指令。
// 产出 styx:backup（改之前跑）与 styx:undo（要回退时跑）。
import fs from 'node:fs';

const B = process.env.NBFORGE_BUILD ?? 'C:/Users/hiliang/Documents/minecraft/build';
const DP = `${B}/styx_build/data/styx/function`;
const profile = JSON.parse(fs.readFileSync(`${B}/single_row_profile.json`, 'utf8'));

const backup = ['# 由 src/emit/undo-clone.mjs 生成：改轨道之前先跑，把每条轨道当前的样子存到轨道上方 +40 格'];
const undo = ['# 由 src/emit/undo-clone.mjs 生成：把每条轨道逐格还原成 styx:backup 时的样子'];
// 必须分窗口！redo 链是"一段强加载 → 改这一段"，一次 clone 全部 49 条会因区块未加载而静默失败。
// 窗口与 redo 链/播放器一致：480..1103 / 1104..2359 / 2352..2880。
const WINDOWS = [[480, 1103], [1104, 2359], [2352, 2880]];
const winOf = (x) => WINDOWS.findIndex(([a, b]) => x >= a && x <= b + 47);
const parts = [[], [], []];
let n = 0;
for (const r of profile) {
  const x0 = r.x0, x1 = r.x0 + 47, y0 = r.y - 1, y1 = r.y + 2;
  const w = winOf(x0);
  if (w < 0) continue;
  parts[w].push({ x0, x1, y0, y1 });
  n++;
}
fs.mkdirSync(`${DP}/undo`, { recursive: true });
parts.forEach((list, i) => {
  const b = [`# 窗口 ${i + 1}（x ${WINDOWS[i][0]}..${WINDOWS[i][1]}）：${list.length} 条轨道的回退快照`];
  const u = [`# 窗口 ${i + 1}：回退 ${list.length} 条轨道`, 'forceload remove all', `forceload add ${WINDOWS[i][0]} -176 ${WINDOWS[i][1] + 47} -136`];
  for (const t of list) {
    b.push(`clone ${t.x0} ${t.y0} -169 ${t.x1} ${t.y1} -145 ${t.x0} ${t.y0 + 40} -169`);
    u.push(`clone ${t.x0} ${t.y0 + 40} -169 ${t.x1} ${t.y1 + 40} -145 ${t.x0} ${t.y0} -169`);
  }
  b.push(`tellraw @a {"text":"[Styx] 已保存回退快照（窗口 ${i + 1}，${list.length} 条轨道）","color":"gray"}`);
  u.push(`tellraw @a {"text":"[Styx] 已回退窗口 ${i + 1}（${list.length} 条轨道逐格还原）","color":"gold"}`);
  fs.writeFileSync(`${DP}/undo/backup${i + 1}.mcfunction`, b.join('\n') + '\n', 'utf8');
  fs.writeFileSync(`${DP}/undo/restore${i + 1}.mcfunction`, u.join('\n') + '\n', 'utf8');
});
// 入口：备份由 redo 链按窗口调用；回退自己按窗口 + 60 刻间隔调度
fs.writeFileSync(`${DP}/undo.mcfunction`, [
  'tellraw @a {"text":"[Styx] 开始回退（3 个窗口依次还原，约 6 秒）","color":"gold"}',
  'schedule function styx:undo/restore1 20t',
  'schedule function styx:undo/restore2 80t',
  'schedule function styx:undo/restore3 140t',
].join('\n') + '\n', 'utf8');
console.log(`undo/{backup,restore}{1,2,3}.mcfunction：${n} 条轨道（每窗口 ${parts.map((p) => p.length).join('/')} 条，每条 4800 格）+ styx:undo 入口`);
