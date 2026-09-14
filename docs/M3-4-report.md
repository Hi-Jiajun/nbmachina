# M3-4 · "音符盒还是原版声音"的完整修复（接线 + 不触发 + 粒子补回）

触发：用户 2026-09-14 15:10 实测——`/nbforge note …` 与 `/nbforge sustain …` 能听到了，
资源包也不再报不兼容，但**音符盒仍然是原版声音**。

这条症状背后是**三个独立问题**，前两个上一轮已修（提交 `459df81`、`4be901a`），本轮修第三个：

| # | 问题 | 根因 | 修法 |
|---|---|---|---|
| 1 | 资源包被判"已损坏或不兼容" | `pack.mcmeta` 缺 `min_format`/`max_format`（1.21.9+ 规定声明 >64 的格式号必须成对给） | 三件套 69（`459df81`） |
| 2 | `/nbforge note nbforge:demo_bell 1 1` 语法报错 | `<音色id>` 是"带引号字符串"参数类型 | 换 `IdentifierArgumentType`（`459df81`） |
| 3 | **开了监听也只有原版音符盒声音** | ① `styx:play/hifi/tick` 从未接线（M2-1 把它留给"根代理"后遗漏）；② 即使接线，**音符盒自己那声原版仍然会响**，与自研音色叠在一起 | ① 接线（`4be901a`）；② 本轮：`#hifi=1` 时数据包**不触发**音符盒 + 用粒子命令补回音符粒子 |

---

## 1. 本轮改动

### 1.1 `#hifi=1` 时不再触发音符盒（`src/emit/datapack-playback.mjs`）

```mcfunction
# 改造前（无论什么模式都触发 → 原版声音一直在）
execute if score #t styx.t matches 0 run setblock 480 86 -160 minecraft:redstone_block
execute if score #t styx.t matches 0 run setblock 480 86 -160 minecraft:air
# 现在（#hifi=1 = 自研音色模式 → 跳过触发；灯与 #hits 计数照旧）
execute if score #t styx.t matches 0 unless score #hifi styx.flag matches 1 run setblock 480 86 -160 minecraft:redstone_block
execute if score #t styx.t matches 0 unless score #hifi styx.flag matches 1 run setblock 480 86 -160 minecraft:air
```

**踩坑（值得记）**：`execute … run unless … run …` 是**非法语法**——条件必须写在 `run` 之前。
第一版把条件插到了 `guard` 变量末尾（它本身以 `run` 结尾），结果 e2e 报
`331 条 Failed to load function`、`#hits 增量 0`，整条播发链失效。判据：`play/lo/b000.mcfunction` 首行。

### 1.2 音符粒子补回（`src/emit/playsound-hifi.mjs`）

不触发音符盒就没有 vanilla 的音符粒子，所以 hifi 表里每条音符补一行
（位置/参数对齐 vanilla 的 `addParticleClient(NOTE, x+0.5, y+1.2, z+0.5, note/24, 0, 0)`）：

```mcfunction
execute if score #ht styx.t matches 0 run particle minecraft:note 480.5 85.2 -159.5 0.375 0 0 1 1 normal
```

同样是坑：`particle` 的 `<count>` 不能省（漏写 → 整个函数加载失败，实测 662 条）。

### 1.3 静音采样（`src/synth/assets/silent.ogg` + 资源包里的 `nbforge:silent`）

为"用 mod 直接把音符盒声音替换掉"的路线预留（见 §3）。0.05 秒静音，3.5 KB。

---

