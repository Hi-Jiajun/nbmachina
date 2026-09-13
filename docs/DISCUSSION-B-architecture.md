# 讨论 B · 技术架构视角（nbforge）

> 产出方：子代理（对应任务书 `nbforge-B-architecture.md`），背景见 `nbforge-brief.md`。
> 上游输入：`DISCUSSION-A-product.md`（产品）、`DISCUSSION-C-music.md`（音乐）。本文只给架构结论与取舍，不含实现代码。
> 文中所有数字都是**本次在 `build/` 真实产物与本机服务器日志上实测的**（口径与证据行号见 §9）；凡属推演的地方已显式标注"待实测"。

## 0. 结论先行

1. **"一条命令跑完"现在跑不通，根因是权限与派发两个架构问题，不是音色问题。** `styx:play/start`、`play/stop`、`play/reset` 三个函数在服务端**整体加载失败**（`v3test.log:5/22/39`；报错定位在 `start` 第 9 行、`stop` 第 7 行、`reset` 第 11 行），而这三行恰好是 `tick rate`。调用处随即报 `Unknown function styx:play/start`（`v3test.log:85`）。
2. **`/tick` 必须从数据包里彻底移除。** 数据包函数以权限等级 2 执行，`/tick` 需要等级 3（玩家/控制台）。函数里出现这类命令 → **整个函数不可加载**，不是"这一行被跳过"。刻率只有两个合法入口：玩家在聊天里敲，或服务器控制台/RCON 下发。因此 M1 的刻率方案必须改成"外部注入 + `styx:doctor` 自检"。
3. **默认刻率选 20 tps**：`tick = round(step × 2.4)`，单音抖动 ≤ ±0.5 刻（**±25 ms**）且不累积。这一条同时消灭三件事：权限 bug、5× 派发成本、以及"世界被 5× 加速且**函数无法自动恢复**"的存档级风险（`tick rate` 会持久化进存档）。100 tps 降级为可选"精确模式"，由玩家敲一条命令进入，`doctor` 里报告当前值。
4. **派发的真实成本是"函数调用次数"，不是命令条数。** 现状 279 次/刻；整曲 27,841 刻 × 279 = **7,767,639 次函数调用**（100 tps 下 2.79 万次/秒）。桶命令总量 **21,696 行**（每条都带一遍 `#t` 守卫，每颗音 6 条），单刻真正被求值的只有当前桶的 **~78 行**（最重的 b168 有 155 行），真正生效的仅 ~10 行。→ brief 里"≈2.8 万条命令/刻"是把桶文件**总量**误当**单刻**成本，高估约 **350 倍**。
5. **两级派发把 279 次/刻压到 19 次/刻（省 14.7×，整曲 53 万次调用）**：17 个"章"守卫 + 1 次章函数 + 1 次桶函数。进一步可用 `/schedule` 链把空闲刻成本降到 0（整曲 ~2,000 次调用），代价与失败模式见 §3.2。
6. **本次新发现两个"必然漏音/徒劳"的实装 bug**（代码 + 算术证据）：
   - `SWITCH_TICK` **差 5 倍**：`Math.round(1248 × 0.12 × 20) = 2995`，而 100 tps 播放轴上该切换点应为 `1248 × 12 = 14976`。后果：演奏开始约 10.8 秒后 `forceload remove all` 会解除前半段（x480..1727）强加载，而那里还有 ~1,000 颗音没播完 → 只要玩家不在旁边，这些音**不响**。
   - `apply_notes_v3.mcfunction` 有 **15,496 行 / 755 KB**，redo 链把它**整文件跑了 3 遍**（s2/s3/s4）= 46,488 条 `setblock`，而每次只有当前加载窗口内的命令真正生效 → 应改成"按强加载窗口分片"的 apply_notes_1/2/3。
