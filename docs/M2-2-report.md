# M2-2 实测报告 · 通用化：去掉单曲硬编码（`paths.mjs` + `new-project.mjs`）

任务书：`nbforge-m2-2.md`。仓库：`nbforge`（Node v24.21.0、零依赖、`node:test`）。
基线（改造前）：`fb6abfc`；本轮提交：`b2d9d0e`（paths）→ `be736af`（arrange）→ `dc4bfa8`（emit/analyze/verify）
→ `73ccb52`（new-project）→ `41f63ac`（A/B 工具）→ 本报告。

**一句话结论**：16 个脚本里写死的 build 目录与 `styx_helix_*` 文件名全部收口到 `src/core/paths.mjs`
（`--build <dir>` / `NBFORGE_BUILD` / 默认 `<仓库上层>/build`；`--project <name>` / `NBFORGE_PROJECT` /
`<build>/project.json` 的 `nbforge.project` / 默认历史参考曲 `styx`）。**同一首歌、同一个绝对 build 目录**下
用"改造前代码 vs 改造后代码"跑 14 步全部脚本，**417 个产出文件逐字节一致**（3 个含耗时的 JSON 剥掉时间字段后一致），
验收口径的 `machine_pipeline.csv` sha256 = `6f2dc232…4dee782`，**与现有 `build/` 里那一份也一致**。
`new-project.mjs` 能在**空目录**里建出骨架、打印"下一步该做什么"、退出码 0，且生成的 `project.json` 过 SPEC 校验器。

---

## 0. 交付物

| 文件 | 作用 | 测试 |
|---|---|---|
| `src/core/paths.mjs`（新） | 唯一的路径解析入口：build 目录 + 工程名 → 音频/谱面/机器谱面/数据包目录等全部绝对路径（正斜杠） | `tests/paths.test.mjs`（15 条） |
| `src/core/new-project.mjs`（新） | 建工程骨架（空目录可用、幂等、不覆盖已有文件）＋"工程状态/下一步该做什么" | `tests/new-project.test.mjs`（7 条） |
| `src/arrange/{fold,pitch-fix,velocity,sustain,percussion,dedupe,machine-pipeline,arrange-all}.mjs` | 改成从 `paths.mjs` 取路径；`arrange-all` 额外把 `--build/--project` 透传给子脚本、缺输入时给"下一步"提示（写文件之前就退出） | 既有 175 条单测全绿 + A/B |
| `src/emit/{datapack-playback,note-blocks,undo-clone,redo-chain,lint-pack}.mjs` | 同上；`lint-pack` 支持 `--build`/`--root`，并在**空数据包**（新工程刚建出来）时给"下一步"提示、退出码 0 而不是报"自检失败" | A/B 第 10–14 步 |
| `src/analyze/{chroma,octave-evidence}.mjs`、`src/verify/score.mjs` | 同上 | A/B 第 7–9 步 |
| `tests/paths.test.mjs`、`tests/new-project.test.mjs`（新） | 22 条新单测：解析顺序/默认值逐字符兼容/非法工程名/骨架幂等/新工程缺输入提示 | `node --test "tests/*.test.mjs"` |
| `tools/ab-verify.mjs`（新） | 改造前后逐字节 A/B 工具（本报告 §2.1 的证据来源，可复现） | 见 §2.1 |
| `package.json` | 加一条 `npm run project:new` | — |

用法：

```bash
# 换一首歌：建骨架（空目录可用；不给 --build 就在当前目录下建 <name>/）
node src/core/new-project.mjs --name mySong --build D:/songs/mySong
node src/core/new-project.mjs --build D:/songs/mySong          # 看状态：还缺什么、下一步跑哪条命令

# 之后所有已改造的脚本都能靠 --build 找到正确的文件名（不用再碰代码）
node src/arrange/arrange-all.mjs --build D:/songs/mySong
node src/emit/note-blocks.mjs --build D:/songs/mySong
node src/emit/datapack-playback.mjs --build D:/songs/mySong
node src/emit/lint-pack.mjs --build D:/songs/mySong
node src/verify/score.mjs --build D:/songs/mySong
```

---

## 1. 解析规则（唯一入口 `src/core/paths.mjs`）

优先级从高到低：

