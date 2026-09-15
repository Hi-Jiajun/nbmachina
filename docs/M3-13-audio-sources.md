# M3-13 · 三套真乐器音源的上游核验（2026-09-15）

**问题（用户原话）**：Salamander、VSCO、Yamaha 这三套"确认都是下载的可以下载的最完整无损母带版本吗？"

本文是逐条的核验证据与结论，以及发现的缺口和处置。核验一律以**上游发布页/仓库**为准，
不采信记忆或二手描述；所有数字都是本次实测（命令与输出见各节）。

## 结论速览

| 库 | 手里的版本 | 上游存在更完整的吗 | 结论 |
|---|---|---|---|
| **Salamander Grand Piano V3** | 48kHz/24bit WAV 母版：641 wav / 1.83GB；30 个录音根音（A/C/D♯/F♯，小三度）× 16 层力度 = 480 可演奏区域，另 157 松键释放层 + 4 踏板/CC 层 | **没有**。官方发行只有 48k24 / 44.1k16 / Ogg 三种；FreePats 的 "V3+2020-06-02" 是**同一批采样的重新打包**（更新 SFZ 映射 + 转成 FLAC/SF2），不是新录音 | ✅ 已是能下载的最完整无损母带 |
| **VSCO 2 CE** | 官方 raw WAV 发行：3168 wav（44.1kHz，**16/24bit 混合**，含 VSCO 1 Percussion + Miscellania 1&2） | **没有**更高规格。官方页原文写明 raw WAV 是 "44.1 kHz, 16- or 24-bit"，不存在 48k 发行；付费的 Pro 版是 Kontakt 库 | ✅ 与官方 GitHub master **逐文件一致**（3168/3168，0 缺 0 多） |
| **Yamaha Disklavier Pro（Zenph）** | Roberto Gordo Saez 编译的 SF2：116 采样 → 103 个可演奏区域，26 个根音（A0..C7，小三度），3–4 层力度，44.1kHz/16bit | **有**。OLPC 原始合集是 **1212 个多奏法采样**（legato + staccato × 多力度，865MB 未压缩，44.1K/22.5K/16K），SF2 只是其中被挑选的一小部分 | ⚠️ 已在补（见 §4） |

---

## 1. Salamander Grand Piano V3（CC-BY 3.0，Alexander Holm）

**上游发布页**：`https://archive.org/details/SalamanderGrandPianoV3`（Alexander Holm 本人上传，
下载 20695 次，licenseurl = CC-BY 3.0）。同一目录下共 4 个发行包：

| 文件 | 规格 | 说明 |
|---|---|---|
| `SalamanderGrandPianoV3_48khz24bit.tar.bz2`（1381MB） | **48kHz/24bit** | 我们下的就是这个 |
| `SalamanderGrandPianoV3_44.1khz16bit.tar.bz2`（466MB） | 44.1kHz/16bit | 降规格版 |
| `SalamanderGrandPianoV3_OggVorbis.tar.bz2`（74MB） | Ogg 有损 | 降规格版 |
| `YamahaDisklavierPro-GrandPiano.tar.bz2`（28MB） | 内含 SF2 | 见 §3 |

**采样结构**（官方 changelog 原文）：`Recorded @ 48khz24bit / 16 Velocity layers Sampled in minor
thirds from the lowest A / Hammer noise releases chromatically / String resonance releases in minor
thirds in three layers / Two AKG c414 … AB ~12cm above the strings`（Yamaha C5）。

**本次实测（本机文件）**：

```
_toolchain/piano/salamander48/.../48khz24bit ：641 wav / 1.83GB
loadSfz(...48khz24bit/SalamanderGrandPianoV3.sfz) → regions 480，roots 30（21..108），
   droppedTrigger 157（松键层），droppedRange 4（踏板/CC 层），每根音 16 层力度
```

**有没有 V4 / 更高规格？** 没有。FreePats（`freepats.zenvoid.org/Piano/acoustic-grand-piano.html`）
把同一批采样重新打包成 `SalamanderGrandPiano-SFZ+FLAC-V3+20200602`（707MiB，48k/24bit）与
`…-SF2-V3+20200602`，页面标注 "Version V3+2020-06-02" —— 日期是**重打包日期**，
采样仍是 V3 那批 48k/24bit；WAV 版的链接文件名也仍是 `…V3+20161209_48khz24bit`。