7. **216 vs 68 是测量假象，不是漏音**（完整证据链见 §6.1）：三个函数加载失败 ⇒ 计数器从未清零；计数器存在 `level.dat` 里**跨会话残留**；`#t` 从 485 涨到 1684（Δ=1199 ≈ 60 s × **20** tps）证明 **100 tps 根本没生效**；`Server empty for 60 seconds, pausing`（`v3test.log:86`）把刻轴冻住；脚本又"先读 `#t`、隔 600 ms 再读 `#hits`"。五个问题叠在一起，这个数字不能当验收依据。
8. **验收必须改成确定性刻步进**：`tick freeze` → `function styx:play/start` → `tick step N` → 读计数器 → 断言 → `tick unfreeze`。它与墙钟、空服暂停、机器性能全部解耦（1.21.10 语义待 M1 实测确认）。
9. **现在的验收脚本永远不会失败**：`run-headless.mjs` 只打印 ✅/⚠️，最后是 `process.exit(0)`；并且用固定 `sleep`（9s/6s/20s/20s）代替日志驱动，还往**共享的** `testserver/world` 里覆盖数据包（脏世界 + 残留计数器）。→ 断言必须落到**退出码**，并复用干净世界模板。
10. **模块化的最大缺口是"没有契约"**：`src/` 里没有 `ingest/verify/deploy`，没有 `project.json`/`score.json`，没有 `report.json`，路径写死（`C:/Users/hiliang/...`、PCL2 存档路径、java.exe 路径）。§2 给出重排方案：七步模块 + 单一 CLI + 每步 report + `manifest.json`（顺带解决陈旧函数问题）。

## 1. 现状快照（实测）

| 项目 | 实测值 | 口径 |
|---|---|---|
| 音符 / 时间轴 | **3,099 音**（harp 1,739 / bass 1,360），落在 **1,821 个刻**上，末刻 **27,840**，平均 1.70 音/刻，最密 4 音/刻 | `build/styx_helix_notes_v3.csv` |
| 时间稀疏度 | 只有 **6.5%** 的刻有音符（1,821 / 27,841）；4 个桶内一颗音都没有 | 同上 + `play/` 桶文件 |
| 桶文件 | **279 个**，合计 **21,696 行**，平均 77.8 行/桶，最重 `b168` = 155 行 | `play/b000..b278.mcfunction` |
| 每刻派发 | `play/tick.mcfunction` = **281 行**（1 计刻 + **279 次函数调用** + 1 收尾判断），19.3 KB | 同上 |
| 派发总量 | 27,841 刻 × 279 = **7,767,639 次调用/曲**；100 tps 下 **27,900 次/秒** | 算术 |
| `play/` 目录 | **288 个文件** = 279 桶 + 9 辅助；其中 `bass_guitar_on|off` 在当前生成器里**已无出处**（陈旧残留） | 目录清单 + `rg bass_guitar src/` 无命中 |
| 数据包规模 | `styx/function/` **327 个函数**（含 `fix_instruments` 5,669 行、`lamps*` 4×2,834 行、`flat_build*` 6 个版本、`light_v1|v2|v3` 等历史家族），`styx/structure/` 196 个结构 | 目录清单 |
| 机器 | 49 段 × 48 格 = **2,352 格**（x 480..2831），y 从 84（前 38 段）逐段爬到 110，8 段需要开槽削山；进深 z 32 格 | `build/single_row_profile.json` |
| 强加载需求 | x 向 ~147 区块 × z 向 3 区块 ≈ **441 区块**，远超 `forceload add` 单次 256 区块上限 → 必须分两段、且**在正确的刻切换** | 算术 + `datapack-playback.mjs` 注释 |

## 2. 流水线划分与 `src/` 重构

### 2.1 七步（SPEC v0.3 的模块表 + 我补的运行时约束）

| 步骤 | 输入 | 输出 | 幂等性要求 | 现状 |
|---|---|---|---|---|
| `ingest` | 音频 / MIDI / MusicXML / PDF(OMR) / 手写 | `project.json` | 同一输入 → 同字节输出；带 `source.sha256` | **不存在** |
| `analyze` | `project.json` + 音频 | `analysis.json`（速度、音域、八度证据、chroma、力度证据） | 只读输入，纯函数式 | 拆成 3 个脚本，输出只有控制台文字 + `notes*.csv` |
| `arrange` | `project.json` + `analysis.json` | `score.json` + `arrange-report.json` | 覆盖式产出，带 `degradations[]` | `arrange-notes.mjs` 直接吐 CSV + 一个 15,496 行的 mcfunction |
| `layout` | `score.json` + 世界地形 | `layout.json` + `build*.mcfunction` | **不得原地改地形输入** | `single-row-layout.mjs` 读存档 region 并**覆盖写回** `single_row_profile.json` |
| `emit` | `score.json` + `layout.json` | 数据包 + `manifest.json` + 安装脚本 | 先清空命名空间再生成 | 只写不删 → 陈旧函数（`bass_guitar_*` 等） |
| `verify` | 数据包 + 音频 | `report.json`（客观指标 + 综合分） | 只读 | **不存在**（`run-headless.mjs` 是打印式脚本） |
| `deploy` | 数据包 | 存档内安装 + 前像快照 + `undo` | 可回退到逐格差异 0 | `undo.mcfunction` 仅 3 行调用 + 硬编码 `fill`，**redo 流程里根本没有生成前像** |

