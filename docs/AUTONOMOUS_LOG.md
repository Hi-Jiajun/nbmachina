# 无人值守开发日志（心跳任务 `nbforge`，每 30 分钟一轮）

> 用户醒来看这一个文件即可。每轮追加一行，末尾维护摘要。

## 醒来先看这里（滚动摘要）

1. **线程已迁移**：旧线程 `01a09a43` 会话历史过大，每轮请求都报 `missing field call_id`（04:08 起连续 6 轮心跳全失败），2026-09-14 14:2x 起改在本线程 `01a09e89` 继续。**心跳已按用户要求撤销（用户手动删除，14:29 确认应用里已不存在）——项目改为交互式推进，不再无人值守自转。**
2. 机器状态：数据包已按**新口径**重装（`pack_structures=196`，3053 音含打击乐）。游戏内先 `/function styx:redo` 换上新谱面，`/function styx:undo` 回退，`/function styx:play/doctor` 自检；精确模式要玩家先敲 `/tick rate 100`。
3. 已完成：M0 全部、M1 六项、M2-1 自研音色、M2-2 通用化、**M2-3 路径收口收尾 + 谱面口径统一**（19/19 步逐字节 A/B 一致；e2e 20 tps 与 100 tps 全绿）、**M3-1 内声部/和声层**（默认 off，16 条单测 + 真实数据）、**M3-2 hifi 认显式声部标签**（两套口径分歧 208 音/150 step，默认路径仍 19/19 逐字节）。
4. 进行中：后端 A Fabric mod 预研（子代理 `nbforge_mod_spike`，已确认 1.21.10 有 loader/API 且本机起过 Fabric 服务端，正在搭编译骨架）。产物按文件到达，不要相信 UI 状态。
5. 需要用户做的事：① ~~复制资源包~~ **已完成**（14:29 一次 UAC 授权后 `resourcepacks\nbforge_resources.zip` 就位，sha256 `C5BED281…05ED8C0`，实例目录已授 Modify 权限）——现在只差**在游戏里"选项→资源包"启用它**；② ~~装 mod~~ **已完成**（15:0x `nbforge-0.1.0.jar` 复制进实例 `mods/`；客户端本来就有 Fabric API；想撤就删这一个文件）；③ 游戏内三项试听：`/function styx:play/monitor_hifi_on` + `/function styx:play/start`（自研音色 A/B）、`/nbforge info|note|sustain|stopall`（后端 A 通路）、`/function styx:redo` 后听打击乐与新力度；④ 决定内声部是否默认开（`arrange-all --inner on`）与用哪个音色（bell/pad/strings）。

## 日志

- 2026-09-14 04:1x · 建立本日志；心跳任务调整为 30 分钟一轮，规则：按产物判断子代理、验收后才装包、同问题两轮无进展就换线、禁止不可逆操作。
- 2026-09-14 14:2x · **接手（新线程）**：定位旧线程故障（`missing field call_id`，请求体 ~5MB，非图片限制而是会话历史过大）；心跳迁到本线程。**M2-3 收尾**：20 个脚本接入 `paths.mjs`（含存档/测试服/java 三个外部路径，新增 `resolveExternal`），新增 9 条路径测试（含"除 paths.mjs 外不许再有历史绝对路径"的字面量审计）→ 单测 226/226。**抓修真实缺陷**：数据包装的是 v3 谱面（279 音）而非 machine_pipeline（295 音），差 16 音；统一口径（`machineScore` 槽位 + 四处默认值）+ 新增"数据包与谱面同源"护栏；A/B 19/19 步逐字节一致（含 727 文件 `play/`）；e2e lo 295/295（MSPT 7.3ms）、hi 28/28（MSPT 6.7ms）、0 加载错误；已装包 `pack_structures=196`。证据 `docs/M2-3-report.md`、`_scratch-m2-3/ab/ab-result.json`。
- 2026-09-14 14:3x · **M3-1 内声部/和声层验收通过**（子代理交付）：默认 `--inner off` 19/19 步逐字节；`--inner on` 拆出旋律 1385 + 内声部 354；**设计文档"内声部 0–11"被实测否掉**（八度命中率 band 0.244 vs keep 0.943）→ 默认 keep。全量 242/242。证据 `docs/M3-1-inner-voice-report.md`。
- 2026-09-14 15:0x · **M3-2 hifi 认显式声部标签**（根代理）：`planHifi` 标签优先（`instrument=inner`/`voiceRole=inner`），修复"inner 被当未知乐器退成 strings"；内声部计数拆 `innerExplicit`/`innerHeuristic`；新增 10 条测试，含真实数据"两套口径分歧 208 颗音 / 150 step"；默认路径 A/B **19/19 逐字节**；`--inner on` 全链路（arrange→note-blocks→playback→hifi→lint）通过，230 颗内声部全按标签渲染；全量 **252/252**。证据 `docs/M3-2-hifi-inner.md`。
- 2026-09-14 15:0x · **流程教训**：`tests/synth.test.mjs` 的 bell 频谱断言偶发失败两次（报出的 1012.7Hz 落在其请求区间 [1100,1276] 之外，当前源码数学上不可能）；仪器化探针 96 进程 × 8 迭代复现 0 次；两次都发生在与子代理同时写仓库/抢资源时 → 归因**并发写文件**，已给该断言加自诊断信息。**规则：验收套件不要在子代理正在写仓库时跑**（与 ab-verify 的"硬链接把输入写穿"同源）。
- 2026-09-14 15:0x · **后端 A 预研通过（子代理交付，已复核）**：Fabric 1.21.10 可做；launcher 的 `java-runtime-delta` 就是完整 JDK 21.0.7（不用另下）；命中 loader 0.19.5 / yarn 1.21.10+build.3 / API 0.138.4+1.21.10 / Loom 1.17.20；`mod/build/libs/nbforge-0.1.0.jar`（15409 B，无 mixin、只有 main 入口）在**真 Fabric 服务端副本**上加载并自检：4 个音色事件命中、命令树 `info,note,sustain,stopall`、累计击发 36 次/峰值并发 3/残留 0。两个坑留证：Gradle 9.1.0 太老（要 9.5.1）、`libraries.minecraft.net` TLS 被中断（加 `mod/gradle-mirror.init.gradle` 镜像）。报告 `docs/M3-mod-spike-report.md`。**根代理已把 jar 装进客户端实例 `mods/`**（向后端 A 试听闭环推进）。缺口：客户端"耳朵听见"未验证；延音是重触发+包络不是循环采样。
- 2026-09-14 15:00 · **客户端实测暴露的两处缺陷已修**（用户 14:45 截图；报告 `docs/M3-3-packmod-fix.md`）：① 资源包被判"已损坏或不兼容"——`pack.mcmeta` 缺 `min_format/max_format`（1.21.9+ 规定 >64 的格式号必须成对声明），改为三件套 69；② `/nbforge note nbforge:demo_bell 1 1` 语法报错——`<音色id>` 用了"带引号字符串"参数类型，换成 `IdentifierArgumentType`（与 vanilla `/playsound` 同款）+ 裸名回退 `nbforge` 命名空间；③ 顺带修 mod 自带 `sounds.json` 缺命名空间导致的静音。**教训：自检当初只用裸名 `demo_bell`（恰好能过），盖住了玩家实际写法（带命名空间）的缺陷——自检必须用用户实际写法。** 副本服解析矩阵 4/4、命令链 6 条执行成功、击发 36/并发 3/残留 0；全量单测 252/252；新 jar 16428 B 与新资源包 2193271 B 已同步到客户端。待用户重启游戏 + `F3+T` 后确认资源包变绿与听感。
