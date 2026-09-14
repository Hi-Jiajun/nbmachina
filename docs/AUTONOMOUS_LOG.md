# 无人值守开发日志（心跳任务 `nbforge`，每 30 分钟一轮）

> 用户醒来看这一个文件即可。每轮追加一行，末尾维护摘要。

## 醒来先看这里（滚动摘要）

1. **线程已迁移**：旧线程 `01a09a43` 会话历史过大，每轮请求都报 `missing field call_id`（04:08 起连续 6 轮心跳全失败），2026-09-14 14:2x 起改在本线程 `01a09e89` 继续；心跳 `nbforge`（30 分钟一轮）已在新线程重建。
2. 机器状态：数据包已按**新口径**重装（`pack_structures=196`，3053 音含打击乐）。游戏内先 `/function styx:redo` 换上新谱面，`/function styx:undo` 回退，`/function styx:play/doctor` 自检；精确模式要玩家先敲 `/tick rate 100`。
3. 已完成：M0 全部、M1 六项、M2-1 自研音色、M2-2 通用化、**M2-3 路径收口收尾 + 谱面口径统一**（19/19 步逐字节 A/B 一致；e2e 20 tps 与 100 tps 全绿）。
4. 进行中：M3-1 内声部/和声层（子代理 `nbforge_inner_voice`）、后端 A Fabric mod 预研（子代理 `nbforge_mod_spike`）。产物按文件到达，不要相信 UI 状态。
5. 需要用户做的事（攒着一起说）：① **把 `build/nbforge_resources.zip` 复制到 `C:\Program Files\PCL2\.minecraft\versions\1.21.10-Fabric 0.19.5\resourcepacks\` 再在游戏里启用**（这步需要管理员：14:27 实测 Copy-Item 报 Access denied，是本轮唯一需要你动手的机械动作）；② `/function styx:redo` 换新谱面后**试听**（打击乐 + 新力度是这轮新东西）；③ 自研音色 A/B 与延音听感判定；④ 旧线程 `01a09a43` 里那个还挂着的心跳建议手动删掉。

## 日志

- 2026-09-14 04:1x · 建立本日志；心跳任务调整为 30 分钟一轮，规则：按产物判断子代理、验收后才装包、同问题两轮无进展就换线、禁止不可逆操作。
- 2026-09-14 14:2x · **接手（新线程）**：定位旧线程故障（`missing field call_id`，请求体 ~5MB，非图片限制而是会话历史过大）；心跳迁到本线程。**M2-3 收尾**：20 个脚本接入 `paths.mjs`（含存档/测试服/java 三个外部路径，新增 `resolveExternal`），新增 9 条路径测试（含"除 paths.mjs 外不许再有历史绝对路径"的字面量审计）→ 单测 226/226。**抓修真实缺陷**：数据包装的是 v3 谱面（279 音）而非 machine_pipeline（295 音），差 16 音；统一口径（`machineScore` 槽位 + 四处默认值）+ 新增"数据包与谱面同源"护栏；A/B 19/19 步逐字节一致（含 727 文件 `play/`）；e2e lo 295/295（MSPT 7.3ms）、hi 28/28（MSPT 6.7ms）、0 加载错误；已装包 `pack_structures=196`。证据 `docs/M2-3-report.md`、`_scratch-m2-3/ab/ab-result.json`。下一个动作：等两条子代理产物落地后验收（内声部 / mod 预研）。
