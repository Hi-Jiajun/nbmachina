# T7 · 无头端到端验收记录（2026-09-14）

运行者：根代理。命令（每次都会把 `build/styx_build` 同步到 `testserver/world/datapacks`）：

```bash
node src/emit/lint-pack.mjs                                     # 静态自检（不开服务器）
node src/test/run-headless.mjs --notes <csv> --mode lo --ticks 600
node src/test/run-headless.mjs --notes <csv> --mode hi --ticks 1200
```

环境：`testserver`（Minecraft 1.21.10 服务端，Java 21 delta 运行时，`server.jar` 58.6 MB）。
验收方式：`tick freeze` → 取基线 → `tick sprint N` → 读分数 → 断言。

## 结果

| # | 谱面 | 模式 | 刻窗口 | 期望触发 | 实际 `#hits` | 监听 钢琴/贝斯 | 加载失败 | MSPT | 退出码 |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `styx_helix_notes_v3.csv`（3099 音，修前） | lo 20 tps | 15 → 616（+601） | 279 | **279** | 104/104 · 175/175 | 0 | 8.6 ms | 0 |
| 2 | `styx_helix_notes_v3.csv` | hi 100 tps | 81 → 1282（+1201） | 50 | **50** | 30/30 · 20/20 | 0 | 5.4 ms | 0 |
| 3 | `styx_helix_machine.csv`（2802 音，T3+T4+T5 修后） | lo 20 tps | 15 → 616（+601） | 265 | **265** | 102/102 · 163/163 | 0 | 6.1 ms | 0 |
| 4 | `styx_helix_machine.csv` | hi 100 tps | 79 → 1280（+1201） | 46 | **46** | 28/28 · 18/18 | 0 | 5.6 ms | 0 |

`#hits` 与数据里「刻窗口内的音数」**逐条精确相等（差 0）**，不是"±2 算过"。监听计数按声部分别核对，也相等。

### 坐标耦合抽查（第 3 次运行新增，专门防"响了但听不到"）

播放器按谱面算触发坐标，世界里音符盒由 `styx:apply_notes_v3` 摆——两者必须用同一个 `pos()` 规则。
抽查 3 颗音（首音 / 首个钢琴 / 中段 step≈1248），每颗核对**音符盒 instrument+note、甲板方块、下方灯、触发位空闲**四项：

| 抽样 | 坐标 | 音色/音高 | 结果 |
|---|---|---|---|
| 首音 | (480, 84, −160) | bass 9 | ✔ 四项全对 |
| 首个钢琴 | (480, 84, −154) | harp 15 | ✔ 四项全对 |
| 中段 step≈1248 | (1728, 84, −158) | harp 11 | ✔ 四项全对 |

对应实现：`src/emit/layout-pos.mjs`（唯一坐标来源，播放器与摆块器共用）、`src/emit/note-blocks.mjs`
（按最终谱面重新摆块，并清空旧折叠留下的坐标——T3 改八度后 row 变了，不重摆就会"播放器触发空气"）。

原始日志：`testserver/e2e-lo.log`、`testserver/e2e-hi.log`；结构化结果：`tests/e2e-run.json`（保存最近一次）。

## 这轮修掉的三个真 bug（都有日志证据）

1. **`/tick rate` 让三个函数整文件加载失败**（A/B 组发现，本轮实测确认并修掉）
   `play/start|stop|reset` 因为含 `tick rate`（函数权限等级 2 < 需要的 3）被服务端拒收 → `styx:redo` 最后一步报
   `Unknown function styx:play/start`，世界停在 20 tps，而谱面按 100 tps 计时 → **整曲被拉成 5 倍慢**。
   现在函数里不再出现 `tick rate`，刻率只由玩家/控制台决定，谱面分两套：`lo`（20 tps，默认，开箱即用）与
   `hi`（100 tps，精确网格，需先在聊天里 `/tick rate 100`）。
2. **`SWITCH_TICK` 与刻率绑定**：旧代码写死 2995（只对 20 tps 正确）。现在按模式由 `switchTick(tps)` 算出
   （20 tps → 2995，100 tps → 14976），演奏到第 1248 步时切换 forceload 窗口。
3. **单刻 275 次函数调用 → 20/35 次**（两级派发：组 → 桶）。100 tps 下 MSPT 5.4 ms（预算 10 ms），
   20 tps 下 6.6–8.6 ms（预算 50 ms）。

## 验收工具自身修掉的两个坑（都会让"看起来在跑"骗人）

- **空服 60 秒自动暂停**：`server.properties` 的 `pause-when-empty-seconds=60` 会在无玩家时冻住刻轴——
  之前 `#t` 读到 216/485/1684 这类怪值就是它 + 计数器未清零的叠加。验收脚本现在开跑前强制写成 `0`。
- **`/tick step` 是按实时 20 tps 走的**（实测 600 刻花 30 秒），而且必须先 `tick freeze`；要全速用 `tick sprint`。
- 旧验收脚本 `process.exit(0)` 永远返回成功；现在断言失败会以退出码 1 结束，并把结果写进 `tests/e2e-run.json`。

## 还没验的（如实记录）

- **人耳部分（SPEC §6 的 30%）未录**，所以 `docs/BASELINE.md` 的 overall 仍是 `null`。
- **音量/音色不是本轮目标**：机器仍用原版 harp/bass 两种音色，打击乐、内声部、长音延音都在 M1/M2。
- **lo 模式有 ±1 刻（±50 ms）抖动**（0.12 s 步长在 20 tps 下不是整数刻）。要精确网格就必须 `hi` 模式。
- **力度相关性指标是自证的**：`velocity_corr 0.990` 是把同一段音频量出来的力度再和音频比，不能当作
  "听感更好了"的独立证据；独立证据要看人耳清单和与原曲的 onset 互相关。
