# M3-101 · 上游 PR 草稿（Flashback / JavaCV / HDR mod）

> 2026-09-24 起草。**最终提交按钮由 Jiajun Liang 点**（本地补丁已经跑通并装机，提交与否不影响使用）。
> 三份草稿互相独立，可以按任意顺序提；每一份都附了"提交前还需要什么"。

---

## PR 1 · Flashback：无损音频档（推荐先提，改动最小、正是作者留的 TODO）

**标题**：`Add lossless audio codecs (FLAC / ALAC / PCM 16/24/32/float32) to the export window`

**改动理由（正文开头）**：上游 `AudioCodec` 里自己留着这句话 ——
`// FLAC("FLAC", avcodec.AV_CODEC_ID_FLAC), // Removed because it doesn't support fltp sample format`；
根因是 `AsyncFFmpegVideoWriter` 对所有音频编码器写死 `recorder.setSampleFormat(avutil.AV_SAMPLE_FMT_FLTP)`，
而 ffmpeg 的 FLAC / ALAC / PCM 编码器只接受 `s16 / s32 / s32p / flt`，`avcodec_open2()` 直接失败。

**补丁（master 上可直接套，两处）**：

```diff
--- a/src/main/java/com/moulberry/flashback/combo_options/AudioCodec.java
+++ b/src/main/java/com/moulberry/flashback/combo_options/AudioCodec.java
@@ import org.bytedeco.ffmpeg.global.avcodec;
+import org.bytedeco.ffmpeg.global.avutil;
@@
-    VORBIS("Vorbis", avcodec.AV_CODEC_ID_VORBIS);
+    VORBIS("Vorbis", avcodec.AV_CODEC_ID_VORBIS),
+    // Lossless codecs (ordinals of the four entries above are unchanged)
+    FLAC("FLAC", avcodec.AV_CODEC_ID_FLAC),
+    ALAC("ALAC", avcodec.AV_CODEC_ID_ALAC),
+    PCM_S16LE("PCM 16-bit", avcodec.AV_CODEC_ID_PCM_S16LE),
+    PCM_S24LE("PCM 24-bit", avcodec.AV_CODEC_ID_PCM_S24LE),
+    PCM_S32LE("PCM 32-bit", avcodec.AV_CODEC_ID_PCM_S32LE),
+    PCM_F32LE("PCM float32", avcodec.AV_CODEC_ID_PCM_F32LE);
+
+    /** Sample format handed to the ffmpeg encoder. Lossless encoders reject fltp. */
+    public int sampleFormat() {
+        return switch (this) {
+            case FLAC, PCM_S24LE, PCM_S32LE -> avutil.AV_SAMPLE_FMT_S32;
+            case ALAC -> avutil.AV_SAMPLE_FMT_S32P;
+            case PCM_S16LE -> avutil.AV_SAMPLE_FMT_S16;
+            case PCM_F32LE -> avutil.AV_SAMPLE_FMT_FLT;
+            default -> avutil.AV_SAMPLE_FMT_FLTP;
+        };
+    }

--- a/src/main/java/com/moulberry/flashback/exporting/AsyncFFmpegVideoWriter.java
+++ b/src/main/java/com/moulberry/flashback/exporting/AsyncFFmpegVideoWriter.java
@@ if (settings.recordAudio()) {
-                recorder.setSampleFormat(avutil.AV_SAMPLE_FMT_FLTP);
+                recorder.setSampleFormat(settings.audioCodec().sampleFormat());
```

**实测证据（写进 PR 正文，作者最关心这个）**：

* 离线逐样本验证：每档编 2 秒已知 48kHz 立体声信号 → ffmpeg 解回 f32le 逐样本比对：
  `FLAC 24bit 1.19e-7` / `ALAC 24bit 1.19e-7` / `PCM24 1.19e-7` / `PCM32 2.33e-10` /
  `PCM f32 0（逐位一致）` / `PCM16 1.53e-5`（16bit 固有量化），全部 48kHz/双声道/整长。
* 对照实验：`fltp + FLAC` → `avcodec_open2() error -22`（复现上面那句注释）。
* 导出窗口各容器可选项实测：MP4/MKV/MOV 十档全有、AVI 八档、WebM 只有 Opus/Vorbis。
* 真实成片：`pcm_s24le / 48k / 2ch / 24bit`（MKV）✓

**已知限制（主动写清，避免被当成坑）**：

* `FLAC @ 192kHz` 会失败，是 **javacv 1.5.10 的 `recordSamples`（swr_convert）** 限制，与本次改动无关
  （原生 ffmpeg CLI 在 192k/s32 下正常）；48/96k 的 FLAC 正常。建议在 UI 层不做特殊处理，或在 writer 里加一句前置检查。
* FLAC/ALAC 实际写入 24bit（>24bit 是 ffmpeg 实验特性），需要的用户可选 PCM 32-bit / float32。
* 原有 4 档行为完全不变（`default -> FLTP`），枚举 ordinal 不变（配置文件按名字序列化，无破坏）。

**提交前还需要什么**：① 在 master 上编译验证（本地 0.39.9 已验证，master 需要搭一次 MC 26.3 的构建环境，
或让作者 CI 验）；② fork + 建分支 + 提交。

---

## PR 1b · Flashback：导出采样率档 48 / 96 / 192 kHz（可选，第二个 PR）

同一处代码里 `recorder.setSampleRate(48000)` 也是写死的。我们的做法（已在 0.39.9 上跑通）：

