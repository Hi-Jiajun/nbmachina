# M3-30 · 运行时音色切换（换琴不用改数据）

> 用户原话："这多个钢琴音色也可以加进 mod 里做钢琴音色选择"。之前换琴要重新导出
> `machine_map.csv` / `score.csv`（数据侧），或者在配置里改；现在**游戏内一条命令即时切换**。

## 做法：客户端侧"声部 → 乐器"覆盖表

谱面里每颗音自带"用哪个乐器"（`machine_map.csv` 的 instrument 列 / `score.csv` 的 instrument 列），
客户端在解析采样前先过一层覆盖表：

```
声部覆盖（如 bass → disklavier） → `*` 全局覆盖 → 谱面原值
```

* 覆盖表落盘 `config/nbforge/voices.json`（重启仍在）；`/nbfc reload` 也会重读。
* 覆盖到的乐器**必须已在本机乐器库里**，否则忽略覆盖（宁可照谱面播，也不静音）。
* 覆盖只影响"用哪套采样"，不影响音高/力度/时值 —— 那些仍在谱面/引擎里。

## 命令

```
/nbfc instrument                     列出当前映射 + 可选乐器
/nbfc instrument <乐器>              全部声部切到该乐器（最常用）
/nbfc instrument <声部> <乐器>       只切某个声部（声部名见谱面：harp / bass / basedrum / hat）
/nbfc instrument reset               全部恢复谱面原值
/nbfc instrument reset <声部>        只恢复某个声部
```

`/nbfc status` 里会多一行 `音色映射（声部→乐器，`*`=全部）`，随时能看到当前设置。

## 当前乐器库（7 件，全部可商用）

| id | 内容 | 许可 |
|---|---|---|
| `salamander48` | Salamander Grand Piano V3 48k/24bit（按音高分档高通版） | CC-BY 3.0 |
| `disklavier` | Yamaha Disklavier Pro（OLPC 完整合集 835 区域） | CC-BY 3.0 |
| `vsco_upright` | VSCO 2 CE Upright Piano | CC0 |
| `disklavier_sf2` | Yamaha Disklavier Pro（SF2 子集，默认不用） | CC-BY 3.0 |
| `vsco_harp` / `vsco_contrabass_pizz` / `vsco_perc` | VSCO 2 CE 竖琴 / 低音提琴拨弦 / 打击乐 | CC0 |

离线对照：`render-ensemble.mjs --melody <id>`（换琴渲染），例如
`--melody disklavier` 就能先在电脑上听同一份谱面换琴的效果，和游戏内的切换口径一致。

## 验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 编译 | `build-mod.ps1` | `BUILD SUCCESSFUL`，jar **81687 B** |
| 副本服自检 | `java -Dnbforge.selftest=true` | `自检通过` |

**只能真机验证的**：换琴后的听感与"是否真的换了采样"——命令会直接回显映射，`/nbfc status` 里也能看到；
切换即时生效（下一颗音就用新乐器）。

## 用法示例

```
1) /nbfc instrument                    看清单
2) /nbfc instrument disklavier         全部换成 Yamaha Disklavier
3) /nbfc instrument bass salamander48  只把左手换回 Salamander
4) /nbfc instrument reset              恢复谱面原值（salamander48）
```
