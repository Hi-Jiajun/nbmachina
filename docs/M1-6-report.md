# M1-6 实测报告 · undo 前像快照（逐格还原 + 逐格对账 diff 0）

任务书：`nbforge-m1-6.md`（M1 第 4 条 / 计划里的 Task 4）。数据：`build/styx_helix_machine.csv`
（2802 颗音，机器实际用的那一版）× 无头服 `testserver`（Minecraft 1.21.10，Java 21 delta，`server.jar nogui`）。

**一句话结论**：`styx:undo` 已经从"3 行硬编码 fill"换成**逐格前像快照**：11208 格（每颗音 4 格：灯 y−1 /
甲板 y / 音符盒 y+1 / 触发位 y+2）逐格 `setblock` 还原 + 逐格 `execute unless block` 对账。
验收（铺地形 → 扫描 → `apply_notes_v3` → 手工改 3 处 → `styx:undo` → 逐格对账）**diff 0**：
`#bad = 0 / 11208`，对账结论写进了控制台日志。

但任务书里"对每格发 `data get block` 就能拿到方块 id + 状态"这条**不成立**（实测只能读方块实体），
而且存档里的方块索引是**"填充"打包**而不是紧凑打包 —— 这两个坑不解决，生成出来的 undo 是**错的**。
下面的实测记录里都有原始回包/原始数字。

---

## 0. 交付物

| 文件 | 作用 | 测试 |
|---|---|---|
| `src/emit/undo-snapshot.mjs` | 解析原始扫描日志（`[console]` 回包 + `[cell]` 前像）→ 生成 `styx:undo`（分片 `setblock`）、`styx:undo/verify`（分片 `unless block` → `#bad`）、可选 `styx:undo/where`（打印不匹配坐标）；CLI 写 `build/undo-report.json` | `tests/undo-snapshot.test.mjs`（9 条） |
| `src/scan/region-nbt.mjs` | 存档 region 只读解析 → 逐格 `{Name, Properties}`；含"紧凑/填充"两种索引打包判别、有符号 byte、区块不存在→`null`（与"空气"严格区分） | `tests/region-nbt.test.mjs`（5 条） |
| `src/scan/undo-scanner.mjs` | 无头驱动：铺地形 → 逐格 `/data get block` 扫描 → 存档前像 → **新鲜度闸门** → 生成 → `reload` → apply → 手工改 3 处 → undo → 逐格对账；`--scan-only` / `--where` 两个开关 | 靠验收本身（无单测：它要开服务器） |
| `build/undo-scan-raw.log` | 原始扫描日志：11208 条 `/data get block` 原样回包 + 11208 条前像格（22421 行） | — |
| `build/undo-report.json` | 报告：扫了多少格 / 成功多少 / 哪些格读不到或未加载 / 交叉校验 / 产物清单 / `complete` | — |
| `build/undo-accept.log` / `undo-accept.json` | 验收的**完整**服务器日志与结构化结果（含时间戳，能复盘上面每个数字） | — |
| `build/styx_build/data/styx/function/undo.mcfunction` + `undo/{p,d,w}NNN.mcfunction` | 进数据包的产物：`styx:undo` 派发 → 3 片 `setblock`（11208 行）→ `styx:undo/verify`（3 片 `unless block`，11208 行）→ 结论 | — |

用法：

```bash
# 铺地形 → 扫描 → 生成 → apply → 改 3 处 → undo → 逐格对账（约 2.5 分钟）
node src/scan/undo-scanner.mjs --notes build/styx_helix_machine.csv --terrain --where
# 只扫描 + 生成（不铺地形：前像 = 当前世界的状态；约 1 分钟）
node src/scan/undo-scanner.mjs --notes build/styx_helix_machine.csv --scan-only
# 已有原始日志、只想重新生成函数（不连服务器）
node src/emit/undo-snapshot.mjs --scan build/undo-scan-raw.log
```

游戏内：`/function styx:undo`（还原 + 自动逐格对账 + 把结论 `say` 到聊天/日志）；
`/function styx:undo/where`（只在不匹配时打印坐标，**默认不生成**，要 `--where`）。

---

## 1. 验收（任务书那一条）：apply → 手工改 3 处 → undo → diff 0

```bash
node src/scan/undo-scanner.mjs --notes build/styx_helix_machine.csv --terrain --where
```

原始输出（`build/undo-accept.log` 摘录，时间戳保留）：

