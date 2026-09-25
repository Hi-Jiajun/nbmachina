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

## 7. 音轨怎么进回放导出（M3-75 实测结论）

用户问："怎么把我们这个 mod 的无损音频接入 replay mod，在导出时能选音频轨道？" 查了两个 mod 的 jar（不是猜）：

| mod | 音频能力 | 结论 |
|---|---|---|
| **ReplayMod** `1.21.10-2.6.27` | 整个 jar **没有任何音频类**，`en_US.lang` 里也**没有一条音频选项**；渲染设置只有渲染方式/分辨率/码率/编码预设/FFmpeg 参数 | **纯画面渲染器**，导出时选不了音轨 → 走"后期合" |
| **Flashback** `0.39.9`（已下载，当前 `.disabled`） | 有完整音频系统：`AudioKeyframe`（带**文件选择器**，字段是 `java.nio.file.Path`，用 FFmpeg 解码）、`Audio Options`（Record Audio / Stereo / **Audio Codec**）、`Set Audio Source: Camera/Entity` | **有你要的"音轨选项"**，但输出编码只有 AAC/MP3/OPUS/VORBIS（**没有 FLAC/PCM**） |

### 路线 A · 真无损（推荐给 B 站 hi-res）

1. ReplayMod 渲染时把 **Encoding Preset 选成 `MKV - Lossless`**（它内置了这个预设），分辨率/帧率按你要的填，导出得到**纯画面** MKV。
2. 用本仓库的工具把母版音轨合进去：

```bash
# 默认音轨 = build/master_v2/styx_master_v2_48k24bit.wav（自动挑最新母版，会跳过 stem_ 分轨）
node tools/mux-video.mjs --video D:/render/styx_lossless.mkv --offset 0 --out build/final/styx_final.mkv
# --flac 用 FLAC 音轨（同样无损，体积约 1/4）；不加则用 PCM 48k/24bit
```

视频流是 `-c:v copy`（无损画面原样搬过去），音轨是 **PCM 48k/24bit 或 FLAC 48k/24bit** → 整条链无损。
实测校验（ffprobe）：`pcm_s24le 48000 2ch 24bit` / `flac 48000 2ch 24bit`。

### 路线 B · 一步到位（音轨有损，但省事）

把 `Flashback-0.39.9-for-MC1.21.10.jar.disabled` 改名去掉 `.disabled` → 进回放编辑器 → 新建 **Audio Track** → 加一个 keyframe（会弹出文件选择器）→ 选母版：

```
build/master_v2/styx_master_v2_48k24bit.wav    # 原始母版 48k/24bit
build/master_v2/styx_master_v2_48k24bit.flac   # 无损、22MB，导入更轻（M3-75 新增）
build/master_v2/styx_master_v2_opus256k.ogg    # 有损 256k，兜底用（M3-75 新增）
```

导出时 `Audio Options → Audio Codec` 选 **OPUS**（四个里最好），音源可选 Camera/Entity。

### ⚠️ 为什么不能让回放 mod"自己录到"我们的声音

Flashback 的 `MixinSoundEngine` 只 hook **原版 `SoundEngine.play`**；而 nbmachina 的音源引擎是 **自己的 OpenAL 设备/上下文**
（`NbmachinaAudio`，M3-16 特意绕开原版 SoundManager 才能把 48k/24bit 采样原样喂进声卡）→
**`Record Audio` 抓不到我们的钢琴声**。所以只有两条正路：导入母版文件（路线 B）或后期合（路线 A）。
（旧的 OBS 桌面音频捕获依然可用：它抓的是系统输出，与 mod 实现无关，但那样录到的是浮点混音而不是母版自身。）

### 对齐（offset 怎么定）

* 母版 t=0 = 机器的**谱面 0 秒**（谱面整体 +3.917 与 Animenz 视频同轴），**第一个音在母版 3.917s**。
* 录制起点正好等于机器启动 → `--offset 0`；早录了 N 秒 → `--offset N`。
* 不确定就打个可见标记：机器启动那一刻执行 `/nbmc click`（3kHz 脉冲 + 脚下 END_ROD 粒子），
  或对 OBS 录音用 `node tools/compare-ingame-vs-master.mjs --record ...` 量出偏移。

