# flashback-lossless · 让 Flashback 导出无损音轨

给 Flashback 的导出窗口补上 **FLAC / ALAC / PCM 16-bit / 24-bit / 32-bit / float32** 六档无损音频，
用于把回放渲染成视频时直接得到无损音轨（48kHz，配合界面的「立体声」勾选即为双声道无损）。

> 本目录**不包含 Flashback 的任何源码或 jar**。Flashback 的许可是 *Do not redistribute /
> All rights reserved*，所以这里只放我们自己的补丁脚本：你自己 `git clone` 上游源码、自己提供
> 官方 jar，脚本在本地生成补丁版 jar。

## 为什么需要补丁

`exporting/AsyncFFmpegVideoWriter.java` 对**所有**音频编码器都写死 `AV_SAMPLE_FMT_FLTP`：

```java
recorder.setSampleFormat(avutil.AV_SAMPLE_FMT_FLTP);
```

ffmpeg 的 FLAC / ALAC / PCM 编码器都不接受 fltp，`avcodec_open2()` 直接失败——上游源码里
`AudioCodec` 那行注释就是这个原因：

```java
// FLAC("FLAC", avcodec.AV_CODEC_ID_FLAC), // Removed because it doesn't support fltp sample format
```

补丁只改两个文件：给枚举**追加**六个常量（原有四项 ordinal 不变，所以配置/存档兼容），
新增 `AudioCodec.sampleFormat()` 返回每个编码器真正支持的采样格式，并让 writer 用它：

| 编码器 | 采样格式 | 说明 |
|---|---|---|
| FLAC | `S32` | ffmpeg 按 24 bit 写入（>24bit 属实验特性） |
| ALAC | `S32P` | 同上，24 bit |
| PCM 16-bit | `S16` | 1 LSB 量化误差 |
| PCM 24-bit | `S32` | 24 bit 存储 |
| PCM 32-bit | `S32` | 整数 32 bit |
| PCM float32 | `FLT` | 与游戏内浮点样本逐位一致 |
| AAC/MP3/Opus/Vorbis | `FLTP` | 与上游行为完全一致 |

## 用法

```powershell
# 1. 上游源码（分支要和 jar 版本对应；0.39.9 对应分支 1.21.10）
git clone https://github.com/Moulberry/Flashback.git
cd Flashback; git checkout 1.21.10

# 2. 用官方 jar 生成补丁版（默认输出 <本目录>/work/Flashback-lossless.jar）
pwsh -File build-patch.ps1 -UpstreamSource <Flashback 源码目录> `
     -FlashbackJar "<游戏目录>\mods\Flashback-<版本>.jar" -Verify