```
控制台扫描：11208 格 / 5.9s，分片对不上 0 次
   前像新鲜度第 1 次：抽样 64 格一致 64；区块 263 读 / 0 缺
   [全量对账（第 1 次前像 vs 现场）] #bad = 0
      [Styx] undo 逐格对账通过：11208/11208 格与扫描前像一致（diff 0）
   >>> function styx:apply_notes_v3
   [apply_notes_v3 之后] #bad = 6413
      [Styx] undo 逐格对账不通过：#bad > 0，逐格坐标见 styx:undo/where
   >>> setblock 480 83 -160 minecraft:diamond_block      →  __DAMAGE_1_OK__
   >>> setblock 1678 83 -161 minecraft:bedrock           →  __DAMAGE_2_OK__
   >>> setblock 2800 111 -153 minecraft:gold_block       →  __DAMAGE_3_OK__
   >>> function styx:undo
   [styx:undo 之后] #bad = 0
      [Styx] undo 逐格对账通过：11208/11208 格与扫描前像一致（diff 0）
   >>> execute if block 480 83 -160 minecraft:redstone_lamp[lit=false] run say __UNDO_CELL_1_OK__   ✅
   >>> execute if block 1678 83 -161 minecraft:redstone_lamp[lit=false] run say __UNDO_CELL_2_OK__  ✅
   >>> execute if block 2800 111 -153 minecraft:air run say __UNDO_CELL_3_OK__                       ✅
```

对应的原始服务器日志行（证明不是"脚本自己说自己过了"）：

```
[03:52:48] [Server thread/INFO]: [Not Secure] [Server] [Styx] undo 逐格对账通过：11208/11208 格与扫描前像一致（diff 0）
[03:53:21] [Server thread/INFO]: [Not Secure] [Server] [Styx] undo 逐格对账不通过：#bad > 0，逐格坐标见 styx:undo/where
[03:53:30] [Server thread/INFO]: Changed the block at 480, 83, -160
[03:53:30] [Server thread/INFO]: [Not Secure] [Server] __DAMAGE_1_OK__
[03:53:30] [Server thread/INFO]: Changed the block at 1678, 83, -161
[03:53:31] [Server thread/INFO]: [Not Secure] [Server] __DAMAGE_2_OK__
[03:53:31] [Server thread/INFO]: Changed the block at 2800, 111, -153
[03:53:32] [Server thread/INFO]: [Not Secure] [Server] __DAMAGE_3_OK__
[03:53:32] [Server thread/INFO]: [Not Secure] [Server] [Styx] undo 逐格对账通过：11208/11208 格与扫描前像一致（diff 0）
[03:53:44] [Server thread/INFO]: [Not Secure] [Server] [Styx] undo 逐格对账通过：11208/11208 格与扫描前像一致（diff 0）
[03:53:53] [Server thread/INFO]: [Not Secure] [Server] __UNDO_CELL_1_OK__
[03:53:53] [Server thread/INFO]: [Not Secure] [Server] __UNDO_CELL_2_OK__
[03:53:54] [Server thread/INFO]: [Not Secure] [Server] __UNDO_CELL_3_OK__
```

**对账命令本身就是产物**（这一段就是任务书要的"对账命令写进报告"）：

```mcfunction
# styx:undo/verify（节选，实为 3 片 × 4000 行）
scoreboard objectives add styx.undo dummy
scoreboard players set #bad styx.undo 0
function styx:undo/d001
function styx:undo/d002
function styx:undo/d003
execute if score #bad styx.undo matches 0 run say [Styx] undo 逐格对账通过：11208/11208 格与扫描前像一致（diff 0）
execute if score #bad styx.undo matches 1.. run say [Styx] undo 逐格对账不通过：#bad > 0，逐格坐标见 styx:undo/where

# styx:undo/d001（节选，前 3 行 = 该列的灯格；甲板格在第 4 行）
execute unless block 480 83 -160 minecraft:redstone_lamp[lit=false] run scoreboard players add #bad styx.undo 1
execute unless block 480 83 -156 minecraft:sea_lantern run scoreboard players add #bad styx.undo 1
execute unless block 480 83 -154 minecraft:redstone_lamp[lit=false] run scoreboard players add #bad styx.undo 1
execute unless block 480 84 -160 minecraft:black_stained_glass run scoreboard players add #bad styx.undo 1
...
```

读数：`scoreboard players get #bad styx.undo` → `#bad has 0 [styx.undo]`（差 0 = 验收通过）。

### 三次完整验收 + 一次纯扫描

