# 客户端高精度播放（解除服务器刻率限制） 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让音符的**发声时刻**由客户端高精度时钟决定（分辨率 ~1ms），不再受服务器刻率（20 tps=50ms、`/tick rate 100`=10ms）限制。

**Architecture:** 客户端自己读 `nbforge/score.csv`（3044 颗、带精确 `time_seconds`），用一个 `nanoTime` 调度线程按时刻逐颗调用现有音频引擎；服务器侧的数据包照旧负责**视觉**（灯/粒子），可把它的发声行关掉（`#snd 0`）避免双响。

**Tech Stack:** Fabric 客户端（`ClientTickEvents` / 客户端命令 API）、现有 `NbforgeAudio`（OpenAL 自有线程）、`NbforgeScore`（谱面解析，纯 Java 可复用）。

**Spec:** `docs/SPEC.md` §4（A 增强模式：自研演奏器）；用户 2026-09-18 拍板"那就直接做"。

## Global Constraints

- 不破坏既有链路：数据包 `playat` 默认行为不变（`#snd` 默认 1）；服务端 `/nbforge score` 播放器保持不变。
- 音频线程**不能**再以 15ms 轮询取任务（会给发声加最多 15ms 抖动）——改为"有任务立刻醒"的队列。
- 发声锚点跟随玩家（与 `listen on` 同口径），保证任何位置都能听全曲。
- 谱面文件：客户端游戏目录 `nbforge/score.csv`（6 列，含 `dur_ms`）。
- 统计口径：调度数、实际发声数、**每颗音的调度抖动（ms）**（可验证"到底准了几毫秒"）。

---

### Task 1: 音频线程改为"有任务立刻醒"

**Files:** Modify `mod/src/main/java/net/nbforge/mod/audio/NbforgeAudio.java`

- [x] **Step 1:** `TASKS` 换成 `LinkedBlockingQueue<Task>`（带入队时间），主循环 `poll(1ms)` + 一次最多连跑 64 条，每轮仍跑 `recycle()`
- [x] **Step 2:** 记录最近一次"入队 → 执行"的延迟（`lastTaskLatencyMs`）+ 排队数，`/nbfc status` 显示

### Task 2: 客户端谱面播放器

**Files:** Create `mod/src/main/java/net/nbforge/mod/score/NbforgeClientPlayer.java`

**Interfaces:**
- Consumes: `NbforgeScore.load(Path)` → `List<Note>`；`NbforgeAudio.play(instrument, voice, midi, velocity, durMs, x, y, z)`；玩家位置由调用方每颗音现取。
- Produces: `start(Path file, double fromSec)`、`stop()`、`isPlaying()`、`elapsed()`、`stats()`（scheduled/played/dropped/maxJitterMs/meanJitterMs）。

- [x] **Step 1:** `NbforgeClientPlayer.load()`：客户端游戏目录 `nbforge/score.csv`（复用纯 Java 的 `NbforgeScore` 解析）
- [x] **Step 2:** 调度线程：粗睡到目标前 1ms + 最后 1ms 自旋 → `NbforgeAudio.play(...)`，锚点 = 玩家眼睛位置；每颗音记录 `|实际-计划|` 抖动
- [x] **Step 3:** `start/stop/isPlaying/elapsed/均值·最大抖动/已调度·发声·跳过` 全部暴露给状态行

### Task 3: 命令

**Files:** Modify `mod/src/main/java/net/nbforge/mod/NbforgeClient.java`

- [x] **Step 1:** `/nbfc play [起始秒]`、`/nbfc stop`
- [x] **Step 2:** `/nbfc status` 增补：客户端播放状态 / 谱面颗数 / 已调度 / 发声 / 跳过 / 抖动（均·最大）/ 音频队列延迟

### Task 4: 数据包"只做视觉"开关

**Files:** Modify `src/emit/datapack-playback.mjs`、`src/emit/redo-chain.mjs`

- [x] **Step 1:** 发声行加 `#snd` 守卫（`#snd 0` 才静音，默认开 = 现有行为），新增 `styx:play/sound_off|sound_on`
- [x] **Step 2:** 重新生成数据包（792 函数 / 146971 行）+ 装包；`verify-pack-vs-score.mjs` 正则容忍该守卫 → lo/hi 各 3044 颗、缺失 0 / 多余 0 / tick 不符 0

### Task 5: 验证

- [x] **Step 1:** `gradlew build` → BUILD SUCCESSFUL（jar 78270 B）；副本服 `-Dnbforge.selftest=true` → 自检通过
- [x] **Step 2:** `node tools/verify-pack-vs-score.mjs` → 通过（见上）
- [x] **Step 3:** 文档 `docs/M3-29-client-hires-playback.md` + 提交

## 结果（2026-09-18）

* 客户端命令：`/nbfc play [起始秒]`、`/nbfc stop`；`/nbfc status` 增补一行为播放状态 + 抖动 + 队列延迟。
* 数据包：`/function styx:play/sound_off` 关掉数据包发声（机器只做视觉），`sound_on` 恢复。
* **没能在这里验证的**：客户端调度线程的实际抖动（`/nbfc status` 里的"抖动 均/最大"）与听感——只能在真客户端里跑一次才算数。
