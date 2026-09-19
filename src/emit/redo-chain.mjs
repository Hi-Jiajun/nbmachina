// 生成「一条命令跑完全部」的链式函数：/function styx:redo（和精确模式 styx:redo_hi）
// 用 /schedule 串联：修地形 → 分段强加载并换音符 → 开监听 → 开始播放
//
// 两个入口只差一个 #hiwant：0 = 20 tps 表（默认，开箱即用），1 = 100 tps 表（需先 /tick rate 100）。
// 为什么不直接在函数里写 tick rate：函数权限等级 2 < `/tick` 需要的 3，写了整文件加载失败（实测）。
import fs from 'node:fs';
import { resolvePaths } from '../core/paths.mjs';

const DP = resolvePaths().functionsDir;
fs.mkdirSync(`${DP}/redo`, { recursive: true });

const w = (name, lines) => fs.writeFileSync(`${DP}/${name}`, lines.join('\n') + '\n', 'utf8');

const entry = (name, hiwant, title) => w(name, [
  'scoreboard objectives add styx.flag dummy',
  `scoreboard players set #hiwant styx.flag ${hiwant}`,
  `tellraw @a {"text":"[Styx] ${title}：① 修地形 → ② 换音符 → ③ 开监听并播放（全程约 1 分钟，请勿离开太远）","color":"gold"}`,
  'forceload remove all',
  'forceload add 2352 -176 2839 -136',
  'schedule function styx:redo/s1 120t',
]);

entry('redo.mcfunction', 0, '开始重做（20 tps 模式）');
entry('redo_hi.mcfunction', 1, '开始重做（100 tps 精确模式，需已执行 /tick rate 100）');

// ① 修地形（第 3 批：削槽 + 铺爬坡段）
w('redo/s1.mcfunction', [
  'function styx:flat_build_v2c',
  'forceload remove all',
  'forceload add 480 -176 1103 -136',
  'schedule function styx:redo/s2 120t',
]);

// ② 换 v3 音符（第 1 批：x480..1103）
w('redo/s2.mcfunction', [
  'function styx:undo/backup1',   // 改这个窗口之前先存回退快照（clone 到轨道上方 +40 格，见 src/emit/undo-clone.mjs）
  'function styx:apply_notes_v3',
  'forceload remove all',
  'forceload add 1104 -176 2359 -136',
  'schedule function styx:redo/s3 200t',
]);

// ③ 换 v3 音符（第 2 批：x1104..2359）
w('redo/s3.mcfunction', [
  'function styx:undo/backup2',
  'function styx:apply_notes_v3',
  'forceload remove all',
  'forceload add 2352 -176 2880 -136',
  'schedule function styx:redo/s4 200t',
]);

// ④ 换 v3 音符（第 3 批：东段，含爬坡部分）+ 开监听 + 按 #hiwant 选模式开播
w('redo/s4.mcfunction', [
  'function styx:undo/backup3',
  'function styx:apply_notes_v3',
  'forceload remove all',
  'scoreboard objectives add styx.flag dummy',
  // M3-23 / M3-38：声音锚在玩家身上（listen on = 整条机器都听得到）。
  // 注意命令名：改名（nbforge → nbmachina）后服务端命令是 **`/nbm`**，
  // 这里曾经残留 `nbmachina listen on` → 整个 s4 函数**加载失败**（日志 "Failed to load function styx:redo/s4"），
  // 于是重做链最后一步永远走不到：不 listen、不重建第三段、也**不会自动开始播放**。
  // 旧的 `/playsound` 监听层（#mon=1）会和它双响 —— 2026-09-18 用户实测"音乐完全不对"就是这两层叠在一起。
  'scoreboard players set #mon styx.flag 0',
  'nbm listen on',
  'tellraw @a {"text":"[Styx] 重做完成：地形已修、音符已换、无损引擎已接管（listen on）—— 3 秒后开始播放","color":"gold"}',
  'execute if score #hiwant styx.flag matches 1 run schedule function styx:play/start_hi 60t',
  'execute unless score #hiwant styx.flag matches 1 run schedule function styx:play/start 60t',
]);

// 单独一个「只开监听」的入口，方便手动试听
w('redo/monitor.mcfunction', [
  'scoreboard objectives add styx.flag dummy',
  'function styx:play/monitor_on',
]);

console.log('已生成: styx:redo（20 tps）、styx:redo_hi（100 tps）、styx:redo/s1..s4、styx:redo/monitor');