| # | 命令 | 前像 vs 现场 `#bad` | apply 之后 `#bad` | undo 之后 `#bad` | 退出码 |
|---|---|---|---|---|---|
| 1 | `--terrain`（首次，紧凑打包 bug 未修；当时还没有闸门） | **3782** | — | — | 1 |
| 2 | `--terrain`（修完打包，未加 `--where`） | 0 | 6414 | **1**（1/11208，见 §4.4） | 1 |
| 3 | `--terrain --where` | 0 | 6413 | **0** | 0 |
| 4 | `--terrain --where`（本次报告引用） | 0 | 6413 | **0** | 0 |
| 5 | `--terrain --scan-only`（同一份地形的第二次铺装） | 0 | — | — | 0 |

第 5 次与前一次的前像**逐格逐字节相同**（11208/11208 格一致、`/data get block` 11208 条回包一致、
`styx:undo` 的 sha256 也相同 `6e1f8116…`），说明"铺地形 → 前像"这条链是可复现的。
对比用的上一份原始日志留在 `build/undo-scan-raw-prev.log`（`undo-scan-raw.log` 只保留最近一次）。

---

## 2. 坑 1：`/data get block` 读不出方块 id + 状态（任务书假设不成立）

任务书要求"对每格发 `data get block x y z`，从控制台回包解析方块 id + 状态"。在 1.21.10 上实测，
这个命令**只认方块实体**；对红石灯 / 音符盒 / 沙子这类普通方块一律回一句没有信息量的错误。
原始回包（`build/undo-accept.log` 之前的探针，逐字复制）：

```
>>> setblock 100 100 100 minecraft:redstone_lamp[lit=false]
[Server thread/INFO]: Changed the block at 100, 100, 100
>>> data get block 100 100 100
[Server thread/INFO]: The target block is not a block entity      ← 连 id 都不给

>>> setblock 100 101 100 minecraft:note_block[instrument=harp,note=15,powered=false]
>>> data get block 100 101 100
[Server thread/INFO]: The target block is not a block entity

>>> setblock 100 102 100 minecraft:sand
>>> data get block 100 102 100
[Server thread/INFO]: The target block is not a block entity

>>> setblock 100 103 100 minecraft:chest[facing=north,type=single,waterlogged=false]
>>> data get block 100 103 100
[Server thread/INFO]: 100, 103, 100 has the following block data: {components: {}, x: 100, y: 103, Items: [], z: 100, id: "minecraft:chest"}
       ↑ 就算是方块实体，也只给方块实体 NBT：facing / type / waterlogged 这些**状态**一个都没有

>>> data get block 5000 84 -160      →  [Server thread/INFO]: That position is not loaded
>>> data get block 100 400 100       →  [Server thread/INFO]: That position is out of this world!
```

本机机器格子的实测统计（`build/undo-accept.json`）：**11208/11208 条回包都是
`The target block is not a block entity`**，`not-loaded 0、out-of-world 0、不认识的回包 0`。

所以前像的**身份**改从存档 region 里读（`src/scan/region-nbt.mjs` 只读解析 palette 的
`Name + Properties`），控制台的 `/data get block` 保留原样并逐条记进 `build/undo-scan-raw.log`，
用来做两件事：① 证明每格**加载了**（"未加载"会明确写在报告里）；② 与存档前像**交叉校验**
（方块实体格子上，控制台给的 `id` 必须等于存档给的 `Name`，不一致就让 `complete:false`）。

```json
// build/undo-report.json 节选
"scan": { "consoleReplies": 11208, "byKind": { "not-block-entity": 11208 }, "notLoaded": [], "outOfWorld": [], "unknownConsoleReplies": [] },
"crossCheck": { "compared": 0, "agreed": 0, "disagreed": [] },
"cells": { "fromLog": 11208, "unique": 11208, "duplicatesDropped": 0, "restorable": 11208, "unreadable": [], "bySource": { "region-nbt": 11208 } },
"complete": true
```

前像的方块成分（`[cell]` 行按角色聚合，来自 `build/undo-scan-raw.log`）：灯行以红石灯 1982 /
海晶灯 135 / 空气 675 为主；甲板行黑玻璃 2783 / 空气 2；音符盒行 1897；触发位空气 2792。
也就是说这份前像**不是一片空气**：11208 格里 **6949 格非空气**（空气 4259 格），
undo 真的在把这些方块按 id + 状态还原回去。

---

## 3. 坑 2：`save-all flush` 打完 "Saved the game" 之后，区域文件还没写完

