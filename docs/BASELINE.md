# nbforge 基线分（M0 结束时的客观分）

> 这份文件是**给后续对比用的**：M1 每次改完数据或口径，重跑 `npm run verify` 并与这里比。
> 口径细节见 `docs/M0-3-report.md`；评分实现见 `src/verify/score.mjs`。

## 0. 基线是什么

| 项 | 值 |
|---|---|
| 音频 | `build/styx_helix_full.wav`（mono 44100Hz 16bit，281.4s）sha256 `a0361e07da3ade4e724c003ad6d4494d5ed02a11e9f14e0855ac41d10db81dd0` |
| 谱面（基线） | `build/styx_helix_notes_v3.csv`（3099 颗音）sha256 `66679fd13444dc97241d01dd2d2b67dd53e02e06276cd4c8479d8ab52e448e91` |
| 八度对标 | `build/analysis_octave.json`（T2，sha256 `10b4f5740a7416f83612e8a0aab08f9fa3d6cec7eaa5920a9d699f160e6eccc1`） |
| 日期 | 2026-09-14 |
| 权重 | 八度 .25 / 起音 F1 .25 / chroma .20 / 力度 r .15 / 有支撑率 .15（`DEFAULT_SCORE_WEIGHTS`） |
| overall | **null**（SPEC §6 的 30% 人耳清单未录；录了之后 `overall = 0.7×客观 + 0.3×人耳`） |

```bash
npm test                                                  # 85 项单测
npm run analyze:chroma                                    # 12 音级分布（音频 vs 谱面）
npm run arrange:velocity                                  # → build/velocity_fixed.csv
npm run verify -- --octave-evidence build/analysis_octave.json   # → build/score_report.json
```

## 1. 基线分

| 指标 | 值 | 说明 |
|---|---|---|
| ① 起音对齐 F1 | **0.888** | P 0.990 / R 0.805；谱面 1821 / 音频 1481 个起音，容差 50ms |
| ② chroma 相似度 | **0.936** | 最佳移调 +0（差异主因不是移调）；局部 4s 窗均值 0.865 |
| ③ 八度命中率 | **0.844** | 旋律 0.895 / 贝斯 0.779；与 T2 的 evidence 逐音一致 95.4% |
| ④ 力度包络相关 | **0.361** | 来源 `mix-rms(volume)`；诊断：与混音 RMS 0.930、**与起音强度 -0.155** |
| ⑤ 有支撑率 | **0.987** | 漏音率 1.3%（阈值 = 0.1 × 能量中位数） |
| **客观综合分** | **0.8223** | = .844×.25 + .888×.25 + .936×.20 + .361×.15 + .987×.15 |

## 2. 修前 / 修后对照（同一条音频、同一套权重）

| 谱面 | 起音 F1 | chroma | 八度 | 力度 r | 有支撑率 | 客观分 | 备注 |
|---|---|---|---|---|---|---|---|
| `styx_helix_notes_v3.csv` | 0.888 | 0.936 | 0.844 | 0.361 | 0.987 | **0.8223** | 基线 |
| `notes_dedup.csv`（T4） | 0.888 | 0.936 | 0.879 | 0.400 | 0.986 | 0.8367 | 去撞格丢 291 颗（相对基线漏音 9.4%） |
| v3 + `velocity_fixed.csv`（T5 口径） | 0.888 | 0.936 | 0.844 | 1.000⁽*⁾ | 0.987 | 0.9183 | 力度换成窄带能量口径 |
| `notes_fixed_v3.csv`（T2/T3）+ 重算力度 | 0.888 | 0.936 | **0.954** | 0.999⁽*⁾ | 0.985 | **0.9453** | 八度 0.844 → 0.954（贝斯 0.779 → 0.941） |
| `styx_helix_machine.csv`（T3+重折行+T5+T4，机器实际用的谱面） | 0.888 | 0.936 | **0.965** | 0.990⁽*⁾ | 0.985 | **0.9467** | 见 §5；这是**进机器的那一版** |

