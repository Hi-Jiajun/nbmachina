# M3-29 · 客户端高精度播放：把"速度局限"从服务器刻率上解下来

> 用户 2026-09-18："关于用音符盒播放的速度局限问题，可以通过 mod 解决吗？" → 评估后："那就直接做"。

## 1. 局限到底在哪

| 层 | 是不是瓶颈 | 现状 |
|---|---|---|
| 布局格位 0.12s | 不是 | M3-24 已把"触发时刻"与"格位"解耦（格位只管住哪儿） |
| **服务器刻率** | **是** | 数据包与服务端谱面播放器都只能落在服务器刻上：20 tps = 50ms、`/tick rate 100` = 10ms |
| 音符盒/红石本体 | 不是 | 已绕开（自研演奏器发声） |

## 2. 做法：客户端自己走时钟

* 新增 `mod/.../score/NbforgeClientPlayer.java`：客户端读游戏目录的 `nbforge/score.csv`（与服务端同一份），
  用 `System.nanoTime()` 逐颗调度——**粗睡到目标前 1ms、最后 1ms 自旋**，再调现有音频引擎；
  锚点 = 玩家眼睛位置（与 `listen on` 同口径，站哪儿都能听全曲）。
* 音频线程原来是"取不到任务就睡 15ms"，会给发声再加最多 15ms 抖动 → 改成
  `LinkedBlockingQueue<Task>` + `poll(1ms)`（有任务立刻醒、一次最多连跑 64 条），并记录
  **"入队 → 执行"延迟**。
* 命令：`/nbfc play [起始秒]`、`/nbfc stop`；`/nbfc status` 增加一行：
  播放状态 / 谱面颗数 / 已调度 / 发声 / 跳过 / **抖动 均·最大** / 音频队列延迟。

## 3. 与机器视觉的分工

* 声音：客户端调度（~1ms 级，不受刻率限制）。
* 视觉（红石灯、粒子）：仍由数据包/服务器刻驱动 —— 这是**做不到更快**的部分（要在客户端画假灯才可能，
  属于另一个话题）。
* 想"机器只做视觉 + 客户端高精度发声"：先 `/function styx:play/sound_off`（把数据包的发声行关掉，
  避免双响），再 `/nbfc play`。恢复：`/function styx:play/sound_on` + `/nbfc stop`。

## 4. 验证（已跑过的）

| 项目 | 命令 | 结果 |
|---|---|---|
| 编译 | `build-mod.ps1` | `BUILD SUCCESSFUL`，jar **78270 B** |
| 副本服自检 | `java -Dnbforge.selftest=true` | `[nbforge][selftest] === 自检通过，停服 ===` |
| 数据包静态自检 | `node src/emit/lint-pack.mjs` | 792 函数 / 146971 行，无 `tick rate`、无悬空引用 |
| 派发一致性 | `node tools/verify-pack-vs-score.mjs` | lo/hi 各 **3044 颗 / 缺失 0 / 多余 0 / tick 不符 0** |

**还没验证的（只能真机）**：客户端调度线程的实际抖动与听感 —— 跑一次
`/nbfc play` 后看 `/nbfc status` 里的"抖动 均/最大"（预期亚毫秒~1ms 级，对照：20 tps = 50ms、
100 tps = 10ms）。

## 5. 怎么用

```
1) 重启游戏（jar 变了）+ /reload（数据包变了）
2) 想只听客户端高精度版：
     /function styx:play/sound_off      ← 机器只留视觉
     /nbfc play                          ← 从头播（也可以 /nbfc play 165 从 2:45 起）
     /nbfc status                        ← 看抖动/队列延迟
     /nbfc stop                          ← 停
3) 回到原链路：/function styx:play/sound_on
```