### 2.2 差异清单（可直接派活）

1. **缺三块**：`ingest`（契约入口）、`verify`（客观评分）、`deploy`（备份/回退）。没有前两者，"保真契约"只是口号；没有后者，A 组的成功标准 5（回退后逐格差异 0）无法满足。
2. **没有内部契约文件**：现在数据在 `build/*.csv` 与散落 JSON 间流动，没有 `project.json` / `score.json` / `layout.json`；`emit` 直接读 CSV 绕过 `arrange` 的输出。
3. **路径全写死**：`B = 'C:/Users/hiliang/Documents/minecraft/build'`、`SAVE = 'C:/Program Files/PCL2/.../saves/Styx Helix'`、`JAVA = .../java-runtime-delta/bin/java.exe`、`TS/SRC/LOG` 等。任何第二个用户都跑不起来 → 必须全部走 CLI 参数/环境变量，并在 report 里回显生效值。
4. **没有报告**：每步都不产出 `report.json`，降级项（折叠、丢音、撞格、开槽）只存在于控制台滚屏里 → 不可回归、不可 diff。
5. **生成物不清空**：`play/` 里留着 `bass_guitar_on|off`；数据包里留着 `fix_instruments`、`lamps*` 4 个版本、`flat_build*` 6 个版本。`manifest.json` + "写前清空"是唯一可靠解法。
6. **层级混乱**：`scan/`（存档侧扫描）与 `test/`（验收）和六个流水线模块平级；`research/bili_*.mjs`（B 站调研）与本项目无关，应移出。
7. **世界数据被当输入又被当输出**：`layout` 既读 `single_row_profile.json` 又覆盖写它 → 无法 diff、无法回退到上一版剖面。

### 2.3 建议的目录与 CLI

```
nbforge.mjs                 # 唯一入口：nbforge <step|all> [options]
src/ingest|analyze|arrange|layout|emit|verify|deploy/
tools/                      # 一次性工具（结构加宽、旧包清理）
legacy/                     # 已取代但保留参考的脚本
build/<project>/            # 全部产物 + 每步 report + manifest（可整体删除重建）
tests/                      # node:test
docs/
```

- 每个模块 = `node src/<mod>/<name>.mjs --in … --out …`，**只通过文件通信**，退出码即成功/失败，可被任何第三方实现替换。
- 每步产出 `<step>.report.json`：`{step, params, inputs{path,sha256}, outputs{path,sha256}, warnings[], degradations[], metrics{}}`。
- `emit` 生成 `manifest.json`（函数/结构清单 + 每个函数的用途与条数）；`deploy` 依据 manifest 删除上一版遗留、写前像快照、从快照生成 `undo`。**`undo` 应该是数据，不是手写的 `fill` 常量**。
- `build/<project>/` 一棵树放全部产物，`git clean` 或删目录即可重来；产物必须字节级可复现（同样的 `project.json` → 同样的数据包）。

### 2.4 幂等性检查表（现状 → 目标）

| 步骤 | 现状幂等？ | 缺口 | 目标 |
|---|---|---|---|
| analyze | 是 | 输出不落文件 | 落 `analysis.json` |
| arrange | 是 | 覆盖旧 CSV，且顺带写 mcfunction（职责混） | 只出 `score.json`；mcfunction 归 emit |
| layout | **否** | 读 `profile.json` → 覆盖写同一文件；依赖实时存档 | 输入 `--world`，输出带版本的 `layout.json` |
| emit | **否** | 不清空输出目录 | 先清空 + manifest |
| verify | 不存在 | — | 只读、可重复、非零退出 |
| deploy | **否** | 无前像、`undo` 硬编码 | 快照 + 生成的 undo |

## 3. 运行时架构：播放器派发

### 3.1 现状的真实成本（先把口径纠正）