⁽*⁾ 力度相关在这两行是**链路自检**（力度由同一描述子生成），不能读成"力度变好 0.6"。
可比的真提升是八度那一项。

> 表里的 `notes_fixed_v3.csv` 是并行任务 M0-2（T2/T3）的产物，写作时 sha256
> `c454fea3255c594a33a05cdef1a77ee615ad72afacbed769d7b049e9b523e48`；若 M0-2 之后重跑，
> 请用 `node src/arrange/velocity.mjs --in build/notes_fixed_v3.csv --out build/velocity_fixed_from_octavefix.csv`
> 重算这一行。`notes_dedup.csv` 同理（M0-1）。

## 3. 已量出来的三个已知弱项（M1 的靶子）

1. **音级吸附**：调外 5 音级（C/D/F/G/A#）在音频里占最大音级的 0.16–0.57，谱面只有 0.01–0.06（差 3–11 倍），
   谱面在这 5 个音级上的总质量仅 3.4%。目标：提到 ≥8% 且与音频的逐音级占比差 < 2 倍。
2. **力度口径没有音乐有效性**：新口径与自己的描述子 r=1.00，但与**音频起音强度** r=-0.53。
   目标：力度与起音强度的相关 > 0.5（否则力度只是"换了个物理量"，仍不是"重音"）。
3. **起音 recall 0.805**：检测器保守，密集 16 分格段相邻音的攻击合并。目标：per-band 通量把 recall 提上去。

## 4. 对比时的规则（避免自己骗自己）

1. **基准必须同为"去撞格"口径**：拿未去撞格的 v3 当基准、去撞格后的谱面当结果，会被记成 9.4% 漏音（M0-1 §4.2）。
2. **力度相关项不能单独引用**：它可能是循环的，必须同时看 `vsOnsetStrength`（非循环诊断）。
3. **起音 F1 只能在同一个检测器版本内横向比较**（换检测器参数要重跑全部对照，并在这里备注）。
4. **改了口径就要写下来**：任何 `DEFAULT_*` 常量的改动都会让这份基线失效，请在新报告里注明并重算。

## 5. T7：进机器的那一版谱面 + 无头端到端结论（2026-09-14）

**产线**（四步，全部零依赖、可单独重跑）：

```bash
node src/arrange/fold.mjs            --in build/notes_fixed_v3.csv --out build/notes_refold.csv   # ① 按修好的 midi 重折 0..24 行
node src/arrange/velocity.mjs        --in build/notes_refold.csv   --out build/notes_vel.csv       # ② 力度换口径（T5）
node src/arrange/dedupe.mjs          --in build/notes_vel.csv      --out build/styx_helix_machine.csv  # ③ 去撞格（T4）
node src/emit/datapack-playback.mjs  --notes build/styx_helix_machine.csv                          # ④ 生成数据包函数
# 一步版（前三步等价，volume := velocity）：
node src/arrange/machine-pipeline.mjs
```

| 项 | 值 |
|---|---|
| 机器谱面 | `build/styx_helix_machine.csv`（3099 → 去撞格后 **2802** 颗音，撞格 281 → **0**） |
| 客观分 | **0.9467**（基线 0.8223，+0.124；八度 0.844 → 0.965） |
| 端到端 | `node src/test/run-headless.mjs --notes build/styx_helix_machine.csv --mode lo --ticks 600` → 全部通过，`#hits` 265/265、0 条加载失败、MSPT 6.6 ms |
| 两种刻率 | `styx:play/start`（20 tps，默认）与 `styx:play/start_hi`（100 tps 精确网格）；`styx:redo` / `styx:redo_hi` 对应一键重做 |
| 证据 | `tests/e2e.md`（三次运行的刻窗口/触发数/MSPT），原始日志 `testserver/e2e-{lo,hi}.log` |