最初的做法是"刷盘 → 立刻读 region"，结果 11208 格里 **3782 格**和现场不一致。证据（同一份
`build/undo-accept.log` 的时间戳 vs 区域文件 mtime）：

```
[03:32:19] [Server thread/INFO]: ThreadedAnvilChunkStorage (world): All chunks are saved
[03:32:19] [Server thread/INFO]: Saved the game          ← 服务器说"存完了"
（此时 build/ 侧对同一份存档的读取：3782/11208 格与现场不符）
region 文件 mtime（Windows 文件时间）：r.0.-1.mca 03:32:50、r.1.-1.mca 03:33:04、r.2..5.-1.mca 03:33:37
                                         ↑ 真正的落盘比"Saved the game"晚 30~45 秒
```

所以 scanner 里加了**新鲜度闸门**：读到的前像必须先过两关才允许用来生成 undo ——

1. **抽样**（默认 64 格，跨整个音轨均匀取）逐格 `execute if block <pos> <存档状态>` 现场对一遍；
2. 抽样过了再生成函数，跑**全量** `styx:undo/verify`，要求 `#bad == 0`；
   不满足就 `save-all flush` + 等一会儿**重读存档**，最多 10 轮，全失败则非 0 退出、**绝不拿过期前像生成 undo**。

```json
// build/undo-accept.json（本次）：第 1 轮就过了
"freshness": [{ "attempt": 1, "sampleOk": 64, "sampleTotal": 64, "chunksRead": 263, "chunksMissing": 0, "preBad": 0 }],
"region": { "chunksRead": 263, "chunksMissing": 0 }
```

这个闸门不是事后补的摆设：第一次跑就是"生成完 undo、跑到全量对账才发现 3782 格不对"；
现在这类不一致会在**生成阶段**被抽样 + 全量对账拦住（重读存档或非 0 退出），
而不是让一份"看起来正常、其实 3782 格是空气"的 undo 流到世界里。

---

## 4. 坑 3：存档里 `block_states.data` 是"填充"打包，不是紧凑打包

`3782` 那次不是刷盘慢，而是**解码错了**。取证链：

### 4.1 存档说 air、现场有红石灯

用"该 section 的 palette 当候选清单，现场逐候选 `execute if block`"做判别（无头服上跑）：

```
(724,83,-146)   存档=minecraft:air | palette=22 | 现场命中=[minecraft:redstone_lamp[lit=false]]
(994,83,-156)   存档=minecraft:air | palette=26 | 现场命中=[minecraft:redstone_lamp[lit=false]]
(2105,83,-151)  存档=minecraft:air | palette=18 | 现场命中=[minecraft:redstone_lamp[lit=false]]
(480,83,-160)   存档=minecraft:redstone_lamp[lit=false] | 现场命中=[minecraft:redstone_lamp[lit=false]]   ← 对照
(2573,98,-160)  存档=minecraft:air | 现场命中=[minecraft:air]                                            ← 对照
```

### 4.2 两种打包的 long 数不一样，可以直接从文件反推

```
区块(45,-10) DataVersion=4556 顶层键=[Status,zPos,block_entities,yPos,LastUpdate,structures,InhabitedTime,xPos,Heightmaps,sections,isLightOn,block_ticks,PostProcessing,DataVersion,fluid_ticks]
  Y=5  键=[block_states,SkyLight,biomes,BlockLight,Y] palette=22 data=342  紧凑期望=320  填充期望=342 → 填充
  Y=5  区块(30,-10)                                  palette=15 data=256  紧凑期望=256  填充期望=256 → 两者等价
  Y=6  区块(160,-10)                                 palette=19 data=342  紧凑期望=320  填充期望=342 → 填充
```

规则：`bits = max(4, ceil(log2(paletteSize)))`；
**紧凑**（条目可跨 long）= `ceil(4096×bits/64)` 个 long；**填充**（每个 long 只放 `floor(64/bits)` 个条目）= `ceil(4096/floor(64/bits))` 个 long。
`bits = 4`（palette ≤ 16）时两者**完全等价**，所以只有 palette > 16 的段落踩坑：

```
(724,83,-146) palette 22（bits=5）：
   bits=5 紧凑 → 索引 0 = minecraft:air          ← 旧实现（错）
   bits=5 填充 → 索引 1 = minecraft:redstone_lamp ← 现场实测一致（对）
```

