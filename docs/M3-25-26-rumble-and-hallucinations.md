# M3-25/26 · 用户点名的两处：碎音/幻觉音 + 采样库的次低频隆隆声

> 用户 2026-09-18 听完 R2/R4b/R7 后反馈：**"2:47 有个音好像双击了"**、**"4:37 出现的低音似乎不该出现"**，
> 并明确"都不如原曲"。逐条查到实证：

## 1. 4:37 的"不该出现的低音" = 采样库自带的 20–40Hz 隆隆声（主因）

用"同一颗音、同一时间窗"对比三条素材的 **20–40Hz 占总能量比例**：

| 素材 | 20–40Hz 占比（中位） |
|---|---|
| 原视频 | **−55.6 dB** |
| 我们的成品（R8） | **−29.7 dB**（+26dB！） |
| **单个 Salamander 采样直出**（A0v8.wav） | **−37.1 dB** |

→ 隆隆声**来自采样本身**（录音的房间/音板噪声），不是混音或限幅造成的；原视频那条音轨在这一带几乎是空的
（YouTube 编码或原始录制本来就薄）。听感就是"底下一直有一层嗡"。

处置：**48Hz 四阶高通**（两级级联 2 阶）

* 渲染侧：`tools/render-ensemble.mjs` 默认给总线加（`--no-hpf` 可关）；
* 游戏内：`_toolchain/piano/salamander48_hp/`（641 个文件批量 `ffmpeg highpass`）+ 同名 SFZ，
  `tools/export-mod-instruments.mjs` 已指向它（`nbforge/instruments.json` 480 个区域全部走高通版）。
  实测单个文件：20–40Hz −37.1 → **−55.3 dB**，60–100Hz 只掉 0.5dB。

效果（20–40Hz 占比）：4:37 处 −36.5 → **−54.4 dB**（原视频 −49.3）；整曲各抽样点都贴近或低于原视频。
谱面最低音是 G#1(51.9Hz)，48Hz 高通对它 <1dB。

## 2. 转谱幻觉：25 颗"原曲根本没有"的音

新增 `tools/filter-notes-vs-render.py`：对每颗音取**基频带**（带宽自适应，低频至少 12 个周期、
≥2.5 个 FFT bin），比较"原视频"与"我们的渲染"在**同一时刻同一频带**的能量 →
`我们 − 原曲 > 12dB` 且 `原曲该带占比 < −35dB` 判为幻觉，删除。

结果：删掉 **4 颗 C#1（34.6Hz）**（172.86 / 176.63 / 180.38 / 264.97s）。这些音原视频里只有 −47…−55dB，
我们却在响——264.97s 那颗还会拖 20 秒，正是"4:37 那个不该出现的低音"的另一半来源。

（更早两步：丢 10 颗 <30ms 的"咔哒"碎片；`verify-notes-against-audio.py` 删 202 颗相对证据不足的音。）

## 3. 2:47 的"双击"：已消除已知两类伪影，仍需用户确认

* 该处谱面在 167.06s 有一簇 6 颗同时音（含 G#1/G#2 八度对）；逐音对照后，原曲**也有**这些音
  （G#1 占比 −8.4dB、G#2 −9.9dB），所以不是"多出来的音"。
* 已消除的两类伪影：<30ms 碎音（全曲 10 颗）、相对证据不足的音（202 颗，含 165.36s 的一颗 G#2）。
* 若仍能听到，需要用户给更细的定位（"第几声之后/哪种乐器"），我再做一次针对性时频比对。

## 4. 当前产物

* 谱面：`build/machine_from_reference.csv`（**2930 颗音**，含 `time_seconds/velMidi/keyMs/durMs`）
* 数据包：790 函数 / 144213 行 / 196 结构（lint 全绿）
* `nbforge/machine_map.csv` 2930 个位置、`nbforge/score.csv` 2930 颗 → 已部署客户端 + 副本服
* 成品：`build/ab/R10_hpf48x2_48k24bit.wav`；两处片段 `final_2m45-2m53.wav` / `final_4m32-4m44.wav`
  （附原曲对照 `final_*_原曲.m4a`）
* 关资源包不依赖；mod 侧另外要**重启游戏**才会读新的 `instruments.json`

## 5. 复现

```powershell
# ① 高通版采样（一次性，641 个文件约 30 秒）
ffmpeg -i <sfz目录>/X.wav -af "highpass=f=48:poles=2,highpass=f=48:poles=2" -c:a pcm_s24le _toolchain\piano\salamander48_hp\X.wav
# ② 幻觉音过滤
python nbforge\tools\filter-notes-vs-render.py --in build\ref_video_transcription_verified.json `
  --orig build\ref_video_original.wav --render build\ab\R8_noC1_48k24bit.wav `
  --out build\ref_video_transcription_final.json
# ③ 谱面 → 数据包/映射表（见 docs/M3-24 的链）
```
