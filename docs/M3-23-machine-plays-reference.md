# M3-23 · 机器改弹"参考演奏本身"（谱面换源）

> 用户 2026-09-18 听过 A/B 后拍板：**"R 好得多了"** —— 于是把机器的谱面从**红石谱**换成**参考演奏的转谱**。

## 1. 为什么换

M3-22 已经证明音区（bass +24）与时值（键释放+踏板）能修好"糊"，但用户仍说"低音完全不一样"。
决定性实验：把"弹什么音"整体换成**从视频里听出来的 3386 颗音**（同一个转谱模型，同一架琴、
同一套时值规则），频谱立刻贴到原曲：

| 频段(Hz) | <60 | 60–100 | 100–150 | 150–250 | 250–500 | 0.5–2k | 质心 |
|---|---|---|---|---|---|---|---|
| 原曲 | 0.02 | 2.63 | 7.58 | 19.69 | 43.35 | 26.13 | 1090 Hz |
| 红石谱（M3-22 校准后） | 0.24 | 7.39 | 21.35 | 12.95 | 22.96 | 34.17 | 932 Hz |
| **转谱当谱面（本版）** | 0.23 | **1.25** | **13.93** | 12.54 | **33.37** | 37.05 | **1068 Hz** |

结论：**瓶颈是"红石谱的左手"本身**（60–150Hz 堆了 3~8 倍能量，而原曲的重量在 250–500Hz），
不是采样也不是混音。用户听感与数据一致，遂换源。

## 2. 换源后机器长什么样

| 项目 | 旧（红石谱） | 新（参考转谱） |
|---|---|---|
| 音符数 | 2915 | **3386** |
| 音域 | 45..102 | 25..104 |
| 布局行 `row` | 红石谱折叠后的行 | `midi % 24`（撞格时顺延到最近空行，本次 134 颗） |
| 甲板配色 | harp/bass 由红石通道决定 | 按音区二分：`midi < 60` → oak_planks（左手色），其余 sand |
| 时值 | 键释放 + 踏板（校准） | 同左（同一个转谱） |
| 力度 | 视频乐句级归一 | **转谱模型逐音力度**（中位 89） |
| 机器范围 | x 480..2880 / z -169..-145 | 不变（step 1..2316，行 0..24） |

摆块时会先把**历史上摆过的全部格位**（`build/old_cells_union.csv`，5902 格并集）清空，
避免世界里留下永不触发的装饰方块。

## 3. 顺手修的体验问题

* `/nbforge reloadmap`：换谱面后不用重启游戏；`/reload`（数据包重载）也会自动重读
  `nbforge/machine_map.csv`。此前只在服务端启动时读一次。

## 4. 产物与验证

* `tools/score-from-transcription.mjs` → `build/machine_from_reference.csv`（3386 颗音，机器口径，
  含 `time_seconds/velMidi/keyMs/durMs`）
* 数据包：792 个函数 / 154408 行 / `pack_structures=196`（`lint-pack` 全绿：无 `tick rate`、
  无悬空引用、note 范围合法）
* `nbforge/machine_map.csv`：3386 个位置（带 `dur_ms`），已部署客户端 + 副本服
* `nbforge/score.csv`：3386 颗音（6 列，带 `dur_ms`），同上
* 副本服自检：谱面 3386 颗 / 跳过 0 行；机器映射 3386 个位置；到点/命令链全绿

## 5. 游戏内怎么换过来

```
1) 重启游戏（新 jar + 新 machine_map.csv 要在起服时读；之后换谱面只用 /nbforge reloadmap）
2) /reload                ← 装新数据包
3) /function styx:redo    ← 清旧块、摆新块（约 1 分钟），结束后自动开始播放
4) 想单独听：/nbforge listen on → /function styx:play/start
5) 想回退：/function styx:undo（redo 时已自动存快照）
```

## 6. 复现

```powershell
cd nbforge
node tools/score-from-transcription.mjs --out ../build/machine_from_reference.csv
node src/emit/note-blocks.mjs     --notes ../build/machine_from_reference.csv --old ../build/old_cells_union.csv
node src/emit/datapack-playback.mjs --notes ../build/machine_from_reference.csv
node src/emit/undo-clone.mjs
node src/emit/redo-chain.mjs
node src/emit/playsound-hifi.mjs  --notes ../build/machine_from_reference.csv
node src/emit/lint-pack.mjs
pwsh -NoProfile -File ../build/install_styx_pack.ps1
node tools/export-mod-machine-map.mjs --in ../build/machine_from_reference.csv --deploy
node tools/export-mod-score.mjs       --in ../build/machine_from_reference.csv --preset piano --deploy
```

## 7. 未做 / 待定

* 转谱有漏检与误检（模型 F1 0.9677 是 MAESTRO 上的数字）；如果某段听出"多了/少了音"，
  可以按段对照 `build/ref_transcription.mid` 手工修。
* 时间轴量化到 0.12s 网格（48% 的音会挪 ≤60ms）——这是机器能表达的极限；要更准得改 tick 网格。
* 低音的"重量感"仍是 Salamander 的音色；若之后想更贴原曲，可换 Disklavier 完整合集再比。
