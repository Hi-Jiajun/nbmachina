# M2-3 实测报告 · 路径收口收尾 + 谱面口径统一

仓库：`nbforge`（Windows、Node v24.21.0、零依赖、`node:test`）。
基线：`e06c773`（M2-1 收口）。本轮**未新增路由/未改算法**，做的是"把最后一批写死的路径收进 `paths.mjs`"，
外加一次**真实缺陷修复**：数据包装的谱面与验收口径不同源。

**一句话结论**：`src/` 下 20 个还在写死绝对路径的脚本全部接入 `paths.mjs`（含存档 / 测试服 / java 三个
机器外部路径），改造前后用 19 步 A/B 逐字节比对**完全一致**（含 727 文件的 `play/` 目录）；
同时抓出并修掉一个静默故障：**数据包实际装的是未编排的 v3 谱面（279 音），而验收口径是编排后的
machine_pipeline（295 音）**，两者差 16 音 —— 修复后 20 tps / 100 tps 两种刻率的无头 e2e 全部通过。

---

## 0. 交付物

| 文件 | 作用 | 证据 |
|---|---|---|
| `src/core/paths.mjs`（改） | 新增 `resolveExternal()`（存档 `--save`/`NBFORGE_SAVE`、测试服 `--server`/`NBFORGE_SERVER`、java `--java`/`NBFORGE_JAVA`）；新增 `midi`、`machineScore` 两个槽位 | `tests/m23-paths.test.mjs` |
| `src/analyze/{audio-tempo,parse-midi-and-audio,drums,onset-detect,wav-rms}.mjs` | 接入 `paths.mjs`（过去 `const B = 'C:/Users/hiliang/...'`） | A/B 16/17 步；`--test` 全绿 |
| `src/arrange/{arrange-notes,octave-fix,onset-recover}.mjs` | 同上（`notes_fixed.csv` / `machine_p1.csv` 等中间产物统一走 `P.file()`） | A/B 15 步 |
| `src/emit/{datapack-structures,fix-instruments,playsound-hifi,resource-pack,undo-snapshot}.mjs` | 同上；`resource-pack` 的 `MINECRAFT` 根改为 `path.dirname(build)`，不再写死 | A/B 19 步 |
| `src/ingest/project-from-notes-csv.mjs`、`src/layout/single-row-layout.mjs`、`src/scan/{undo-scanner,world-notes-audit}.mjs`、`src/synth/render-all.mjs`、`src/test/{setup-headless,run-headless}.mjs` | 同上（`test/*` 与 `scan/*` 还要拿到存档 / 测试服 / java） | A/B 18 步 + e2e 复跑 |
| `tests/m23-paths.test.mjs`（新） | 9 条：**字面量审计**（除 `paths.mjs` 外不许再出现历史绝对路径）、外部路径默认值逐字符一致、`--save/--server/--java` 覆盖优先级、相对路径归一化 | `node --test tests/m23-paths.test.mjs` |
| `tools/ab-verify.mjs`（改） | 步骤 14→19；新增"输入库不被改写"护栏；输入库由硬链接改真拷贝（见 §3） | `_scratch-m2-3/ab/ab-result.json` |
| `src/emit/datapack-playback.mjs`、`src/emit/note-blocks.mjs`、`src/verify/score.mjs`、`src/test/run-headless.mjs`（改） | **谱面口径统一**：默认输入一律 = `arrange-all` 的最终产物 `machine_pipeline.csv` | e2e lo/hi 全绿 |
| `src/test/run-headless.mjs`（改） | ① 起播前显式 `function styx:play/monitor_on`（监听计数不再依赖存档残留状态）；② 新增"数据包派发表与 `--notes` 同源"断言 | e2e 输出第 3 条 |

---

## 1. 谱面口径统一（本轮最重要的修复）

### 1.1 症状

M2-1 那一轮重新生成数据包时，`datapack-playback.mjs` 的默认输入是 `styx_helix_notes_v3.csv`
（**没经过编排**的 v3 谱面），而验收脚本读的是 `machine_pipeline.csv`（arrange-all 的最终产物：
力度三通道 + 延音 + 打击乐合并）。结果：

| 口径 | 前 600 刻（刻窗口 (15,616]）触发数 |
|---|---|
| `machine_pipeline.csv`（验收口径，含 basedrum 96 / hat 42） | **295** |
| `styx_helix_notes_v3.csv`（数据包装的那份） | **279** |
| `styx_helix_machine.csv`（更早的单文件产物） | 265 |

无头 e2e 因此报 `#hits 增量 = 期望 295，实际 279`，且监听计数恒 0（`#mon` 没打开）。
**这台机器当时在演奏的是丢了力度/延音/打击乐的旧谱面**，而所有文档都以为装的是编排结果。

### 1.2 修法（三处同源 + 一处护栏）

1. `paths.mjs` 新增唯一槽位：`machineScore = <build>/machine_pipeline.csv`，注释里写明它就是"可演奏机器谱面"。
2. `datapack-playback`（派发表）、`note-blocks`（摆块）、`verify/score`（评分）、`run-headless`（验收）
   四个入口的默认输入全部改成 `P.machineScore`；仍可用 `--notes <csv>` 显式覆盖。
3. `run-headless` 新增断言：解析数据包 `play/<mode>/bNNN.mcfunction` 里 `#hits` 的守卫刻号，
   与 `--notes` 谱面算出的期望数**必须一致（差 ≤1）**，否则直接判失败并打印两个数字。
   这条断言就是"装错谱面"这类静默故障的专门护栏（本次它报的是 `数据包 295 vs 谱面 295`）。

