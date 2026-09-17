# M3-22 · 拿参考演奏校准机器谱面（音区 + 时值）

> 一句话：**谱面的节奏是对的、旋律是对的、左手低音低了两个八度、而且整首没有时值。**
> 这一轮用 Animenz 视频的转谱把这三件事一次性对齐。

## 1. 怎么"听"参考演奏：MIT 转谱模型

`tools/transcribe-reference.py` 调用 [piano_transcription_inference](https://github.com/qiuqiangkong/piano_transcription_inference)
（MIT，qiuqiangkong，"Onsets and Frames" 系 CRNN，MAESTRO 训练；官方 note F1=0.9677 / pedal F1=0.9186），
权重来自 Zenodo（`CRNN_note_F1=0.9677_pedal_F1=0.9186.pth`，165MB，已放 `_toolchain/piano_transcription/`）。

输入是**已经和谱面时间轴对齐**的 `build/animenz_aligned.wav`（M3-20 的 `-ss 4.30 -atempo 1.007`），
输出每颗音的 onset / offset / velocity，以及**踏板**的踩下/抬起（182 段，踩下时间占比 83%）。

CPU 推理：292s 音频 84.5s（Ryzen 7 9700X，torch 2.14 CPU）。

## 2. 三条实测结论

### ① 时间：谱面与视频的时移是**随段落漂移**的，不是常数

纯 onset 互相关在密集织体里峰值又宽又平（前两个探针都栽在这），改用"同音名 + 时间软匹配"后峰值锐利：
56 个 10s 窗的最佳时移落在 **-0.60s ~ +0.48s**，中值滤波后作为 `lag(t)` 曲线。

> 影响：M3-20 的"实测力度"就是拿这条错位的时间去音频上采样的 —— 这是 M3-14 那版"实测力度特别不好听"的
> 另一个根因（另一个是力度取自原曲混音而非视频，已在 M3-20 修正）。

### ② 音区：`bass` 声部整体低**两个八度**，`harp` 不用动

按 `lag(t)` 对齐后，逐声部搜索整体移调（步进 12 半音）：

| 声部 | 音数 | 不移调命中 | 最佳移调 | 移调后命中 | 结论 |
|---|---|---|---|---|---|
| harp（旋律 + 内声部） | 1639 | **89.9%** | 0 | 89.9% | 不动 |
| bass（左手） | 1276 | 2.8% | **+24** | **72.8%** | 采纳 |

`bass` 的 +24 在**每一个 20s 窗口**里都是最优（命中 63~96%），不是局部现象。
证据链：视频 0.05–0.75s 的频谱最低强分音是 A3(220Hz)/E4/A4，**没有 55Hz**；
而谱面同刻写的是 A1(55Hz)/C#2/E2 —— 同样的 A 大三和弦，整体低两个八度。
grep 佐证：修前 bass 有 124 颗音超出钢琴采样音域被整八度折回。

> 听感影响：低音从 55Hz 挪到 220Hz，就是"低音一直轰、越弹越糊"的根因（26.7% 能量在 100Hz 以下 →
> 校准后 7.6%）。对应用户反馈"低音的部分感觉延音一直都在，低音多了之后就很混乱嘈杂"。

### ③ 时值：谱面没有时值，但视频里有"手指松开"和"踏板抬起"

真钢琴上一颗音什么时候停，由两件事决定：**键释放**（note offset）与**踏板抬起**（制音器落下）——
踏板踩着的时候松键**不**制音。转谱同时给出这两者，于是：

```
实际发声时长 = max(键释放, 松键那一刻所在踏板段的抬起时刻)
```

一对一匹配结果：**2384/3053 = 78.1%** 的谱面音直接匹配到转谱音（剩下 559 颗按踏板兜底、110 颗按 0.35s 短触键兜底）。
键按住时长中位 0.462s，实际发声 p10 0.228s / 中位 0.892s / p90 2.706s。

## 3. 落地改了什么

| 位置 | 改动 |
|---|---|
| `tools/transcribe-reference.py` | 新增：参考演奏 → `build/ref_transcription.json`（音 + 踏板） |
| `tools/calibrate-from-reference.mjs` | 新增：时移曲线 + 逐声部音区校准 + 逐音时值 → `build/machine_pipeline_calibrated.csv`（新增列 `midiBefore/regShift/durMs/refMatched`，`midi` 列直接写校准后的音高） |
| `src/emit/playsound-hifi.mjs` | `parseScoreCsv` 认识可选列 `durMs`（透传到事件，不影响旧行为） |
| `tools/render-ensemble.mjs` | `--preset piano`（与 mod 同一套编制：三层都是同一架琴、跳过打击乐）；`durMs` → 渲染时加**制音器放音包络**（低音 300ms / 中音 200ms / 高音 140ms raised-cosine） |
| `tools/export-mod-machine-map.mjs` | 第 8 列 `dur_ms`（2915/2915 颗） |
| `tools/export-mod-score.mjs` | 第 6 列 `dur_ms` |
| mod `NbforgePlayPayload` / `NbforgeNoteBlocks` / `NbforgeScore` | 协议与 CSV 都带 `durMs` |
| mod `NbforgeAudio` | 声部带 `durMs`：**到点自动放音**（`releasedByScore` 计数）；有谱面时值时**关掉**"低音单声部"硬掐（那颗音该响多久由演奏者决定） |
| mod `/nbforge info` | 修掉误导：原先把"旧路径（/nbforge note\|sustain）"的计数摆在第一行，看起来像"什么都没发生"；现在第一行是**自研演奏器已派发次数** |

## 4. 验证

* 副本服自检（`-Dnbforge.selftest=true`）：谱面直读 2915 颗 / 跳过 0 行（6 列新格式）、
  机器映射 2915 个位置（8 列新格式）、命令链与解析矩阵全绿、干净停服。
* 离线成品（全钢琴编制，48k/24bit）：`build/ab/对比1_现状_全曲_48k24bit.wav` vs
  `build/ab/对比2_参考校准_全曲_48k24bit.wav`；低频（<100Hz）能量占比 26.7% → **7.6%**，谱质心 884Hz → 932Hz。
* A/B 片段（低音最重的 55–95s）：`对比1_现状_55-95s.wav` / `对比2_参考校准_55-95s.wav`。

## 5. 复现

```powershell
# ① 转谱（只需跑一次；权重在 _toolchain/piano_transcription/）
_toolchain\py312\python.exe nbforge\tools\transcribe-reference.py `
  --in build\animenz_aligned.wav --out build\ref_transcription.json `
  --checkpoint _toolchain\piano_transcription\note_F1=0.9677_pedal_F1=0.9186.pth

# ② 校准（音区 + 时值）
node nbforge\tools\calibrate-from-reference.mjs

# ③ 导出并部署给 mod
node nbforge\tools\export-mod-machine-map.mjs --in build\machine_pipeline_calibrated.csv --deploy
node nbforge\tools\export-mod-score.mjs --in build\machine_pipeline_calibrated.csv --preset piano --deploy

# ④ 离线成品（A/B 的 B 就是这个）
node nbforge\tools\render-ensemble.mjs --preset piano --dynamics measured `
  --score build\machine_pipeline_calibrated.csv --name styx_B2_piano_calibrated --out build\ab
```

## 6. 未做 / 待定

* **时间轴**没有改：谱面比视频最多早/晚 0.5s（自由速度差异）。改它要重排机器布局
  （step 变 → 方块坐标变 → 数据包与结构都要重生成），等听感定稿后再决定要不要做。
* 力度仍是"视频力度 · 乐句级"（用户 2026-09-16 定稿的档位）。时间轴校准后**逐音力度**理论上会变准
  （采样点不再错位），可以再出一版 A/B 让用户判。
* 转谱漏检的 559 颗音目前用"响到踏板抬起"兜底；若要更准，可对这批音单独做能量衰减跟踪。
