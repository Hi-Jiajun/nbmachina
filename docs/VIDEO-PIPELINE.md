# 出片链路（画面 + 无损音轨 → 成片）

> 原则一句话：**音轨不用录**。音频用离线母版（`build/master/styx_master_48k24bit.wav`，
> 和游戏内同一份谱面、同一套采样渲染出来），画面从游戏里录，最后用 `tools/mux-video.mjs` 按时间轴合起来。
> 这样音轨永远是无损的，也不受录制时的声卡/编码影响。

## 0. 先决条件（已就位）

* 客户端：`replaymod-1.21.10-2.6.27`（画面录制/渲染）、`nbmachina-0.1.0.jar`（机器与无损引擎）
* 母版：`build/master/styx_master_48k24bit.wav` + 三条 stems（要重配比时用）
* 时间轴小抄：`build/video_cuesheet.md`（19 段 + 关键点，剪辑对着用）

## 1. 录制前（游戏内，按顺序）

```
1) 重启游戏（换过 jar 必须重启）→ /reload
2) /function styx:redo            ← 只有谱面/machine_map 更新过才需要；约 1 分钟
3) /nbmc instrument set all <id>  ← 可选：选音色（salamander48 / disklavier / vsco_upright …）
4) /tick rate 100                 ← 让灯/粒子的视觉误差压到 ±5ms（声音已是 ~1ms 级）
5) /function styx:play/sound_on   ← 让机器自己发声，录制时你能听到进度（成片会用母版替换）
6) F1 隐藏 HUD、F5 切好视角（ReplayMod 录制后机位还能改，不必纠结）
```

## 2. 录制（ReplayMod）

```
1) 开始录制（ReplayMod 的录制开关）
2) /function styx:play/start      ← 20 tps 表；如果上面 /tick rate 100 就改用 start_hi
3) 等 4 分 38 秒演完；期间不要动世界（想挪视角无所谓，回放里能改）
4) 停止录制 → 回放列表里能看到这段
```

**记下"音乐起始偏移"**（合成时要用的 `--offset`）——两种等价办法：

* 在回放里拖到**第一盏灯亮起**的那一帧，读时间戳（= 母版的 0:00）；
* 或者拖到聊天里出现 `[Styx] 开始演奏…` 的那一帧。

## 3. 渲染画面（ReplayMod 渲染器）

* 分辨率 **2560×1440**、帧率 **60fps**、码率 **40–80 Mbps**（或先导 ProRes 再压）
* 相机：加几个关键帧做平滑推拉；建议一个全景俯拍（看整条机器亮灯）+ 一两个近景（看音符盒/粒子）
* 导出得到 `styx.mp4`（这时的音轨是游戏内录的，**后面会被母版替换**）

> 不想学 ReplayMod 相机就用 OBS 直接录窗口，规格同上；代价是机位只能在录制时定。

## 4. 合成（一条命令）

```powershell
cd nbmachina
node tools/mux-video.mjs --video D:/render/styx.mp4 --offset 3.2 --out build/final/styx_final.mkv
# 先体检不合成：加 --check
# 兼容优先（MP4 + AAC 320k）：加 --aac
# 想要投稿平台响度（会改电平，默认不做）：加 --loudness -14
```

它会打印三条信息并做对齐检查：视频规格/时长、音轨规格/时长、**偏移后是否够长**（不够会警告）。
产物：MKV（视频流直接 copy + 音轨 **PCM 48k/24bit**）——即"无损成片"。

## 5. 投稿规格（B 站 hi-res）

* 视频：1440p60（B 站会二压，但源越高越好）
* 音轨：48kHz / 24bit 无损（`styx_final.mkv` 里就是）
* 署名：采样来源按 `NOTICE.md` 写进简介（Salamander CC-BY 3.0 / OLPC CC-BY 3.0 / VSCO CC0）
* 不要用原曲录音；封面/简介注明"MIDI/piano 改编：Animenz；作曲：MYTH & ROID / KADOKAWA"

## 6. 已知的取舍

* **多声道**：用户 2026-09-18 决定暂缓（先做双声道无损）。
* **视觉升级**（更绚丽的灯/粒子）：已记录为**另一个独立 mod**，不在 nbmachina 里做。
* **游戏内直录音频**：不做——离线母版就是机器该有的声音，且无损、可复现。
* 20 tps 下灯/粒子的视觉误差是 ±25ms；`/tick rate 100` 后 ±5ms。想更准只能客户端画假灯（未做）。
