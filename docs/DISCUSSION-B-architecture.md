# 讨论 B · 技术架构视角（角色：架构师）

> **结论先行**（只读这段也能决策）
>
> 1. **流水线**：`analyze → arrange → layout → emit → verify` 这个划分够用，但必须再加一层
>    **`plan`（刻→音符组的世界坐标表）**，让 `emit` 与 `verify` 读同一份数据——否则验收口径
>    永远可能和播放器漂移。现状 `src/` 没有文件契约、没有 `project/score/layout/plan`，
>    中间数据是 `build/` 里 7 种互不对应的格式 + 一堆硬编码绝对路径。
> 2. **播放器调度**：现状是「279 个分桶函数 + 全部桶的 guard 全量求值」= **每刻 21,977 条命令**
>    （实测：`tick.mcfunction` 281 行 + `b00..b278` 共 21,696 行）。这是把"刻"当"下标"扫了一遍
>    全表。推荐 **数字派发 + 每刻叶子函数（~60 条/刻，约 370× 降幅）**；最小改动版（只换派发层）
>    也有 ~110 条/刻。
> 3. **刻率**：**默认 25 tps，不要用 100**。0.12 s/步在 25 tps 下正好 3 刻（精确），世界只加速
>    1.25×；100 tps 是 12 刻/步但要 5× 加速，而且**本机实测根本跑不动**：空转 100 tps 能跑满
>    99.99 刻/秒，一开播放就掉到 **76.9 刻/秒（77%）**，服务器日志出现 `Can't keep up!`。
>    也就是说，用 100 tps「换精确节奏」的效果是**实际速度慢 23%**（0.12 s/步 → 0.156 s/步）。
> 4. **修了一个静默 bug**：`play/b30` 里的强加载切换用的是 20 tps 时代的常量（`1248*0.12*20 = 2995`），
>    在 100 tps 时间轴上落在 **tick 3000 = step 250（x≈730）**，那一刻 `forceload remove all` 把
>    x<1728 整段卸掉 → **1326 个音（x 730..1735，tick 3012..15060，占全曲 43%）所在区块未加载，
>    setblock 失败、音不响，但 `#hits` 照样 +1**（实测日志：`That position is not loaded`）。
> 5. **「216 vs 68」不是播放器的 bug**：`#hits` 与数据对账**差 0**（我在白盒探针里加了每刻累计
>    应触发数 `#exp`，20/25/100 tps 三个阶段实测差值都是 0）。观察值偏高是验收脚本的问题：
>    `play/start` 因含 `/tick rate`（权限等级 3 > 函数等级 2）**整份加载失败**，而清零 `#hits`、
>    置 `#on=1` 恰好都在那个文件里 → 读到的 216 是上一次运行残留在存档里的计数（CSV 里
>    `tick ≤ 1684` 的音数**正好是 68**，与预期值完全吻合）。
> 6. **验收口径必须改**：`#hits` 只证明「命令被执行」，不证明「音符盒响了」。要加三件套：
>    **同刻充能见证（`note_block[powered=true]` 计数）+ 区块覆盖断言 + 每刻累计对账**，
>    声学部分用仓库里已有的无头客户端录音链路（`build/tools/audio_capture_test.mjs`）做 T3 证据。
>    顺带修正设计文档的一个口径错误：`MSPT ≤ 50` 在 100 tps 下不可能成立（50 ms/刻 × 100 刻/秒
>    = 5 秒 CPU/秒），该写成「**实测推进刻率 ≥ 0.98 × 设定刻率**」，MSPT 只作诊断量。

---

## 0. 本轮实测与复核（所有数字都有出处）

### 0.1 播放器现状：279 个桶 = 每刻 21,977 条命令

| 事实 | 数值 | 出处 |
|---|---|---|
| 音符总数 / 有音符的刻数 | 3099 / 1821（平均 1.70 音/刻，最多 4 音/刻） | `build/styx_helix_notes_v3.csv` |
| `play/tick.mcfunction` | 281 行 = 1 行自增 + **279 个桶调用** + 1 行停止判断 | 实测行数 |
| `play/b00..b278` | 279 个文件，**合计 21,696 行 guard**（平均 77.2，最多 `b168` 155 行，`b15/b16/b17/b229` 为空） | 实测行数 |
| 每刻实际求值的命令 | **281 + 21,696 ≈ 21,977 条**（每刻只有一个 guard 命中，另外 ~2.2 万条全部白跑） | 由前两行相加 |
| 100 tps 下命令吞吐需求 | ≈2.2 M 条/秒 | 21,977 × 100 |
| 本机实测吞吐上限 | **≈1.7 M 条/秒**（两次独立测量：21,697×76.95；23,522×72.7） | `_probe/arch-tickrate/SUMMARY4.txt` |
| 每音符的指令数 | 6 条（红石块 / 空气 / 计数 / 灯 / 监听 playsound / 监听计数）+ 上一组灯的熄灭 | `src/emit/datapack-playback.mjs` |

### 0.2 刻率实测（`_probe/arch-tickrate/`，隔离目录 + 独立端口 25577，`-Xms1G -Xmx2G`）

| 场景 | 设定 | 实测推进 | 达成率 | 备注 |
|---|---|---|---|---|
| 空转（只有 tick 标签 281 行/刻） | 100 tps | **99.99 刻/秒** | 100% | 世界本身没问题 |
| 播放（+21,696 行 guard/刻） | 100 tps | **76.9 刻/秒** | **77%** | 日志 `Can't keep up! ... 1201ms / 3074ms behind` |
| 播放（+1,821 行对账函数/刻） | 100 tps | 72.7 刻/秒 | 73% | 对账函数本身也要 ~1.8 万条/秒 |
| 播放 | 25 tps | **24.98 刻/秒** | **100%** | 还有 3 倍余量 |
| 播放 | 20 tps | 20.00 刻/秒 | 100% | |
| 空转 | 20 tps | 20.00 刻/秒 | 100% | |

