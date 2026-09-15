# M3-18 · 四声部全真采样（VSCO 竖琴 / 低音提琴拨弦 / 打击乐）

用户："继续"。这一轮把 `score.csv` 里剩下的两个声部从"钢琴顶替/直接跳过"换成**真乐器**。

## 1. 乐器库：4 → 7 件

`config/nbforge/instruments.json`（`tools/export-mod-instruments.mjs` 生成，共 **1559 个区域**）：

| id | 乐器 | 许可 | 区域 / 根音 | 音域 | 用途 |
|---|---|---|---|---|---|
| `salamander48` | Salamander V3 48k/24bit | CC-BY 3.0 | 480 / 30 | 21..108 | 旋律（默认钢琴） |
| `disklavier` | Yamaha Disklavier（OLPC 全集） | CC-BY 3.0 | 835 / 30 | 21..108 | 备选钢琴 |
| `vsco_upright` | VSCO 直立钢琴 | CC0 | 69 / 23 | 21..108 | 备选钢琴 |
| `disklavier_sf2` | Yamaha SF2 子集 | CC-BY 3.0 | 103 / 26 | 21..96 | 对照 |
| **`vsco_harp`** | VSCO 竖琴 | CC0 | **23 / 23** | 28..101 | 内声部（本轮入库，当前谱面无内声部） |
| **`vsco_contrabass_pizz`** | VSCO 低音提琴拨弦 | CC0 | **40 / 14** | 24..60 | **贝斯声部（1276 颗）** |
| **`vsco_perc`** | VSCO 打击乐（底鼓 7 层 + 铃鼓 2 层） | CC0 | **9 / 2** | 36 / 42 | **打击乐（138 颗）** |

打击乐是**非音高**乐器（`pitched:false`）：直接用 `GM-StylePerc.sfz` 的两件，但按我们的声部键位重映射
（底鼓 GM36 原样；铃鼓 GM54 → 我们的 `hat` 键 42——VSCO 2 CE **没有闭合踩镲**，用铃鼓替代，
与离线渲染 `render-ensemble` 同一处理，如实标注）。

## 2. 两个真实缺陷（都在导出这一层，已修）

1. **打击乐的 `midi` 其实是行号**：机器谱面里 `basedrum` 的 midi=0/row=0、`hat` 的 midi=24/row=24，
   不是 GM 键位。旧导出直接把它当音高写进 `score.csv` → mod 侧按"最近区域"匹配，**鼓和铃鼓都会落到 36（底鼓）**。
   修法：按**声部名**映射（`basedrum→36`、`hat→42`），与离线渲染 `GM = { basedrum: 36, hat: 42 }` 同口径。
2. **窄音域乐器要整八度折回**：低音提琴只到 C1(24)，而谱面贝斯声部最低到 A0(21)（116 颗低于 24、8 颗高于 60）。
   旧 mod 侧只有"最近区域 + 硬变调"，会把这 124 颗音硬拽 3 个半音（拨弦会变成怪声）。
   修法：`pitched:true` 的乐器在播放前**整八度折回音域**（与离线 `foldIntoRange` 同口径），
   并在 `/nbfc status` 暴露"八度折叠"计数。

## 3. 实测（副本服自检 23:46）

```
[nbforge] 谱面已加载：3053 颗音 / 总时长 278.4s（跳过 0 行）
[nbforge][selftest] 谱面直读：3053 颗音 / 278.4s / 跳过 0 行；声部 {bass=1276, harp=1639, hat=42, basedrum=96}
[nbforge][selftest] 到点计数：t=0 → 4，t=60s → 527，末尾 → 3053（应等于 3053）→ 通过
[nbforge][selftest] 谱面播放器 t=40（约 2.0s）：到点 14 颗 = 谱面前 2.0s 的 14 颗 → 通过
```

`score.csv` 导出结果：

```
乐器：{vsco_contrabass_pizz:1276, salamander48:1639, vsco_perc:138}
键位：vsco_contrabass_pizz=21..61  salamander48=56..102  vsco_perc=36..42
```

## 4. 听感上应该有的变化（等用户验收）

- 低音不再由钢琴代弹，而是**低音提琴拨弦**（C1 以下整八度折回，不硬变调）；
- 曲子里多了**底鼓与铃鼓**（以前这 138 颗是直接跳过的）；
- 旋律仍是 Salamander 48k/24bit 母版。

> 提示：`/nbfc instruments` 现在应有 7 件；`/nbfc status` 多了一行"八度折叠 N"——
> 低音提琴那 124 颗会被折回，正常情况下这个数字在整曲放完后应该 ≈124（不是 0）。

## 5. 下一步

1. 内声部（`arrange-all --inner on`）接上 `vsco_harp`——现在谱面还没有内声部层；
2. 机器与引擎合一：红石触发 → 直接派发无损音；
3. 延音/断奏（`sta` 采样）、多声道、游戏内无损录制。
