# M3-17（P2-2）· 谱面直读：服务端按谱面派发，客户端无损播（2026-09-15）

用户在客户端验收无损通路"听到了"之后，接着做 P2 的第二个里程碑。

## 1. 这一轮补上了什么

以前游戏内的演奏是：
`数据包 → 红石触发音符盒 / hifi 时 /playsound nbforge:* → 资源包（Ogg）`——
**必须装着资源包**，而且必然有损（实测 09:22 有一次重载没带上资源包，客户端直接刷 54 条
`Unable to play unknown soundEvent: nbforge:*`，那段时间机器是哑的）。

现在是：
`服务端读 score.csv → 每个 tick 按时间派发 nbforge:play → 客户端无损引擎（WAV 母版）`
——**不吃资源包、不做 Ogg 编码、与离线渲染共用同一套"力度→采样层+增益"映射**。

## 2. 新增的模块

| 模块 | 文件 | 职责 |
|---|---|---|
| 谱面解析 | `mod/.../score/NbforgeScore.java` | 读 `time_seconds,instrument,midi,velocity,voice`；按表头取列、坏行计数跳过、按时间排序 |
| 播放器 | `mod/.../score/NbforgeScorePlayer.java` | 服务端 tick 派发：**按墙上时间**（nanosecond 起点 + 30ms 预看），不依赖 tick rate；锚点 = `/nbforge score play` 时执行者的坐标（玩家走动时声场不跟着跑） |
| 命令 | `NbforgeCommands` | `/nbforge score load [路径]` / `play` / `stop` / `status` |
| 导出 | `tools/export-mod-score.mjs` | `machine_pipeline.csv` → `score.csv`（声部→乐器 id；力度优先 `velMidi`，否则 `volume×127`），`--deploy` 落到客户端与测试服 |
| 自检 | `NbforgeSelfTest` | 解析 + "到点计数"抽查 + **真跑一次播放器**（无玩家时只计数不发送） |

## 3. 实测证据（副本服自检，09:38）

```
[nbforge][selftest] /nbforge 命令节点存在=true 子命令=info,note,sustain,stopall,play,score
[nbforge] 谱面已加载：2915 颗音 / 总时长 278.4s（跳过 0 行）← nbforge\score.csv
[nbforge][selftest] 谱面直读：2915 颗音 / 278.4s / 跳过 0 行；声部 {bass=1276, harp=1639}
[nbforge][selftest] 到点计数：t=0 → 4，t=60s → 515，末尾 → 2915（应等于 2915）
[nbforge][selftest] 谱面自检 通过
[nbforge][selftest] 已启动谱面播放器（自检用，t=120 停）
[nbforge][selftest] 谱面播放器 t=40（约 2.0s）：到点 13 颗 / 已发 0 条 / 收件人 0
                    （无玩家时只计数不发送；谱面前 2.0s 应为 13 颗）   ← 13 = 13，时间轴对得上
[nbforge][selftest] 结束：累计击发=36 峰值并发作业=3 残留作业=0
[nbforge][selftest] === 自检通过，停服 ===
```

## 4. 口径与限制（如实声明）

- **声部→乐器**：旋律(harp 1639)与贝斯(bass 1276)都先用 `salamander48` 弹；
  **打击乐 138 颗默认跳过**（VSCO 的鼓还没导进乐器库）——用 `--perc <id>` 可以改。
- **力度**：导出时优先用谱面的 `velMidi`（乐句级/段落解读口径），没有就退回 `volume×127`
  （= 现在游戏里那版恒定 0.35）。也就是说：**你选哪种力度口径，直读播放就跟着变**。
- **锚点固定**：声音在开始播放的坐标上；玩家走远了只是变轻/偏声像（`rolloff` 现在设 0，
  等于不随距离衰减，与离线渲染的"整片都听得到"一致）。
- **没有玩家时不发送**（专用服务器上只跑调度）；有玩家时每个音符对每个玩家发一次。
- **可视化/机器**：这条链路只负责"出声"，红石机器与粒子还是数据包那套——mod 里把两者
  合一（机器触发 → 无损出声）是下一步。

## 5. 下一步

1. **客户端试听验收**：`/nbforge score load` → `/nbforge score play`（见 §6）；
2. 把 VSCO 的竖琴/低音提琴/鼓导进 `instruments.json`，四个声部全换真采样；
3. 机器与引擎合一：机器（红石/方块）触发时直接派发 `nbforge:play`（替掉资源包那条）；
4. 延音/断奏（`sta` 采样 + 时值门控）、多声道、游戏内无损录制。

## 6. 用户测试清单（游戏内）

```
1) /nbforge score load
   期望：谱面已加载：2915 颗音 / 278.4s（跳过 0 行）+ 声部分布 + 来源路径

2) /nbforge score play
   期望：开头的旋律立刻用**无损钢琴**响起来（不走资源包），持续约 4 分 38 秒

3) /nbforge score status         （播放中随时可看）
   期望：进度颗数 / 到点 / 发送 / 收件人=1 / 播放中=true

4) /nbforge score stop
   期望：立即停；回显"到点 X 颗 / 发送 Y 条"
```

> 提示：这条链路**不需要资源包**——把资源包关掉再听一次，能听到声音就说明它彻底独立了。