用「1.7 M 条/秒」反推每刻预算，模型与实测完全吻合：

| 设定刻率 | 每刻预算 | 现状每刻 21,977 | 预测 | 实测 |
|---|---|---|---|---|
| 20 tps | 85,000 | 26% | 跑满 | 20.00 ✓ |
| 25 tps | 68,000 | 32% | 跑满 | 24.98 ✓ |
| 50 tps | 34,000 | 65% | 跑满 | ~49 ✓ |
| 100 tps | 17,000 | **129%** | 76.9 | 76.9 ✓ |

（50 tps 那一行的实测来自较粗的 `probe2`（`#t` 在 26 秒内到 1280 ≈ 49.2 刻/秒），只作量级参考；
20/25/100 tps 三行来自 `probe3`/`probe4` 的口径。）

### 0.3 「触发计数 216 vs 预期 68」的完整证据链

1. `testserver/v3test.log`：`Failed to load function styx:play/start` / `play/stop` / `play/reset`，
   随后执行时是 `Unknown function styx:play/start`。根因（A 组已确认）：这三个文件里含
   `/tick rate`，需要权限等级 3，而数据包函数只有等级 2 → **整份函数加载失败**。
2. 同一份日志里 `#t has 1684 [styx.t]`：`play/start` 没执行，`#t=-1` 也没执行，
   说明 `#on = 1` **是存档里残留的**（服务器一开服 tick 标签就在跑）。1684 刻 ÷ 20 tps ≈ 84 秒，
   与服务器启动到读数的真实时间一致 → 刻率其实还是 20（`tick rate 100` 也没生效）。
3. 我用 node 复算 CSV：**`tick ≤ 1684` 的音数正好是 68**，与脚本打印的预期值一模一样。
   所以 68 是对的，216 偏大 → `#hits` 从未被清零（清零代码就在加载失败的 `play/start` 里），
   216 − 68 = 148 是上一次运行留下的残留值。
4. 白盒复核（`probe3`）：在探针副本里加了一个 **1821 行的累计应触发函数 `styx:probe/audit`**
   （挂在 tick 标签、播放之后），跑完读 `#hits - #exp`：

| 刻率 | #t | #hits | 应触发 #exp | 差值 |
|---|---|---|---|---|
| 20 tps | 404 | 23 | 23 | **0** |
| 25 tps | 505 | 25 | 25 | **0** |
| 100 tps（过载） | 1469 | 67 | 67 | **0** |

**结论：播放器的触发逻辑是忠实的（不漏不多），问题全在验收脚本（不校验启动是否成功、不清零计数器）。**

### 0.4 强加载切换 bug（实测复现）

`src/emit/datapack-playback.mjs`：
```js
const SWITCH_TICK = Math.round(1248 * 0.12 * 20);   // = 2995，20 tps 时代的常量
if (!switched && t >= SWITCH_TICK) { … forceload remove all; forceload add 1728 … }
```
`t` 取自 v3 时间轴（`step × 12`，100 tps），第一条 ≥2995 的音符刻是 **3000 = step 250 = x≈730**。
于是演奏进行到第 30 秒（100 tps 下）就把前半段（x480..1727）整个卸载了，而前半段的音符一直排到
tick 15060。探针实测（`probe.mjs`，取一个真实音符格 `(1600, 85, -153)`，v3 数据 step=1120）：

| 场景 | `execute if loaded` | 读到该音符盒 | 触发后 `powered=true` |
|---|---|---|---|
| 前半段仍被强加载（对照） | true | — | **true（真的会响）** |
| `forceload remove all` 之后 | **false** | false | — |
| 只加后半段 1728..2880（= b30 干的事） | **false** | false | — |
| 在未加载区块上照播放器写法触发 | — | — | **false**；`setblock` 报 `That position is not loaded`；`#hits` 仍 +1 |

影响面：**x ∈ (730, 1735] 的 1326 个音（tick 3012..15060，占全曲 43%）会静默不响**，
而所有"计数类"验收都会显示通过。

### 0.5 与同任务另一版 B 文档的口径差异（可复查）

同一任务下另有一版 B 文档先提交了（commit `cecd26c`，00:32:31）。本文件取代了工作区里的那一版，
**原版没丢**：`git -C nbmachina show cecd26c:docs/DISCUSSION-B-architecture.md > B-alt.md` 即可取回。
两处口径差异，以本轮实测为准：

1. **瓶颈是"每刻被求值的命令条数"，不是"函数调用次数"。** 另一版认为"单刻真正被求值的只有当前桶
   的 ~78 行，brief 里的 2.8 万条/刻高估了约 350 倍"。这不成立：`tick.mcfunction` 每刻**无条件调用
   全部 279 个桶**，而每个桶体里装的是**它自己那 100 刻窗口内全部有音符的刻**的 guard，所以每刻被求值的命令是
   `281 + 21,696`。反证：若真是 ~360 条/刻，100 tps 只需 ~3.6 万条/秒，不可能实测掉到 76.9 刻/秒
   （`probe4`：空转 100 tps 跑满 99.99，一开播放掉到 76.95）。这个差别会直接改变优化目标的排序：
   **光把 279 次调用压到 19 次（两级派发）只省下 260/21,977 ≈ 1% 的成本，必须同时消掉
   "整桶 guard 全量求值"**（这就是本文 b2 的每刻叶子函数）。
   澄清一点：另一版**实现出来的**方案（组→桶两级派发，`src/emit/tick-map.mjs`）其实是对的——
   它每刻只求值"当前组 15 个桶 + 当前桶 ~77 行"，落在本文 b1 那一行（~110 条/刻，约 200× 改善），
   与本文结论并不冲突；只是它的**文字口径**（把成本记成调用次数、认为桶内行数不被求值）会让后续
   优化误判方向：要从 b1 再降到 b2（~60 条/刻），必须消掉桶内那 77 行 guard。
