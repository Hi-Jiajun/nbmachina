# M3-103 · 上游 PR 状态（2026-09-24）

## 已提交

**PR 1 · Flashback 无损音频档** → https://github.com/Moulberry/Flashback/pull/71

* base `master`（`bf046b76` = 0.43.6），head `Hi-Jiajun:lossless-audio-codecs`，2 文件 +26/-1，GitHub 报 `MERGEABLE`；
* 提交前在干净 worktree `_scratch-m3-78/fb-pr1` 上跑 `git apply --check` 零冲突，并确认上游 master 期间没有移动；
* `AudioCodec.java` 用 `_scratch-m3-78/fb-src/deps/bytedeco-shaded.jar` 单独 `javac` 通过（`setSampleFormat(int)` 签名核对过）；
* 补丁本体：`tools/upstream-pr/flashback-lossless-audio-0.43.6.patch`；
* 风险提示：上游 README 写着 "Flashback currently does not accept outside contributions"，但它历史上合并过外部 PR（#67）；被关掉不影响本地补丁继续用。

**PR 3 · HDR 桥（两边一对）**

| | 仓库 | base / head | 规模 | 状态 |
|---|---|---|---|---|
| 3a | [Moulberry/Flashback#72](https://github.com/Moulberry/Flashback/pull/72) | `1.21.10` ← `Hi-Jiajun:hdr-export-bridge` | 10 文件 +242/-9 | OPEN / MERGEABLE / CLEAN |
| 3b | [rrtt217/Minecraft-HDR-Mod#87](https://github.com/rrtt217/Minecraft-HDR-Mod/pull/87) | `1.21.10` ← `Hi-Jiajun:hdr-flashback-bridge` | 2 文件 +76/-1 | OPEN / MERGEABLE / UNSTABLE（`checks: []`，仓库没配 CI 的必选状态导致，非冲突） |

* 3a 的树在 `_scratch-m3-78/fb-bridge`（worktree，base = 上游 `1.21.10` / `0f1c297b`），**bridge-only**：
  已剔除采样率补丁（`SampleRate` / `flashback.sample_rate` 键 / `ExportSettings.sampleRate` 组件）、无损音频补丁、以及本地 `build.gradle` 取 deps 的黑客改动；
  色彩元数据也不再依赖注入式 javacv 补丁，改成在 HDR 分支调 `recorder.setVideoOption("color_primaries"/"color_trc"/"colorspace"/"color_range")`。
* 3a 验证：`.\gradlew.bat --no-daemon build`（Loom + remapJar）**BUILD SUCCESSFUL**（31s），产物 `build/libs/flashback-0.39.9.jar`
  里 `javap` 能查到 `HdrExportBridge`、`encodeHdr`、`supportsPixelFormat`、`startDownloadHdr/finishDownloadHdr`、5 字段 `DownloadedFrame`。
* 3b 的树在 `_scratch-m3-78/hdr-bridge`（worktree），验证：`.\gradlew.bat --no-daemon :common:compileJava` **BUILD SUCCESSFUL**（1m57s）；
  日志打印换成 `HDRMod.LOGGER`、去掉 nbmachina 前缀，注册仍是纯反射（没装/未打补丁的 Flashback 什么都不做）。
* 本地装机版本**未动**：仍是打过全部补丁的 `Flashback-0.39.9-for-MC1.21.10.jar`（`BD929CE2…`）+ `hdr_mod-fabric-2.5.1-1.21.10.jar`（`81F4EB7D…`）。
* 待办：**PR 1b（导出采样率 48/96/192 kHz）**已就绪但先压着不提——和 PR 1 动同一片音频代码，等 #71 有回应再说。

## 作废：PR 2 · JavaCV `setColorInfo` —— 不需要提

2026-09-24 实测推翻原判断（原因：**原来只数了 `FFmpegFrameRecorder` 自己声明的方法，漏了父类 `FrameRecorder`**）。

用**官方原版 jar**（`mods\Flashback-0.39.9-for-MC1.21.10.jar.upstream`，未经任何注入）里的 javacv，只调现成 API：

```java
recorder.setVideoOption("color_primaries", "bt2020");
recorder.setVideoOption("color_trc",       "smpte2084");
recorder.setVideoOption("colorspace",      "bt2020nc");
recorder.setVideoOption("color_range",     "pc");
```

`ffprobe -select_streams v:0 -show_entries stream=color_*` 对照：

| | color_range | color_space | color_transfer | color_primaries |
|---|---|---|---|---|
| 不打选项 | unknown | unknown | unknown | unknown |
| 打选项 | **pc** | **bt2020nc** | **smpte2084** | **bt2020** |

探针：`_scratch-m3-78/coloropt/ColorOptProbe.java`（编译/运行用 `java-runtime-delta` + 官方 jar 当 classpath）。
ffmpeg 日志同样显示 `yuv420p(pc, bt2020nc/bt2020/smpte2084)`。

结论：

1. 不用改 JavaCV——`setVideoOption` 把 AVCodecContext 的色彩选项带进 `avcodec_open2`，容器就写进去了；
2. 上游 Flashback 更不用它：master 已经把 recorder 抄成自己的 `FlashbackFFmpegFrameRecorder`（0.39.9 是 mixin 进 javacv），直接调 `setVideoOption` 即可；
3. 本地这套"注入 javacv class"的补丁理论上也能退役（HDR 分支改成 4 行 `setVideoOption`），但当前装机版本已实测通过，先不动。

## 待做：PR 3 · HDR 桥（Flashback + HDR mod 两边）

* Flashback 侧提交前必须做成 **bridge-only**：现有 `_scratch-m3-78/apply-fb-hdr.mjs` 的锚点依赖采样率补丁
  （`FlashbackConfigV1` 的 `SampleRate exportSampleRate`、`StartExportWindow` 的 `SampleRate` import、lang 的 `flashback.sample_rate` 键），
  直接套干净 checkout 会 anchor 失配，要改锚点或手工移植；
* 建议 base = 上游 `1.21.10` 分支（我们本地构建 + 用户实导验证过的就是这条分支的代码）；
  master 差异大（vendored recorder、encoder 存成字符串、`ExportJob`/queue 也动过）；
* HDR mod 侧上游是 `rrtt217/Minecraft-HDR-Mod`（MIT），本地分支 `hdr12110`，改动是未跟踪的 `compat/flashback/` +
  `HDRMod.java` 注册点；提交时要排除 `gradle.properties` 的本地改动。
