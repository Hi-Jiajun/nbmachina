# M3-3 · 两类"装好却用不了"的实测修复（资源包被拒 + 命令语法错）

触发：用户 2026-09-14 14:45 在客户端实测，贴了两张截图——
①「选项→资源包」里 nbforge 显示 **不兼容（已损坏或不兼容）**；
② `/nbforge note nbforge:demo_bell 1 1` 报**参数后应有空格分隔，但发现了紧邻的数据**。

两条都在客户端日志里拿到了原文根因，**都不是用户的操作问题**：

| # | 症状 | 根因（证据） | 修复 |
|---|---|---|---|
| ① | 资源包被判"已损坏或不兼容" | `pack.mcmeta` 只声明了 `pack_format: 69`。1.21.9+ 规定：**声明 >64 的格式号必须同时给 `min_format`/`max_format`** —— 客户端日志：`Pack declares support for version newer than 64, but is missing mandatory fields min_format and max_format` | 生成器改为三件套 `pack_format/min_format/max_format = 69`（vanilla 内置包也只写 min/max 成对，见下） |
| ② | `/nbforge note nbforge:demo_bell 1 1` 语法报错 | 命令树的 `<音色id>` 参数用了 `StringArgumentType.string()`（**带引号的字符串**）。裸写冒号在 Brigadier 里过不去：`Expected whitespace to end one argument, but found trailing data` | 换成 `IdentifierArgumentType`（与 vanilla `/playsound` 同一套参数类型），并让裸名 `demo_bell` 兜回 `nbforge` 命名空间 |
| ③ | （日志顺手发现）mod 的四个演示音色**会静音** | mod 自带 `sounds.json` 里写的是 `bell/a3`（无命名空间 → 被当 `minecraft:bell/a3`）——客户端日志：`File minecraft:sounds/bell/a3.ogg does not exist, cannot add it to event nbforge:demo_bell` | 四个 name 全部改成 `nbforge:bell/a3` 这类**带命名空间**写法 |

---

## 1. ② 为什么"自检通过"却仍然不能用（最值得记的一条）

预研阶段的自检命令链用的是**裸名**写法：

```java
execute(server, "nbforge note demo_bell 1.0 1.0");   // ← 恰好能过
```

而玩家在游戏里敲的是**带命名空间**的写法：`nbforge:demo_bell`。两种写法在旧参数类型下
一个能过一个不过——**自检覆盖的不是用户实际用法**，于是绿灯把缺陷盖住了。

修完之后：自检里加了一个"命令**解析**矩阵"，把用户会敲的四种写法钉死，并在命令链里改成
带命名空间的写法（与玩家一致）：

```
解析通过 期望=ok 实际=ok /nbforge note nbforge:demo_bell 1 1      ← 玩家踩坑的那条
解析通过 期望=ok 实际=ok /nbforge note demo_bell 1 1              ← 裸名兼容
解析通过 期望=ok 实际=ok /nbforge note minecraft:block.note_block.harp 1 1  ← 原版音效直用
解析通过 期望=ok 实际=ok /nbforge sustain nbforge:demo_pad 0.8 1 60 10
解析矩阵：4 条，不符 0 条
```

> 口径提醒：矩阵只做**解析**（`dispatcher.parse`）。实测它连"音量 99"这种越界也不抛
> （范围校验在 `parseAndExecute` 那一步），所以矩阵里不放"越界应当失败"的用例——
> 那种用例要用执行链来验。

---

## 2. ① 的证据链（为什么是 min/max，不是把 69 改小）

1. 客户端 `1.21.10-Fabric 0.19.5.json` 对应的 `version.json`（从客户端 jar 里取出）：
   `pack_version = {"resource_major":69,"resource_minor":0,"data_major":88,"data_minor":0}`
   → 69 就是 1.21.10 的资源格式号，**不该改小**。
2. vanilla 自己怎么写的？客户端 jar 里 `data/minecraft/datapacks/redstone_experiments/pack.mcmeta`：
   ```json
   {"features":{"enabled":["minecraft:redstone_experiments"]},
    "pack":{"description":{"translate":"..."},"max_format":88,"min_format":88}}
   ```
   `88` 正是它的 `data_major`，而且**只写 min/max**。→ 新校验要的就是这对字段。
3. 我们的包同时保留 `pack_format`（照顾老读取器），三者取值一致（69），不会互相矛盾。

产物：

```json
{"pack":{"pack_format":69,"min_format":69,"max_format":69,"description":"nbforge 自研音色（零第三方采样：…）"}}
```

单测 `tests/synth.test.mjs` 里加了断言：`min_format`/`max_format` 必须等于 `PACK_FORMAT`，
并把这个客户端错误的原文写进注释，防止以后被"简化"掉。

---

## 3. 验收

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| 副本服自检（真 Fabric 1.21.10） | 命令解析矩阵全绿 + 命令链可执行 | 矩阵 **4 条 / 不符 0 条**；命令链 6 条执行成功（`note nbforge:demo_bell`、`nbforge:strings_a3`、三条并发延音…），累计击发 36 / 峰值并发 3 / 残留 0 / 干净停服 | 通过 |
| 全量单测 | 全绿 | **252 / 252**（新增 pack.mcmeta 三件套断言） | 通过 |
| 产物同步 | 客户端真的拿到新东西 | 客户端 `mods/nbforge-0.1.0.jar` = 16428 B（15:01 复制）、`resourcepacks/nbforge_resources.zip` = 2193271 B（含新 pack.mcmeta） | 通过 |
| 客户端加载 | 资源包不再被判不兼容 | **未验证**：需要你在游戏里重载资源包（`F3+T` 或重开资源包界面）后看它是否变绿 | 待你确认 |
| 耳朵听见 | 自研音色可听 | **未验证**：需要你的耳朵（这条从 M2-1 挂到现在） | 待你确认 |

复现：

```powershell
cd C:\Users\hiliang\Documents\minecraft\nbforge\mod
$env:JAVA_HOME = "C:\Users\hiliang\AppData\Roaming\.minecraft\runtime\java-runtime-delta"
.\gradlew.bat build --no-daemon --init-script gradle-mirror.init.gradle   # → BUILD SUCCESSFUL
# 自检（副本服，端口 25599，读 mods/ 里的 jar）
node C:\Users\hiliang\Documents\minecraft\_scratch-m3-2\spike-selftest.mjs
```

---

## 4. 踩坑记录（给下一次省时间）

1. **改完 jar 要确认 spike 服起来的是新 jar**：第一次复跑自检时旧 JVM 还持有 `mods/nbforge-0.1.0.jar`，
   复制被静默跳过，日志里还是旧矩阵（6 条 / 不符 2 条）——判据看 `jar 时间戳 + class 里有没有新字符串`。
2. **`dispatcher.parse()` 不校验取值范围**（见 §1 口径提醒），别用它当"参数合法性"的断言。
3. **mod 自带 `sounds.json` 的 name 要写全命名空间**，否则默认落到 `minecraft:`，客户端只会给一行
   `File ... does not exist` 的 warning，表现形式是"装了 mod 但没声音"。

## 5. 下一步

1. 你在客户端**重启游戏**（mod jar 已换）→ `F3+T` 重载资源包 → 资源包界面确认 nbforge 变绿。
2. 再敲 `/nbforge note nbforge:demo_bell 1 1`（**不用引号**）与 `/nbforge sustain nbforge:demo_pad 0.8 1 60 10`。
3. 听到声音后回到 §M3-2 的听感判定：内声部是否默认开、用哪个音色、打击乐与力度是否更像原曲。