2. **`/tick rate` 不持久化。** 另一版把它当作"写入存档的存档级风险"。实测：`tick rate 35` → `stop`
   → 重启后 `tick query` 报 20.0/s（`probe5`）。所以崩溃不会把世界永久 5× 加速，但每次运行都必须显式设置。

已采纳另一版的四条结论（本文对应位置）：① `/tick` 必须从数据包中彻底移除（= 本文 §3.3.1，与 A 组一致）；
② 两级派发方向（= 本文 §2.1 的 b1）；③ 用 `tick freeze` + `tick step` 做与墙钟无关的确定性验收
（= 本文 §5.1 的 T2.0，已实测复用）；④ `redo/s2|s3|s4` 三遍重跑 `apply_notes_v3` 的浪费（= 本文 §1.2）。

---

## 1. 问题 1 · 流水线划分

### 1.1 推荐划分（在 SPEC 五段之间补一层 `plan`）

| # | 步骤 | 输入 | 输出（纯文本） | 幂等 | 可单独重跑 | 重跑代价 |
|---|---|---|---|---|---|---|
| 1 | `ingest` | 音频 / MIDI / MusicXML / 手写 | `project.json`（+ 源文件 sha256） | 是 | 是 | 秒级 |
| 2 | `analyze` | `project.json` + 音频 | `analysis.json`（速度/八度证据/chroma/力度证据） | 是 | 是 | 秒~分钟（FFT） |
| 3 | `arrange` | `project` + `analysis` | `score.json` + `arrange-report.json`（`degradations[]`） | 是 | 是 | 秒级 |
| 4 | `layout` | `score.json` + 世界扫描 | `layout.json`（机型/剖面/开槽） | 是 | 是 | 秒级（扫存档） |
| **4.5** | **`plan`** | `score` + `layout` | **`plan.json`：刻→音符组 + 世界坐标 + 灯位 + 强加载分区** | 是 | 是 | 秒级 |
| 5 | `emit` | `plan.json` | 数据包目录（结构 NBT + 函数）+ `manifest.json` | 是（**先清空输出**） | 是 | 秒级 |
| 6 | `verify` | `plan.json` + 证据（游戏内计数 / 录音 WAV） | `verify-report.json`（客观指标 + 综合分） | 是 | 是 | 分钟级 |
| 7 | `deploy` | 数据包 + `manifest` | 存档内安装（备份 / 回退 / 增量区域） | 是 | 是 | 秒级 |

**为什么必须单独有 `plan`**：`emit` 需要它来渲染函数，`verify` 需要它来逐刻/逐格对账。
如果 `verify` 自己再去"重算一遍坐标"，两边就会漂移——本项目已经漂移过一次
（forceload 常量）。`plan` 是唯一真相，`verify` 只读它。

**`plan.json` 是"刻 → 音符组"的单一表**，也是 §2 里推荐调度方案的数据形态：
```jsonc
{ "meta": { "tickRate": 25, "ticksPerStep": 3, "totalTicks": 6960 },
  "groups": [ { "tick": 0, "notes": [ { "x":480,"y":85,"z":-160,"instrument":"bass",
                 "note":9,"volume":0.35,"lamp":[480,83,-160] } ] } ],
  "forceload": [ { "firstTick":0, "lastTick":6960, "from":[480,-176,-141],"to":[2831,-141,-136] } ] }
```

### 1.2 现状 `src/` 与这个划分的差异

| 差异 | 证据 | 后果 |
|---|---|---|
| 没有 `ingest` / `verify` / `deploy` | `src/` 只有 analyze / arrange / layout / emit / scan / test / research | 输入来源与验收报告都不是模块，是"脚本 + 人工看输出" |
| 没有文件契约 | 中间数据是 `build/` 下 `styx_helix_notes.csv`、`_v3.csv`、`notes.json`、`notes_raw.json`、`song.json`、`song_midi.json`、`single_row_profile.json` **7 种格式**，字段口径各不相同 | 无法判断"哪份是真相"，改一步要人工确认 |
| 全部硬编码绝对路径 | `C:/Users/hiliang/Documents/minecraft/build`、PCL2 存档路径、`java.exe` 路径写死在每个脚本里 | 换机器/换存档必炸；模块无法单独跑 |
| **产物不在版本库里** | `build/styx_build/` 在仓库外（git 只跟踪 `nbmachina/`，`.gitignore` 也没管它） | "可复现"无法证明，回退只能靠人肉备份目录 |
| 时间常量多处复制 | `SEC_PER_STEP=0.12`（arrange）、`PLAY_TPS=100`（arrange）、`SWITCH_TICK=1248*0.12*20`（emit）、`schedule … 120t/200t`（redo-chain）、`tick rate 100`（start） | **已经炸了一次**（§0.4 的 1326 个音）；`redo` 的等待在 100 tps 下从 6 s 变成 1.2 s |
| `emit` 不清空输出目录 | `data/styx/structure/` 里 196 个 NBT（`flat_a/flat_b/flat_c/styx` × 49）：当前链路（`flat_build_v2a/b/c`）只引用 `flat_b_*`，`styx_*` 由遗留的 `build.mcfunction` 引用，`flat_a/flat_c` 只有 2 条引用——**147 个是死重量**；函数目录里还有 `flat_build`、`flat_lights`、`lamps`、`light_v1..v3`、`melody_line`、`reset1/2`、`undo_*`、`bass_guitar_*` 等 60+ 个历史产物 | 数据包体积与解析/加载成本翻倍，且"哪个函数是当前版本"要靠猜 |
| 没有 report | 没有 `arrange-report.json` / `degradations[]` | 违背 v0.2 的"保真契约"（不允许静默近似） |
| 一次性大函数 | `apply_notes_v3.mcfunction` **15,496 行 / 773 KB**，实测执行 **20 秒**（`v3test.log` 23:49:42→23:50:02）；而 `redo/s2`、`s3`、`s4` **各调用它一遍**（= 46,488 条 setblock），其中非当前加载窗口的那两遍靠"setblock 在未加载区块上失败"来跳过 | 玩家会看到十几秒的卡顿；而且这条链依赖**静默失败**（和 §0.4 同一类问题）——一旦强加载范围与假设不一致，就会"跑过了但没铺上" |