- 每颗音 = **6 条守卫命令**（放红石块、拆红石块、`#hits+1`、点灯、监听 `playsound`、监听计数）+ 上一组灯的 1 条熄灭 → 全曲 **21,696 行**，实测 `#hits` 行数 = 3,099、红石块行数 = 3,099、点灯行数 = 3,099（三者完全一致，说明"一音一触发"语义本身是对的）。
- 单刻被**求值**的命令 = 当前桶的全部行（平均 **77.8**，最重 155），其中真正生效 ~10 行。
- 单刻被**调用**的函数 = **279**（+1 计刻 +1 收尾）。这是主导成本：100 tps → 27.9k 调用/秒；20 tps → 5.6k 调用/秒。
- **MSPT 目前没有实测证据**（日志里没有 `Can't keep up` 也没有 MSPT 记录）。`MSPT ≤ 50` 这条成功标准目前是"未验证的目标"，M1 必须实测。

### 3.2 四种派发方案对比

| 方案 | 调用/刻 | 整曲调用 | 文件数 | 失败模式 | 可验证性 | 结论 |
|---|---|---|---|---|---|---|
| **a) 现状**：每刻扫全部桶，桶内逐条 `#t` 守卫 | **279** | 777 万 | 279 | 线性膨胀（歌越长越贵）；守卫写错一格就静默错音；`forceload` 切换与时间轴不同源（就是 §0.6 的 bug） | 容易（计数对照） | 必须改 |
| **b) 层级派发**：章（17）→ 桶（17）→ 刻函数 | **19** | 53 万 | 279 + 17 + ~1,821 | 与现状同类（全同步、全在刻内），最大风险只是"章边界写错"→由生成器派生即可 | 容易（同 a，另加边界单测） | **推荐（阶段 1+2）** |
| **c) `/schedule` 事件链**：start 时只给"有音符的刻"排期 | **~0（空闲）** | ~2,000 | ~1,821（或两级：17 章 + 章内排期） | ① 排期存在 `level.dat`，崩溃/存档重启后会**带残留续跑**；② `/reload` 后 id 解析行为需实测；③ 取消要逐 id `schedule clear` → 需要代次守卫 `#gen` | 中等（要专门测残留） | 阶段 3 可选 |
| **d) 压缩单一"刻→音符组"表 + 二分/哈希** | log₂(1,821)≈11 | 31 万 | ~1,821 + 树节点 | Minecraft 函数**没有动态索引**，只能靠守卫二叉树，文件数与 b 同量级但更难生成与调试 | 中等 | 本质是 b 的变体，不选 |

> 补充一个**产品级**替代：把机器从"单排 2,352 格"改成 S 形折返/双排（`layout` 模块的职责），区块需求从 ~441 降到 ~150，`forceload` 一次装得下 → 直接消掉"两段切换"这一类 bug。代价是改造现有存档建筑，收益是可维护性。建议列为 M2 的候选，不阻塞 M1。

### 3.3 推荐路线（每阶段独立可验收）

- **阶段 1（低风险，立刻做）**：把守卫从"每条命令一遍"改成"每次派发一遍"——`execute if score #t styx.t matches <t> run function styx:play/tNNN`，桶内不再写守卫。效果：单刻求值行数 78 → ~10，代码量减半，且 `#hits` 语义可逐刻核对。
- **阶段 2**：两级派发（章 → 桶），279 → **19 次/刻**。章数 `g = ceil(sqrt(桶数))`，由生成器算，禁止手写。
- **阶段 3（可选）**：`/schedule` 链；只在阶段 2 仍达不到 MSPT 目标时才上。上之前必须做"崩溃残留"实验：跑一半 kill 服务器，重启后确认旧排期不会与新一次演奏叠加（`#gen` 代次守卫 + start 里 `schedule clear`）。
- **阶段 4（可选）**：把 `forceload` 切换并进同一张时间表；当前加载窗口写进 `#win` 分数，`doctor` 里断言"窗口 ⊇ 本刻音符所在 x 范围"。

### 3.4 丢刻、卡顿、跨维度