## 8. M3-76 · 游戏内无损录音（`/nbmc rec`）—— 让"对齐"这件事消失

用户要求：在 mod 里做游戏内无损录制，且能直接和 ReplayMod / Flashback 配合，**不用手算时间戳**，
渲染出来的视频里就是游戏里听到的那份音频。

### 怎么工作

* 录音器（`NbmachinaRecorder`）不录声卡，而是**按引擎真正起的每一路声部重建混音**：
  引擎每次 `alSourcePlay` 都会把（采样文件 / 实际增益 / 音高比 / 谱面时值）交给它，
  放音（制音器落下、同键重击、低音单音线抢音、被抢声掐掉）时再回填包络 → 与 `NbmachinaAudio` 同一套口径，
  **可复现**、不受设备重采样/延迟影响。
* 输出：`<游戏目录>/nbmachina/recordings/nbm-<时间戳>[-tag].wav` = **48kHz / 24bit / 立体声（无损）**，
  旁边一份同名 `.json` 锚点（采样率、时长、峰值、削顶帧数、录音起点刻、回放录制起点时刻…）。
* **零对齐**：ReplayMod / Flashback 一按"开始录制"，聊天栏那条 `replaymod.chat.recordingstarted`
  （TranslatableText，按键名匹配、不看语言）会被客户端 hook 到 → **我们的录音就从那一刻起算**。
  于是 **WAV 的 t=0 == 回放时间轴的 t=0**。
* 手动开关：`/nbmc rec start|stop|status`（一般不用，自动那条更准）。

### ReplayMod（优先支持，零偏移）

```bash
# 1) 正常录回放（mod 会自动开始录音，聊天栏会打一行"无损录音开始"）
# 2) ReplayMod 渲染：Encoding Preset 选 MKV - Lossless（或任意画质）
# 3) 一条命令合片：锚点文件里已经写好了音轨路径与偏移
node tools/mux-video.mjs --report "<游戏目录>/nbmachina/recordings/nbm-XXXX.json" \
     --video D:/render/styx_lossless.mkv --out build/final/styx_final.mkv
```

`--report` 会读出音轨与 `replayOffsetSec`（自动开录时恒为 0），不需要你输 `--offset`。

### Flashback

Flashback 的编辑器里新建 **Audio Track** → 加 keyframe（文件选择器）→ 选那条 `nbm-XXXX.wav`
→ **放在 0 秒**（因为 t=0 已经对齐）→ Audio Codec 选 OPUS（它只有 AAC/MP3/OPUS/VORBIS）。

### 自检 / 边界

* 脱离游戏也能验：`_scratch-m3-76/RecorderSelfTest.java` 用三路已知声部跑一遍，
  输出的 WAV 逐 0.2s RMS 与预期一致（0.0312 = 主增益 0.5 × 源 RMS、确定性放音、抢声立刻掐、淡出后静音）；
  `_scratch-m3-76/wav-stats.mjs` 是配套的波形统计脚本。
* 单文件最长 90 分钟（约 1.5GB）；录音中若游戏卡顿，混音线程会自动补上（它按**起播时刻**记账，不是按处理时刻）。
* 录音的 t=0 是"引擎起播那一刻"，不含声卡输出延迟（约几十毫秒）——**对视频同步反而更准**，
  因为画面也是同一条命令链路出来的。

## 9. Flashback 无损导出（M3-78：`tools/flashback-lossless/`）

Flashback 的导出界面原本只有 **AAC / MP3 / Opus / Vorbis** 四档，全是有损的——也就是说
上面那条 48k/24bit 的 WAV 挂成回放音轨之后，**成片里还会被再丢一次精度**。原因在
`exporting/AsyncFFmpegVideoWriter.java`：它对所有音频编码器都写死 `AV_SAMPLE_FMT_FLTP`，
而 ffmpeg 的 FLAC / ALAC / PCM 编码器都不接受 fltp（上游源码里 FLAC 那行注释就是同一个坑）。