### 1.3 重构建议（不推翻现有代码，加壳）

```
nbmachina/
  nbmachina.config.json      # { worldPath, javaExe, outDir, server.jar, proxy? }
  work/                    # 可删可重建；不进 git（但每次运行的 sha256 进 report）
    01-project.json  02-analysis.json  03-score.json  04-layout.json  05-plan.json
    reports/{analyze,arrange,layout,plan,emit}.report.json
    datapack/styx_build/  +  manifest.json（文件清单 + 哈希）
  src/{ingest,analyze,arrange,layout,plan,emit,verify,deploy}/*.mjs   # 每个都支持 --in/--out
  tests/*.test.mjs         # node:test，零依赖
```

三条硬规则：
1. **任何时间量都从 `score/plan.meta.tickRate` 派生**；`SEC_PER_STEP`、`SWITCH_TICK`、`schedule Nt` 里
   都不许再出现裸数字（加一条 grep 测试）。
2. `emit` **先清空输出目录**再写，并产出 `manifest.json`；`deploy` 用 manifest 做增量和回退。
3. 每个模块产出 `*.report.json`：输入哈希、参数、做了什么近似、丢了什么、指标是多少。

### 1.4 分步幂等性口径

- `analyze/arrange/layout/plan`：纯函数（同输入 → 同输出字节），可直接重跑。
- `emit`：**重建式**（清空 + 重写），天然幂等；不要做"增量改文件"。
- `deploy`：**分区声明式**——`plan.forceload` 的每个区域是一个"单元"（含结构、音符、灯、首末 tick），
  支持 `--region k` 只重铺一个区域；这才是"增量更新"的正确粒度（现在 `redo` 是全量三段重铺）。
- `verify`：只读（不改世界），可反复跑；它的输入必须包含 `plan.json` 的哈希。

---

## 2. 问题 2 · 运行时架构（游戏内调度）

### 2.1 四个方案对比（数字都是每刻执行的命令条数）

| 方案 | 每刻成本 | 100 tps 下 | 生成复杂度 | 失败模式 |
|---|---|---|---|---|
| **a) 现状**：279 个分桶函数，全部桶的 guard 全量求值 | **21,977** | 2.2 M/秒 → **跑不动（76.9 刻/秒）** | 低（已实现） | 过载掉刻：节奏随负载线性变慢；没有局部失败，是全局变慢 |
| **b1) 最小改动**：保留 279 个桶，只把派发改成数字分层（10×10×3 个分支） | 10+10+10 + 桶体 ~77 ≈ **110** | 1.1 万/秒（0.6% 吞吐） | 中（只改 tick.mcfunction 生成器） | 无；桶内仍是 guard 扫描，但只有 1 个桶进内存 |
| **b2) 推荐**：数字派发 + **每刻一个叶子函数**（叶子只含该刻要执行的 setblock/playsound，没有 guard） | 各层分支 10×5 + 每刻 3 条控制 + 叶子 ~11 ≈ **60** | 6 千/秒（0.35%） | 中高（要按刻生成 1821 个叶子） | 无状态：`#t` 是唯一真相，可暂停/继续/跳转；漏刻=服务器真的跳了刻，可用计数器检测 |
| c) `/schedule` 事件链（每个有音符的刻调下一个） | ~12（空刻 0） | 1.2 千/秒 | 低 | **链断了就永久静默**：函数未加载、`/reload`、服务器重启、误 `schedule clear` 都会断，且**没有任何痕迹**；不能 seek/暂停；重启后计划表不持久 |
| d) "把时间轴压成单一表" | 若理解成"一个函数里放 27,840 条 guard" → **27,840/刻（更糟）**；<br>若理解成"刻→音符组的表 + 数字派发" → 等价于 b2 | — | — | 表格本身不是问题，**访问方式**才是问题：MC 没有数组/间接跳转，只能"比较 + 调用"，所以必须是分层派发 |

### 2.2 推荐：b2（数字派发 + 每刻叶子函数）

MC 函数没有间接寻址，唯一能做到"对数级派发"的办法是**把刻号按十进制拆位，每层 10 条分支**：

```mcfunction
# play/tick.mcfunction —— 每刻固定 15 条（含下面 10 条分支），与歌曲长度无关
execute if score #on styx.flag matches 0 run return 0        # return 需要 1.20.5+，本项目 1.21.10 ✓
scoreboard players add #t styx.t 1
execute if score #t styx.t matches 6961.. run function styx:play/stop     # 上界随 tickRate 生成
scoreboard players operation #q styx.t = #t styx.t
scoreboard players operation #q styx.t /= #ten styx.t        # #ten 在 start 里初始化一次 = 10
scoreboard players operation #r styx.t = #q styx.t
scoreboard players operation #r styx.t %= #ten styx.t
execute if score #r styx.t matches 0 run function styx:play/d1/0
… （10 条，按 #r = 0..9）
```

下一层做同样的事（`#q` 各位继续拆），最后落到 **`styx:play/leaf/<tick>`**：

```mcfunction
# play/leaf/1008.mcfunction —— 该刻的全部音符，没有 guard
setblock 495 86 -160 minecraft:redstone_block
execute if block 495 85 -160 minecraft:note_block[powered=true] run scoreboard players add #w styx.flag 1
setblock 495 86 -160 minecraft:air
setblock 495 83 -160 minecraft:redstone_lamp[lit=true]
setblock 490 83 -157 minecraft:redstone_lamp[lit=false]
```