- **丢刻（服务器跟不上）**：只要派发轴是**刻**（而不是墙钟），音符之间的相对间隔永远不会错，最坏结果是整曲被拉长。这是"用刻轴派发"的核心优点，20/100 tps 都成立。
- **卡顿**：单刻最重的工作是"一个桶"（155 行）而不是"全曲"，所以尖峰可控；真正的风险在于 100 tps 把每秒钟的派发量放大 5 倍。
- **跨维度**：`forceload` 是按维度生效的，主世界机器在玩家跑进下界/末地时**仍保持加载**，函数标签也全局执行，因此 `setblock`/音符盒依旧工作；但**声音**只有主世界附近的玩家听得到（监听模式是 A/C 组的设计，不解决"人不在主世界"）。`#hits` 计数与维度无关，可放心用于验收。
- **多人**：本 MVP 明确不做；但 `#hits` 用全局假名分数（`#hits`），天然与玩家数无关，这一点对将来扩展是好架构。

## 4. 刻率方案

### 4.1 硬约束（实测）

- `/tick` 在数据包函数里**不可用**：`v3test.log:39-51` 明确报 `Whilst parsing command on line 9: Unknown or incomplete command`，随后 `Unknown function styx:play/start`。三个含 `tick rate` 的函数同时废掉。
- `tick rate` 是**存档级设置**，会持久化；一旦玩家敲了 100 又中途退出，世界就停在 100 tps，而**没有任何函数能把它改回来**——只能玩家再敲一次。这是必须写进 `doctor` 提示的真实风险。
- 100 tps 的代价不止"作物/生物/红石 5× 加速"：派发从 5.6k 次/秒涨到 **27.9k 次/秒**，而收益只是"0.12 s 的步长落在整数刻上"。

### 4.2 三个档位

| 方案 | 步长精度 | 单音抖动 | 世界副作用 | 派发成本/秒 | 入口 |
|---|---|---|---|---|---|
| **20 tps（推荐默认）** | `round(step × 2.4)` | ≤ ±0.5 刻 = **±25 ms**，不累积 | 无 | 5.6k | 无需任何命令 |
| 100 tps（精确模式） | 每步 12 刻，完全精确 | 0 | 全世界 5× 加速；需手动恢复 | 27.9k | 玩家/控制台敲 `/tick rate 100` |
| 其它（如 40/50 tps） | 0.12 s × 40 = 4.8 刻 → 仍需取整 | ±0.5 刻 | 2×/2.5× 加速 | 11k~14k | 同上 |

> 20 tps 的 `2.4` 是"2,3,2,3…"的确定性交替（每 5 步恰好 12 刻），不是随机抖动；整曲总长仍是 278.4 s。人耳对 25 ms 的起音抖动基本不可察（16 分音符是 120 ms）。

### 4.3 推荐

1. **默认 20 tps**，`score.json` 里同时保留 `onsetSec` 与 `meta.tps`，emit 时按目标刻率渲染 tick。这样"要不要 100 tps"变成一个渲染参数，而不是代码里的硬编码（现在 `PLAY_TPS = 100` 写在 `arrange-notes.mjs` 里，四处派生常量各自手算，这就是 §0.6 那个 5× bug 的土壤）。
2. 保留 100 tps 作为 `--tick100` 产物；进游戏时由**玩家**敲 `/tick rate 100`（`styx:redo` 里只 `tellraw` 提示，不尝试执行）。
3. `styx:doctor` 必须报告四项：当前 `tick rate`、本刻应播放的音符数、`forceload` 窗口、`#hits/#t/#on` 现值。任何一项不符就明确告诉用户"现在这一遍不算数"。

## 5. 数据格式（契约）

### 5.1 五个文件，三类信息

| 文件 | 承载 | 关键字段 | 为什么这样切 |
|---|---|---|---|
| `project.json` | **音乐意图**（与机器无关） | `meta{title,tempo,license,source{format,path,sha256}}`、`voices[]`、`notes[]{voice,onsetSec,durSec,midi,velocity,tie}`、`tempoMap[]`、`annotations[]` | 时间真源是**秒**；可 1:1 映射 MusicXML/SMF；换机器、换刻率都不用改它 |
| `analysis.json` | **对原曲的客观证据** | `perNote[]{id,midi,chroma12[12],octaveScores[8],bestOctave,bandEnergy,window{start,ms,hann}}`、`tempo{secPerStep,confidence}` | 证据必须与结论分开存：M0 的"修数据"全靠它，且可复查口径 |
| `score.json` | **音符盒可演奏层** | `meta{tps,secPerStep,steps,totalTicks,layoutHint}`、`notes[]{id,step,tick,voice,instrument,row,velocity,lenSteps,srcMidi,flags[]}`、`degradations[]{noteId,kind,detail}` | 单一可演奏真源；双后端（原版/mod）共享它；`degradations` 就是"保真契约"的落点 |
| `layout.json` | **空间与机器** | `machine{type,version}`、`segments[]{k,x0,z0,y,terrain,cutAboveFrom}`、`cell{stepToXZ}`、`forceload[]{tickFrom,from,to}`、`trigger{dx,dy,dz}`（红石块位、灯位） | 只有它依赖世界；地形变了只重跑 layout，不动音乐 |
| `manifest.json`（emit 产物） | **生成物清单** | `files[]{path,kind,lines,sha256,usedBy}`、`legacy[]`（本次删除的旧文件） | 解决"陈旧函数"这一类事故（`bass_guitar_*`、`fix_instruments`、`lamps*`） |

