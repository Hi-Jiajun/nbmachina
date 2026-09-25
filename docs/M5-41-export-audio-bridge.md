# M5-41 · 导出音轨接进 Flashback（2026-09-25）

## 1. 用户报的现场

> "这个测试成品我发现似乎并没能成功，主要是游戏内音乐没能成功导入 flashback，从而在导出渲染时发生错误；
> 在 flashback 中进行编辑时是可以听到音乐声音的，但是有 bug：我只要点击了含音乐的时间轴，不管哪个时间，
> 它都会从头播放一次音乐，而且是叠加的，最后让我的游戏变得很卡很卡。"

（成片：`C:\Users\hiliang\Videos\StyxHelix.mkv`；会话：`codex://threads/01a0cff1-e221-74e0-bb1e-3d5699b6885c`）

## 2. 取证（都是实测，不是推测）

| 证据 | 实测结果 |
|---|---|
| 成片音轨 | `ffprobe`：`pcm_s24le 48000Hz 2ch` **存在**；`volumedetect`：mean = max = **-91 dB（逐样本 0，整条静音）** |
| 9-24 那条"验收过"的成片 | `2026-09-24T03_40_38.mkv` 同样是 **-91 dB** —— 当时只验了编码格式，没验内容，属于**误判**，本轮更正 |
| Flashback 编辑态 | `flashback/editor_states/*.json`：9-25 三条 Styx 回放**没有任何 AUDIO 轨**（只有 CAMERA） |
| mod 录音目录 | `<gameDir>/nbmachina/recordings/` **空的** —— M3-76 的"自动开录"从没被触发过 |
| 为什么没触发 | M3-76 挂在 `replaymod.chat.recordingstarted` 这条**聊天键**上；**Flashback 不用聊天提示**（它用 toast，见 `flashback.option.recording_controls.show_recording_toasts`）→ 钩子永远不响 |
| 编辑里听到的音乐是什么 | 回放里录进了 **3044 条 `nbmachina:play` payload**（见下），回放时 mod 照样收包、照样用**自有 OpenAL 设备**实时发声 → 耳朵听见的是 mod 实时音；这条音**不进导出**（Flashback 的 `Record Audio` 抓的是原版 SoundEngine 设备的 `SOFTLoopback.alcRenderSamplesSOFT`） |
| 为什么点时间轴会"从头放一遍还叠加" | Flashback 的 seek = **回到快照重新快进**整段回放；mod 的调度锚点被重发出来的 `machine_sync` 重置成"谱面 0s"，于是整首歌被**重新排程一遍**；每点一次多排一遍 → 叠加、越听越卡（日志：一轮会话里 mod 收到 **25200** 条音 = 全曲 8 遍） |

回放文件的动作流可以直接解析（`c0.flashback` 条目 → deflate → `[varint actionId][int size][payload]`，
`flashback:action/next_tick` 计刻），据此反解出时间对齐：

| 量 | 实测 |
|---|---|
| `nbmachina:machine_sync` | tick 72（= 3.60s） |
| `nbmachina:play` | **3044 条**，tick 146 → 5744，谱面时间 3.917s → 283.858s |
| 偏移（`tick/20 − 谱面秒`） | **3.3458s**，σ 29.2ms（tick 量化 ±50ms 内），范围 3.272–3.393 |
| 母版 | 298.75s，前奏静音到 3.9316s、末音后静音 287.89s 起 |
| 成片 | 34027 帧 @120fps = 283.55s（音频流 283.478s）；t=0 ≈ 音乐 0s（开场卡片在 0.6s 已成形、首音特效约 3.9s 出现，与母版首音 3.93s 吻合） |

## 3. 修法：导出音频桥（不再依赖声卡/回环）

两条路可选，本轮选了**确定性**的那条：

* ❌ 挂 Flashback 音频轨 → 靠 `SOFTLoopback` 抓回环：依赖设备切换、要手动挂轨、内容没验证过；
* ✅ **导出音频桥**：补丁版 Flashback 每导出一帧就问一次外部 Provider 要样本，直接写进这一帧的 float 缓冲。
  样本来自无损文件，**不经设备、不经重采样、不经编码损耗**；裁剪/变速/改帧率都自动跟随（因为按导出时间轴取）。

### 3.1 Flashback 侧（本地补丁，工具可重放）

`tools/flashback-lossless/apply-fb-audiobridge.mjs <flashback checkout>`：

* 新增 `exporting/NbmAudioBridge.java`：`Provider.fillAudio(FloatBuffer dst, int frames, int channels, double replaySeconds, int sampleRate)`；
* `ExportJob`：`recordAudio || bridge != null` 时分配缓冲；先照旧跑回环（保留原版行为），再让桥**叠加**自己的样本；
  传给桥的时间是 **回放时间轴秒数** = `settings.startTick()/20 + 已写样本数/采样率`；
* 桥抛异常只记一次日志、导出继续（不把用户的导出搞挂）。

### 3.2 mod 侧

* `net.nbmachina.mod.audio.NbmExportAudio`：反射注册 Provider（没装补丁版 Flashback 就静默跳过）；
  读 `<gameDir>/nbmachina/export_audio.json` → 载入 WAV（PCM16/24/32、float32/64，单/双声道）→ 每帧按
  `pos = (replaySeconds − offsetSec) × srcRate` 线性插值混入；`/nbmc exportaudio [reload]` 看状态。