# 3. 替换 mods 里的 jar（把官方 jar 改名备份）
```

`-Verify` 会额外跑一遍离线编解码测试（见下）。

## 它是怎么做进去的（以及为什么不会"套错版本"）

Flashback 发布的 jar 里 MC 类名是 **intermediary**（如 `net.minecraft.class_1011`），而仓库源码是
Mojang 官方名（`com.mojang.blaze3d.platform.NativeImage`）。`AsyncFFmpegVideoWriter` 只引用了一个
MC 类，所以脚本不跑 remap，而是用 `stub/net/minecraft/class_1011.java`（成员名直接取自已发布 jar 的
`javap` 输出）当编译目标，生成的字节码与 jar 内其它类是同一套命名。

注入前脚本会把**未修改的上游源码**用同一套工具链编译一遍，再和官方 jar 里的类逐一对比
（`diff-bytecode.mjs`：忽略常量池编号、`ldc`/`ldc_w` 差异、分支偏移这类编译器产物）。
对不上就直接报错退出，所以"把 0.39.9 的补丁打到 0.40 的 jar 上"这种事故不会静默发生。

## 实测数据（0.39.9 / 分支 1.21.10 @ 0f1c297b）

离线跑 `AudioCodecHarness.java`：喂 2 秒 48kHz 立体声已知信号 → 每个编码器各写一个文件 →
`ffmpeg` 解码回 f32le 后逐样本对比（`verify-audio.mjs`）：

| 文件 | 编码 | 采样格式 | 位深 | 最大误差 | 结论 |
|---|---|---|---|---|---|
| flac.mkv | flac | s32 | 24 | 1.19e-7 | LOSSLESS |
| alac.m4a | alac | s32p | 24 | 1.19e-7 | LOSSLESS |
| pcm_s24le.mkv | pcm_s24le | s32 | 24 | 1.19e-7 | LOSSLESS |
| pcm_s32le.mkv | pcm_s32le | s32 | 32 | 2.33e-10 | LOSSLESS |
| pcm_f32le.mkv | pcm_f32le | flt | f32 | 0 | 逐位一致 |
| pcm_s16le.mkv | pcm_s16le | s16 | 16 | 1.53e-5 | LOSSLESS（16bit 固有量化） |

对照实验：把 `FLTP` 喂给 FLAC 编码器 → `avcodec_open2() error -22`，复现了上游注释里的那句话。

导出窗口里各容器能选到的音频编码器（`VideoContainer.getSupportedAudioCodecs()` 的实测输出）：

```
MP4 / MKV / MOV   AAC, MP3, Opus, Vorbis, FLAC, ALAC, PCM 16-bit, PCM 24-bit, PCM 32-bit, PCM float32
AVI              AAC, MP3, Vorbis, FLAC, PCM 16-bit, PCM 24-bit, PCM 32-bit, PCM float32
WebM             Opus, Vorbis
```

## 上游 PR

改动只有两个文件、一个新增方法，正是作者当年注释掉 FLAC 时缺的那一步，适合回馈上游。
**尚未提交**：需要先由 Jiajun Liang 拍板（提交后仓库里也只有我们自己的补丁内容）。

## 采样率选项（48 / 96 / 192 kHz）与 Gradle 版构建

`AudioCodec.sampleFormat()` 之外，导出窗口还补了**采样率**档位：新建
`combo_options/SampleRate`，配置字段 `internalExport.exportSampleRate`，导出侧三处跟着走 ——
`ExportJob`（每视频帧抓的样本数）、`AsyncFFmpegVideoWriter.setSampleRate`、以及
`MixinAudioLibrary` 里 OpenAL loopback 设备的 `ALC_FREQUENCY`（导出时整个混音就是按这个采样率跑的，
不是后期重采样）。

这条链改到了 MC 相关类（`ExportJob` / `StartExportWindow` / mixin），所以改用 **Gradle 真编译**：

```powershell
# 1. 克隆对应分支的源码，并把 bytedeco/imgui/nfd 换成本地文件（省掉 ~2GB 的 javacv-platform）
git clone https://github.com/Moulberry/Flashback.git; cd Flashback; git checkout 1.21.10
node <本目录>/prep-fb-build.mjs .
jar xf <官方 jar> org && jar cf deps/bytedeco-shaded.jar org    # 只取编译用的类

# 2. 打补丁 + 编译（Loom 会输出 intermediary 名字的类，可直接注入官方 jar）
node <本目录>/apply-fb-lossless.mjs .
node <本目录>/apply-fb-samplerate.mjs .
pwsh <本目录>/patch-fb-flac-guard.mjs .      # 可选：FLAC@192k 的快速失败
./gradlew --no-daemon remapJar

# 3. 注入 + 自检
pwsh <本目录>/assemble-fb-jar.ps1
```

**工具链等价性证据**：用这套 Gradle 构建出的**未修改**类（`SaveableFramebufferQueue` /
`PixelFormatHelper` / `VideoWriter` / `FlashbackAudioManager` / `MixinFFmpegFrameRecorder` /
`PNGSequenceVideoWriter`）与官方 jar 里的同类用 `diff-bytecode.mjs` 对比 → **全部字节码等价**，
所以本仓库构建的修改类可以安全注入。

**实测矩阵**（离线：每档编一个 2 秒已知信号 → ffmpeg 解回 f32le 逐样本比对）：

| 采样率 | FLAC | ALAC | PCM 16 | PCM 24 | PCM 32 | PCM f32 |
|---|---|---|---|---|---|---|
| 48 kHz | ✔ 24bit | ✔ 24bit | ✔ | ✔ | ✔ | ✔ 逐位一致 |
| 96 kHz | ✔ 24bit | ✔ 24bit | ✔ | ✔ | ✔ | ✔ 逐位一致 |
| 192 kHz | ✘ JavaCV 限制 | ✔ 24bit | ✔ | ✔ | ✔ | ✔ 逐位一致 |

`FLAC@192k` 的失败来自 **JavaCV 1.5.10 的 `recordSamples`**（`swr_convert() -5984`，与分块大小无关；
官方 ffmpeg CLI 在 192k/s32 下正常），因此补丁在 writer 构造时**提前抛错并说明**，
而不是导出到一半崩掉。192k 请用 PCM 24-bit / ALAC / PCM float32。
