# M3-28 · 无损成片音轨（双声道）+ 数据包一致性校验

> 用户 2026-09-18 拍板："A 就行"（成片音轨 = 离线母版），并明确 **多声道暂缓**：
> "多声道可以暂时不做，等我多了解一些再做，先就只做双声道无损就行"。
> 按 Superpowers 的流程走：计划 `docs/superpowers/plans/2026-09-18-lossless-master-and-verification.md` → 实现 → 验证。

## 1. 交付物（`build/master/`）

| 文件 | 规格 | 说明 |
|---|---|---|
| `styx_master_48k24bit.wav` | 48kHz / 24bit / 立体声 / 287.941s | **成片音轨本体**（总线归一 -18dBFS + 软限幅，立体声峰值 0.978） |
| `styx_master_stem_melody_48k24bit.wav` | 同上 | 旋律层分轨（与总线同一套增益/声像、同一归一，**不含**软限幅） |
| `styx_master_stem_inner_48k24bit.wav` | 同上 | 内声部层分轨 |
| `styx_master_stem_bass_48k24bit.wav` | 同上 | 左手（低音）层分轨 |
| `styx_master_manifest.json` | — | 文件清单 + 时长/声道/峰值/RMS + 来源（谱面、preset、力度口径、总线高通）+ 5.1 状态 |

生成命令（一条）：

```powershell
cd nbforge
node tools/render-ensemble.mjs --preset piano --dynamics measured --master-kit `
  --score ../build/machine_from_reference.csv --name styx_master --out ../build/master
```

为什么用"离线母版"而不是"游戏内录制"：游戏内播放和离线渲染**用的是同一份谱面 + 同一套采样**
（`config/nbforge/instruments.json` 指向的高通版 Salamander），母版就是机器该有的声音，
而且确定性、可复现、可回滚；游戏内直录要在 Java 里重写混音器（重采样/包络/限幅），收益相同、风险更大。

**投稿用法**：B 站 hi-res 直接传 `styx_master_48k24bit.wav`（48k/24bit PCM 满足要求）；
要重配比就用三条 stems，它们的和 ≈ 母版（差一个软限幅）。

## 2. 数据包 ↔ 谱面 一致性校验（纯离线）

```powershell
node tools/verify-pack-vs-score.mjs     # 不需要进游戏
```

它把生成好的 `play/{lo,hi}/*.mcfunction` 里的 `run nbforge playat x y z` 全部解出来，
用同一份 `makePos(profile)` 反算谱面每颗音的坐标，逐项比对：

| 模式 | 谱面 | 派发 | 缺失 | 多余 | tick 不符 | 结论 |
|---|---|---|---|---|---|---|
| lo（20 tps） | 3044 | 3044 | 0 | 0 | 0 | 通过 |
| hi（100 tps） | 3044 | 3044 | 0 | 0 | 0 | 通过 |

顺带量出一个有用的数字：**"精确时刻触发"比"0.12s 格位触发"平均准 30ms、最多准 100ms**
—— 这就是 M3-24 那次改动（触发时刻精确到刻）除掉的量化误差。

## 3. 明确暂缓/未做

* **多声道（5.1）**：按用户指示暂缓（manifest 里记 `surround51: deferred`）。将来要做时的方案：
  FL/FR = 立体声母版、FC = 旋律层 ×0.7、LFE = 低音层 120Hz 低通、BL/BR 留空（独奏钢琴没有环绕内容，如实标注）。
* **游戏内直录**：不做（理由见 §1）。
* **mod 运行时音色切换 / sta 断奏采样**：仍在待办队列，各自会走一遍同样的"计划 → 实现 → 验证"流程。