**顺带纠正一条我们自己的错误记录**：Ogg 精简包**并不是**"只有 16 个录音点、最大变调 4 半音"。
实测它和 48k/24bit 母版是**同一套映射**：30 个根音 × 16 层 = 480 个 Ogg 文件（另有 157 + 4）。
两者的差别只在**有损编码**，不在录音点数量。此前的错误结论已从测试注释与工具注释里改掉。

## 2. VSCO 2 CE（CC0，Versilian Studios LLC）

**上游发布页**：`https://versilian-studios.com/vsco-community/`。页面原文关键句：

- 库许可：**Creative Commons 0（公有领域）**，"no rules, no royalties, no limits"；
- `Vanilla 'sfz' Version` → DIRECT DOWNLOAD 按钮指向 `https://github.com/sgossner/VSCO-2-CE/releases`；
- `Original .wav FORMAT by Versillian Studios LLC. Format: **.WAV (44.1 kHz, 16- or 24-bit)** …
  Bonus: includes VSCO 1 Percussion + Miscellania 1 & 2`；同样 CC0。

即：**官方最高规格就是 44.1kHz，且原生就是 16/24bit 混合**（部分乐器当年录成 24bit）。
不存在 48k 版本；`VSCO 2 Pro`（$229，Kontakt）是另一条商业产品线，不属于 CC0。

**完整性核验（逐文件比对，不是抽样）**：

```
GitHub API: repos/sgossner/VSCO-2-CE/git/trees/master?recursive=1
  → tree 3313 项，其中 .wav = 3168，truncated=false
本机 _toolchain/piano/vsco2ce/VSCO-2-CE-SFZ ：.wav = 3168（+75 sfz 索引）
路径名逐条比对（大小写归一）：missing(本机缺)=0，extra(本机多)=0
随机抽 120 个采样 ffprobe：72 × pcm_s16le + 48 × pcm_s24le，全部 44100Hz / 2ch
```

结论：**本机就是官方发行版的完整副本**，没有截断、没有转码降规格。

## 3. Yamaha Disklavier Pro（CC-BY 3.0，Zenph Studios / OLPC）

**我们手里的**：`acoustic_grand_piano_ydp_20080910.sf2`（138.6MB）+ 同目录 txt，
txt 原文：`116 samples, 44100Hz, 16bit … built from the Zenph Studios Yamaha Disklavier Pro Piano
Multisamples for OLPC … CC Attribution 3.0`。

**注意**：这个 SF2 在 Salamander 的 archive.org 发布页里也有一份完全相同的副本
（`YamahaDisklavierPro-GrandPiano.tar.bz2`，28.1MB，解包后 sf2 138627388 字节，与我们手上的逐字节同源）
——说明它就是这条线的"官方再发行版本"，不是某个人私自丢出来的文件。

**上游其实更全**（OLPC 官方 wiki 原文）：`The Zenph Studios Yamaha Disklavier Pro Piano
Multisamples for OLPC (OVER 1212 Multi-SAMPLES at different velocities both legato and staccato!
- 865 megaBytes) … The Yamaha Disklavier Pro Piano Multisamples (1212 samples) 44.1K, 22.5K, 16K`。

也就是说：**SF2 只是 1212 个多奏法采样里被挑出来的一小部分**（我们解析出的可演奏区域是
26 个根音 A0..C7 × 3~4 层 = 103 个）。缺的主要是①更高音区（到 C8）、②staccato/legato 的
不同时值、③更多力度档。

**实测到的直接后果**：整曲渲染里旋律最高到 F♯7(102)，而 SF2 最高根音只到 C7(96) →
顶多 6 个半音的变调（`render-ensemble --melody disklavier` 日志：`变调 947 条（最大 6.00 半音）`）。
Salamander 母版同一条旋律只有 926 条 / 最大 **1.00** 半音。

**处置（已完成）**：完整合集只存在于 `olpc-sound-samples-v2.7z`（archive.org，4.27GiB，
CC-BY 3.0，含 8000+ 采样）。已下载并校验：

```
size 4580780916 / md5 687c31eeab8e4676e946bf47ae39e7f3（与 archive.org 元数据逐字符一致）
7z 内目标目录：yamahaGrandPiano44\（1212 个 wav + __MACOSX 影子文件）
解包后：1212 个 pno*.wav，862.10MB，44.1kHz/16bit **单声道**
```

再索引成 SFZ（`tools/import-olpc-piano.mjs`，本轮新增）：

```
扫描 1213 个文件 → 采用 835 个 leg 区域（丢弃 -click 1 / sta 奏法 376）
音高 30 个：21 24 27 … 108（A0..C8，小三度）
每根音力度层数：12..33（对照：SF2 只有 3~4 层）
键位最大变调（首尾按中点外推）：21 半音 = 仅"低于 A0"的理论外推，实际旋律只用 1 半音
```

