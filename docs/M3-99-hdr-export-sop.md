# M3-99 · HDR10 + 无损音轨 出片 SOP（2026-09-24 定稿）

> 结论先行：**光影用默认（AgX 动态范围 12.0 / 中灰 0.16）、导出用 H265+hevc_nvenc+勾 HDR+PCM 24bit、
> 导出后必须打 HDR10 标签**。实测峰值 3095 nits（真高光），音轨 `pcm_s24le / 48k / 2ch / 24bit`（无损）。

## 1. 出片流程（四步）

1. **录制**：Flashback 正常录回放（`/nbm machine start` 只按一次；中途别按 ESC 同一段反复 start）。
2. **导出**（回放中心 → 导出，实测这套组合可用）：

   | 项 | 值 |
   |---|---|
   | 容器 | MKV |
   | 编码器（codec） | **H265 (HEVC)** |
   | 编码器（encoder） | **hevc_nvenc**（或 libx265 / av1_nvenc / libsvtav1） |
   | 码率 | 20m（或"使用最大码率"） |
   | HDR | **勾 `flashback.hdr_export`** |
   | 音频 | **PCM 24-bit** + **立体声** + **48 kHz** |

3. **打标签**（必做，否则播放器按 SDR 解释 → 画面发灰）：
   ```bash
   node tools/hdr-tag.mjs "<导出的.mkv>"
   ```
3. **校验**：
   ```bash
   node tools/hdr-report.mjs "<打标签后的.mkv>"     # peak 应 > 400 nits，verdict = real highlight headroom
   ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,profile,pix_fmt -of default=nw=1 <文件>
   ffprobe -v error -select_streams a:0 -show_entries stream=codec_name,sample_fmt,bits_per_raw_sample,sample_rate,channels -of default=nw=1 <文件>
   ```
   期望：视频 `hevc / Main 10 / yuv420p10le`；音频 `pcm_s24le / s32 / 24 / 48000 / 2`。

## 2. 实测证据（2026-09-24，同一场景 / 同一次会话）

| 导出 | 光影设置 | PQ 峰值 | p99 | p50 | 判定 |
|---|---|---|---|---|---|
| 02:16 | 默认 12.0 / 0.16 | 211 nits | 139 | 4 | 没有超纸白高光（**那一段没把太阳/强反光拍进画面**） |
| 03:13 | 12.0 / 中灰 0.13 | 3068 nits | 508 | 94 | 真高光 |
| 03:14 | 动态范围 8.0 / 0.16 | 3123 nits | 522 | 94 | 真高光 |
| **03:16** | **默认 12.0 / 0.16** | **3095 nits** | 532 | 81 | **真高光（采用这组）** |

**重要结论**：决定"有没有 HDR 高光"的是**画面内容**（有没有把超亮像素拍进来）与**光影的 HDR 通路本身**，
**不是** AgX 两个参数——同样的默认设置，换个机位就从 211 nits 变成 3095 nits。参数保持默认即可。

## 3. 已知坑（都踩过）

- **8-bit 编码器会被守卫拒绝**：`h264_nvenc` 之类没有 10bit，日志会打
  `HDR export requested but encoder … offers no 10-bit … - exporting 8-bit`，片子只有 SDR → 换 HEVC/AV1。
- **NVENC 的 10bit 是 `p010le`**，不是 `yuv420p10le` —— 补丁已改成多候选（`yuv420p10le → p010le → yuv420p12le`），
  成功时日志有 `HDR export: using pixel format p010le for encoder hevc_nvenc`。
- **漏打标签一定发灰**：PQ 内容 + 无标签 ⇒ 播放器当 BT.709 播 → 又灰又平。上传前跑一次 `hdr-report` 看 verdict。
- **提前量**（`/nbm machine lead`）只决定载荷早到多少，**不影响音高/节奏**；实测 0 刻 100% 过期（必晚一格），
  6/8 刻都零过期。当前默认 6 刻。
- **`/nbmc play` 需要 `nbmachina/score.csv`**；如果把它改名藏起来（做"无 CSV 播放"实验时），这条客户端整轨会报找不到谱面。

## 4. 回退开关（都在游戏目录里，改完 `/reload` 或重启）

| 想回到 | 操作 |
|---|---|
| CSV 谱面方案（默认） | `nbmachina\machine.json` 改名/删除即可（当前为 `machine.json.off`） |
| Flashback 官方原版 | `mods\Flashback-0.39.9-for-MC1.21.10.jar.upstream` 覆盖回 `.jar` |
| HDR mod 官方原版 | `mods\hdr_mod-fabric-2.5.1-1.21.10.jar.upstream` 覆盖回 `.jar` |

## 附：导出窗口逐项口径（2026-09-25 用户截图问询后补）

| 选项 | 口径 | 依据 |
|---|---|---|
| **SSAA** | **关**（开 HDR 时绝对不能开） | 代码里 SSAA = 渲染分辨率 ×2（4K → 8K 渲染，4× 像素）；更要命的是 **HDR 通路读不回来**：`ColorTransformRenderer` 的 dst 纹理固定按**源分辨率**创建（`srcTextureView.getWidth(0)`），而 `SaveableFramebuffer.startDownloadHdr` 按 **输出分辨率** 读 `glReadPixels(0,0,w,h)` → 开 SSAA+HDR 只会拿到**左下 1/4 画面**（等价 2× 放大裁切）。要用 SSAA 得先修那条桥 |
| **无界面** | **开** | 移除 hotbar / 准星 / 聊天 / 调试层，只渲染世界；开场卡片与音符盒特效都是**世界内粒子**，不受影响 |
| **码率 20m** | 太低，改 **150m** 或勾 **使用最大码率** | `AsyncFFmpegVideoWriter`：`maxBitrate = min(288_000_000, 4096 + av_image_get_buffer_size(fmt,w,h,1)*8*fps)`；4K120 10bit 下等于 **288 Mbps 上限**；勾"使用最大码率" → `numBitrate = 0` → 用满 288M。20 Mbps 在粒子+HDR 渐变上会糊 |
| **开始/结束 Tick** | 起 **67**、止 **5828** | 音乐 0s = tick 67（封面 0.35s 起淡入）；回放末尾 5828 |
| 封装/编码 | MKV + H265(HEVC) + hevc_nvenc | 10-bit 只有 hevc_nvenc / av1_nvenc 可用（自带 ffmpeg 没有 libx265） |
| 音频 | 录制音频 ✓ + 立体声 ✓ + PCM 24-bit + 48 kHz | `AsyncFFmpegVideoWriter` 只在 `recordAudio=true` 时建音频流；导出音频桥写的就是这条流 |
