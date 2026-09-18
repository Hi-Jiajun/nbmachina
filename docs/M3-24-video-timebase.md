# M3-24 · 改用"原视频真实时间轴"（修开头缺音 / 速度 / 卡顿）

> 用户听完 R 后指出三个问题：**开头缺音、偶尔卡顿、部分节奏和速度不对**。三条全部复现并定位，逐条修掉。

## 1. 开头缺音：对齐音频把开头切掉了

`build/animenz_aligned.wav` 是用 `ffmpeg -ss 4.30` 从视频切出来的（M3-20 的 chroma 对齐给的 lag=4.30s）。
实测原视频的演奏其实从 **3.904s** 就开始了 —— 被切掉的 0.4 秒正是**开头那个和弦**
（A2/E3/A3/C#4/D#4/B4/D#5，频谱里 3.90s 处 E4/A4/A3 三个峰）。

修法：**直接转谱原视频音频**（不切头、不变速）→ `build/ref_video_transcription.json`：
3146 颗音、161 段踏板、演奏区间 **3.904–283.845s**（=279.94s，与"视频演奏段 280.4s"一致）。

## 2. 速度/节奏：不该有那一次 atempo

旧链路为了让"视频时间轴 = 谱面时间轴"，对音频做了 `atempo=1.007`（整体提速 0.7%）再转谱，
等于给演奏**强加了一个常数变速**；而谱面本身与视频之间还有最多 ±0.5s 的自由速度差（M3-22 已量到）。
新链路把这一层彻底去掉：机器的时间轴**就是视频的时间轴**（t=0 = 第一颗音 = 视频 3.904s）。

## 3. 卡顿：触发时刻被 0.12s 格位量化了

机器布局是按 **0.12s 一排**摆的（`step`），旧实现把"触发时刻"也绑在格位上 →
人手演奏被量化到 0.12s 网格，最多 **±60ms** 的抖动，密集段落听感就是"卡顿/粘连"。

修法：把"格位"和"触发时刻"拆开 ——

* **格位 `step`**：只当"这个音符的房子在哪"（决定坐标 x/z，摆块用）；
* **触发时刻 `time_seconds`**：精确到**刻**（20 tps = 50ms；`/tick rate 100` 时 10ms）。

改动落在 `src/emit/tick-map.mjs`（`tickOfTime` + `buildTickGroups` 优先用 `timeSec`）、
`datapack-playback.mjs` / `playsound-hifi.mjs`（读可选列 `time_seconds`）、
`tools/render-ensemble.mjs`（离线渲染同样优先用精确时刻）。

> 所以：**格位擦边不再影响节奏**。20 tps 下抖动 ≤25ms；若在游戏里先 `/tick rate 100`，
> 用 `/function styx:redo_hi`，抖动 ≤5ms。

## 4. 客观验证

与**原视频音频**的对数包络相关（50ms 帧、全曲 286s）：

| 版本 | r |
|---|---|
| 旧 R（对齐时间轴 + 0.12s 量化） | 0.713 |
| **新 R2（视频时间轴 + 精确时刻）** | **0.859** |

产物：`build/ab/R2_videotime_48k24bit.wav`（全曲 48k/24bit）、`R2_head_0-40s.wav`、`R2_55-95s.wav`。

## 5. 机器侧

* 谱面：`build/machine_from_reference.csv`（3146 颗音，`step 0..2333`，含 `time_seconds/velMidi/keyMs/durMs`）
* 数据包：790 函数 / 149459 行 / 196 结构（lint 全绿）；`apply_notes_v3` 3146 格 + 清历史格位 5835 格
* `nbforge/machine_map.csv` 3146 个位置（带 dur_ms）、`nbforge/score.csv` 3146 颗（6 列）→ 已部署客户端 + 副本服
* mod 默认 `listen on`（M3-23 已改）、`/function styx:redo` 收尾不再打开旧 `/playsound` 监听层

## 6. 游戏内换过来

```
1) 重启游戏
2) /reload
3) /function styx:redo          ← 清旧块、摆新块（约 1 分钟，自动开播）
   · 想要最准：先 /tick rate 100，再用 /function styx:redo_hi
```

## 7. 复现

```powershell
ffmpeg -y -i "<原视频.mp4>" -vn -ac 1 -ar 44100 -c:a pcm_s16le build/ref_video_original.wav
_toolchain\py312\python.exe nbforge\tools\transcribe-reference.py `
  --in build\ref_video_original.wav --out build\ref_video_transcription.json `
  --checkpoint _toolchain\piano_transcription\note_F1=0.9677_pedal_F1=0.9186.pth
node nbforge\tools\score-from-transcription.mjs --out build\machine_from_reference.csv
# 之后照 docs/M3-23 的 emit 链重建数据包与映射表
```
