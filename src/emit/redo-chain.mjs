// 生成「一条命令跑完全部」的链式函数：/function styx:redo
// 它用 /schedule 串联：修地形(第3批) → 分三段强加载并换 v3 音符 → 开监听 → 开始播放
import fs from 'node:fs';

const DP = 'C:/Users/hiliang/Documents/minecraft/build/styx_build/data/styx/function';
fs.mkdirSync(`${DP}/redo`, { recursive: true });

const w = (name, lines) => fs.writeFileSync(`${DP}/${name}`, lines.join('\n') + '\n', 'utf8');

// 第 0 步（用户敲的那一条）：先强加载第 3 批（东段）并修地形
w('redo.mcfunction', [
  'tellraw @a {"text":"[Styx] 开始重做：① 修地形 → ② 换 v3 音符 → ③ 开监听并播放（全程约 1 分钟，请勿离开太远）","color":"gold"}',
  'forceload remove all',
  'forceload add 2352 -176 2839 -136',
  'schedule function styx:redo/s1 120t',
]);

// ① 修地形（第 3 批：削槽 + 铺爬坡段）
w('redo/s1.mcfunction', [
  'function styx:flat_build_v2c',
  'forceload remove all',
  'forceload add 480 -176 1103 -136',
  'schedule function styx:redo/s2 120t',
]);

// ② 换 v3 音符（第 1 批：x480..1103）
w('redo/s2.mcfunction', [
  'function styx:apply_notes_v3',
  'forceload remove all',
  'forceload add 1104 -176 2359 -136',
  'schedule function styx:redo/s3 200t',
]);

// ③ 换 v3 音符（第 2 批：x1104..2359）
w('redo/s3.mcfunction', [
  'function styx:apply_notes_v3',
  'forceload remove all',
  'forceload add 2352 -176 2880 -136',
  'schedule function styx:redo/s4 200t',
]);

// ④ 换 v3 音符（第 3 批：东段，含爬坡部分）+ 开监听 + 开始播放
w('redo/s4.mcfunction', [
  'function styx:apply_notes_v3',
  'forceload remove all',
  'scoreboard objectives add styx.flag dummy',
  'scoreboard players set #mon styx.flag 1',
  'tellraw @a {"text":"[Styx] 重做完成：地形已修、音符已换 v3、监听已开 —— 3 秒后开始播放","color":"gold"}',
  'schedule function styx:play/start 60t',
]);

console.log('已生成: styx:redo （以及 redo/s1..s4）');
