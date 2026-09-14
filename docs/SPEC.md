# nbforge 规格（SPEC v0.3）

上游设计讨论：`DESIGN.md`（v0.1 三组讨论 + v0.2 用户反馈）。

## 1. 目标与成功标准
**目标**：把一首歌的**工程文件 + 音频**，变成一台在 Minecraft 里由实体音符盒/自研演奏器真实演奏的机器；
工程文件与实际效果可回归对齐，并给出综合评分。

**成功标准**（可量化）：见 `DESIGN.md` 第二节（一条命令 ≤60s 出声 / 触发计数差 0 / MSPT ≤ 50 /
听觉清单 10 条 / 回退逐格差异 0）。

## 2. 模块与接口（文件进 / 文件出）
| 模块 | 输入 | 输出 |
|---|---|---|
| `ingest` | 音频 / MIDI / MusicXML / PDF(OMR) | `project.json` |
| `analyze` | `project.json` + 音频 | `analysis.json`（速度 / 音域 / 八度证据 / 力度证据 / chroma） |
| `arrange` | `project.json` + `analysis.json` | `score.json` + `arrange-report.json` |
| `layout` | `score.json` + 世界数据 | `layout.json` + `build*.mcfunction` |
| `emit` | `score.json` + `layout.json` | 数据包（结构/播放/灯光）+ 安装脚本 |
| `verify` | 数据包 + 音频 | `report.json`（客观指标 + 综合分） |
| `deploy` | 数据包 | 存档内安装（含备份/回退） |

每个模块：**幂等**、可单独运行、可被替换；全部产物为纯文本（JSON/CSV），可 diff、可手改。

## 3. 数据契约
**foreign 标准**（可商用、权威、广泛使用）：
- 乐谱层 **MusicXML**（W3C 社区标准）
- 演奏层 **SMF / MIDI**（含 tempo map、velocity、多轨）
- 制作层（可选）**DAWproject**（开放工程交换格式）

**内部规范 `project.json`**（超集，字段与以上三者 1:1 可映射）：
```
meta{title,author,tempo,license,source{format,path,sha256}}
voices[]        # melody / inner / bass / perc
notes[]         # {voice, onsetSec, durSec, midi, velocity, tie, slur}
tempoMap[]      # {sec, bpm}
annotations[]   # 力度记号、段落、反复（来自 MusicXML）
```

**核心产物 `score.json`**（音符盒可演奏层）：
```
meta{tps, secPerStep, steps, totalTicks}
notes[]  # {step, tick, voice, instrument, row(0..24), velocity(0..1), len(steps)}
degradations[]  # 显式记录被折叠/丢弃/近似的项（保真契约）
```

## 4. 双后端
- **A 增强模式**：自研 Fabric mod（自研代码 / MIT），音符盒映射任意音色 + 独立力度/延音；
  保留 MC 特色（方块视觉、粒子、红石灯、木质手感），**不播放原曲音频**。
- **B 原版兼容模式**：2 八度（row 0..24）+ harp/bass + 打击乐（stone→basedrum、glass→hat）。
- 两者共享同一 `score.json`。

## 5. 音色来源（用户不演奏乐器 → 决定）
1. **自研合成引擎（主力，完全自主、零许可风险）**：
   - 拨弦类：Karplus–Strong（竖琴/吉他/贝斯）
   - 键盘类：FM + 多层采样合成（电钢/钢琴近似）
   - 打击类：噪声 + 带通/包络（底鼓/军鼓/踩镲）
   - 钟琴类：模态合成（glockenspiel/bell）
   - 后处理：轻微失谐、真实衰减包络、房间早期反射
2. **CC0/公有领域素材补充**（可选，用于管弦类）：VSCO 2 CE、Sonatina 等；一律在 `NOTICE.md` 标注。
3. **不使用**通用 GM SoundFont（用户明确不要的"塑料电子味"）。

## 6. 验证与评分
`verify` 输出：起音对齐 F1、音级 chroma 相似度、八度命中率、力度包络相关、漏音率；
加权成综合分（客观 70% + 人耳清单 30%，权重可配）。

## 7. 非目标
基岩版 · 多人服务器（MVP）· 跨版本 · 音频版权处理 · 自动音频转谱 · GUI。

> **架构决策（2026-09-15，用户拍板）**：**自研 Fabric mod 是主路径**；早期那条"不依赖 mod / 不强制依赖模组"
> 的约束**已撤销**（用户原话："不强制依赖模组 这个要求去掉，我从来没有过这个意思"）。
> 资源包（Ogg）**降级为可选遗留 / 降级副本**，不再是主交付。
>
> 依据：① 客户端只认 Ogg（javap 实测 `OggAudioStream` 是唯一实现）→ 资源包路线**必然有损**；
> ② mod 可绕开 vanilla `SoundManager`，直接加载 WAV/FLAC 母版并用 LWJGL/OpenAL 播放
> → **无损 + 多声道 + 真·力度/延音**都可实现；③ 原版音符盒音色**不需要复现**（mod 直接引用游戏内置
> `SoundEvents` 即为原版音；机制也可完整复刻），因此不装资源包也能听。
>
> 落地顺序：P1 离线无损渲染（48k/24bit 母版 + `--hires` 立体声/5.1）→ P2 mod 音频引擎（直接读谱面 +
> 无损采样，冻结资源包主路径）→ P3 录音校验（离线渲染 vs 游戏内 OBS 数字采集，量化差异）。
