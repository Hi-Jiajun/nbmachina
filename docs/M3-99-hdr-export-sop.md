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

## 5. HDR10 静态元数据 + 全片峰值实测（2026-09-25，0.10.2 那版导出）

**背景**：`2026-09-25T15_04_28.mkv`（4K120 / HEVC Main10 / bt2020+PQ / PCM 24bit48k / 278 Mbps）**没有 HDR10 静态元数据**
（`stream_side_data` 为空）。原因：`hdr-tag.mjs` 只写 colour primaries / transfer / matrix / range；
而 ffmpeg 8.1 的 `hevc_metadata` bsf **根本没有**这两个选项（实测报 `Option 'mastering_display' not found`）。

### 5.1 全片峰值（逐帧，全分辨率）

| 指标 | 值 | 位置 |
|---|---|---|
| **MaxCLL** | **867 nits**（真码值 753） | t=88.225s |
| **MaxFALL**（线性帧均） | **84 nits** | t≈234s（帧均非常稳：p50 75.6 / p90 78.4 / p99 81.1） |
| 每帧峰值分位数 | p99.9 773 / p99 725 / p90 674 / **p50 633 nits** | — |

峰值最高的 12 帧（nits）：88.225→867、244.025→858、88.758/108.808/279.150→832、108.792/142.958/163.075→823、93.858/118.675/163.842/163.875→814。

测量口径：34,525 帧**逐帧全分辨率** `signalstats` 取 YMAX（约 8 分钟）；MaxFALL 另跑一遍 1 fps 的 raw `gray10le`
在 node 里用 PQ→线性 LUT 算**线性光均值**（前 3 帧全像素精确校验，其余按 8 像素步长抽样）。

### 5.2 三个换算坑（都踩过，别再踩）

1. **`signalstats` 在这条 pc 全范围流上输出的是"折算过的值"**：它按 limited(16..235@8bit) 口径报，
   不是 10-bit 真码值。反算：`true = (s/4 - 16) / 219 × 1023`。
   交叉验证：peak 帧 raw 753/752 ↔ signalstats 709/708（误差 <1 码）。
   **把 signalstats 的值直接当码值过 PQ 会把峰值低估 33%**（582 → 867 nits）。
2. **量 HDR 别用 `format=gray`**（8-bit，会再丢一档），要用 `gray10le`。
3. **降采样会漏峰值**：1280×720 邻域采样比全分辨率低 0–13 码（≈10% nits）。量 MaxCLL 必须全分辨率。

### 5.3 无损注入 HDR10 静态元数据（新工具 `tools/hdr10-sei.mjs`）

往裸 HEVC 里插 prefix SEI（payload 137 mastering_display + 144 content_light_level），**每个 PPS 后插一个** →
每个 IRAP 前都有，跳转任意位置都读得到。**像素完全不动**。

```bash
ffmpeg -i in.mkv -an -c:v copy -f hevc - \
  | node tools/hdr10-sei.mjs --cll 867,84 --master 1000 \
  | ffmpeg -r 120 -f hevc -i - -c copy -f mp4 tmp_v.mp4
ffmpeg -i tmp_v.mp4 -i in.mkv -map 0:v -map 1:a -c copy \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range pc out.mkv
# 校验：
ffprobe -v error -select_streams v:0 -show_entries frame_side_data=side_data_type \
  -read_intervals "%+#1" -of default=nw=1 out.mkv   # 应出现 Mastering display metadata + Content light level metadata
```

* ⚠ 中间那步 MP4 不能省：裸 HEVC 没有时间戳，**Matroska 复用器会直接拒绝**（`Can't write packet with unknown timestamp`）。
* 本次成品 `2026-09-25T15_04_28_hdr10.mkv`：144 个 SEI（只多 5.8 KB）；30/120/250s 三帧 raw MD5 与原文件**完全一致**；
  容器时长从错误的 295.595s 修正为 **287.725s**（原文件容器头比实际内容长 7.9s：视频末包 287.692s、音频 287.573s）。
* 以后 x265 编码可以直接带（不用后处理）：`-x265-params "master-display=G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1):max-cll=867,84"`；
  **hevc_nvenc 没有这个开关** → 走本工具后处理。

### 5.4 音画偏移：视频是对的，音频早了 340ms

| 事件 | 视频实测 | 谱面 | 结论 |
|---|---|---|---|
| 第一颗音的特效粒子出现 | **3.900s**（逐帧帧差最大处，144 帧里唯一天然尖峰） | 3.917s | 视频锁在谱面（差 1 帧内） |
| 音轨第一个声音 | **3.577s** | 3.917s | **音频早 340ms**（≈ Flashback 音频桥的偏移） |

修法（**不重编码**）：
```bash
mkvmerge -i in.mkv                       # 先确认轨道 id（一般 0=video, 1=audio）
mkvmerge --sync 1:340 -o out.mkv in.mkv  # 音频整体后移 340ms
```
或按用户原计划在剪辑软件里对齐音频轨（对齐量 **+340ms**）。

#### 5.4.1 本机实际执行（2026-09-25，mkvmerge 未安装 → 用 ffmpeg）

本机没有 mkvmerge，改成 ffmpeg 的 `adelay`（视频 `-c:v copy` 不动，音频 PCM 重编但**逐样本一致**）：

```bash
ffmpeg -i in.mkv -map 0:v -map 0:a -c:v copy -c:a pcm_s24le -af "adelay=340|340" \
  -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range pc \
  -f matroska out.mkv
```

* ⚠ `-itsoffset 0.34 -c copy` **不管用**（实测：不配 `-copyts` 时 ffmpeg 会把时间戳重新归零，音频仍是 3.577s）。
* `adelay` 是唯一改动 = 前面补 340ms 静音：逐字节比对过 —— 原 20s 的 PCM 与移位后偏移 **16320 样本**
  （= 340ms @48k）处的窗口 `Buffer.compare === 0`，**完全一致**。
* 成品：`C:\Users\hiliang\Videos\2026-09-25T15_04_28_hdr10_sync.mkv`
  （≈ +96 KB，只多出静音；视频包数 34525 与末包 287.700s 不变；HDR 静态元数据与色彩标记都在；
  音频末包 287.590 → 287.930s；**音频第一声 3.577s → 3.917s**，与视频的第一颗音特效 3.900s 对齐）。
