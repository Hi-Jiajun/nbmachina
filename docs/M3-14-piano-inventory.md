# M3-14 · 钢琴采样库总表

> 由 `node tools/piano-inventory.mjs` 生成（2026-09-15）。明细逐根音见 `build/piano_inventory.csv`。

## 一览

| 库 | 许可 | 格式 | 录音根音 | 录音音域 | 力度层/根音 | 区域数 | 采样体积 | 最近根音最大变调 |
|---|---|---|---|---|---|---|---|---|
| **Salamander Grand Piano V3（48kHz/24bit 完整母版）** | CC-BY 3.0 | 48.0kHz/24bit/2ch | 30 个（每 3 半音） | A0..C8（midi 21..108） | 16 | 480（另丢 161 层松键/CC） | 1811MB（480 文件） | 1 半音 |
| **Salamander Grand Piano V3（Ogg 有损包）** | CC-BY 3.0 | — | 30 个（每 3 半音） | A0..C8（midi 21..108） | 16 | 480（另丢 161 层松键/CC） | 76MB（480 文件） | 1 半音 |
| **Yamaha Disklavier Pro（OLPC 完整合集 · legato）** | CC-BY 3.0 | 44.1kHz/16bit/1ch | 30 个（每 3 半音） | A0..C8（midi 21..108） | 12~33 | 835（另丢 0 层松键/CC） | 766MB（835 文件） | 1 半音 |
| **Yamaha Disklavier Pro（SF2 子集）** | CC-BY 3.0 | 44.1kHz/16bit/1ch | 26 个（每 3 半音） | A0..C7（midi 21..96） | 3~5 | 103（另丢 0 层松键/CC） | 119MB（103 文件） | 12 半音 |
| **VSCO 2 CE Upright Piano** | CC0 1.0 | 44.1kHz/24bit/2ch | 23 个（每 3/4 半音） | A0..C8（midi 21..108） | 3 | 69（另丢 0 层松键/CC） | 242MB（69 文件） | 2 半音 |
| **VSCO 2 CE Upright Nr.1（直出采样）** | CC0 1.0 | 44.1kHz/16bit/2ch | 14 个（每 5/7 半音） | C1..G7（midi 24..103） | 5~6 | 82（另丢 0 层松键/CC） | 148MB（79 文件） | 5 半音 |

## 力度分层是怎么切的

SFZ 的 `lovel/hivel` 是"这一层采样负责的力度区间"，区间边界 = **相邻力度采样值的中点**；
力度值来自采样文件名里的实测力度（如 `pno057v43leg.wav` = 57 号音、力度 43、legato）。
下面以每个库的**最低根音**为例，列出它完整的力度分层：

- **Salamander Grand Piano V3（48kHz/24bit 完整母版）**（根音 21 = A0）：16 层　1-26 27-34 35-36 37-43 44-46 47-50 51-56 57-64 65-72 73-80 81-88 89-96 97-104 105-112 113-120 121-127
- **Salamander Grand Piano V3（Ogg 有损包）**（根音 21 = A0）：16 层　1-26 27-34 35-36 37-43 44-46 47-50 51-56 57-64 65-72 73-80 81-88 89-96 97-104 105-112 113-120 121-127
- **Yamaha Disklavier Pro（OLPC 完整合集 · legato）**（根音 21 = A0）：12~33 层　0-5 6-7 8-9 10-11 12-14 15-18 19-22 23-26 27-30 31-33 34-35 36-39 40-45 46-49 50-52 53-57 58-62 63-66 67-70 71-73 74-76 77-80 81-86 87-92 93-97 98-102 103-106 107-110 111-114 115-117 118-120 121-125 126-127
- **Yamaha Disklavier Pro（SF2 子集）**（根音 21 = A0）：3~5 层　0-127 0-127 0-127 0-127
- **VSCO 2 CE Upright Piano**（根音 21 = A0）：3 层　0-60 61-110 111-127
- **VSCO 2 CE Upright Nr.1（直出采样）**（根音 24 = C1）：5~6 层　0-80 0-60 61-110 81-127 111-127

## 用在什么地方

- Salamander Grand Piano V3（48kHz/24bit 完整母版）：旋律默认（离线渲染 + 数据包 hifi）
- Salamander Grand Piano V3（Ogg 有损包）：对照用（同一套映射，只是有损编码）
- Yamaha Disklavier Pro（OLPC 完整合集 · legato）：Yamaha 主用（30 根音 A0..C8、最多 33 层力度）
- Yamaha Disklavier Pro（SF2 子集）：对照用（26 根音 A0..C7、3~4 层；顶音区要变调）
- VSCO 2 CE Upright Piano：第三架钢琴（CC0，无署名义务）
- VSCO 2 CE Upright Nr.1（直出采样）：备用（同一架琴的另一套采样）

## 许可与署名（发布成品时必须遵守）

| 库 | 作者 | 许可 | 商用 | 署名 |
|---|---|---|---|---|
| Salamander Grand Piano V3（48kHz/24bit 完整母版） | Alexander Holm | CC-BY 3.0 | ✅ | 必须：`Salamander Grand Piano V3 — Alexander Holm (CC-BY 3.0)` 类同 |
| Salamander Grand Piano V3（Ogg 有损包） | Alexander Holm | CC-BY 3.0 | ✅ | 必须：`Salamander Grand Piano V3 — Alexander Holm (CC-BY 3.0)` 类同 |
| Yamaha Disklavier Pro（OLPC 完整合集 · legato） | Zenph Studios 录 / OLPC 合集 v2.7 | CC-BY 3.0 | ✅ | 必须：`Salamander Grand Piano V3 — Alexander Holm (CC-BY 3.0)` 类同 |
| Yamaha Disklavier Pro（SF2 子集） | Zenph Studios 录 / Roberto Gordo Saez 编译 | CC-BY 3.0 | ✅ | 必须：`Salamander Grand Piano V3 — Alexander Holm (CC-BY 3.0)` 类同 |
| VSCO 2 CE Upright Piano | Ivy Audio / Versilian Studios（VSCO 2 CE） | CC0 1.0 | ✅ | 不需要（CC0 无署名义务，仍鼓励） |
| VSCO 2 CE Upright Nr.1（直出采样） | Versilian Studios（VSCO 2 CE） | CC0 1.0 | ✅ | 不需要（CC0 无署名义务，仍鼓励） |

> 采样本体不进仓库（`_toolchain/` 已 gitignore）；本表只记录来源、规格与核验方式。
> 上游核验过程见 `docs/M3-13-audio-sources.md`。