要点：
- **只有有音符的刻才生成叶子**（1821 个），叶子里的命令数 = 6×该刻音符数（≤ 24）。
- 派发层只需要生成"通向叶子的分支"，实测可控制在 ~50 条/刻。
- **灯**用"上一组熄灭"列表跟着叶子走，仍然每刻 ≤ 4 条。
- 每刻加 1 条 `scoreboard players add #beat styx.t 1`（心跳），验收直接量它（见 §5）。
- `#t` 是唯一状态：暂停 = `#on=0`，继续 = `#on=1`，跳转 = `set #t <tick>`。

**收益**：21,977 → ~60 条/刻（**约 370×**）。此时即使真的用 100 tps，也只占 0.35% 的实测吞吐；
25 tps 下余量 ~30 倍。

### 2.3 各方案的失败模式（逐项比较）

| 失败模式 | a 现状 | b1/b2 分层派发 | c `/schedule` 链 |
|---|---|---|---|
| **丢刻**（服务器跳刻/过载） | 掉刻 → 整首歌变慢（实测 77%） | 掉刻时该刻的叶子就不会被调用（与 a 相同），但**不会连锁放大**；用 `#beat` 对账能立刻发现 | 掉一个 `schedule` 就**永久停**，无痕迹 |
| **卡顿**（单刻命令量） | 每刻固定 2.2 万条，永远在危险区 | 每刻 ≤ ~60 条，与歌曲长度无关 | 最省，但省下来的复杂度换来"可靠性换性能" |
| **跨维度** | `forceload` 是服务器级（对所有维度生效），不会因为玩家在别的维度而失效；`setblock/place` 在 tick 标签里以主世界为执行维度 | 同 a（不引入新风险） | 同 a；但 `/schedule` 是**服务器级、不随维度**，跨维度安全 |
| **玩家不在场** | 玩家在别的维度时：声音听不到（`playsound` 目标是 @a，位置在别处），但机器照跑 | 同 a | 同 a |
| **可恢复性** | 可暂停/继续/任意 seek | 可暂停/继续/任意 seek（推荐给 `report`/`doctor` 用） | 不能 seek；重启即失效 |
| **可验收性** | 可以逐刻对账（虽然慢） | **每刻都有确定的叶子函数可对账** | 断了没有痕迹，只能靠心跳检测 |

**结论**：主干用 b2；`/schedule` 只保留一个用途——`redo` 那种"分步铺装"的链（每个铺装批次之间必须让出
主线程），并且每个 `schedule Nt` 的 `N` 必须按当前 tickRate 换算（100 tps 下 120t 只有 1.2 秒，
而那段铺装实测要 20 秒）。

---

## 3. 问题 3 · 刻率方案

### 3.1 先算清楚哪些刻率能"精确"表示 0.12 秒/步

`0.12 s = k / tps`（k 为整数刻）⇒ `tps = k / 0.12 = 8.333 k`：

| tps | 每步刻数 | 世界加速 | 单音抖动 | 实测能否跑满（现状播放器） |
|---|---|---|---|---|
| 20（默认） | 2.4（交替 2/3） | 1× | 起点 ±0.5 刻（±25 ms）、间隔 ±0.6 刻（±30 ms） | 能（100%） |
| **25** | **3（精确）** | 1.25× | **0** | **能（99.9%）** |
| 50 | 6（精确） | 2.5× | 0 | 能（~98%） |
| 100（现状） | 12（精确） | 5× | 0 | **不能（76.9%）** |

### 3.2 推荐

- **默认 25 tps**：唯一的"最小精确刻率"（3 刻/步），世界只加速 1.25 倍（作物/生物/红石/昼夜
  基本无感）；实测跑满（99.9%），对 1.7 M 条/秒的天花板还有 3 倍余量（换成 b2 派发后 ~30 倍）。
  写成一句话：**用 25 tps 换"零抖动"，用 1.25× 加速付账**。
- **20 tps 作为"零改动/不想改刻率"降级**：每步 2.4 刻 → 交错 2/3 刻，**起点误差 ≤±25 ms、
  间隔误差 ≤±30 ms，但长期节奏精确**
  （每 5 步正好 12 刻 = 0.6 s）。实现上不需要任何新东西（就是 `tick = round(step × ticksPerStep)` 的取整结果），
  代价只是快速十六分音符上有 ±25~30 ms 的"摇摆"。如果要更好，做 **Bresenham 分配**（把 0.4/0.6 的余数
  按累积误差撒开），长期仍是 0 误差，听感比"每步独立四舍五入"更稳。
- **100 tps 只作为可选的"演示/高精度"模式**，且必须：① 换成 b2 派发；② 在 tellraw 里写清副作用
  （世界 5× 加速、作物/红石/生物一起加速）；③ 验收必须能测到 ≥0.98×。
  按实测数据，现状播放器 + 100 tps = **节奏慢 23%**，比 20 tps 的 ±25~30 ms 抖动差得多。
- **不要**为了"更细的网格"去用 40/60/80 tps（0.12 s 不是整数刻），那等于把抖动换成"更慢"。

### 3.3 恢复策略（含"不改刻率"的路径）

1. `/tick rate` **不能在数据包函数里执行**（权限 3 > 函数等级 2，已实证）。
   三个可行路径，按推荐顺序：
   - **`tellraw` 里放可点击的 `click_event: {action:"run_command", value:"/tick rate 25"}`**：
     以"点击者"身份执行，单人+作弊下玩家权限足够，用户只点一下。**（我未在 1.21.10 实测过
     click_event 的权限等级，建议 M1 第一件事验证；失败就退回下面第 2 条）**
   - **`doctor` 自检 + 明确提示**：`redo` 结尾检测 `tick query` 与期望不一致时，用 tellraw 打印
     "请粘贴这一行：`/tick rate 25`"（A 组的产品口径也是这个）。
   - 命令方块/`/execute` 同样不行（同为等级 2），不要浪费时间去试。
