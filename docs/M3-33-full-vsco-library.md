# M3-33 · 把"所有可商用无损乐器"装进 mod（VSCO 2 CE 全集）

> 用户原话："同时你可以把所有乐器的无损采样可商用的都可以装进我们的mod使用，
> 后期创作各类歌曲就不存在音色音源的瓶颈了。" 之前只接了 3 件 VSCO（竖琴/低音提琴拨弦/打击乐），
> 磁盘上的 **VSCO 2 CE 全集有 75 个 SFZ / 3168 个 wav / 3.02GB（CC0 1.0）**——这一轮全部接进来。

## 结果：乐器库 7 → **70 件**（3724 个区域，1.04MB JSON）

| 组 | 件数 | 内容 |
|---|---|---|
| Strings | 26 | 小提琴/中提琴/大提琴/低音提琴**声部组**（sus / vib / pizz / spic / trem / quiet）+ 独奏小提琴 |
| Woodwinds | 14 | 长笛 / 双簧管 / 单簧管 / 巴松 / 短笛（sus / vib / stac） |
| Brass | 13 | 小号 / 圆号 / 长号 / 大号（sus / stac / vib / 弱音器） |
| Percussion | 6 | 定音鼓 / 定音鼓滚奏 / 钟琴 / 马林巴 / 木琴 / 管钟 |
| Keys | 4 | 管风琴（响/轻 × 踏板两档）+ VSCO Upright Nr.1 |
| 其他 | 7 | 4 件钢琴（Salamander 高通版 / Disklavier OLPC / SF2 子集 / VSCO Upright）+ 竖琴 + 低音提琴拨弦 + 打击乐 |

## 实现

`tools/export-mod-instruments.mjs` 自动扫描 VSCO 目录里的 75 个 SFZ 生成条目（已在清单里的 4 件跳过），
名称带组别；采样路径全部校验存在（**3724 个路径，缺失 0**）。
mod 侧不需要改代码——乐器库本来就是数据驱动的（`config/nbforge/instruments.json`）。

被跳过的 8 件是 `*-KS.sfz`（keyswitch 合集补丁）：它们引用了本机没有的交叉目录采样
（如 `Strings/Cello Section/pizzT/...`），而不带 KS 的同款**单独 articulation 全都在**（sus/pizz/spic/trem…），
所以没有内容损失，只是少了一层"一键切换奏法"的壳。

## 怎么用（游戏内）

```
/nbfc instruments              ← 分组统计（70 件）
/nbfc instruments violin       ← 按关键字看 id
/nbfc instrument set <声部> <id>   ← 声部名用谱面里的：harp（旋律/内声部）/ bass（左手）/ basedrum / hat；写 all = 全部
/nbfc note <id> 60 100         ← 单独试听一件乐器
```

想给"新曲子"配器：谱面里 `instrument` 列的声部名（harp/bass/…）→ 用 `/nbfc instrument set` 映射到
这 70 件里的任意一件即可（例如 harp → `vsco_violinenssusvib`、bass → `vsco_contrabass_ks` 之外的那几档）。

## 验证

| 项目 | 命令 | 结果 |
|---|---|---|
| 导出 | `node tools/export-mod-instruments.mjs --deploy` | **70 件 / 3724 区域 / 1.04MB**；3724 个采样路径缺失 0 |
| 编译 | `build-mod.ps1` | `BUILD SUCCESSFUL`，jar **83935 B**（已部署客户端+副本服） |
| 副本服自检 | `java -Dnbforge.selftest=true` | `自检通过` |

**只能真机验证的**：70 件在游戏内加载（`/nbfc instruments` 的分组统计）与试听。