### 5.2 两条硬规则

1. **时间轴单点定义**：所有刻/秒换算只允许出现在 `score.json.meta` 与一个工具函数里；`SWITCH_TICK`、`totalTicks`、`forceload` 切换刻**全部由它派生**。禁止再出现 `Math.round(1248 * 0.12 * 20)` 这种手算常量。
2. **增量更新**：`score.json` 的音符有稳定 `id`（`step|voice|row` 或内容哈希），`emit` 用"上一版 manifest ↔ 新版 score"做差，只生成 `apply_delta.mcfunction`（增/删/移三类命令）。当前每次改谱都要重跑 15,496 行的全量 apply_notes。

### 5.3 回退

`deploy` 在写入前记录**前像**（受影响坐标 → 原方块状态），产出 `undo.mcfunction` 与快照哈希；`undo` 的顺序与 `apply` 严格相反。这样"回退后逐格差异 0"才是可验证的（现在 `undo.mcfunction` 只有 3 行调用 + 硬编码 `fill` 矩形，A 组那条成功标准实际无法证明）。

## 6. 验收与可观测性

### 6.1 为什么现在的验收结果不可信（证据链）

| # | 证据 | 结论 |
|---|---|---|
| 1 | `v3test.log:5/22/39` 三个函数加载失败 → `v3test.log:85` `Unknown function styx:play/start` | 负责清零的 `start/reset` 从未执行，`#hits/#t/#on/#mon` **没有复位** |
| 2 | 计数器是假名分数，落在 `level.dat`；测试服世界被多次复用 | 上一次（`redotest` 等）的数字会**粘到**下一次 |
| 3 | `#t`：485（`redotest.log:24`）→ 1684（`v3test.log:87`），Δ=1199 ≈ 60 s × **20** tps | 100 tps **从未生效**（唯一设置它的函数加载失败），而 100 tps 正是"0.12 s = 12 刻"这条设计的全部依据 |
| 4 | `v3test.log:86` `Server empty for 60 seconds, pausing` | 无人时的服务器会暂停模拟，刻轴**冻住**（`redotest.log:24/27` 两次读数都是 485，间隔 6 秒）→ 任何基于墙钟的采样都不可靠 |
| 5 | `run-headless.mjs`：先读 `#t`、隔 600 ms 再读 `#hits`，期望值却按"最后一次 `#t`"计算；固定 `sleep`；`process.exit(0)` | 采样不同刻 + 永不失败 → 脚本既可能误报漏音，也永远无法拦住回归 |

⇒ "216 vs 68" 的差值是上述 5 条叠加的**口径/时序产物**，与"音符盒漏音"无关。但**结论不是"没问题"**：`SWITCH_TICK` 的 5× 偏差和「前半段解除强加载」是真实的漏音来源（§0.6），必须在 M1 修掉并用新验收口径复测。

### 6.2 确定性验收流程（建议直接固化为脚本）

1. 从**干净世界模板**复制一份测试世界（不含任何 `level.dat` 计数器残留），数据包由 `emit` 现产并拷入。
2. 启动服务器 → 从**控制台**（等级 4）下发：`pause 关`（或用 `tick freeze` 规避暂停）→ 需要 100 tps 时才下发 `tick rate 100`。
3. `tick freeze` → `function styx:play/start` → **`tick step N`**（N 为检查点刻数）→ 读 `#t`、`#hits`（此时刻轴确定，两次读取之间不会有任何刻推进）。
4. 断言：`#hits == 数据里 tick ≤ N 的音数`；再 `tick step`（余下刻数）→ 断言终值 `#hits == 3099`。
5. 断言日志：**0 条** `Failed to load function` / `Unknown function` / `Can't keep up`；打印 MSPT（`/debug` 或 Spark）。
6. 记录 `elapsed/mspt/调用次数/计数差` 到 `docs/BASELINE.md`；**断言失败必须非零退出**。