* **回放快进保护**（`NbmachinaClient` + `NbmachinaScheduler.clear()`）：一秒内 payload > 80 条判为"快进重放"
  → 清空排程、这段不发声；快进结束后把锚点重新对准当前谱面时间。迟到 > 200ms 的音直接丢。

### 3.3 一条命令配好音轨

```bash
node tools/nbm-export-audio.mjs --replay <回放.zip> --audio build/master_v2/styx_master_v2_48k24bit.wav
# → 扫回放里的 payload 反解 offset（不用手量）→ 写 <gameDir>/nbmachina/export_audio.json
```

## 4. 验收

| 项 | 结果 |
|---|---|
| 补丁版 Flashback 构建 | `gradlew build` **BUILD SUCCESSFUL**；注入后 `javap` 见到 `NbmAudioBridge` / `NbmAudioBridge$Provider` / `ExportJob.exportedAudioFrames` |
| 组装 jar | `assemble-fb-jar.ps1` → `Flashback-0.39.9-nbm-audiobridge.jar`，sha256 `7E1ABA3D…`（211,544,661 B） |
| mod 构建 | `nbmachina-0.10.3.jar`（含 `NbmExportAudio`） |
| **混音逐样本对账**（离线，`ExportAudioHarness`） | 母版 14,340,000 帧载入 95ms；前奏静音段 / 首音 3.95s / 中段 120.25s / 末和弦 283.90s / 片尾静音 297.5s 五个窗口 **最大误差 ≤ 1.16e-10**（float 舍入级）→ 与母版字节一致 |
| 待用户实测 | 关游戏 → 装两枚 jar → 回放中心导出（**Record Audio 打开**，容器 MKV / 编码 FLAC 或 PCM 24-bit）→ 成片音轨应等于母版 |

## 5. 备注

* 导出音轨与"回放里听到的"现在是两条路：编辑器里听到的是 mod 实时音（自己设备），成片里是桥混进去的无损母版；
  两者内容同源（同一套谱面/采样/力度），但成片那份**没有设备与回环的损耗**。
* `Record Audio` 关掉时 Flashback 不建音频流（`AsyncFFmpegVideoWriter` 里写死），所以导出时必须勾上它 —— 本地配置已预置 `recordAudio=true / stereoAudio=true / audioCodec=FLAC`。
* 若以后要"录游戏内实际听到的那一份"，把 `/nbmc rec` 的 WAV 填进 `export_audio.json` 即可（同一条桥）。

## 6. 2026-09-25 14:18 导出崩溃取证（M5-43）

用户反馈"导出渲染快完了但是崩溃了"，错误报告 `错误报告-2026-9-25_14.18.25.zip`。

**① 表层异常是二次异常，真正的失败被吞了。**
崩溃报告：`java.lang.IllegalStateException: Cannot encode after finish()` @ `AsyncFFmpegVideoWriter.encodeHdr`。
代码里编码线程/缩放线程一旦抛异常，只把异常塞进 `threadedError` 并置 finish 旗标；上层下一次 `encodeHdr`
检查旗标就直接抛这句——**原始异常从未打印**（日志里 FFmpeg 只有启动那 34 行 info，之后什么都没有）。
修法（已进补丁版）：编码/缩放线程的 catch 里 `Flashback.LOGGER.error("…thread failed", t)`，
且上层把 `threadedError` 作为 cause 抛出（`Video writer stopped early: …`）。

**② 系统侧：提交内存被打满，机器随后硬重置。**
崩溃报告：`Virtual memory max 196265 MiB / used 194074 MiB`（= 提交上限 191.7 GB、已用 189.5 GB）。
对照本机历次崩溃：9-19 71.5/89.8、9-20 50.3/93.9、9-24 73.1/93.9 —— 这次是**上限翻倍且顶满**；
页面文件当时被自动涨到 **144 GB**（现在 52 GB）。事件日志：14:17:12 游戏崩，14:18:51 系统非正常关机
（Kernel-Power 41，`BugcheckCode=0`，无 minidump）→ 硬挂/断电式，不是蓝屏。
⇒ 导出 42 分钟里提交内存涨了约 120 GB（≈47 MB/s）。嫌疑：导出通路（HDR 取帧 66 MB 原生缓冲）、
或 Distant Horizons（其配置里自带 out-of-memory 警告，本次镜头飞 2000+ 格、DH 持续加载 LOD）、或其它进程。

**③ 工具**：`tools/export-watch.ps1`（另外开一个终端跑，每 10s 记提交内存/页面文件/显存/磁盘/游戏工作集/句柄，CSV 留档）。
下一步：先做 60 秒短导出 + 监控，看提交内存增速，再决定是修泄漏还是分段导出（74→1975 / 1975→3876 / 3876→5828，最后 `-c copy` 拼接）。

**④ 顺带确认**：这次的音频桥是好的 —— 日志 `[nbmachina] 导出音频桥已接管：回放 3.700s 起、48000Hz / 2ch`，
FFmpeg 报告 `Audio: pcm_s24le, 48000 Hz, stereo, s32, 2304 kb/s`，`bitrate max/min/avg: 0/0/288000000`（用的是最大码率档）。
