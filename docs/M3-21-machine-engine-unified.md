# M3-21 · 机器与引擎合一：音符盒触发 → 无损引擎发声（2026-09-16）

用户："继续吧"。这一轮把最后一块拼上：**红石触发音符盒的那一刻，声音由 mod 的无损引擎发出**
（替掉"数据包 /playsound + 资源包 Ogg"那条链路），机器照常运转、粒子照旧由方块生成。

## 1. 关键突破：mixin 路线打通（2026-09-14 曾卡在 refmap）

| 事实 | 证据 |
|---|---|
| mixin 现在**真的生效** | 副本服自检：真放一个音符盒 + 红石块触发 → `[nbforge] 音符盒触发 #1 pos=0, 100, 0 乐器=HARP note=0 → salamander48 midi=42 vel=100`；自检打印 `事件 1 次 → 注入生效` |
| 注入点选择有实证依据 | `javap` 显示 `NoteBlock.playNote` 是 **if/else**：客户端分支只 `World.addParticleClient`（粒子），服务端分支才 `World.playSound`（声音）→ 服务端方法头接管**只掐声音、不动粒子** |
| `@Redirect` 为什么不行 | 无 refmap 时 target **描述符字符串**不会被 remap → `InjectionError: ... Scanned 0 target(s). No refMap loaded.`（实测崩服）→ 改用**方法名注入**（方法名注入不受影响） |
| 自检自身的坑 | 上一轮已在同坐标放过方块，重复 `setBlockState` 同样方块**不产生方块更新** → 音符盒不再触发（首轮误判"注入失效"）；自检已改成先清空再放 |

## 2. 力度从哪来：位置 → 谱面音符映射

方块本身只有"乐器 + 音高"，**没有力度**；力度只存在于谱面里。所以新增导出：

```
node tools/export-mod-machine-map.mjs --deploy
  → nbforge/machine_map.csv：x,y,z,instrument,voice,midi,velocity（**2915 个音符盒位置**）
```

坐标规则与数据包**同源**（`src/emit/layout-pos.mjs` 的 `makePos(profile)`，摆块与播放共用），
所以 mod 在方块响的那一瞬间就能查到"这是谱面第几颗音、该用多大力"。

## 3. 数据包改成"永远触发音符盒"

旧行为：`#hifi=1` 时**不触发**音符盒、改由数据包播 `/playsound`（会与 mod 双响）。
新行为（`datapack-playback.mjs`）：

- **装了 mod** → 原版声音被 mixin 掐掉，改播无损采样（力度取谱面真实力度）；
- **没装 mod** → 就是原版音符盒声音（可用的降级路径）。

已重生成并装包：`pack_structures=196`；`play/lo|hi/bNNN.mcfunction` 里的触发行不再带 `unless #hifi` 守卫。

## 4. 现在能听到的完整链路

```
红石机器（数据包逐刻触发）
   → 音符盒 onSyncedBlockEvent（服务端）
      → mixin 拦截 → 查 machine_map.csv（位置 → 谱面音符：乐器/声部/midi/力度）
         → 发 nbforge:play 给附近玩家
            → 客户端无损引擎（48k/24bit 母版 + 力度层 + 放音规则）
   同时：客户端自己生成音符粒子（原版行为，未受影响）
```

## 5. 验收清单（游戏内）

```
1) 重启游戏（mod 换了 jar + 数据包装了新版本）
2) /nbforge info
   期望：音符盒接管（mixin）：事件 0 / 已派发 0 / 跳过 0；机器映射 2915 个位置
        声部→乐器：旋律=salamander48 低音=salamander48 打击乐=null
3) /function styx:play/monitor_hifi_off     ← 关掉旧的 playsound 监听，避免双响
4) /function styx:play/start                ← 机器开始演奏
   期望：音符盒照常亮灯/出粒子，但声音是**无损钢琴**；不再有资源包 Ogg 味
5) /nbforge info
   期望：事件 / 已派发 持续增长（≈ 已播音符数），跳过 0
```

> 不需要资源包（可以关掉它再听一次）；`/nbforge score play` 那条"直读播放"仍然可用，
> 两条路径互不干扰（`stopall` / `score stop` 分别停）。

## 6. 2026-09-18 实测补正：音符盒本体在本题材里**发不出声**

用户按 §5 测了两轮：`事件 0`、机器 `#hits` 在涨但没声音。逐层查下来：

1. **存档读取（自写 region 解析）**：机器布局完全正确 ——
   `(480,83)=redstone_lamp / (480,84)=oak_planks（甲板）/ (480,85)=note_block[bass,note=9] / (480,86)=air`；
2. **数据包派发**：`#t=506 / #hits=210`，说明播放函数在跑、音符在派发；
3. **javap 找真因**：`NoteBlock.playNote` 开头有一条硬检查 —
   `if (!INSTRUMENT.isNotBaseBlock() && !world.getBlockState(pos.up()).isAir()) return;`
   **harp/bass 都是"基座类"乐器 → 音符盒上方必须是空气**，而旧触发位正好在音符盒正上方（`y+2`）
   → 放红石块的那一刻就被这条检查拦掉 → **机器从来没响过**（历史上听到的"原版声音"其实是
   监听模式 `#mon=1` 在玩家脚下放的 `/playsound`）；
4. **改触发位重测**：把触发挪到甲板下方（`y-1`，红石块给甲板充能）→ 副本服自检实测**仍然不响**
   → "隔一层间接充能"这条路在 1.21.10 不成立。

结论：**这个密集单排布局（每个音符一格、行距 1 格）没有可用的"相邻充能位"**——
上方是唯一空位，但被"上方必须空气"的规则禁掉；侧面/下方都被相邻音符占着或充不上。

## 7. M3-21c：改走"自研演奏器"（SPEC 允许的主路径）

```
数据包播放函数（每音一行）
   run nbforge playat <x> <y> <z>     ← mod 按 machine_map.csv 查"位置→谱面音符"
   run particle minecraft:note …      ← 音符粒子（音符盒自己出不了，由数据包补）
   run setblock <x> <y-1> <z> redstone_lamp[lit=true]   ← 灯闪
        ↓
   mod：发给附近玩家 → 客户端无损引擎（48k/24bit + 力度层 + 放音规则）
```

好处：**音频与机器同 tick**（不再有时钟漂移），机器照常运行（灯/粒子），且完全不依赖资源包。
另外加了 `/nbforge listen on|off`：`on` = 声音锚在玩家身上（站哪儿都能听全曲，牺牲方位感）；
默认 `off` = 按方块物理位置发声（需要站在音轨附近，机器长 2880 格）。

**如果将来要"音符盒本体出声"**：需要把布局改成留出侧向充能位（行距或列距加 1，机器重建）——
这是一次大改，等用户明确要的时候再做。