### 6.3 测试矩阵

| 层级 | 对象 | 手段 | 门槛 |
|---|---|---|---|
| L0 单元 | 契约校验、撞格合并、八度证据、chroma、力度、评分 | `node:test` + 合成正弦/和弦 WAV | 合成样本 100% 判定正确；完全相同 → 满分 |
| L1 数据 | `score.json` 自身一致性 | 断言：`tick` 单调、`row∈0..24`、`(step,row)` 唯一、`degradations` 覆盖所有折叠/丢弃 | 撞格 0、越界 0 |
| L2 离线流水线 | 七步串联 | 同一 `project.json` 跑两遍 → 数据包字节级一致；`manifest` 差异为空 | 可复现 |
| L3 无头刻步进 | 播放器 | §6.2 流程，抽查 3 段 × 3 音的（方块/音色/灯/触发位） | 计数差 0；0 ERROR；MSPT ≤ 50 |
| L4 人耳 | 听感清单（C 组 10 条） | 录音 √ 原曲 onset 互相关、末尾漂移 ≤ 150 ms | 主观打分表 |

### 6.4 客观指标口径（`verify` 输出）

起音对齐 F1（容差 ±1 刻）· 12 音级 chroma 相似度（cosine）· 八度命中率（对 `analysis.json` 的 `bestOctave`）· 力度包络相关（Pearson，窗 60–120 ms）· 漏音率（应有 vs `#hits`）。权重与窗口参数必须写进 `report.json`，否则分数无法跨版本比较。

## 7. 风险清单（按"会不会让项目失败"排序）

| # | 风险 | 触发条件 | 影响 | 缓解 | 验证方式 |
|---|---|---|---|---|---|
| 1 | **时间轴单位不一致**（手算常量 × 不同刻率） | 再有人手写 `×0.12×20` 之类常量 | 静默漏音、错音，且极难定位（就是现在的 `SWITCH_TICK`） | 单点定义 + 生成器派生 + 断言"切换刻由 `score.json.meta` 推出" | L1/L3 断言 |
| 2 | **函数里的权限命令** | 任何等级 ≥3 的命令（`/tick`、`/debug 等`）进数据包 | **整个函数不可加载**，一条命令链断掉 | 生成器静态拦截命令白名单；`doctor` 检查加载告警 | L3 断言 0 条 `Failed to load` |
| 3 | **强加载窗口与音符位置不匹配** | 441 区块 > 256/次；切换刻错 | 远端音符不响（当前就是） | 由 `layout.json` 派生切换刻；`doctor` 断言窗口覆盖；远期改 S 形折返把 441 → ~150 | L3 抽查远端音符确实触发 |
| 4 | **输入数据不可信**（C 组结论） | 不做 M0 直接进 M1 | 所有"验收通过"都是假绿 | 先 M0 修八度/撞格/音级/力度，再上 `verify` 基线分 | L0/L1 + `BASELINE.md` |
| 5 | **观测性假象**（残留计数器、空服暂停、异步读数、exit 0） | 复用脏世界 / 墙钟采样 | 把"漏音"和"通过"都判错 | §6.2 确定性刻步进 + 干净世界 + 非零退出 | 故意注入"漏 10% 音符"应让 L3 变红 |
| 6 | **生成物陈旧 / 不可回退** | emit 只写不删；undo 是手写常量 | 运行时引用到旧函数；回退不干净 | manifest + 清空输出 + 前像快照 | L2 + "undo 后逐格差异 0" |

## 8. 给 M1 的工单（建议按序执行）