修法：按 `data` 长度判别（`data.length === 填充期望` → 填充，否则紧凑；bit=4/8 两种等价时无歧义），
并加了两条回归单测（`palette=22/data=342` 的合成 region、以及 `Y=-4` 的负 section）。
顺带修掉一个 NBT 真 bug：**`TAG_Byte` 是有符号的**，section 的 `Y` 会出现 `252…255`（= −4…−1），
按无符号读会把 y<0 的 section 全部对不上（现在的单测里 `Y=-4` 必须能定位）。

---

## 5. 覆盖范围（如实划界）

1. **前像范围 = 每颗音的 4 格**（灯 y−1 / 甲板 y / 音符盒 y+1 / 触发位 y+2），11208 格全覆盖、0 格读不到。
2. **`styx:undo` 不再调用旧的 `undo_wall/undo_deck/undo_terrain`**（那三个是硬编码 `fill`，会改到前像范围
   之外的格子，无法用本报告的判据证明）。这是与旧行为的**明确差异**：文件还在包里，但没人调用了。
3. **老坐标不在前像里**：`styx:apply_notes_v3` 除了摆新音符，还会把**旧 v3 谱面坐标**清成空气
   （5616 格），其中 **202 格（3.6%）**不在本次前像范围内 —— 这些格子被 apply 改过，undo 还原不了。
   要"完全回退"就得把旧谱面坐标也扫进前像（属于下一步，不在本任务范围）。
4. **机器区域之外**（挡墙/地形本身的 `fill`、海晶灯带、水面）不在前像范围内。

---

## 6. 还没做到 / 已知风险

1. **一次"1 格落差"没能复现**：第 2 次完整验收里 `undo 之后 #bad = 1`（11208 格里的 1 格），
   当时还没接 `--where`，所以没留下坐标；此后两次带 `--where` 的完整验收都是 0，且两次铺地形的
   前像逐格相同（§1 表），所以**不是**"铺地形不确定"造成的，最可能是某个格子受方块更新顺序影响
   （灯的点亮/重力/流体这类"放了以后还会自己变"的状态）。现在 `--where` 已接进 scanner：
   再出现落差，日志里会直接打印不平格坐标 + 期望状态，一轮就能定位。
2. **判据仍然是"跑完这一遍 diff 0"**：`#bad != 0` 时 scanner 退出码 1（不是"警告一下"），
   但 `styx:undo` 本身是**单向**的（undo 之后再 undo 没有意义），运行前不会自动比对"这份前像是不是
   当前世界的前像"——需要的话可以加一条"undo 前先跑 verify，`#bad != 0` 就拒绝执行"的闸门。
3. **无头服里 `tellraw @a` 是静默的**（没有玩家）：本轮所有面向日志的结论都改用 `say`
   （`say` 不需要玩家）。数据包里 `play/*` 的 `tellraw @a` 同样属于"有玩家才看得见"，
   以后写验收断言别去 grep 那些行。
4. **单函数规模**：`setblock` 11208 行 / 对账 11208 行，按 4000 行分片；整包含 420 个函数文件、
   115062 行，`node src/emit/lint-pack.mjs` 静态自检通过（无 tick rate、无悬空引用）。

---

## 7. 下一步（交给根代理接的线）

1. **接进一键流程**：`styx:redo` 里在铺装前先跑一次前像扫描（或把 `styx:undo` 与前像一起生成），
   让"一键 redo"自带"一键 undo"；本任务的产线是独立的 `src/scan/undo-scanner.mjs`，没有改
   `src/emit/datapack-playback.mjs` / `note-blocks.mjs` / `layout-pos.mjs` / `src/layout/*` / `src/test/*`。
2. **把 202 格老坐标纳入前像**（§5.3）→ 真正的"完全回退"，同时可以让 `undo.mcfunction` 继续保留
   旧的 `undo_wall/deck/terrain`（顺序：先逐格快照、再地形 fill，两步各自可对账）。
3. **机器区域外的地形回退**（挡墙/水面）目前仍是旧 `fill` 口径，若要逐格可信，需要扩大扫描范围
   （scan 的格子表是按机器谱面算的，扩展成"谱面 4 格 ∪ 区域 AABB"即可，代价是扫描格数上升）。

---

## 附：本轮单测

```bash
node --test tests/undo-snapshot.test.mjs tests/region-nbt.test.mjs
# tests 14 / pass 14 / fail 0
node --test "tests/*.test.mjs"          # 全仓 175 项，全过（含 M1-4/M1-5 并行任务的用例）
```