* 新增 `combo_options/SampleRate`（48/96/192 kHz）+ 配置字段 `exportSampleRate` + 导出窗下拉；
* 三处联动：`ExportJob`（每视频帧抓的样本数 = `sampleRate / framerate`）、`setSampleRate(...)`、
  `MixinAudioLibrary` 里 OpenAL loopback 设备的 `ALC_FREQUENCY`（**整条混音管线就跑在该采样率上，不是后期重采样**）。
* 实测：48/96/192 kHz × 6 档无损共 17/18 组合逐样本无损（唯一失败的就是上面那条 FLAC@192k）。

---

## PR 2 · JavaCV：给 `FFmpegFrameRecorder` 一个写色彩元数据的入口

**标题**：`Add a way to set colour metadata (primaries / TRC / matrix / range) on the video stream`

**问题**：JavaCV 目前**没有任何公开 API** 能设色彩元数据（本机实测：`FFmpegFrameRecorder` 44 个 public 方法里
没有 `setVideoOption` / `getFormatContext`）。而色彩元数据必须在 `avformat_write_header` **之前**落到
`AVStream.codecpar()` 上 —— 那一步在 `startUnsafe()` 内部，调用方没有插钩子的位置。
结果是：任何用 JavaCV 写 HDR/色彩管理视频的项目（例如 Flashback 这类 Minecraft 录制工具）都无法标注
BT.2020 / PQ / full-range，播放器会把 HDR 内容当 SDR 播（画面发灰）。

**建议的 API 形态（干净版，比我们本地的 system property 版本更适合上游）**：

```java
// FFmpegFrameRecorder
public void setColorInfo(int primaries, int transferCharacteristic, int matrix, int range);
```
实现：存 4 个字段；在 `startUnsafe()` 里、`avcodec_parameters_from_context(video_st.codecpar(), video_c)`
**之前**把它们设到 `video_c`（`color_primaries/color_trc/colorspace/color_range`），拷进 codecpar 后由封装器写入容器。

**我们本地的验证方式（可作为 PR 的"如何测试"）**：
用 `-Dnbmachina.hdr.color=bt2020-pq` 开关编一小段 10bit HEVC（`hevc_nvenc` + `p010le`），`ffprobe` 结果：

```
关（对照）：yuv420p10le | range=tv  | colour 全 unknown
开：        yuv420p10le | range=pc  | bt2020 / smpte2084 / bt2020nc
```

**许可证**：JavaCV 是 `Apache-2.0 或 GPLv2+Classpath` 双许可 → 提 PR 无障碍。
**提交前还需要什么**：把本地的 system-property 版本改写成上面的正式 API（约 20 行 + 文档 Javadoc）。

---

## PR 3 · 桥：Flashback 侧 + HDR mod 侧（一对，用户已定"两边都提，哪边不接就自用"）

**Flashback 侧标题**：`Add an opt-in hook so an external colour/HDR mod can transform exported frames`

正文要点（我们本地的实现已经完全跑通，可直接作为参考实现）：

* 新增 `exporting/HdrExportBridge`：一个注册点 + `ColorTransform` 接口（把导出用的 `RenderTarget` 变成
  "可 16bit 读回的 PQ/BT.2020 纹理"）；
* 导出窗口只在**有实现注册时**才显示 HDR 勾选（没装对应 mod 的玩家完全看不到、行为不变）；
* 取帧侧：`SaveableFramebuffer` 增加 16bit 读回（PBO 8 字节/像素、`GL_UNSIGNED_SHORT`、行翻转），
  `SaveableFramebufferQueue`/`ExportJob`/`AsyncFFmpegVideoWriter` 增加 `hdrPointer` 通路；
* 编码侧：HDR 时优先 `yuv420p10le → p010le → yuv420p12le`（**NVENC 给的是 p010le**，只认前者会误判成没有 10bit）；
* 实测（本机，0.39.9）：`hevc_nvenc + p010le` → `hevc Main 10 / yuv420p10le`，PQ 峰值 3013 nits（真高光），
  音轨同时保持 `pcm_s24le/48k/24bit`。

**HDR mod 侧标题**：`Add Flashback export support`

* 正文要点：注册上面的桥（本地实现用反射 `Class.forName("com.moulberry.flashback.exporting.HdrExportBridge")` +
  `Proxy`，这样**不依赖 Flashback 打补丁**——没装补丁版时只是安静地不注册）；
* 复用其现成的 `ColorTransformRenderer`（BT.2020 + ST2084_PQ，自动切 16bit 读回）；
* 若 Flashback 侧拒绝开桥 → 改为 mixin 直接注入 Flashback（与它现有的 ReplayMod/Iris 兼容同一套做法），
  那样只需提 HDR mod 一家。

**提交前还需要什么**：Flashback 侧 PR 需要先 rebase 我们的 0.39.9 实现到 master（约半天）并跑一次 GPU 导出验证；
HDR mod 侧需要把反射注册版整理进它的 `compat/flashback/` 包（已有本地实现）。

---

## 附：本地现状（提交与否都不影响）

* 本地所有补丁都已装机可用（Flashback `BD929CE2…`、HDR mod `81F4EB7D…`），并都有官方 jar 备份（`.upstream`）；
* 无损、HDR、导出即带标签三条链路均已实测通过（见 `docs/M3-99-hdr-export-sop.md`）；
* 一旦上游接受，我们就能**删掉本地补丁**，改成"升级官方 jar 即可"。