## 2. 验收

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 全量单测 | 全绿 | **252 / 252** | 通过 |
| 无头 e2e（20 tps / 600 刻，`#hifi=1`） | 触发差 0、0 加载错误、MSPT ≤ 50 | `#hits 295/295`、钢琴 110/110、贝斯 185/185、`Failed to load function 0`、**MSPT 7.5 ms** | 通过 |
| **自研音色链真的在每刻触发** | 增量 = 音符数 | **295 / 295**（接线前恒为 0） | 通过 |
| **hifi 模式下音符盒确实没被触发** | 触发器位置仍为空气 | 抽查 3 处 **✔✔✔**（开播后复查） | 通过 |
| 静态自检 | 无悬空引用/无 tick rate/note 合法 | `lint-pack` 通过（788 函数 / 140344 行） | 通过 |
| 产物同步 | 客户端拿到新数据包/资源包/mod | 存档 `pack_structures=196`；客户端 `nbforge_resources.zip` 2196192 B、`nbforge-0.1.0.jar` 17502 B | 通过 |
| 听感 | 机器响的是自研音色、不再混原版 | **未验证：需要你的耳朵** | 待你确认 |

复现：

```powershell
cd C:\Users\hiliang\Documents\minecraft\nbforge
node src/emit/datapack-playback.mjs; node src/emit/playsound-hifi.mjs; node src/emit/lint-pack.mjs
node src/test/run-headless.mjs --mode lo --ticks 600     # 9 项全绿
```

### 用户侧用法（语义现在是明确的两档）

| 操作 | 听到什么 |
|---|---|
| `/function styx:play/monitor_hifi_on` + `/function styx:play/start` | **自研音色**（strings/bell/bass，按每音力度）；音符盒**不发声**；粒子由命令补，灯照旧 |
| `/function styx:play/monitor_hifi_off`（或什么都不做） | **原版音符盒**（实体发声，站近了听最自然） |

---

## 3. 被放弃的路线：mod 侧 mixin 替换（证据与后续）

更"正统"的后端 A 做法是让 mod 把音符盒自己的声音换成 `nbforge:silent`（方块本体照常触发、
粒子由方块生成、声音再按每音力度播）。本轮试了，**卡在 refmap**，如实记录：

1. 挂 `getCustomSound(World, BlockPos)`：javap 显示它在 `onSyncedBlockEvent` 里**只在
   `NoteBlockInstrument.hasCustomSound()==true`** 时被调用（`ifeq 127`），而 harp/bass 都是 false
   → 注入点永远走不到（第一版"编译通过、运行毫无反应"）。
2. 改挂 `onSyncedBlockEvent` 里**唯一**那处
   `World#playSound(Entity,DDD,RegistryEntry,SoundCategory,FFJ)`（粒子在偏移 82、播放在 182，
   重定向它可保住粒子）：Mixin 调试日志确认
   `Mixing NoteBlockMixin from nbforge.mixins.json into net.minecraft.class_2428` ✓，
   但没有任何一次替换发生。
3. 排查到产物里**没有 refmap**（Loom 未跑 Mixin AP；加了 `loom { mixin { defaultRefmapName = … } }`
   也没生成），而运行时是 intermediary 名字（日志 `Mixin Subsystem … Env=SERVER`、
   `mixin.env.remapRefMap: false`）→ Yarn 方法名翻不过去，注入不生效（且不报错，是静默失效）。
4. 顺带确认：`ServerWorld`（偏移 322）确实会调 `processSyncedBlockEvents()`，
   所以音符盒事件**服务端会处理**，mixin 路线本身可行，只缺 refmap。

**结论**：本轮先用不依赖 mixin 的数据包方案（可用、可无头验收）；mixin 路线等补上 refmap
（给 `build.gradle` 加 mixin AP，或手写 `nbforge-refmap.json`）后再启用，届时可把粒子交回方块本体、
去掉数据包里的粒子命令。`nbforge:silent` 与 `NbforgeFlags`（读 `#hifi` 的约定）已留在仓库里，接上即可用。

---

## 4. 下一步

1. 你在游戏里听两档（开/关监听）各 10 秒：自研音色是否可接受、内声部要不要换音色、打击乐与力度是否更像原曲。
2. 若监听模式听感 OK，可把 `#hifi` 默认打开（`play/start` 里自动开），不用每次手敲。
3. mixin 路线（§3）修好后可去掉"不触发音符盒"的取舍：声音回荡在方块位置、粒子自带。
4. 仍待办：`undo` clone 版无头断言、录音对齐的人耳验收闭环、代码审查与性能优化。
