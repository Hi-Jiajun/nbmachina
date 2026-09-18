# nbmachina · 从一首歌到「会演奏的音符盒机器」

> 2026-09-18 由 **nbforge** 更名为 **nbmachina**（NB = NoteBlock，machina = 自动机/乐器）。
> 改名原因：`forge` 在 Minecraft 语境里容易被误认成 **Minecraft Forge** 加载器，而本项目是 **Fabric**：
> 命令由 `/nbforge` → **`/nbm`**、客户端由 `/nbfc` → **`/nbmc`**，配置与数据目录由 `nbforge/` → `nbmachina/`。

作者：**Jiajun Liang（梁嘉骏）** · GitHub [@Hi-Jiajun](https://github.com/Hi-Jiajun)

把一首歌（音轨 + 转谱数据）自动变成一台 **真正由实体音符盒发声** 的 Minecraft 音乐机：
生成数据包（结构 + 播放器 + 灯光），并自带无头服务器验收工具。

> 本仓库所有代码均为自研实现。设计上参考了社区公开项目的**思路**（见 `NOTICE.md`），未复制其代码。

## 核心思路（我们自己的做法）

| 环节 | 做法 | 为什么这么做 |
|---|---|---|
| **音高** | 按声部（旋律 / 低音）做「**保持音程的八度折叠**」：每颗音选离同声部上一个音最近的八度，音级保持原调 | 音符盒只有 2 个八度（`note` 0~24），整首歌必须折叠；逐音固定八度会**破坏音程**（这是最常见"错音"来源） |
| **节奏** | 播放时用 `/tick rate 100` 提高刻率，原曲 0.12 秒/步 = **正好 12 刻** | 20 tps 下 0.12 秒 = 2.4 刻，只能四舍五入 → 节奏摇摆。提高刻率后**完全精确**且不用改速度 |
| **力度** | 从原曲音频逐音取响度（RMS），映射到 0.35~1.0 | 原版音符盒音量固定；力度在「监听模式」生效，配合模组也能写进音符盒 |
| **触发** | 每颗音符：在其正上方瞬放红石方块再拆掉（音符盒收到充能即发声） | 声音来自**实体音符盒**（不是 `/playsound` 播放音频），这才是「红石音乐」 |
| **灯光** | 每颗音符正下方两格一盏红石灯，随演奏点亮/熄灭 | 视觉指示；与音符盒不接触，不会改变音色 |
| **地形** | 逐段扫描地表，生成「贴湖面 + 平滑爬升」的剖面；挡住的部分只在音轨宽度内开槽 | 音轨 2352 格太长，直线上难免碰到山体 |
| **强加载** | 播放器自动 `forceload` 分两段（forceload 单次上限 256 区块），演奏结束自动解除 | 否则远处音符所在区块未加载 → 那些音根本不响 |
| **验收** | `src/test/run-headless.mjs`：起无头服务器 → 铺装 → 演奏 → 对照数据核对触发数量 | 不靠"听起来差不多"，用数据验收 |

## 目录结构

```
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

它会：修地形 → 分三段强加载并替换音符 → 开监听 → 自动开始播放（演奏期间刻率 100，结束恢复 20）。

## 已知问题 / TODO

- [ ] `tick rate 100` 模式下，无头验收的**触发计数**与数据对照有偏差（216 vs 68），需要定位是计数口径还是重复触发
- [ ] 2 个八度限制下的极少数极端音仍会折回（物理限制）
- [ ] 力度目前只在监听模式生效；写进实体音符盒需要模组（如 NoteBetter）配合
- [ ] 资源包音色（钢琴/弦乐/鼓）尚未实现

## 许可

MIT（见 `LICENSE`）。参考项目的思路来源见 `NOTICE.md`。