| 要解析什么 | 参数 | 环境变量 | 兜底 | 默认 |
|---|---|---|---|---|
| build 目录 | `--build <dir>`（`--build=D` 也认） | `NBFORGE_BUILD` | — | `<仓库上层>/build`（本机 = `C:/Users/hiliang/Documents/minecraft/build`） |
| 工程名 | `--project <name>` | `NBFORGE_PROJECT` | `<build>/project.json` 的 `nbforge.project` | `styx`（历史参考曲） |

工程名 → 文件名前缀（`styx` 是别名，映射到历史前缀 `styx_helix`）：

| 槽位 | 参考曲 `styx`（默认） | 新工程 `<name>` |
|---|---|---|
| 音频 | `<build>/styx_helix_full.wav` | `<build>/<name>_full.wav` |
| 转谱 | `<build>/styx_helix_notes.csv` | `<build>/<name>_notes.csv` |
| v3 谱面 | `<build>/styx_helix_notes_v3.csv` | `<build>/<name>_notes_v3.csv` |
| 机器谱面 | `<build>/styx_helix_machine.csv` | `<build>/<name>_machine.csv` |
| 数据包目录 | `<build>/styx_build/` | `<build>/<name>_build/` |
| 数据包命名空间目录 | `<数据包>/data/styx/` | 同左（**命名空间固定 `styx`**，见 §5.3） |
| 函数/结构/标签目录 | `<数据包>/data/styx/{function,structure}`、`<数据包>/data/minecraft/tags/function` | 同左 |
| 全曲布局档 | `<build>/single_row_profile.json` | 同左（`layout` 还没改造，见 §5.1） |

两条硬约束（不满足就没法谈"逐字节一致"）：

1. **默认值与历史硬编码逐字符相同**：不传任何参数时解析出来的就是过去写死的那串字符串——
   `tests/paths.test.mjs` 里有一条专门的回归断言（`P.audio === 'C:/Users/hiliang/Documents/minecraft/build/styx_helix_full.wav'` 等 9 个槽位）。
2. **路径一律绝对 + 正斜杠**：路径会进产物（报告 JSON 的 `meta.*Path`、`apply_notes_v3.mcfunction` 的注释、
   `manifest.json` 的 `out`），分隔符从 `/` 变 `\` 就不再是逐字节相同。

文件名分两档（有意为之）：

- **带工程前缀**的是"工程身份"文件：音频、转谱、v3、机器谱面、数据包目录。
- **不带前缀**的是中间产物：`notes_fixed_v3.csv`、`pipeline_*.csv`、`machine_pipeline.csv`、`*-report.json`、
  `manifest.json`、`score_report.json`、`single_row_profile.json` …——
  **一个 build 目录 = 一首歌**，所以它们同目录内唯一即可；这也让还没改造的脚本（§5.1）与新版继续兼容。

`project.json` 里的 `nbforge.project` 只是**兜底**（方便 `--build <dir>` 一句话就能定位工程）；
SPEC 校验器对未知字段放行（`src/ingest/project-schema.mjs` 头部注释就写了"契约只做加法演进"），
所以新字段不会破坏 `npm run validate:project`。

---

## 2. 验收

### 2.1 A/B 逐字节（改造前 vs 改造后，同一首歌、同一个绝对 build 目录）

证据来源：`tools/ab-verify.mjs`（本轮新增，可复现）——
把改造前的代码从 git 取出来（`git archive fb6abfc`）放到临时目录，两侧**都用同一个绝对路径的 build 目录**
（`…/_scratch-m2-2/ab/build`），基线走 `NBFORGE_BUILD` 环境变量，新版走 `--build`；
每跑完一个脚本就把它的产出拷成快照，逐文件比 sha256。

```bash
node tools/ab-verify.mjs --baseline fb6abfc --input C:/Users/hiliang/Documents/minecraft/build \
  --work C:/Users/hiliang/Documents/minecraft/_scratch-m2-2/ab