2. **复位必须与含权限命令的文件分开**：`play/start`（含 `/tick rate`）整份加载失败，会把
   `#t=-1`、`#hits=0`、`#on=1` 一起带走 —— 这是本次 216/68 的直接原因。拆成
   `play/reset`（纯 scoreboard，永远能加载）+ `play/tickrate`（只含 `/tick rate`），
   并让 `doctor` 检查"每个函数是否加载成功"（可选：`execute if function`（1.20.5+，未实测）
   或直接解析服务器启动日志里的 `Failed to load function`）。
3. **恢复刻率**：`stop/reset` 里恢复 20（或按 tickRate）；`redo` 开头**先**把刻率归一到 20，
   再做铺装，最后才提刻率 —— 否则铺装的 `schedule` 等待会被加速 5 倍。
   好消息：实测 `/tick rate` **不写存档**（设 35 → `stop` → 重启后 `tick query` 仍报 20.0），所以
   "崩溃后世界被永久 5× 加速"这个风险不存在；坏消息是**每次都要显式设**，验收脚本不能省这一步。
4. `doctor` 的最小检查集：函数是否全部加载 · 当前刻率 · 强加载覆盖（`forceload query` vs `plan`）·
   触发位是否空（`note_block` 上方应为空气）· 计数器是否为零。

---

## 4. 问题 4 · 数据格式（`score` / `layout` / `plan` 的字段与切分理由）

### 4.1 `score.json`（音乐意图，与机器/世界/刻率无关）
```jsonc
{ "meta": { "title":"Styx Helix", "tickRate":25, "secPerStep":0.12, "ticksPerStep":3,
            "steps":2320, "totalTicks":6960, "tempoMap":[{"sec":0,"bpm":125}],
            "source":{"format":"midi+csv","sha256":"…"} },
  "voices":[{"id":"bass","instrument":"bass","rowRange":[0,12]},
            {"id":"harp","instrument":"harp","rowRange":[12,24]}],
  "notes":[ { "id":"n0001", "voice":"bass", "step":0, "timeSec":0.000, "midi":33,
              "row":9, "volume":0.35, "lenSteps":1, "srcNoteId":33 } ],
  "degradations":[ {"noteId":"n0001","kind":"octave-fold","detail":"…","evidence":"…"} ] }
```
关键：**只存 `step`，不存 `tick`**。`tick = step × meta.ticksPerStep` 由消费方派生。
这样换刻率（100→25）只需要改 `meta.tickRate/ticksPerStep`，不需要重跑 `analyze/arrange`。
（现状把 100 tps 的 tick 烤进了 CSV 和每一条 guard，所以换刻率=全链路重生成。）

### 4.2 `layout.json`（空间落地，与世界/机型有关，与音乐无关）
```jsonc
{ "meta": { "world":"Styx Helix", "dimension":"minecraft:overworld",
            "machine":"single-row", "segLen":48, "rowToZ":{"base":-172,"offset":3,"dir":1} },
  "segments":[ { "k":39, "x0":2352, "z0":-172, "y":95, "terrain":112,
                 "cutAboveFrom":97, "cutTo":112, "deck":"black_stained_glass" } ],
  "cells":[ { "step":1120, "row":16, "x":1600, "y":84, "z":-153 } ],
  "structures":[ {"name":"styx:flat_b_39","size":[3,48,32],"sha256":"…"} ] }
```
- `segments[].y / cutAboveFrom / cutTo`：剖面与开槽（地形变了只重跑 `layout`，音符不动）。
- `meta.rowToZ`：把"行号"翻译成世界 z 的规则（机型变了只改这里）。
- `cells[]`：**预展开的落点**，给 `verify` 逐格核对用（不用再实现一遍坐标数学 → 杜绝口径漂移）。

### 4.3 `plan.json`（刻→音符组，`emit` 与 `verify` 共用）
见 §1.1 的示例。字段要点：
- `groups[].tick` = 该刻要执行的**全部**音符（含世界坐标、乐器、`note`、`volume`、灯位）。
- `forceload[]`：**按区域给出 `firstTick/lastTick`**，播放器只在"该区域最后一个音之后"才允许卸载它
  （这就是 §0.4 那个 bug 的正确修法：切换点是**数据算出来的**，不是常量）。
- `regions[]`：区域单元（结构 + 音符 + 灯 + 首末 tick），给 `deploy --region` 做增量与回退。

### 4.4 为什么这样切分（回退与增量）

| 变更 | 需要重跑 | 不需要重跑 |
|---|---|---|
| 换刻率 100 → 25 | `plan` → `emit` | `ingest/analyze/arrange/layout`（音符与落点不变） |
| 换音色/加打击乐 | `arrange` → `plan` → `emit` | `ingest/analyze/layout`（结构与地形不变） |
| 地形变了/换机型 | `layout` → `plan` → `emit`（+ `deploy --region`） | `ingest/analyze/arrange`（音乐不动） |
| 只想修一个区域 | `deploy --region k` | 其他区域、结构 NBT |
| 回退 | `deploy --undo`（按 `manifest.json` 逐格对比） | — |

每一层都带 sha256，`verify-report.json` 里记录"用了哪份 score/layout/plan"，
于是"分数变好了"永远可归因到某一层的某次改动。

---

## 5. 问题 5 · 验收与可观测性（怎么让"听不到"变成数字）

### 5.1 三层证据（缺一层就会假绿）

