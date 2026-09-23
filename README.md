# nbmachina · 从一首歌到「会演奏的音符盒机器」

> 2026-09-18 由 **nbforge** 更名为 **nbmachina**（NB = NoteBlock，machina = 自动机/乐器）。
> 改名原因：`forge` 在 Minecraft 语境里容易被误认成 **Minecraft Forge** 加载器，而本项目是 **Fabric**：
> 命令由 `/nbforge` → **`/nbm`**、客户端由 `/nbfc` → **`/nbmc`**，配置与数据目录由 `nbforge/` → `nbmachina/`。

作者：**Jiajun Liang** · 仓库：[github.com/Hi-Jiajun/nbmachina](https://github.com/Hi-Jiajun/nbmachina)

## 现在能做什么（mod 主线 · 2026-09-24 订正）

装了 mod 之后，**声音由 mod 的无损引擎出**：48kHz/24bit 母版、逐音力度、按谱面时值放音，
资源包可以关掉。**演奏由 mod 自己驱动**（`/nbm machine start`，真实时间调度，
刻率只影响精度不影响速度）；数据包只负责"把机器铺出来 / 核对"。

| 能力 | 入口 | 实测 |
|---|---|---|
| **整机演奏（当前主入口）** | `/nbm machine start [起始秒]` | 3044 颗音；每颗音排原版方块事件（**不放红石块**），载荷提前 6 刻发给客户端、到点发声 |
| 触发提前量现场 A/B | `/nbm machine lead <0..6>` | 6 刻（300ms）兼顾抗抖与视觉提前量（M3-97） |
| 无损发声 + 高精度调度 | `/nbmc play [起始秒]` | 抖动均 **0.18ms** / 最大 1.36ms |
| （遗留路线）数据包逐音派发 | `/function styx:play/start[_hi]` | 与 mod 驱动**互斥**：两条链同时跑会让同一颗音触发两次（M3-43） |
| 乐器库 **70 件 / 3719 个采样文件** | `/nbmc instruments [关键字]` | 5 架钢琴 + VSCO 2 CE 全集，全部可商用许可 |
| 运行时换琴 | `/nbmc instrument set <声部\|all> <乐器>` | 立即生效，落盘 `config/nbmachina/voices.json` |
| 采样库自检 | `/nbmc samples` | 逐乐器报告"在位 / 缺多少" |
| 服务端状态 / 监听模式 | `/nbm info`、`/nbm listen on\|off` | 声音跟人走（on）或按方块方位（off） |

## 安装（三步）

1. **装 jar**：把 `nbmachina-<版本>.jar` 放进 `<游戏目录>/mods/`（需要 Fabric Loader ≥0.19.5、
   Fabric API、MC 1.21.10）。**服务端和每个想听到声音的客户端都要装**。
2. **准备采样库**：`node tools/install-samples.mjs --download all --deploy`
   （已有采样目录就用 `--adopt <目录>` 就地接管，不复制文件；详见 [`docs/INSTALL.md`](docs/INSTALL.md)）。
   jar 里自带**相对路径**的乐器索引，采样根按 `环境变量 NBMACHINA_SAMPLES` →
   `config/nbmachina/samples.json` → `<游戏目录>/nbmachina-samples` 的顺序解析，
   所以**换机器 / 换目录都不用重新导出**。
3. **验证**：进游戏跑 `/nbmc samples`（每个乐器应显示 `在位 ✔`），再 `/nbmc demo salamander48` 听一声。

把一首歌（音轨 + 转谱数据）自动变成一台 **真正由实体音符盒发声** 的 Minecraft 音乐机：
生成数据包（结构 + 播放器 + 灯光），并自带无头服务器验收工具。

> 本仓库所有代码均为自研实现。设计上参考了社区公开项目的**思路**（见 `NOTICE.md`），未复制其代码。

## 核心思路（我们自己的做法）

| 环节 | 做法 | 为什么这么做 |
|---|---|---|
| **音高** | 按声部（旋律 / 低音）做「**保持音程的八度折叠**」：每颗音选离同声部上一个音最近的八度，音级保持原调 | 音符盒只有 2 个八度（`note` 0~24），整首歌必须折叠；逐音固定八度会**破坏音程**（这是最常见"错音"来源） |
| **节奏** | 播放时用 `/tick rate 100` 提高刻率，原曲 0.12 秒/步 = **正好 12 刻** | 20 tps 下 0.12 秒 = 2.4 刻，只能四舍五入 → 节奏摇摆。提高刻率后**完全精确**且不用改速度 |
| **力度** | 用 `piano_transcription_inference` 逐音量出参考演奏的力度 → 分位数拉伸成 `velMidi` 1..127 | 原版音符盒音量固定；力度由 mod 引擎按 `velMidi` 选采样层 + 定增益 |
| **触发** | mod 侧真实时间调度（`/nbm machine start`）：到点就 `addSyncedBlockEvent`（原版"被红石激活"的同一路径，**不放红石块**）；音符盒不在时回落引擎直派 | 不走红石、不留可见方块；载荷提前 6 刻到客户端，客户端用 nanoTime 等到准确时刻发声（M3-71/72/97） |
| **灯光** | **已取消**（你 2026-09-22 要求"取消音符盒下面的红石灯"）：现在每颗音只有 mod 发的一颗 NOTE 粒子，真正到点才出现 | 机器看起来更干净；灯/粒子增强交给 M5 视觉层（`docs/M5-show-design.md`） |
| **地形** | 逐段扫描地表，生成「贴湖面 + 平滑爬升」的剖面；挡住的部分只在音轨宽度内开槽 | 音轨 2352 格太长，直线上难免碰到山体 |
| **强加载** | mod 驱动时**滚动**强加载：当前音 ~ 未来 40s 涉及的区块（z 带 ±1 chunk），每 10 刻重申一次，落后 >6 chunk 释放；`styx:redo` 则是整套三段强加载（单次 ≤256 区块，总量无上限） | 否则远处音符所在区块未加载 → 方块事件排不进去；滚动窗口避免常驻 300 个区块 |
| **验收** | `src/test/run-headless.mjs`：起无头服务器 → 铺装 → 演奏 → 对照数据核对触发数量 | 不靠"听起来差不多"，用数据验收 |

## 目录结构

```
mod/
  src/main/java/net/nbmachina/mod/   Fabric mod：无损音频引擎（自研 OpenAL）+ 命令 + mixin
  src/main/resources/nbmachina-instruments.json   jar 内置乐器索引（**相对路径**，构建时自动刷新）
tools/
  render-ensemble.mjs     离线母版渲染（48k/24bit + stems）
  install-samples.mjs     采样库一键下载 / 就地接管 / 自检
  export-mod-*.mjs        乐器索引 / 谱面 / 机器映射导出到游戏目录
  mux-video.mjs           画面 + 无损音轨 → 成片（MKV PCM 48k/24bit）
  compare-ingame-vs-master.mjs   游戏内录音 vs 离线母版的一致性量化
src/
  analyze/   音频与 MIDI 分析（速度、响度、音高范围）
  arrange/   编曲：音高折叠 + 时间轴量化 + 力度  → notes_v3.csv
  layout/    机器布局：逐段高度剖面 + 建造函数
  emit/      生成数据包（结构、播放器、灯光、一键重做链）
  scan/      存档侧扫描（地形剖面、音符审计）
  test/      无头服务器搭建 + 验收
research/    调研脚本（如何检索社区项目、拉 README 等）
```

## 快速开始

```bash
# 0) 准备：一首歌的转谱数据（CSV：step, time, instrument, midi, note_block_pitch）
#    以及原曲音频（wav）——力度与速度从它提取

# 1) 分析原曲
node src/analyze/audio-tempo.mjs          # 估速度（决定每步多少刻）
node src/analyze/parse-midi-and-audio.mjs # 解析 MIDI / 统计音域与响度

# 2) 编曲（音高折叠 + 时间轴 + 力度）
node src/arrange/arrange-notes.mjs        # → styx_helix_notes_v3.csv + apply_notes_v3.mcfunction

# 3) 布局（逐段剖面 + 建造函数）
node src/layout/single-row-layout.mjs     # → single_row_profile.json + flat_build_v2*.mcfunction

# 4) 生成播放器与一键链
node src/emit/datapack-playback.mjs       # → play/*（含 /tick rate、监听、报告）
node src/emit/redo-chain.mjs              # → styx:redo（一条命令跑完全部）

# 5) 验收（无头服务器）
node src/test/setup-headless.mjs
node src/test/run-headless.mjs
```

游戏内只需要一条命令：

```
/function styx:redo
```

它会：修地形 → 分三段强加载（窗口从剖面推导）→ 等区块真就绪 → 铺 3044 个音符盒（每个自带 `nbm_*` NBT）
→ **全量核对 3044/3044**（有缺口自动补，最多 3 次）→ 撤强加载并告诉你一句
**「用 `/nbm machine start` 开始演奏」**（不再自动起播）。

## 已知限制（2026-09-19 更新）

- **没装 mod 就听不到声音**：当前布局里音符盒本体没有可用充能位（"上方必须空气"那条规则挡住），
  发声完全走 mod 引擎，见 `docs/M3-21-machine-engine-unified.md` §6。多人服里只有装了 mod 的玩家能听到。
- **机器已经没有红石灯层**（你 2026-09-22 要求取消）：现在每颗音的视觉只有 mod 发的一颗 NOTE 粒子
  （在真正到点时才发）；灯/粒子增强是 M5 视觉设计的事（见 `docs/M5-show-design.md`）。
- **强加载是滚动的**（mod 驱动时：当前音 ~ 未来 40s，后方只留 ~6 chunk）：拍摄有远景/逆流镜头时要先把窗口放宽。
- **画面精度仍受服务器刻率限制**（声音是客户端 1ms 级）：录视频建议先 `/tick rate 100`。
- **断奏（sta）采样默认关闭**（听感判负，见 `docs/M3-31-staccato-samples.md`）；实验用 `/nbmc sta <ms>`。
- **离线母版的"混音平衡"默认关闭**（耳测判负，见 `docs/M3-35-mix-balance.md`）；需要时 `--balance piano1`。
- **多声道（5.1）暂缓**、**灯/粒子增强计划做成独立 mod**（用户 2026-09-18 拍板）。
- 采样库约 5.7GB，不进仓库；许可与署名见 `NOTICE.md`。

## 许可

MIT（见 `LICENSE`）。参考项目的思路来源见 `NOTICE.md`。