# → ✔ 14/14 步逐字节一致；结果 JSON：…/_scratch-m2-2/ab/ab-result.json
```

任务书那条验收命令**原样**也单独跑过一次（把现有 build 的 7 个输入文件拷进一个空目录，再让新版写进去）：

```bash
$ node src/arrange/arrange-all.mjs --build C:/Users/hiliang/Documents/minecraft/_scratch-m2-2/accept-20260914-043618
编曲链（工程 styx，输入基线 …/accept-20260914-043618/notes_fixed_v3.csv）
  ① 音级恢复: 3099 行 → pipeline_1_pitchfix.csv（797d9a4e8e873bab，3919ms）
  ② 重折 0..24 行: 3099 行 → pipeline_2_refold.csv（39feab4aac01e462，61ms）
  ③ 力度 accent 口径: 3099 行 → pipeline_3_accent.csv（6c12e0109d7e5601，3486ms）
  ④ 长音延音: 3209 行 → pipeline_4_sustain.csv（d6279a0d5b8809a4，1315ms）
  ⑤ 打击乐层: 138 行 → pipeline_5_percussion.csv（70d2749815cad252，2626ms）
  ⑥ 合并主谱面 3209 + 打击乐 138 = 3347 行
  ⑦ 去撞格: 3053 行 → machine_pipeline.csv（6f2dc232d4a1acc5，85ms）
完成 → …/accept-20260914-043618/machine_pipeline.csv（6f2dc232d4a1acc5）；清单 → …/manifest.json