**T1 静态/离线**（秒级，改代码就自动跑）
1. 数据包加载：启动日志里 `Failed to load function` 必须为 0（现状 3 条）。
2. 契约：`plan ↔ score` 一致（每刻音数、`row ∈ 0..24`、撞格 = 0、`tick = step×ticksPerStep`）。
3. `emit` 幂等：连跑两次，输出目录**字节一致**且 `manifest.json` 相同。

**T2 游戏内状态见证**（这是当前最缺的一层）
0. **确定性刻步进做骨架**（推荐，实测可用）：验收不许用固定 `sleep`，改成
   `tick rate <目标>` → `tick freeze`（回声 `The game is frozen`）→ `function styx:play/reset` →
   `scoreboard players set #on styx.flag 1` → `tick step N`（回声 `Stepping N tick(s)`）→ 读计数器 → 断言 →
   `tick unfreeze`。冻结期间 tick 标签照常执行（实测 `#beat` 随 step 推进），所以播放逻辑与墙钟彻底解耦，
   结果可复现；顺序与并发问题（空服暂停、机器性能、上一次运行残留）全部消失。
   **注意：`/tick rate` 不会写进存档**（实测：设 35 → `stop` → 重启后 `tick query` 回到 20.0），
   所以每次验收都必须显式设一次，不能依赖"上次设过"。
1. **同刻充能见证**：每个音符在 `setblock 触发块` 与 `setblock air` 之间插一条
   `execute if block <note_block> minecraft:note_block[powered=true] run scoreboard players add #w styx.flag 1`
   （实测有效：对照场景 `powered=true` 为真，未加载区块上为假）。
   **`#w` 才叫"真的会响的音符数"**；`#hits` 只说明"命令执行了"。
2. **每刻累计对账**：把 `plan.groups` 展开成 `#exp` 累加函数（实测 1821 行，约 +1800 条/刻）
   挂到 tick 标签尾部；收尾比较 `#hits − #exp`（本轮实测 20/25/100 tps 全部为 0）。
3. **区块覆盖断言**：`plan` 涉及的区块集合 vs `forceload query`，每个音符开播时刻必须 loaded
   （用 `execute if loaded <x> <y> <z>` 抽查，实测能区分 true/false）。
4. **刻率达成**：`Δ#beat / Δwall ≥ 0.98 × 目标`（本轮实测 100 tps 只有 0.77 → 不合格）。

**T3 声学（真·听得到）**：仓库里已有链路 `build/tools/audio_capture_test.mjs`
（无头 Fabric 客户端 + VB-Audio 虚拟声卡 + ffmpeg 录 48 kHz WAV，`testserver/capture.wav` 是它的产物，
本轮未复验）。录下来之后可以做**客观声学指标**：
- 起音点检测（能量上升沿）→ 起音数量、与 `plan` 时间轴互相关求 **offset(ms)** 与 **drift(ms/min)**；
- 音级 chroma 相似度 / 八度命中率 / 力度包络相关（与 C 组的 10 条人耳清单互为印证）。
这样"听不到/不好听"就变成"起音 F1 = 0.94 / offset = 32 ms / drift = 20 ms/min"这种可追踪的曲线。

### 5.2 度量换算（修正设计文档的口径 bug）

- 服务器能跑满刻率的**必要条件**是 `MSPT ≤ 1000 / tickRate`：
  20 tps → 50 ms（= DESIGN 里写的 50），25 tps → 40 ms，50 tps → 20 ms，**100 tps → 10 ms**。
  `DESIGN.md` 的"MSPT ≤ 50（即推进 ≥ 20 tps）"在 100 tps 下是自相矛盾的（50 ms × 100 = 5 s CPU/秒）。
  验收请写 **"实测推进刻率 ≥ 0.98 × 设定刻率"**，MSPT 只用来解释"为什么没跑满"。
- 本机经验常数（可复用到任何优化决策）：**≈1.7 M 条命令/秒**（`-Xms1G -Xmx2G`，237 区块强加载）。
  每刻命令预算 = 1.7 M / tickRate：25 tps → 68k，100 tps → 17k。

### 5.3 测试矩阵

| # | 层级 | 做法 | 通过判据 | 现状 |
|---|---|---|---|---|
| 1 | T1 | 起服后 grep `Failed to load function` | 0 条 | ❌ 3 条（`play/start|stop|reset`） |
| 2 | T1 | `emit` 连跑两次 + diff | 字节一致 + manifest 相同 | ⚠️ 未做（输出目录不清空；196 个结构里 147 个是死重量） |
| 3 | T1 | `plan ↔ score` 契约校验 | 全部断言通过 | ⚠️ 无 plan、无校验器 |
| 4 | T2 | 抽样 100 格 `if block note_block[instrument,note]` | 100/100 命中 | ⚠️ 现在只抽查 4 条 |
| 5 | **T2** | **`#w` 充能见证 vs plan** | **差 0** | ❌ 现在只有 `#hits`（不能证明发声） |
| 6 | T2 | `#exp` 每刻累计对账 | 收尾 `#hits − #exp = 0` | ✅ 探针已验证（20/25/100 tps 差值 0） |
| 7 | T2 | `forceload query` + `if loaded` 抽查 | 每个音符开播时刻其区块 loaded | ❌ 实测切换后 x<1728 未加载 |
| 8 | T2 | 刻率达成 Δ#beat/Δwall | ≥0.98 × 目标 | ❌ 100 tps = 0.77 |
| 9 | T2 | 确定性复现：同一 plan 用 `tick freeze`+`tick step` 跑两遍 | 两次读数逐位一致 | ✅ 机制已实测可用（双跑对比待做） |
| 10 | T2 | 全曲跑完（25 tps，6960 刻 ≈ 4:38） | `#w = 3099`、0 报错 | ⚠️ 现在只跑 20 秒片段 |
| 11 | T3 | 客户端录音 + 起音检测 | 起音数 = 音符数、offset < 50 ms、drift < 100 ms/min | ⚠️ 链路已存在，未复验 |
| 12 | T1/T2 | 备份 → `redo` → `undo` → 逐格 diff | 差 0 | ⚠️ `undo_*` 函数存在，未自动化 |
| 13 | 主观 | C 组 10 条人耳清单 | 达标 | ⚠️ 未做 |