### 1.3 重新生成 + 装包 + 复验

```bash
node src/emit/note-blocks.mjs        # apply_notes_v3：3053 音（bass 1276 / harp 1639 / basedrum 96 / hat 42）
node src/emit/datapack-playback.mjs  # lo 单刻 20 次调用、hi 35 次；触发 3053
node src/emit/undo-clone.mjs         # 49 段 × 4800 格
node src/emit/redo-chain.mjs         # redo / redo_hi / s1..s4 / monitor
node src/emit/playsound-hifi.mjs     # 361 个 hifi 函数
node src/emit/lint-pack.mjs          # 静态自检通过（788 个函数 / 134236 行）
pwsh -NoProfile -File C:\Users\hiliang\Documents\minecraft\build\install_styx_pack.ps1
# → OK pack_structures=196
```

---

## 2. 验收对照

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| `node --test "tests/*.test.mjs"` | 全绿 | **226 / 226**（基线 217 + 本轮 9） | 通过 |
| A/B 逐字节（基线 `e06c773` vs 本轮） | 全部一致 | **19 / 19 步**（含 727 文件的 `play/` 目录；只有 3 个 JSON 的耗时字段不同） | 通过 |
| 无头 e2e · 20 tps / 600 刻 | 触发差 0、监听对得上、0 加载错误、MSPT ≤ 50 | `#hits 295 vs 295`、钢琴 110/110、贝斯 185/185、加载错误 0、**MSPT 7.3 ms** | 通过 |
| 无头 e2e · 100 tps / 600 刻 | 同上（MSPT ≤ 10） | `#hits 28 vs 28`、钢琴 20/20、贝斯 8/8、加载错误 0、**MSPT 6.7 ms** | 通过 |
| 数据包与谱面同源（新护栏） | 差 ≤1 | 20 tps：数据包 295 vs 谱面 295；100 tps：28 vs 28 | 通过 |
| 装包 | 通过验收才装 | `install_styx_pack.log` → `OK … pack_structures=196` | 通过 |

原始结果：`_scratch-m2-3/ab/ab-result.json`、`tests/e2e-run.json`、`testserver/e2e-{lo,hi}.log`。

---

## 3. 过程中发现的另一个坑：A/B 的输入库被"写穿"

第一版 A/B 打印 `✘ 14/19`，差异集中在 `play/lo|hi/bNNN`、`play/stop|reset`、`single_row_profile.json`。
根因不是代码，而是**验证工具自己**：`layout/single-row-layout.mjs` 会**原地覆盖**它自己的输入
`single_row_profile.json`，而 A/B 的沙箱输入是用**硬链接**建的 —— 第一侧跑完就把共享输入库改掉，
第二侧于是从"被改过的世界剖面"起步，Y 坐标整片错位。

修法：沙箱输入改**真拷贝**，并加"跑完一侧核对输入库 sha256，被改写就直接判 A/B 无效"的护栏
（`tools/ab-verify.mjs`）。修完复跑：19/19 一致。

> 教训：**验证工具和被测代码一样要防"输入被写穿"**，否则你会拿两个不同初始状态的产物去比"逐字节相同"。

---

## 4. 未验证 / 需要人耳的部分（如实声明）

1. **听感**：本轮的产物（含打击乐与力度三通道）**没有在人耳侧验收过**。需要你在游戏里
   `/function styx:redo` 换上新谱面后试听，并与旧版对比。
2. **资源包在真实客户端的加载**：M2-1 只验证到结构 / pack_format / ogg 回读；真实客户端加载仍未跑。
3. **hifi 自研音色未接线**：`lint-pack` 明确警告 `styx:play/hifi/tick` 没被每刻调用，
   目前只能用 `/function styx:play/monitor_hifi_on` 手动进入。接线属于 M2-1 的收尾项（可选）。
4. **100 tps 模式仍要求玩家先执行 `/tick rate 100`**（数据包函数权限等级 2 < `/tick` 需要的 3），
   e2e 是在控制台（等级 4）跑的，真机需要你手敲一次。
5. **非 Windows / 非 `C:` 盘、UNC 路径**未测；`NBFORGE_BUILD` 指向不存在目录时没有可写性预检。

---

## 5. 复现

```powershell
cd C:\Users\hiliang\Documents\minecraft\nbforge
node --test "tests/*.test.mjs"                                    # 226 条
node tools/ab-verify.mjs --baseline e06c773 `
  --input C:/Users/hiliang/Documents/minecraft/build `
  --work C:/Users/hiliang/Documents/minecraft/_scratch-m2-3/ab  # 19 步逐字节
node src/test/run-headless.mjs --mode lo --ticks 600              # 8 项全绿
node src/test/run-headless.mjs --mode hi --ticks 600              # 8 项全绿（控制台自动 /tick rate 100）
```

---

## 6. 下一步

1. **内声部 / 和声层**（M3-1，已并行开工）：把中音区材料从旋律层里拆出来，降撞格、提清晰度。
2. **后端 A 预研**（已并行开工）：Fabric mod 工具链在 1.21.10 上是否可做 + 最小骨架。
3. 人耳验收闭环：`wav-rms.mjs` + `testserver/capture.wav` 的录音对齐比较。
4. `undo` 的 clone 版无头断言（现在只有 M1-6 的扫描式 undo 有无头验证）。
5. 代码审查与性能优化：`emit` 幂等（先清空输出目录）、`lint-pack` 覆盖更多规则、清理历史脚本。