| # | 工单 | 验收 |
|---|---|---|
| T1 | 命令白名单：把 `/tick` 从所有函数里移除；`redo` 只提示玩家敲命令；gen 时静态拒绝等级 ≥3 命令 | 服务器启动日志 **0 条** `Failed to load function`；`/function styx:redo` 之后无 `Unknown function` |
| T2 | 时间轴单点化：`score.json.meta{tps,secPerStep,totalTicks}`；默认 20 tps 渲染（`round(step×2.4)`，整曲 **5,568 刻**） | 由 `meta` 重算出的刻与现有 CSV 在 100 tps 下完全一致；20 tps 产物终值 `#hits == 3099` |
| T3 | `layout.json` 派生 `forceload` 时间表（修 2995 → 14976） | 播放全程 `doctor`/日志报告"当前窗口覆盖本刻音符"；远端音符抽查通过 |
| T4 | 派发重构：阶段 1（守卫去重）+ 阶段 2（两级派发） | 派发次数 **≤ 20 次/刻**（实测），`tick step` 逐刻计数差 0，MSPT ≤ 50（实测值入 `BASELINE.md`） |
| T5 | `apply_notes` 按加载窗口分片；`emit` 先清空 + 写 `manifest.json` | 单次 apply ≤ 5,200 行；`play/` 与 `styx/function/` 无 manifest 之外的文件 |
| T6 | 确定性验收脚本（§6.2）：干净世界 + `tick freeze/step` + 非零退出 + 日志断言 | 注入"漏 10% 音符"的实验必须让它失败；正常数据必须绿 |
| T7 | `verify` 与基线：客观 5 指标 + 综合分写 `report.json`、`docs/BASELINE.md` | 与 M0 的修复前/后分数可比；分数变化能解释到具体工单 |

## 9. 口径与证据（哪些是实测，哪些待实测）

**实测（本机，2026-09-14）**

- 音符/时间轴/撞格统计：对 `build/styx_helix_notes_v3.csv` 直接统计（3,099 音、1,821 个有音刻、末刻 27,840、桶 279、平均 1.70 音/刻、最密 4、撞格 `(step,row)` **276** 处 —— 与 C 组独立统计一致）。
- 桶与派发：`play/` 目录实测 288 文件、279 个桶、21,696 行、平均 77.8 行/桶、最重 `b168`=155 行、4 个空桶；桶内 `#hits`/红石块/点灯 行数各 3,099；`tick.mcfunction` 281 行 / 279 次调用。
- 数据包规模：`styx/function/` 327 个 `.mcfunction`（含 `apply_notes_v3` 15,496 行/755 KB、`fix_instruments` 5,669 行、`lamps*` 4×2,834 行）、`styx/structure/` 196 个 `.nbt`。
- 机器剖面：`build/single_row_profile.json` = 49 段、y 84..110、前 38 段 y=84、8 段有 `cutAboveFrom`、x 480..2831、z 宽 32。
- 服务器日志：`testserver/v3test.log`（行 5/22/39 加载失败；85/90 `Unknown function`；86 空服暂停；87 `#t=1684`；88 `#hits=216`）、`testserver/redotest.log`（22 `Running function styx:redo`；23 空服暂停；24/27 `#t=485` 6 秒未变）。
- 代码事实：`src/emit/datapack-playback.mjs`（`BUCKET=100`、`SWITCH_TICK = Math.round(1248*0.12*20)`、每音 6 条守卫命令、两段 `forceload`）、`src/arrange/arrange-notes.mjs`（`PLAY_TPS=100`、`SEC_PER_STEP=0.12`）、`src/emit/redo-chain.mjs`（s2/s3/s4 各跑一次 `apply_notes_v3`）、`src/test/run-headless.mjs`（固定 sleep、共享世界、`process.exit(0)`）。

**待 M1 实测（本文按语义推演，请勿当结论引用）**

- `/tick` 被函数解析器拒绝的确切原因（通行解释是"函数上下文权限等级 2 < `/tick` 要求的等级 3"；日志本身只证明"该命令在函数解析器里不存在"，等级归属属推断，待逐版本复核）。
- MSPT / TPS 实测值（现在没有任何记录）。
- `tick freeze` + `tick step N` 在 1.21.10 下对函数标签与 `/schedule` 的精确语义。
- `/schedule` 排期在崩溃重启、`/reload` 后的残留与解析行为。
- `forceload add` 单次 256 区块上限在当前版本的确切上限行为（现方案已按此分两段，未逐版本复核）。
- 20 tps 下 ±25 ms 抖动的听感验收（属 C 组 L4 范围）。

---

*本文所有建议都不改变"发声必须来自实体音符盒"这一前提；派发重构只改"谁来按下触发器"，不改触发方式与灯光语义。*
