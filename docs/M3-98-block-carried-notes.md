# M3-98 · 让机器自带音符数据（方块/方块实体承载，替代运行时 CSV）

参考项目：[atemukesu/extendednoteblock](https://github.com/atemukesu/extendednoteblock)（MIT，已归档）。
它把 MIDI 0-127 / 力度 / 时值 / 淡出**放在方块自己的数据里**，而不是外部表；编辑、复制、搬运都跟着方块走。
我们照这个**思路**改，不复制其代码（NOTICE.md 的口径不变）。

## 为什么要改（我们今晚踩的坑全在这一类）

运行时依赖 `machine_map.csv` / `score.csv`，于是"世界里的方块"和"表里的数据"是两个真值，必然出现：

- 谱面 CSV 换代（3053 vs 3044）→ 表与方块不同源；
- 坐标语义错位（甲板 y 与音符 y+1、触发列 tx/ty/tz）→ 重合度 0；
- 换原点/换存档 → 必须重新导出+部署两份 CSV，漏一步就错。

方块自带数据后：**机器就是数据的唯一真值**，`/clone`、结构文件、存档迁移都自动带上；CSV 降级为**导入/导出用的中间产物**。

## 数据放哪：给 `minecraft:note_block` 注册我们自己的方块实体

原版音符盒没有 BE，但 Fabric 侧可以注册一个**挂在 note_block 上的 `BlockEntityType`**：

```java
BlockEntityType<NoteDataBlockEntity> TYPE =
    BlockEntityType.Builder.create(NoteDataBlockEntity::new, Blocks.NOTE_BLOCK).build();
```

之后 `setBlockState` 放下的音符盒就会带 BE（因为 BE 类型里声明了 note_block），`/clone`、结构方块、存档都会带上它的 NBT。

### NBT 结构（尽量小，只放引擎需要的）

```
nbm: {
  instrument: "salamander48",   // 或声部层 id（沿用 NbmachinaInstruments 的解析）
  voice: "harp",                // 保留，兼容现有多声部
  midi: 75,                     // 0..127
  velocity: 62,                 // 1..127
  dur_ms: 4009,                 // 制音器/时值；0 = 自然衰减
  time_sec: 3.917               // 可选：谱面绝对时刻（自描述用，机器搬到别处也认）
}
```

**时序本身已经由几何编码**（这是我们现有布局的既有性质，不用改）：
`step = 段号*48 + (x − 段起点x)`、`pitch 行 = y`、`voice = z`；
`time = step * STEP_SECONDS`（`src/emit/layout-pos.mjs` 里那套 4 层规则的 y 层，mod 侧 `notePos = y+1`）。
所以只要 BE 里有 `instrument/voice/midi/velocity/dur_ms`，加上 x 就能还原整张播放表。

## 运行时怎么用

| 环节 | 现在 | 改后 |
|---|---|---|
| 服务器起播 | 读 `machine_map.csv`（位置→音符） | **扫机器包围盒里的音符盒 BE**（按段/行/列还原 step 与音高），自建播放表；`/nbm machine rescan` 可重建 |
| 派发 | `addSyncedBlockEvent(notePos, NOTE_BLOCK, 0, note)` | 不变（音符盒仍是发声体，客户端照旧按谱面时刻精确发声） |
| 客户端取音色/力度/时值 | 读客户端 `machine_map.csv` | **读同位置方块 BE**（块已加载）；载荷只保留"这颗音的谱面时刻"用于 1ms 对齐 |
| 数据包摆放 | `setblock … note_block` | 之后追加 `data merge block x y z {nbm:{…}}`（`note-blocks.mjs` 生成） |
| CSV | 运行时唯一真值 | **导入/导出**：`export-mod-machine-map.mjs` 从世界导出，`apply_notes` 把 CSV 写进世界 |

兼容策略：mod 侧"**有 BE 就读 BE，没有就回落 CSV**" → 旧存档/旧数据包不用一次性迁移。

## 分三步落地（每步都有可量化的验收）

**M3-98a · BE + NBT 写入**
- 注册 BE 类型 + NBT 序列化；`note-blocks.mjs` 生成 `data merge block` 行；新增 `/nbm notes get|set` 便于手查手改。
- 验收：数据包装进存档后 `/data get block 0 111 -6` 能读出 `nbm:{midi:75,…}`；重进存档仍在；`/clone` 到别处后 NBT 跟着走。

**M3-98b · 运行时改读 BE**
- 服务器扫描建表（含 `/nbm machine rescan`）；客户端按位置读 BE；保留 CSV 回落。
- 验收：把 `machine_map.csv` / `score.csv` **改名藏起来**，`/nbm machine start` 仍能完整播放 3044 颗音；逐音对账（`tools/audit-strict.mjs`）结果与藏起来之前一致。

**M3-98c · CSV 降级为导入/导出**
- `/nbm machine export` 从世界导出 CSV；与现有 `machine_map.csv` 做**往返对比**。
- 验收：往返对比 **3044/3044 行逐字段相同**（这是硬指标，直接复用今晚那套对账脚本）。

## 风险与代价（先摊开）

- **需要服务端+客户端都装 mod**（现在就是这条约定）；原版客户端只会看到普通音符盒，忽略 NBT。
- BE 只在**写了数据**的音符盒上创建，3044 个小 NBT 对存档体积影响可忽略（每个几十字节）。
- `/data merge block` 需要 BE 已存在 → 必须"先放方块、再 merge"（生成器按这个顺序输出）。
- 客户端读 BE 要求该 chunk 已加载 —— 与现在读 CSV 的时机不同：现在是"客户端随时可读文件"，改后依赖区块加载（我们有 forceload/强加载那条链，且机器本来就是围着播放的）。
- 如果以后要做"运行时热改音色"，BE 是更好的落点（改一格就改一颗音，不用重导 CSV）。

## 与其它主线的顺序

不阻塞：HDR 出片、无损音轨导出、6 刻默认值、以及卡顿的设备层测量都可以先跑。
建议排在 **HDR 验收之后**动手，因为 M3-98b 会改"起播时怎么建表"，而 HDR 验收要用当前的稳定基线。