整曲对照（`render-ensemble --melody disklavier`，同一份谱面）：

| 版本 | 区域数 | 旋律变调 | 说明 |
|---|---|---|---|
| OLPC 完整合集 | 835 | 926 条 / 最大 **1.00** 半音 | 与 Salamander 相当 |
| SF2 子集（旧） | 103 | 947 条 / 最大 **6.00** 半音 | 顶音区被硬拽上去，已在工具里标为对照 |

## 4. 本轮顺带修掉的两个真实缺陷

1. **`readWav` 读不了 24bit**（`src/analyze/dsp.mjs`）：只认 8/16/32bit，遇到 24bit 直接抛
   `不支持的位深: 24` —— 而 Salamander 母版与 VSCO 约四成采样都是 24bit。
   已补 24bit 小端有符号解析，并加守卫 `tests/wav-bits.test.mjs`（含"母版前 40 个采样逐个读、
   峰值 > 0.005"的真库断言）。
2. **半音阶试听工具的变调统计口径错**（`tools/audition-scale.mjs`）：SFZ 模式下它把
   `lokey/hikey`（键位覆盖）当成录音点，于是"变调版"永远取到同键位采样、统计恒为 0 半音
   （VSCO 报 0/88，等于没测）。已改成按 `pitch_keycenter`（真录音根音）算，并把"真录过的音"
   与"覆盖键位"分开输出。

## 5. 另一个发现：谱面里的"力度"其实是恒定值

整曲渲染时发现 1385 颗旋律音**全部落在同一个力度层**（Yamaha 完整合集只解出 16 个采样文件）。
追到源头：`build/machine_pipeline.csv` 的 `volume` 列**全曲恒为 0.350**，而 M0 T5b 从参考演奏
里量出来的逐音力度（`velocity` 列）只存在于中间产物（`velocity_accent.csv` 等），
**没有进 machine 谱面**，所以离线渲染和游戏内 playsound 都拿不到它。

已新增离线 A/B 通道（不改数据包）：

- `tools/make-velocity-score.mjs`（新增，带单测 `tests/velocity-join.test.mjs`）：按
  (step, instrument, midi) 把实测力度并进 machine 谱面 → `build/machine_pipeline_velocity.csv`
  （命中 2804/3053；harp 覆盖率 1634/1639 = 99.7%，bass 1170/1276，打击乐无力度概念）；
- `render-ensemble.mjs --score <csv> --dynamics measured`：力度同时驱动**采样层选择**与增益
  （默认仍是 `flat`，即现状）；
- 产物：`build/ensemble/styx_ens_salamander48_dyn_48k24bit.wav`、
  `styx_ens_disklavier_dyn_48k24bit.wav`（对照 = 同名不带 `_dyn`）。

**待用户耳定**：要不要把实测力度接进数据包（`playsound` 的 volume）——那会同时改变游戏内机器与
离线母版；这一步属于"改听感"，按项目惯例由用户听过后拍板。

## 6. 许可与署名

| 库 | 作者 | 许可 | 商用 | 署名要求 |
|---|---|---|---|---|
| Salamander Grand Piano V3 | Alexander Holm | CC-BY 3.0 | ✅ | 必须（写进 `NOTICE.md`） |
| VSCO 2 CE | Versilian Studios LLC（录 Sam Gossner & Simon Dalzell） | CC0 1.0 | ✅ | 无强制（仍鼓励） |
| Yamaha Disklavier Pro | Zenph Studios（录音）/ Roberto Gordo Saez（SF2）/ OLPC | CC-BY 3.0 | ✅ | 必须（写进 `NOTICE.md`） |

采样文件本身**不进仓库**（`_toolchain/` 已在 `.gitignore` 里），仓库只记录来源、规格、核验方式；
将来发布的音频成品按上表署名。

## 7. 仍待办

1. 三架钢琴的整曲 48k/24bit 母版已出（`build/ensemble/styx_ens_{salamander48,disklavier,upright}_48k24bit.wav`），
   等用户听感挑选；
2. 实测力度是否进数据包（见 §5）；
3. `sta`（staccato）采样暂未启用——谱面目前没有"音符时值/断奏"信息，等做延音/断奏建模时再开；
4. 后续 P1：管线切 48k/24bit 母版 + `--hires` 输出；P2：mod 音频引擎直接读这些无损母版。
