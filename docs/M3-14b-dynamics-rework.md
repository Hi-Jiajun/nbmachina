# M3-14b · 逐音实测力度判负 → 回滚 + 乐句级力度（2026-09-15）

**用户听感**："现在听倒是很明显能听出力度差别，但是实测力度的力度分配特别不好听，完全不如恒定力度。"

按项目规矩（听感优先于指标、判负立刻回滚）处理：**先把数据包回滚到恒定力度**，再定位原因。

## 1. 回滚（已完成，游戏内已生效）

```bash
node src/arrange/arrange-all.mjs --dynamics off   # 新增开关：不写 velMidi，playsound 回落到谱面 volume 列
node src/emit/note-blocks.mjs && node src/emit/datapack-playback.mjs
node src/emit/undo-clone.mjs && node src/emit/redo-chain.mjs
node src/emit/playsound-hifi.mjs && node src/emit/lint-pack.mjs
pwsh -NoProfile -File build/install_styx_pack.ps1   # → pack_structures=196
```

实测回滚结果：`play/hifi/**` 的音量取值从 77 个（0.15..1.00）回到 **1 个（0.35）**；
谱面回到 12 列（保留 velocity 原始列，但没有 velMidi）——即用户判定"更好听"的那一版。

## 2. 为什么"分配特别不好听"（有数）

不是音色问题，是**逐音力度的跳变**：M0 的 `velocity` 是"该音自己的音级在该八度上的短时窄带能量"，
它测的是**混音里那一瞬间的窄带能量**（人声/贝斯/鼓/其他音都在里面），再被我按 p5→10、p50→64、
p95→127 三分位拉伸放大。实测旋律 1385 颗音的相邻差：

| 口径 | velMidi 范围 | 相邻音跳变 中位 | p90 | 跳变 >32 级的比例 |
|---|---|---|---|---|
| 逐音实测（判负） | 10..127 | **17** | 46 | **26.4%** |
| 乐句级（本轮候选） | 52..104 | **2** | 8 | 0.1% |
| 乐句级 · 窄档 | 68..100 | 1 | 5 | 0.0% |

也就是说：**每四颗相邻音里就有一颗跳 32 级以上**（≈4dB，常常更多），听感上就是"每颗音随机强弱"，
而不是"人在弹琴"。用户"完全不如恒定力度"的判定与数据完全一致。

## 3. 候选：乐句级力度（离线 A/B 已出，等耳定）

`src/arrange/dynamics.mjs` 新增 `phraseVelMidi()`：

1. 先按逐音口径算出 velMidi；
2. 用 **±0.75s 时间窗的截尾均值（去掉两端 10%）** 平滑
   —— 用中位数会在"逐音交替抖动"上随窗口相位来回翻（夹具里实测 52↔76），截尾均值既抗离群又连续；
3. 把平滑后的曲线按 **p10..p90** 压到 `floor..ceiling`：默认 **52..104（≈7.4dB）**，
   可用 `--dyn-floor/--dyn-ceiling` 调窄（如 68..100 ≈ 4.6dB）。

整曲渲染（同一份谱面、同一套采样，只改力度口径）：

| 文件 | 力度口径 | 增益范围 |
|---|---|---|
| `build/ensemble/styx_ens_salamander48_flat_*` | 恒定（对照 = 现在游戏内） | ×0.71 恒定 |
| `build/ensemble/styx_ens_salamander48_dyn_*` | 逐音实测（判负） | ×0.146..1.000 |
| `build/ensemble/styx_ens_salamander48_phrase_*` | 乐句级 52..104 | ×0.291..0.685（7.4dB） |
| `build/ensemble/styx_ens_salamander48_phrase_narrow_*` | 乐句级 68..100 | ×0.379..0.641（4.6dB） |
| `build/ensemble/styx_ens_disklavier_phrase_*` | 乐句级（Yamaha） | ×0.291..0.685 |

**回接数据包**（用户选定后一条命令）：

```bash
node src/arrange/arrange-all.mjs --dynamics phrase   # 或 --dynamics measured
# 然后重跑 §1 里那 6 条 emit + 装包
```

## 4. 未做 / 如实声明

- 逐音实测力度**保留**为 `--dynamics measured`（对照用），不再作为默认；
- 乐句级的平滑窗（1.5s）与范围（7.4dB / 4.6dB）是**听感参数**，等用户耳定后再调；
- 若还想更贴原曲，下一步应该是"用 UVR 把人声/伴奏分离后，只从钢琴轨量力度"，而不是继续调映射
  ——但那是更大的工程，本轮不做。
