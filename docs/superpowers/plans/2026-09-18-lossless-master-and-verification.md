# 无损成片音轨 + 游戏内一致性校验 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让"成片音轨"有确定的交付物（48k/24bit 立体声母版 + 分层 stems + 5.1），并给出"游戏内实际派发 = 谱面意图"的离线可复跑校验。

**Architecture:** 音轨不靠游戏内录制，而是用**与 mod 同一套采样、同一份谱面**的离线渲染器产出（确定性、可复现、可回滚）；游戏内一致性用**数据包派发函数的静态反解**来校验（把 `play/lo|hi/*.mcfunction` 里的 tick/坐标还原成音符，与谱面逐颗比对），不依赖进游戏。

**Tech Stack:** Node 20+（现有 `tools/render-ensemble.mjs`）、ffmpeg（PCM s24 / 声道映射）、现有 `src/emit/tick-map.mjs` 口径。

**Spec:** `docs/SPEC.md` §2（emit/verify）、§6（验证与评分）；用户 2026-09-18 拍板"A 就行"。

## Global Constraints

- 采样与谱面必须与游戏内一致：`config/nbforge/instruments.json` 指向的 **高通版 Salamander**（`_toolchain/piano/salamander48_hp/`）与 `build/machine_from_reference.csv`（3044 颗音）。
- 母版规格：**48kHz / 24bit PCM**；峰值 ≤ 0dBFS（现有总线归一 -18dBFS + 软限幅）。
- 触发时刻口径：`tick = round(time_seconds × tps)`（20 tps 与 100 tps 两套），与 `src/emit/tick-map.mjs` 同源。
- 所有产物落 `build/master/`，文件名带规格后缀；不改动游戏内数据（本轮纯离线）。

---

### Task 1: 分层 stems + 5.1 导出

**Files:**
- Modify: `tools/render-ensemble.mjs`（新增 `--stems` / `--surround51` / `--manifest`）
- Create: `build/master/*.wav` + `manifest.json`

**Interfaces:**
- Consumes: 现有 `layerBuf`（每层 Float32 缓冲）、`LAYER_GAIN`、`SR=48000`。
- Produces: `<NAME>_stem_<layer>_48k24bit.wav`（每层一路，未做总线归一）、`<NAME>_48k24bit.wav`（立体声母版，已有）、`<NAME>_51_48k24bit.wav`（5.1：L/R/C = 三层声像重排，LFE = 低音层 120Hz 低通，SL/SR = 静音，明确标注"前向为主、无环绕内容"）、`manifest.json`（各文件峰值/RMS/时长 + 许可与来源）。

- [x] **Step 1:** 在渲染循环里把每层 `buf`（定标后）额外写一份 48k/24bit 立体声 stem
- [x] ~~**Step 2:** 实现 5.1 路由~~ → **用户 2026-09-18 指示暂缓**："多声道可以暂时不做，等我多了解一些再做，先就只做双声道无损就行"。manifest 里记 `surround51: deferred`。
- [x] **Step 3:** 写 `manifest.json`（文件名、时长、峰值、RMS、来源采样、许可）
- [x] **Step 4:** 跑一次全曲导出：母版 + 3 条 stems + manifest，时长一致 287.941s

### Task 2: 数据包 ↔ 谱面 一致性校验（离线，不需要进游戏）

**Files:**
- Create: `tools/verify-pack-vs-score.mjs`
- Create: `build/verify_pack_report.json`

**Interfaces:**
- Consumes: `build/styx_build/data/styx/function/play/{lo,hi}/*.mcfunction`、`build/machine_from_reference.csv`、`src/emit/layout-pos.mjs` 的 `makePos(profile)`。
- Produces: 报告 `{ modes: { lo: {notes, ticks, missing, extra, maxTickErrorMs, meanTickErrorMs}, hi: {...} } }`。

- [x] **Step 1:** 解析 datapack 里的 `execute if score #t styx.t matches <tick> run nbforge playat <x> <y> <z>`，抽出 (tick, 坐标)
- [x] **Step 2:** 用同一份 profile 把谱面每颗音算成 (期望 tick, 坐标)，与 Step 1 的集合逐项比对（缺失/多余/坐标不符）
- [x] **Step 3:** 统计"精确时刻 vs 0.12s 格位"的偏差，输出最大/均值
- [x] **Step 4:** 断言 `missing = 0 && extra = 0 && tickMismatch = 0`；否则非零退出

### Task 3: 收尾（验证与归档）

- [x] **Step 1:** 跑 Task 1/2 的产物校验：lo/hi 两套表 各 3044 颗 / 缺失 0 / 多余 0 / tick 不符 0 → 通过
- [x] **Step 2:** `docs/M3-28-lossless-master.md` 记录：交付物清单、规格、投稿用法、5.1 暂缓
- [x] **Step 3:** 提交（含计划文件本身）

## 实施结果（2026-09-18）

* `build/master/`：`styx_master_48k24bit.wav`（母版）+ `styx_master_stem_{melody,inner,bass}_48k24bit.wav` + `styx_master_manifest.json`
* `node tools/verify-pack-vs-score.mjs`：lo/hi 双表全绿；顺带量出"精确时刻 vs 格位"平均差 30ms、最大 100ms（M3-24 那次改动的收益）
