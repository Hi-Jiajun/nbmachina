# M3-31 · 断奏（sta）采样接进 mod 与离线渲染

> 队列里最后一项 mod 功能：OLPC 合集里同一颗音录了 **leg（连奏）** 与 **sta（断奏）** 两套，
> 之前只用了 leg（835 区域），sta 那 376 个文件一直没接。

## 规则

谱面每颗音自带 `dur_ms`（实际发声时长，来自参考演奏的键释放+踏板）：

```
dur_ms > 0 且 ≤ 300ms  → 用 sta（断奏）采样
其余（含 dur_ms = 0）  → 用 leg（连奏）采样
```

全曲 **356 / 3044 颗（12%）** 落在短音档；短音最密集的窗口是 2:20 起（20 秒内 55 颗）。

## 落地

* `tools/export-mod-instruments.mjs`：新增 `staccatoRegions()` —— 扫 OLPC 目录的 `pno<midi>v<vel>sta.wav`
  （两种命名都认：`pno021v106sta` 与 `pno27v75sta`），按"根音 → 力度层中点"生成 region，
  标记 `staccato: true`。disklavier 从 **835 → 1211 区域**。
* mod `NbforgeInstruments.pick(midi, velocity, durMs)`：有 sta 区域时**互斥选池**（短音只用 sta、长音只用 leg）。
* 离线 `src/sample/sfz.mjs` 的 `pickRegion(..., durMs)` + `render-ensemble.mjs --melody disklavier`：
  同一条规则（离线与游戏内必须一口径）。
* Salamander 没有 sta 采样 → 那条规则对它自动无效（切到 Disklavier 才生效）。

## 修掉的一个真 bug（否则长音会被 sta 抢走）

sta 区域的 `loKey == hiKey`（span 0），而选层规则里有一条"**音域最窄者优先**"（防通配区域抢音）。
第一版没有互斥，结果：

```
midi 60 vel 95 durMs 200  → pno060v95sta.wav（sta）✓
midi 60 vel 95 durMs 3000 → pno060v95sta.wav（sta）✗ 长音也用了断奏
```

改成互斥选池后：

| 用例 | 选中的采样 |
|---|---|
| midi 60 vel 95 durMs 200 | `pno060v95sta.wav`（sta）✓ |
| midi 60 vel 95 durMs 3000 | `pno060v90leg.wav`（leg）✓ |
| midi 40 vel 60 durMs 200 | `pno039v3sta.wav`（sta）✓ |
| midi 40 vel 60 durMs 3000 | `pno039v60leg.wav`（leg）✓ |
| midi 84 vel 110 durMs 200 | `pno084v110sta.wav`（sta）✓ |
| midi 84 vel 110 durMs 3000 | `pno084v112leg.wav`（leg）✓ |

旁证：A/B 两版的差异能量从 **−2.4dB**（错误版：一大半音都换了采样）收敛到 **−11.4dB**（正确版：只有短音变）。

## 验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 规则直查 | `node _scratch-m3-31/check-sta-rule.mjs` | 上表 6 条全对 |
| 采样导出 | `node tools/export-mod-instruments.mjs --deploy` | disklavier 1211 区域（含 sta 376），已部署 |
| 编译 | `build-mod.ps1` | `BUILD SUCCESSFUL`，jar **82154 B**（已部署客户端+副本服） |
| 副本服自检 | `java -Dnbforge.selftest=true` | `自检通过` |

## 试听 A/B（都是 Disklavier 音色）

```
build/ab2/AB_leg_140-160s.wav   只用 leg（改前）
build/ab2/AB_sta_140-160s.wav   短音用 sta（改后）
```

游戏内要听差别：先 `/nbfc instrument set all disklavier`（Salamander 没有 sta 采样），再 `/function styx:play/start`。