`tools/flashback-lossless/build-patch.ps1` 用你自己的上游 clone + 官方 jar，在本地生成一个
补丁版 jar，给导出窗口补上 **FLAC / ALAC / PCM 16 / 24 / 32 / float32** 六档：

```powershell
git clone https://github.com/Moulberry/Flashback.git; cd Flashback; git checkout 1.21.10
pwsh -File tools/flashback-lossless/build-patch.ps1 `
     -UpstreamSource <clone 目录> -FlashbackJar "<游戏目录>\mods\Flashback-0.39.9-for-MC1.21.10.jar" -Verify
```

出片流程（与前面的录音/音轨注入是同一条链）：

1. 回放录完 → `tools/flashback-attach-audio.mjs` 把 `nbm-XXXX.wav` 挂成 t=0 的音频轨；
2. Flashback 回放中心 → 导出：**容器 MKV**、勾 **Record Audio** 与 **Stereo**、
   编码器选 **FLAC**（或 `PCM 24-bit`，体积大但零编码）；
3. 成片音轨校验：`ffprobe -select_streams a:0 -show_entries stream=codec_name,sample_fmt,bits_per_raw_sample`。

为什么这条路是无损的（`FlashbackAudioManager.playAt(... soundEngine.channelAccess ...)` ⇒
回放音轨走**原版 SoundEngine 设备**播放，导出侧 `ExportJob` 抓的是同一台 device 的
`SOFTLoopback` 环回）：24bit 整数样本在 float32 混音里**精确可表示**，所以只要编码器选无损档，
我们那份 24bit 母版就原样进成片。前提是勾"立体声"——不勾的话 `MixinAudioLibrary` 会把设备
切成单声道。

注意：Flashback 的许可是 *Do not redistribute / All rights reserved*，所以仓库里**只有我们自己的
补丁脚本**（`build-patch.ps1`、`diff-bytecode.mjs`、`verify-audio.mjs`、`AudioCodecHarness.java`、
intermediary stub 与 README），没有任何 Flashback 源码或 jar。

---

## 10. M5-41 · 导出音频桥：音乐怎么进 Flashback 成片（2026-09-25 定稿）

上面 §9 的"挂音频轨 → 回环抓音"路线**实测不成立**：Flashback 的 `Record Audio` 抓的是原版 SoundEngine 设备的
`SOFTLoopback`，而 nbmachina 的引擎走**自有 OpenAL 设备**，所以导出的 PCM 轨是**整条静音**（2026-09-25 `StyxHelix.mkv`：
音轨存在、逐样本 0、volumedetect -91 dB；9-24 那条"验收过"的成片也是静音，当时只验了编码格式）。

现在走**导出音频桥**（补丁版 Flashback + mod 反射注册），细节与取证见 `docs/M5-41-export-audio-bridge.md`：

1. 打包/装机：`tools/flashback-lossless/apply-fb-audiobridge.mjs` → `gradlew build` → `assemble-fb-jar.ps1`
   （产物 sha256 `7E1ABA3D…`）；mod 侧 `nbmachina-0.10.3.jar`；
2. 配音轨（自动算偏移，不用手量）：
   `node tools/nbm-export-audio.mjs --replay <回放.zip> --audio build/master_v2/styx_master_v2_48k24bit.wav`
3. Flashback 回放中心导出：容器 **MKV**、勾 **Record Audio**、编码 **FLAC** 或 **PCM 24-bit**
   （`recordAudio` 关掉时 Flashback 不建音频流，桥写不进去）；
4. 成片音轨校验：`ffprobe … -select_streams a:0` + `ffmpeg -af volumedetect`（要看到真实电平，不能是 -91 dB）。

离线逐样本对账：`tools/flashback-lossless/ExportAudioHarness.java`（五个窗口最大误差 ≤1.16e-10 = 与母版字节一致）。