$ sha256sum …/accept-20260914-043618/machine_pipeline.csv
6f2dc232d4a1acc54079e00f22982f9587503ac132b9c663e2a6591534dee782
```

——与改造前产出的那份（`build/machine_pipeline.csv`，也是 `6f2dc232…`）逐字节相同。

| # | 步骤（脚本默认参数） | 产出文件数 | 组合 sha256（两侧相同） | 备注 |
|---|---|---|---|---|
| 01 | `machine-pipeline` | 2 | `d56be90090904e3ee490d091…` | `styx_helix_machine.csv` = `2bfb75728e579467…`（与现有 build 里一致） |
| 02 | `sustain`（默认输入 = 机器谱面） | 2 | `d0ee89bd7247bd4bca3a6115…` | |
| 03 | `velocity`（默认 = v3 谱面） | 1 | `e54ac66fb7ae9aa6eed0df28…` | |
| 04 | `dedupe` | 2 | `64f5383340de46e9df7371ef…` | |
| 05 | `fold` | 1 | `96d33908ce79a0bfb5d06582…` | |
| 06 | **`arrange-all`（整条链，验收口径）** | 12 | `0234f286ecc4d8886bb27e67…` | `machine_pipeline.csv` = **`6f2dc232d4a1acc54079e00f22982f9587503ac132b9c663e2a6591534dee782`**（两侧 + 现有 `build/` 三者相同）；`manifest.json`/`pitch_fix_report.json` 只有时间字段不同 |
| 07 | `chroma` | 1 | `68d34e4eccbf1c351b0554d8…` | |
| 08 | `octave-evidence` | 1 | `7f34cde8f0a88d7d2d0623f8…` | |
| 09 | `verify/score` | 1 | `980df5f73cdd60c3881d999d…` | `score_report.json` 只有 `durationMs` 不同 |
| 10 | `emit/playback`（数据包函数） | 367 | `83300d356bf905d71f816b2b…` | `play/**` + `data/minecraft/tags/function/tick.json` |
| 11 | `emit/note-blocks` | 1 | `ff81aaefad8f6cffdc77db2b…` | `apply_notes_v3.mcfunction` = `0392ea2c2bdfa06bce35c222…`（文件头注释里就含输入路径 → 正好验证路径字符串一致） |
| 12 | `emit/undo-clone` | 18 | `3fa0e1a77fa9d1811c945df6…` | 在**现有数据包的副本**上跑（含 M1-6 留下的 `undo/` 分片） |
| 13 | `emit/redo-chain` | 7 | `6c44d483da8e7062618b9f29…` | |
| 14 | `emit/lint-pack`（静态自检） | 1（stdout） | `8b4afeb16d7f97ec95a86c90…` | 两侧都输出 `扫描 427 个函数文件 / 117775 行；tick 标签 OK` + `静态自检通过`，退出码 0 |

合计 **417 个产出文件**；其中 **414 个逐字节相同**，3 个（`manifest.json`、`pitch_fix_report.json`、
`score_report.json`）只差时间字段（`at` / `ms` / `durationMs`），剥掉这些字段后 JSON 完全相同。

**A/B 的诚实声明**（不改口径）：

1. 改造前有 4 个脚本（`datapack-playback` / `note-blocks` / `redo-chain` / `lint-pack`）不认 `NBFORGE_BUILD`
   ——它们把 build 目录**写死**在文件里（`lint-pack` 只认位置参数；这正是 M2-2 要修的病）。A/B 要求"两侧写同一个绝对目录"，
   所以基线副本里把这些脚本里的那个常量整体重写成临时 build 目录（等价于新版 `--build` 的效果），
   **逻辑一行未动**；工具会把它改过的文件名打印出来（`tools/ab-verify.mjs` 输出第 1 行）。
2. 两侧用的是同一个 build 目录字符串，因此产物里出现的路径字符串也完全一致——这是"逐字节"能成立的前提，
   也意味着这次比对**不能**发现"路径前缀本身写错"这类问题（那由 §2.3 的单测覆盖）。

### 2.2 新工程骨架（任务书验收 3）

（下面这段是"示意"，实际路径是本机临时目录——`_scratch-m2-2/demo` 与 `%TEMP%` 下的单测目录；命令与输出逐行照抄。）

```bash
$ node src/core/new-project.mjs --name demo --build /tmp/demo      # 空目录，退出码 0
新建工程骨架：/tmp/demo（工程名 demo，文件名前缀 demo）
  新建：project.json、README.md、audio/、midi/、demo_build/、demo_build/pack.mcmeta

工程：demo（文件名前缀 demo）
工作目录：/tmp/demo
  ✗ ① 音频      /tmp/demo/demo_full.wav
  ✗ ② 转谱      /tmp/demo/demo_notes_v3.csv
  ✗ ③ 八度修复      /tmp/demo/notes_fixed_v3.csv
  ✗ ④ 编曲链      /tmp/demo/machine_pipeline.csv
  ✗ ⑤ 出数据包      /tmp/demo/demo_build
  ✗ ⑥ 评分      /tmp/demo/score_report.json

下一步：① 放音频 —— 把 wav 放成 /tmp/demo/demo_full.wav
  （也可以先扔进 /tmp/demo/audio/，跑的时候用 --audio 指过去）
```

要点：**幂等**（第二遍 `已存在，跳过`，手改过的 README 不会被覆盖、缺的目录会补回来）、
`project.json` 是 SPEC §3 超集且**自带能过校验器**（模板生成前先跑一遍 `validateProject`，不过就抛错）、
`README.md` 里写着"放什么·放哪儿"+ 一条条可直接复制的命令；
骨架建出来后 `paths.mjs` 能从 `project.json` 读出工程名 → 后续脚本只给 `--build` 就够。

新工程缺输入时不是 ENOENT 栈：

```bash
$ node src/arrange/arrange-all.mjs --build /tmp/demo        # 退出码 1（绝不当"成功"），不留半成品
✗ 缺少输入：
    /tmp/demo/notes_fixed_v3.csv   —— 八度修复后的谱面（编曲链的输入基线）
    /tmp/demo/demo_full.wav   —— 参考音频（力度 / 延音 / 打击乐都要用它）
  下一步：把音频与转谱放进 /tmp/demo/（说明见 /tmp/demo/README.md），或用别的工程：--build <dir> --project <name>

$ node src/emit/lint-pack.mjs --build /tmp/demo             # 退出码 0：还没产出 ≠ 自检失败
数据包还没产出（/tmp/demo/demo_build 下没有 data/）
  下一步：node src/emit/note-blocks.mjs --build … && node src/emit/datapack-playback.mjs --build …
```

### 2.3 单测

```bash
$ node --test "tests/*.test.mjs"
ℹ tests 217 / pass 217 / fail 0        # 全仓库（含 M1 全部既有测试与另一位代理的 M2-1 测试）
$ node --test tests/paths.test.mjs tests/new-project.test.mjs
ℹ tests 22 / pass 22 / fail 0
```

新增 22 条覆盖：默认值逐字符兼容、`--build` 相对/绝对/等号写法/末尾斜杠、`NBFORGE_BUILD` 与
`--build` 的优先级、`--build` 缺值报错、`--project` 决定前缀、`styx` 别名、非法工程名（空/路径分隔符/空格/非 ASCII）、
`project.json` 兜底与坏文件降级、`file()`/`prefixed()`、解析过程无副作用；
骨架的空目录创建/幂等/status 模式/新工程缺输入提示/空数据包自检。

---

## 3. 关键设计取舍（为什么这么做）

1. **解析放在一个纯函数里，不在每个脚本里重复**：`resolvePaths()` 只做"字符串 → 绝对路径"，
   不建目录、不读业务数据（只在不传 `--project` 时瞄一眼 `<build>/project.json` 的 `nbforge.project`，坏文件静默降级）。
2. **默认值必须"逐字符等于历史硬编码"**：否则 M1 的全部产物（`build/` 下 400+ 文件、427 个数据包函数）
   会一夜之间"找不到了"。历史别名 `styx → styx_helix` 与数据包目录 `styx_build` 都保留。
3. **前缀只加在"工程身份"文件上**（§1 表格）：中间产物保持原名的好处是——`layout`/`scan`/`ingest`/`test`
   这些**还没改造**的脚本（§5.1）在读 `notes_fixed_v3.csv`、`single_row_profile.json` 时不会突然失配，
   参考曲这一条链保持 100% 兼容。
4. **`arrange-all` 把 `--build/--project` 透传给子脚本**：父进程解析出来的工程名/目录就是子进程的默认值，
   避免"父进程换目录、子进程还写老地方"。
5. **缺输入/空数据包给"下一步"提示**：`arrange-all` 在写任何文件之前检查基线输入，缺就退出码 1 + 指路
   （守住"不留半成品当成功"）；`lint-pack` 把"数据包还没产出"与"自检失败"分开（前者退出码 0 + 指路）。

---

## 4. 这一轮踩到的坑（都有原始证据）

1. **路径字符串会进产物**：`note-blocks` 把输入 CSV 的路径写进 `apply_notes_v3.mcfunction` 的注释、
   `manifest.json`/`machine-report.json` 记 `inPath/outPath`、`score_report.json` 记 `notesPath`。
   所以 A/B 必须"两侧用同一个绝对目录"，也必须把路径统一成正斜杠——否则比出来的差异全是噪音。
2. **改造前有 4 个脚本连环境变量都不认**（写死常量，见 §2.1 声明 1）。第一次跑 A/B 时基线把它们写进了**真实
   `build/styx_build`**（因为写死的路径就是那里）；好在内容与既有产物一致（同一份代码、同一份输入）。
   第二次起工具会在基线副本里重写该死路径，不再碰真实目录。
3. **时间字段**：`manifest.json`（`at` + 每步 `ms`）、`pitch_fix_report.json`、`score_report.json`（`durationMs`）
   天然每次不同，A/B 只能"剥掉时间字段再比"。工具会把"仅时间字段不同"的文件单独列出来，不静默放过别的差异。
4. **`arrange-all` 的打击乐步是把输出直接指到 `pipeline_5_percussion.csv`**（不落 `percussion.csv`），
   比对清单要按实际产物写，不然会误报"没产出"。

---

## 5. 覆盖范围（如实划界）

### 5.1 已改造（16 个脚本）

`arrange/{fold,pitch-fix,velocity,sustain,percussion,dedupe,machine-pipeline,arrange-all}`、
`emit/{datapack-playback,note-blocks,undo-clone,redo-chain,lint-pack}`、
`analyze/{chroma,octave-evidence}`、`verify/score`。

### 5.2 还没改造（仍然硬编码 / 只认 `NBFORGE_BUILD`）

> 换歌时这些脚本要么显式给 `--notes/--out/--report/--csv`，要么先 `set NBFORGE_BUILD=<build>`；
> 它们的默认文件名仍是 `styx_helix_*`。

| 文件 | 写死的东西 |
|---|---|
| `src/arrange/octave-fix.mjs`、`src/arrange/onset-recover.mjs` | `NBFORGE_BUILD` + `styx_helix_notes.csv` / `notes_fixed.csv` 等默认名 |
| `src/analyze/{drums,onset-detect}.mjs` | 同上（`NBFORGE_BUILD`） |
| `src/analyze/{audio-tempo,parse-midi-and-audio,wav-rms}.mjs` | 直接写死 `C:/Users/hiliang/Documents/minecraft/build`（`wav-rms` 还写死 `testserver/capture.wav`） |
| `src/arrange/arrange-notes.mjs`、`src/layout/single-row-layout.mjs` | 写死 build 目录 |
| `src/emit/{datapack-structures,fix-instruments,undo-snapshot}.mjs` | 写死 build 目录/数据包目录 |
| `src/scan/{undo-scanner,world-notes-audit,terrain-profile}.mjs` | 写死 build/存档/java 路径 |
| `src/ingest/project-from-notes-csv.mjs` | `NBFORGE_BUILD` + `styx_helix_*` 默认名 |
| `src/test/{setup-headless,run-headless}.mjs` | 写死 build/testserver/java 路径 |
| `src/synth/*`、`src/emit/{resource-pack,playsound-hifi}.mjs` | M2-1（另一位代理）的交付范围，本任务按约定不碰 |

### 5.3 明确没动的

- **数据包命名空间**：函数名 `styx:play/tick`、计分板 `styx.t` / `styx.flag` / `styx.undo` 全部保留 `styx`。
  它和文件路径无关（换目录不影响加载），而改它会改变**所有生成内容的字节**，与本任务的"逐字节可复现"直接冲突；
  真要改属于独立一条任务（namespace 参数化 + 全量重生成 + 游戏内复验）。
- **`single_row_profile.json`、`SEC_PER_STEP`/`SWITCH_TICK` 这类常量**：属于 `DISCUSSION-B §1.2` 的另一条
  （时间常量多处复制），不在 M2-2 范围。

---

## 6. 已知风险 / 还没做到

1. **同一目录两首歌仍然会互相覆盖**：中间产物不带前缀（§1），所以"一个 build 目录 = 一首歌"是硬约定；
   `new-project.mjs` 的 README 里也这么写。想支持"一个目录多首歌"需要把全部中间产物也前缀化（可做，代价是
   所有既有文档/命令要跟着改）。
2. **`--project` 与文件名的绑定是"约定"，不是"检查"**：改名工程不会自动重命名已存在的文件。
   `new-project.mjs --build <dir>`（status 模式）会指出缺什么，但不会替你改名。
3. **工程名限制为 ASCII `[A-Za-z0-9][A-Za-z0-9._-]*`**：中文名请写进 `project.json` 的 `meta.title`；
   这么做是因为工程名会直接变成文件名前缀与数据包目录名（跨 shell/编码的坑太多）。
4. **`project.json` 兜底读取是隐性行为**：不传 `--project` 时会读 876KB 的 `<build>/project.json`（约几毫秒）；
   文件坏掉/字段类型不对会静默退回 `styx`（有单测）。想显式就永远传 `--project`。
5. **`lint-pack` 对"空数据包"退出码 0**：这是刻意把"还没产出"与"自检不通过"分开。若你想让 CI 区分，
   可以加 `--strict`（没做，属于可选增强）。
6. **没验证过的环境**：非 Windows、非 `C:` 盘、UNC 路径、`NBFORGE_BUILD` 指向不存在的目录（会一路走到
   "缺少输入"提示或 ENOENT，没有专门做目录可写性预检）。

---

## 7. 下一步（交给根代理接的线）

1. **M2-3（建议）**：把 §5.2 的脚本按同一套 `paths.mjs` 接完——优先级：`octave-fix`（换歌链路的第 3 步）、
   `onset-detect`/`drums`（打击乐与力度都要）、`layout/single-row-layout`（写 `single_row_profile.json`）、
   `test/*`（无头验收）、`scan/*`（undo 扫描）。
2. `DISCUSSION-B §1.2` 的另两条还没做：**emit 先清空输出目录**、**产物进版本库/`work/` 目录 + manifest**。
3. 想支持"一个目录多首歌"就把中间产物也前缀化（§6.1）；想支持多命名空间就把 `styx:` 抽成参数（§5.3）。

---

## 附：本轮单测与 A/B 原始结果

```bash
$ node --test "tests/*.test.mjs"
ℹ tests 217 / pass 217 / fail 0 / skipped 0        # 含 M1 全部既有测试、M2-1 的 synth 测试、本任务 22 条新测试

$ node tools/ab-verify.mjs --baseline fb6abfc --input C:/Users/hiliang/Documents/minecraft/build \
    --work C:/Users/hiliang/Documents/minecraft/_scratch-m2-2/ab
基线副本里重写死路径的脚本（32）：…（见 §2.1 声明 1）
✔ 14/14 步逐字节一致；结果 → …/_scratch-m2-2/ab/ab-result.json
```

`ab-result.json` 里每步都记了：产出文件清单、两侧 sha256、退出码、耗时、哪些文件"仅时间字段不同"。
快照目录 `…/_scratch-m2-2/ab/{base,new}/<步骤>/` 可直接手工 `sha256sum` 复核。
