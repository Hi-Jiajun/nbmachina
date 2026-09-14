# M3-2 · hifi 渲染器认显式声部标签（`inner`）

任务来源：`docs/M3-1-inner-voice-report.md` §6 的 next（"让 playsound-hifi 直接读 inner 标签"）。
基线：HEAD `895868d`（M3-1 三提交）。**没有改任何音符数据**，只改"哪一层用哪个音色"的判定来源。

**一句话结论**：`/playsound` 渲染器（后端 A 的软件路径）现在**以谱面里的显式声部标签为准**
（`instrument=inner` 或 `voiceRole=inner`），没有标签的老谱面继续走"同刻最高行=旋律"的启发式且
**逐字节不变**（19/19 步 A/B 一致）。真实数据上两套口径分歧 **208 颗音 / 150 个 step** —— 说明接过
标签不是修辞：它会实打实改变哪些音用内声部音色。

---

## 1. 为什么必须接（两套口径实测差多少）

| 谱面 | 内声部音色用量 | 来源 |
|---|---|---|
| `machine_pipeline.csv`（当前装机版，无标签） | **254**（启发式 254 / 标签 0） | "同刻最高行=旋律" |
| 同曲 `--inner on` 的最终谱面（有标签） | **230**（标签 230 / 启发式 0） | M3-1 的续线判定 |
| 同一颗音在两套口径下音色 `strings↔bell` 翻转 | **208 颗 / 150 个 step** | `tests/hifi-inner-voice.test.mjs` 实测打印 |

即：光靠启发式，有 208 颗音的"是旋律还是内声部"是**判错的**（内声部行可能比旋律更高，于是被
当成旋律、旋律被降成内声部）。M3-1 已经把正确答案写进了谱面（`voiceRole` 列 + `instrument=inner`），
渲染器此前却没读它——本轮补上这条线。

---

## 2. 改了什么

| 文件 | 改动 |
|---|---|
| `src/emit/playsound-hifi.mjs` | ① `INSTRUMENT_ALIAS` 增加 `inner`（修复前它算**未知乐器**→退回 strings，等于"内声部被当旋律"，且会污染 `unknownInstrument` 统计）；② `planHifi` 的旋律判定改成**标签优先**：标了 `inner` 的音不参与"谁是旋律"的竞争，其余 harp 家族音里没有标签时才用老启发式；③ 内声部计数拆成 `innerExplicit` / `innerHeuristic` 两个来源（报告与测试都看这个）；④ CLI 打印两来源拆分 |
| `src/emit/playsound-hifi.mjs`（`parseScoreCsv`） | 读可选列 `voiceRole`（没有就是空串，老谱面逐字节兼容） |
| `tests/hifi-inner-voice.test.mjs`（新） | 10 条：标签优先（`instrument=inner` / `voiceRole=inner` / `--inner pad`）、混用计数互不串台、老口径不变、CSV 有无 `voiceRole` 列、**3 条真实数据硬断言**（当前装机谱面仍是启发式口径 / 标签谱面 230 颗全被认 / 两套口径分歧可量化）——一条 skip 都没有 |
| `tests/synth.test.mjs` | bell 非谐分音那条断言加**自诊断**（bin / 区间 / binHz / 采样点数 / 谷值），原因见 §4 |

---

## 3. 验收

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| `node --test "tests/*.test.mjs"` | 全绿 | **252 / 252**（其中本轮新增 10 条） | 通过 |
| 默认路径逐字节不变 | 无标签谱面产物与改造前一致 | `tools/ab-verify.mjs --baseline 895868d` → **19/19 步逐字节一致**（含 727 文件的 `play/` 目录） | 通过 |
| 标签路径真实链路 | `--inner on` 的最终谱面能被 emit 链路消费 | 隔离 build 副本上：`arrange-all --inner on` → 3053 音（bass 1300 / harp 1385 / **inner 230** / basedrum 96 / hat 42）→ `note-blocks` 摆 3053 格（inner 并入 harp 方块）→ `datapack-playback` 367 函数 → `playsound-hifi` 打印 **内声部 230（显式标签 230 / 启发式 0）** → `lint-pack` 静态自检通过 | 通过 |

复现：

```powershell
cd C:\Users\hiliang\Documents\minecraft\nbforge
node --test tests/hifi-inner-voice.test.mjs        # 10 条（含真实数据分歧数字）
node tools/ab-verify.mjs --baseline 895868d `
  --input C:/Users/hiliang/Documents/minecraft/build `
  --work C:/Users/hiliang/Documents/minecraft/_scratch-m3-2/ab   # 19/19 逐字节
```

---

## 4. 附带发现：一次"看起来像数值抖动"的假失败

`tests/synth.test.mjs` 的 bell 非谐分音断言在 14:33 与 14:39 偶发失败两次，报的是
`非谐分音位置不对：1012.7Hz ≠ 2.66×440=1170.4Hz`。**这个数字落在它自己请求的 [1100,1276]Hz 之外**
——用当前源码在数学上不可能（`dominantPeak` 只在给定带内取峰）。

排查过程（全部留痕）：

1. 单进程内连跑 60 次：0 失败（合成器与 FFT 都是决定论，无 `Math.random`/`Date.now`）。
2. 写仪器化探针（打印 `bin`/`lo`/`hi`/`binHz`），**96 个进程 × 8 次迭代**并行施压：0 失败。
3. 两次失败都发生在我与子代理**同时读写同一份仓库/抢资源**的时间窗里。

结论：归因于**并发写文件造成的"读到半旧半新的源码/谱面"**，不是数值抖动（与 `tools/ab-verify.mjs`
那次"硬链接把输入写穿"属同一类：**验证工具/并发流程**才是元凶）。处理：断言里加自诊断信息
（下次一眼分清"测量问题"还是"文件被换过"），并把"验收套件不要在子代理写仓库时跑"写进无人值守日志。

---

## 5. 未验证 / 需要人耳

1. **听感**：内声部换成 bell/pad 之后"是否更好听、更像原曲"没验过——这正是要你在游戏里判的。
2. **hifi 仍未接线**：`styx:play/hifi/tick` 还没有被每刻调用（`lint-pack` 会警告），
   现在要靠 `/function styx:play/monitor_hifi_on` 手动进入；接线是下一个可做的小项。
3. 内声部**默认仍是 off**：本轮只让渲染器"能认"标签，并没有把 `--inner on` 设成默认。

---

## 6. 下一步

1. 你在游戏里做一次 A/B：`/function styx:play/monitor_hifi_on` + `/function styx:play/start`，
   对比自研音色（strings/bell）与原版 harp；再决定内声部是否默认开、用哪个音色（bell / pad / strings）。
2. 把 `styx:play/hifi/tick` 接进每刻（一行 + 标签），消掉 `lint-pack` 的未接线警告。
3. M4：给 `inner` 单独定音色（现默认 bell），配合后端 A 的 mod 实验。