**验收脚本的三条纪律**（直接针对本次的 216/68）：
1. 每条会影响状态的命令都要**断言回声**（`Unknown function` / `That position is not loaded` 都要判失败）；
2. 读数前显式复位（`#t=-1 #hits=0 #w=0 #exp=0 #on=1`），且复位代码不能和含权限命令放在同一个文件；
3. 容差为零（`差 0`），不允许"≤2 就算过"这类宽松判据。

---

## 6. 风险清单（最可能让项目失败的 5 件事 + 缓解）

| # | 风险 | 为什么致命 | 缓解 |
|---|---|---|---|
| 1 | **验收假绿**：计数只证明"命令执行"，不证明"发声" | 实测：未加载区块上 `setblock` 失败而 `#hits` 仍 +1；脚本不校验启动成功、不清零 → 1326 个音静默丢失、43% 内容缺失却"全部通过"；本轮 216/68 就是它的产物 | T2 三件套（`#w` 见证 + `#exp` 对账 + 区块覆盖断言）；验收脚本先断言命令回声、再复位、容差 0；T3 录音作为独立证据 |
| 2 | **时间常量多处复制**（0.12 / 20 / 100） | 已经炸过一次：`SWITCH_TICK = 1248*0.12*20` 在 100 tps 时间轴上提前 1000 步切卸载；`redo` 的 `schedule 120t` 在 100 tps 下只有 1.2 s | 唯一来源 `score/plan.meta`；`emit/redo/test` 全部派生；加 grep 测试禁止裸 `0.12`/`20`/`100`；切换点由 `plan.forceload[].lastTick` 算出 |
| 3 | **刻率与负载不自洽** | 100 tps 实测只有 73~77%，"用高刻率换精确"反而慢 23%；MSPT 目标写错（≤50 ms @100 tps 不可能） | 默认 25 tps（实测 100%）；b2 派发把每刻从 2.2 万降到 ~60 条；一号验收指标改成"实测推进刻率 ≥0.98×"；100 tps 降级为可选并标注副作用 |
| 4 | **输入不可信 + 无溯源** | C 组已量化（贝斯八度命中率 30.8%、276 处撞格、音级被吸到单一音阶）；而 `build/` 里 7 种中间格式互不对应、无哈希、且**不在 git 里** → 既无法证明"改好了"，也无法回退 | `project/analysis/score/layout/plan` 全量 JSON + sha256；每步 `report.json` 显式 `degradations[]`；`work/` 可重建但哈希进 git（或把关键产物入库） |
| 5 | **大而脆的单体交付**：2352 格、196 结构文件、3099 音、60+ 历史函数、强加载切换 | 任何地形漂移都要全量重铺（`apply_notes_v3` 单函数就要 20 s）；失败无细粒度回退；数据包体积/解析成本翻倍 | 按 `plan.regions` 做区域单元（含首末 tick + 结构 + 音符），`deploy --region/--undo`；`emit` 先清空 + `manifest.json`；`undo` 逐格 diff 进 DoD；铺装分批 + 进度提示（现在是一口气 2 万条命令） |

（附：还有一个"一条命令"承诺的持续性风险——`/tick rate` 只能由玩家/控制台执行。
它不会让项目失败，但会让产品承诺降级为"点一下/粘一行"；见 §3.3 的三条路径。）

---

## 附：本轮证据与探针脚本

```
_probe/arch-tickrate/
  probe.mjs      # 区块/强加载复现 + 触发充能对照（probe.log / SUMMARY.txt）
  probe2.mjs     # 20/25/50/100 tps 粗测（probe2.log / SUMMARY2.txt）
  probe3.mjs     # 精确刻率 + 每刻累计对账（#exp），验证"触发差 0"（probe3.log / SUMMARY3.txt）
  probe4.mjs     # 空转 vs 播放 分离量：世界本身 99.99 刻/秒，播放器掉到 76.9（probe4.log / SUMMARY4.txt）
  probe5.mjs     # tick rate 是否持久化（probe5.log / SUMMARY5.txt）
  probe6.mjs     # tick freeze + tick step 100 的确定性步进（probe6.log / SUMMARY6.txt）
```

关键原始行（可直接复查）：
```
probe.log:  [00:32:05] #t has -1 [styx.t]        ← play/start 没执行，tick 也在跑（#on 残留）
probe.log:  [00:32:28] #t has 1049 [styx.t]
probe.log:  [00:32:16] Can't keep up! ... Running 1201ms or 120 ticks behind
probe.log:  [00:32:50] That position is not loaded      ← 未加载区块上的 setblock 失败
probe3.log: @20tps  20.00 刻/秒  #hits=23 应触发=23 差值=0
probe3.log: @25tps  24.98 刻/秒  #hits=25 应触发=25 差值=0
probe3.log: @100tps 72.70 刻/秒  #hits=67 应触发=67 差值=0
probe4.log: 空转@100tps 99.99 刻/秒 / 播放@100tps 76.95 刻/秒
probe5.log: 重启后 tick query → "Target tick rate: 20.0 per second"   ← tick rate 不持久化
probe6.log: 冻结回声 "The game is frozen"；步进回声 "Stepping 100 tick(s)"；#beat 随 step 推进
```

本文只讨论技术架构；产品口径以 `DISCUSSION-A-product.md` 为准，数据口径以
`DISCUSSION-C-music.md` 为准。三个数字是本组的取舍基线：**每刻 21,977 条 → ~60 条**、
**100 tps(77%) → 25 tps(100%)**、**"计数=发声" → "计数 + 充能见证 + 区块覆盖 + 录音"**。
