# M3-14 · 实测力度正式接进数据包（2026-09-15）

**用户决定**："力度强弱关系我没有听出来，但是最好还是把实测力度正式接进数据包吧。"
（同时确认 Salamander 与 Disklavier 两架钢琴"都十分不错"→ 两架都保留，Salamander 仍是默认。）

## 1. 为什么之前"听不出来"

不是采样的问题，是**口径**的问题：

| 环节 | 改造前 | 后果 |
|---|---|---|
| M0 T5b 力度 | 窄带能量按 p10/p90 **线性**映到 0.35..1.0 | 能量是重尾分布 → 旋律 80% 的音挤在 0.36~0.48（n=1639，中位 0.422） |
| machine 谱面 | 去撞格时只保留 7 列，`velocity` 列被丢掉，`volume` 恒为 0.350 | 实测力度**根本没进**数据包 |
| 离线渲染 | `volume` 恒 0.35 → 每颗音都落在同一个采样力度层、增益只差 0.55+0.45·0.35 | 1385 颗旋律音只解出 16 个采样文件（Yamaha）——等于没有强弱 |

离线 A/B（第一版，只把 0.35..1.0 的原始力度直接当增益）用户判定"没有听出来"——指标上确实只有
~1dB 的动态，听不出来是**正确的听感**，这条反馈直接暴露了上面的口径问题。

## 2. 改造（四个文件 + 一个新步骤）

1. **`src/arrange/dynamics.mjs`（新）**：把实测力度归一成 **`velMidi`（1..127）**
   —— 三点分段线性的**分位数拉伸**：p5→10、p50→64、p95→127，旋律与贝斯**各自统计**
   （两者能量分布差得远，共用一套分位数会把贝斯压平）；打击乐没有力度概念（留空）；
   `velocity = 0`（音频里没有证据）落在地板 10。
   同一个模块给出 `velMidiToAmplitude()`：1 → -18dB、127 → 0dB，**采样层选择与播放音量共用这把尺子**。
2. **`src/arrange/arrange-all.mjs`**：新增步骤 **⑥b 力度归一（velMidi）**
   （`pipeline_6_merged.csv` → `pipeline_6b_dynamics.csv`），在去撞格之前完成。
3. **`src/arrange/dedupe.mjs`**：追加列**透传**（原来固定写 7 列，会把 velocity/velMidi 吃掉）；
   同时顺手修掉"主谱面 12 列 + 打击乐 7 列"混排的历史问题（写出时按表头对齐）。
   去撞格的**决策字段（前 7 列）与改造前逐字符一致**（有单测守着）。
4. **`src/emit/playsound-hifi.mjs`**：音量口径改成 `velMidi → velMidiToAmplitude()`
   （没有 velMidi 的音退回旧的 `volume`）。
5. **`tools/render-ensemble.mjs`**：`--dynamics measured` 时用 velMidi 同时驱动
   **采样层选择**与增益；`--dynamics flat`（默认）保持与改造前逐字节一致。

## 3. 实测证据

**谱面**（`build/machine_pipeline.csv`，13 列）：

```
harp  n=1639  velMidi min 10 / p25 33 / 中位 66 / p75 91 / max 127
bass  n=1276  velMidi min 10 / p25 44 / 中位 64 / p75 64 / max 127
打击乐 96+42 留空（无力度概念）          列数一致性：全部 13 列
```

**数据包**（`build/styx_build/data/styx/function/play/hifi/**`）：

```
2915 条 playsound 带逐音音量，77 个不同取值，0.15..1.00
lint-pack：788 个函数 / 140345 行，静态自检通过
装包：`build/install_styx_pack.log` → `OK … pack_structures=196`
```

**无头 e2e（真服务端 + 真数据包）**：`#hits 增量 295/295`、MSPT **7.2ms**、0 加载错误、退出码 0。

**离线渲染动态范围**（同一份谱面、同一套采样，30 秒窗口=0.25s 的短时 RMS 统计）：

| 渲染 | 短时 RMS 标准差 | p5 / p95 | 用到的力度层 | 增益范围 |
|---|---|---|---|---|
| Salamander · flat（改造前口径） | 5.51 dB | -31.1 / -13.9 | 1 层 | ×0.71..1.00 |
| Salamander · measured（新） | **7.33 dB** | -32.6 / -12.9 | **118 层** | ×0.146..1.000（16.7dB） |
| Yamaha · flat | 6.57 dB | -31.5 / -13.3 | 1 层 | ×0.71..1.00 |
| Yamaha · measured（新） | **7.96 dB** | -33.6 / -12.6 | **118 层** | ×0.146..1.000 |

## 4. 怎么回退 / 怎么复算

```bash
npm run arrange:all                       # 重新生成含 velMidi 的谱面（⑥b 步骤）
node src/emit/note-blocks.mjs             # 以下 5 条 = 重生成数据包（顺序不能变）
node src/emit/datapack-playback.mjs
node src/emit/undo-clone.mjs
node src/emit/redo-chain.mjs
node src/emit/playsound-hifi.mjs
node src/emit/lint-pack.mjs
pwsh -NoProfile -File build/install_styx_pack.ps1
```

回到"没有强弱"只需 `--dynamics flat`（离线）或把 `velMidi` 列删掉再重生成数据包；
归一的参数（p5/p50/p95、floor/mid/ceiling、rangeDb=18）都在 `DYNAMICS_DEFAULTS` 里集中可调。

## 5. 未做的事（如实声明）

- **原版音符盒（后端 B）拿不到力度**：红石触发的 note block 只有音高，没有音量，
  所以"有强弱"只在 hifi（自研音色/将来 mod）这条链路上成立；
- 力度是**从参考演奏（Animenz 视频）量出来的**，不是乐谱自带的力度记号；带 249 行没有测到
  （打击乐 138 + 低音提琴 dedup 后少掉的 106 等），这些音退回地板或原 volume；
- 归一是**按声部的相对拉伸**：它还原的是"这首曲子里谁比谁响"，不是绝对 MIDI 力度。
