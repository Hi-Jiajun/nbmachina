# M3-1 实测报告 · 内声部 / 和声层（`instrument=inner`）

任务书：`nbforge_inner_voice.md`（M3 第 1 条）。基线：HEAD `fc7bde5`（M2-3 收口）。
数据：`build/pipeline_4_sustain.csv`（3209 颗音 / 1831 个 step / 238 个"同刻多音"step）
＋ `build/pipeline_5_percussion.csv`（138）＋ `build/styx_helix_full.wav`（281.4s）。

**一句话结论**：内声部层已落地并且**默认完全不动老链路**——`--inner off`（默认）时
改造前后 **19/19 步逐字节一致**；`--inner on` 时把 238 个多音 step 拆成 **旋律 1385 + 内声部 354**
（其中 222 颗是独立和声音、132 颗是转谱重复），旋律层从"混着和弦"变成**每刻单音**、线条更平滑
（平均音程 5.14 → 4.78 半音，>7 半音大跳 217 → 178 处）。

音区映射**默认 `keep`（不动八度）**，这一条是**实测否掉了设计文档字面的"内声部 harp 0–11"**：

| 音区映射 | 内声部八度命中率 | 漏音率 | 客观分 | 机器多响几颗 |
|---|---|---|---|---|
| `keep`（默认，保留 T3 音频标定的八度） | **0.943** | 6.3% | **0.8024** | 0 |
| `relocate`（只在会被合并时搬到另一八度） | 0.871 | 6.8% | 0.8002 | **+19** |
| `band`（一律压到 0–11 低带） | 0.244 | 11.8% | 0.7772 | +78 |

即：本曲的"内声部"在音频证据上**就在它现在的八度**（T3 已经逐音标定过），把它压到低带会
让 76% 的内声部音从"对上音频"变成"对不上"。所以 M3-1 的交付是**声部分层（标签 + 溯源数据）**，
不是"搬八度"；要靠音色把它听出来是 M4（后端 A mod）的事。

---

## 0. 交付物

| 文件 | 作用 | 测试 |
|---|---|---|
| `src/arrange/inner-voice.mjs`（新） | 文件进/文件出：同刻多音的 harp 层拆成 旋律（`harp`）+ 内声部（`inner`）；追加 `voiceRole/innerOf/innerReason` 三列；`--register keep\|relocate\|band`；幂等、可单独跑、走 `paths.mjs`（`--build/--project`） | `tests/inner-voice.test.mjs`（16 条） |
| `src/arrange/arrange-all.mjs`（改） | 新增 `--inner on\|off`（**默认 off**）与 `--inner-register <mode>` 透传；只多一步"④b 内声部层" | 默认 off 的逐字节 A/B：`tools/ab-verify.mjs` 19/19 |
| `package.json`（改） | 加 `"arrange:inner": "node src/arrange/inner-voice.mjs"` | — |
| `tests/inner-voice.test.mjs`（新） | 12 条合成 fixture（空输入/单音/两音/三音/完全重复/keep 不动行/band 边界/relocate 边界/幂等/CSV 契约/取值合法性/纯函数不改入参）＋ **4 条真实数据/emit 链路**断言（一条 skip 都没有） | 本次 TDD：先红（`does not provide an export named 'tableToCsv'`）再绿 |
| `build/pipeline_4b_inner.csv`（`--inner on` 时产出） | 内声部谱面：既有 12 列逐字符保留 + 追加 3 列，3209 行 | §3.3 |
| `build/inner-voice-report.json`（`--inner on` 时产出） | 本模块报告：拆分统计 / 两种撞格口径 / 音区搬运明细 / 旋律线统计 / 前 8 个 step 的拆分明例 | §3.3 |

---

## 1. 验收对照（任务书 §3）

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| `node --test "tests/*.test.mjs"` | 全绿且总数 ≥227 | **242 通过 / 0 失败 / 0 跳过**（其中本任务 16 条） | 通过 |
| 默认关闭的逐字节 A/B | `machine_pipeline.csv` 等产物 sha256 与改造前一致 | `tools/ab-verify.mjs --baseline fc7bde5` → **19/19 步逐字节一致**（2 个文件仅时间字段不同：`manifest.json`/`pitch_fix_report.json`） | 通过（做的是完整 A/B，不是退路） |
| `arrange-all` 默认能跑通 | — | 跑通；`machine_pipeline.csv` sha256 `6f2dc232d4a1acc5…` 与改造前**逐字节相同** | 通过 |
| `arrange-all --inner on` 能跑通且被 emit/lint 认 | note-blocks / lint-pack 接受 | 三档模式都跑通：`note-blocks` 摆出 3053/3072/3131 个音符格 → `datapack-playback` 生成 367 个函数 → `lint-pack` **静态自检通过：无 tick rate、无悬空函数引用、note 范围合法** | 通过 |
| 单测不得有"跳过真实数据"的偷懒项 | — | 4 条真实数据/链路断言全部**硬断言**（产物不在就 fail，不 skip） | 通过 |
| 报告要有真实数据上的数字 | 内声部音数 / 撞格变化 / chroma / 漏音率 | §2、§3 全给，两种撞格口径都给 | 通过 |

---

## 2. 口径：每题为什么这么定

### 2.1 谁是"旋律"：续线，而不是"最高音"

同一刻有 ≥2 颗 harp 时，M2-1 的 hifi 渲染器用的是"**行号最高者 = 旋律**"的临时启发式
（`src/emit/playsound-hifi.mjs` 的 `planHifi` 注释里写明了）。本模块改成维护**旋律游标**：
取离上一颗旋律音最近的那颗（并列取行号高者 → 音高小者 → 原始行序，全决定论）。实测（真实数据）：

| 旋律判定规则 | 平均音程 | 中位 | >7 半音大跳 | >12 半音 | 最大跳进 |
|---|---|---|---|---|---|
| `top`（最高行 = 旋律，M2-1 旧启发式） | 5.143 | 3 | 217 | 84 | 43 |
| `continuation`（本模块默认） | **4.783** | 3 | **178** | **73** | 43 |

两条规则在 **85 / 238** 个多音 step 上给出**不同的旋律音**（35.7%）——不是"换个名字"，是真的
选了另一颗音当主线。所以这条不是口味问题：续线的旋律线更平滑，取它当默认。

### 2.2 内声部里到底有什么：三类材料分开记

354 颗内声部分成三类（`innerReason` 列直接写进谱面，报告里也有计数）：

| 类别 | 颗数 | 含义 | 处理 |
|---|---|---|---|
| `chord-tone` | **222** | 与同刻所有 harp 音**音高都不同**的和声材料（和弦音、内声部填充） | 标 `inner`；这是 M3-1 真正要"分层"的东西 |
| `duplicate-of-melody` | 68 | 与同刻旋律**同音高**（转谱重复） | 标 `inner`，但**不搬八度、不合并**；交给 `dedupe` 按"同一格"处理（现状就是合并成一颗，音高不变） |
| `duplicate-in-chord` | 64 | 与另一颗内声部同音高 | 同上 |

**不许凭空造音**：本模块不新增、不删除任何音高；`keep` 模式下 `midi/row` 逐音符逐字符不变
（单测里对真实数据 3209 行逐行断言过）。

### 2.3 音区映射：`keep` 是唯一不与音频证据打架的档

设计文档（`docs/DESIGN.md` v0.1 §C）建议"内声部 harp 0–11、旋律 harp 12–24"。T3（`octave-fix`）
已经用原曲音频把每颗音的八度标定过一遍，所以"把内声部压到低带"= 把标定结果改掉。三档实测：

| 档 | 规则 | 搬运颗数 | 内声部八度命中率 | 内声部存活（dedupe 后） | 客观分 |
|---|---|---|---|---|---|
| `keep` | 不动行号 | 0 | 0.943（n=230） | 230 | 0.8024 |
| `relocate` | **只在**"这颗音会被撞格合并掉"时，搬到同音级的另一个空闲八度（优先向下） | 19（下 15 / 上 4） | 0.871（n=249） | 249 | 0.8002 |
| `band` | 一律落到 0–11 低带里该音级的唯一行（被占则留原行） | 220 | **0.244**（n=308） | 308 | 0.7772 |

配合旋律/贝斯/打击乐看更清楚（`score.mjs` 的 `byVoice`）：

| 模式 | 总音数 | 旋律 | 贝斯 | 内声部 | 打击乐 | 客观分 |
|---|---|---|---|---|---|---|
| `off`（改造前） | 3053 | 1639 @0.977 | 1276 @0.928 | — | 138 | **0.80256** |
| `--inner on --inner-register keep` | 3053 | 1385 @**0.983** | 1300 @0.928 | 230 @**0.943** | 138 | 0.80240 |
| `--inner on --inner-register relocate` | 3072 | 1385 @0.983 | 1300 @0.928 | 249 @0.871 | 138 | 0.80018 |
| `--inner on --inner-register band` | 3131 | 1385 @0.983 | 1300 @0.928 | 308 @**0.244** | 138 | 0.77716 |

三点如实说明：

1. `keep` 的客观分比改造前低 **0.00016**（0.80256 → 0.80240）。成分：八度命中率 0.9129 → 0.9122
   （旋律那颗 0.977 → **0.983**，但因为 230 颗内声部**单独成为一路声部**参与统计，整体被拉低
   0.0007）；chroma 0.957125、起音 F1 0.969399、有支撑率 0.937111、漏音率 6.2889% **逐位不动**。
2. `relocate` 多救回 19 颗音（3072 vs 3053，+0.6% 发声量），代价是内声部八度命中率掉到 0.871、
   漏音率 6.3% → 6.8%、客观分 −0.0024。**它救的正是"本来会被静默合并掉"的音**——这是个取舍，
   不是纯赚，所以默认不打开。
3. `band` 是设计文档的字面口径，实测**不能用**（内声部八度命中率 0.244 = 76% 的内声部音
   "机器在响、但响在音频证据不支持的那个八度上"）。这条要在 M4 或用户拍板时再看，
   本任务把它做成可复现的一档而不是默认。

### 2.4 撞格：两种口径都报，别挑对自己有利的那个

| 口径 | 定义 | 改造前 | `keep` 后 | `relocate` 后 | `band` 后 |
|---|---|---|---|---|---|
| 物理撞格 | 同 `(step,row)` 有 ≥2 颗音 → **机器那一格只能响一颗** | 278 格 / 多 294 颗 | 278 / 294（**不变**） | 261 / 275 | 208 / 216 |
| 同音色同格 | 同 `(step,instrument,row)` 有 ≥2 颗音 | 159 格 / 多 159 颗 | **91 / 91** | 91 / 91 | 72 / 72 |

**必须写清楚的一条**：`keep` 让"同音色同格重复"从 159 掉到 91，其中一部分是**标签效应**
——本曲 harp 侧那 100 颗同格重复（落在 88 个格上）全是**完全重复**（同 step 同 midi），把它们里的一颗改标成
`inner` 之后就不再计入"同音色同格"，但**机器上的实际发声没变**（那一格本来也只响一颗，
`dedupe` 照旧合并）。物理撞格数在 `keep` 下**一格都没少**——本模块不靠搬八度去"消灭撞格"。
剩下的 91 格=（贝斯侧同格重复 59 格）＋（同一格上有 ≥2 颗内声部音 32 格，即和弦内重复）。

---

## 3. 命令与原始输出

（在 `nbforge/` 下执行；`build/` 在仓库上一层，故写作 `../build/`。验收都在
`_scratch-m3-1/` 的**独立 build 副本**里跑，不碰真实 `build/styx_build/`。）

### 3.1 单测（先红后绿）

红灯（实现之前）：`node --test tests/inner-voice.test.mjs` →
`SyntaxError: The requested module '../src/arrange/inner-voice.mjs' does not provide an export named 'tableToCsv'`。

```bash
$ node --test tests/inner-voice.test.mjs
✔ 空输入：只有表头 → 没有音符、没有内声部，只在末尾追加三列表头
✔ 单音 step 不产生内声部；低音不参与拆分（原样透传、role=bass）
✔ 同刻多音 → 续线的那颗留 harp(旋律)，另一颗标 inner 并记 innerOf/innerReason
✔ 旋律判定按"续线"而不是"最高音"：melodyFrom=top 得到另一颗（两种模式都断言）
✔ 三音和弦 → 1 旋律 + 2 内声部，两颗内声部的 innerOf 都指向旋律音高
✔ 同 step 同 midi 的完全重复：不造音、不搬八度，一颗旋律 + 一颗 inner(duplicate-of-melody)
✔ register=keep：midi/row 与输入逐字符一致（只改 instrument 与追加列）
✔ 临界音区边界 register=band：内声部落进 0..11 带内该音级的唯一行；目标被占则保持原行
✔ register=relocate：只在"否则会被撞格合并"时搬，同音级、优先向下、不越界
✔ 幂等：同一输入跑两次逐字节相同；对已拆分的输出再跑不会产生新的内声部
✔ CSV 契约：既有列（含 velocity 等额外列）逐字符保留，只在末尾追加三列
✔ instrument 取值合法性：inner 被 dedupe/velocity 的声部表认，且 emit 的摆方块规则接受它
✔ 真实数据：build/pipeline_4_sustain.csv 的拆分数字（旋律 1385 / 内声部 354 / 撞格两种口径）
✔ 真实数据：keep 不改动任何音高/行号，且"续线"旋律线比"最高音"更平滑
✔ 真实数据 + emit 链路：开 --inner 的谱面能被 note-blocks 摆成方块、并被 lint-pack 静态自检通过
✔ splitInnerVoice 纯函数：不改入参、非法配置报错、空数组安全
ℹ tests 16  ℹ pass 16  ℹ fail 0  ℹ skipped 0

$ node --test "tests/*.test.mjs"
ℹ tests 242  ℹ pass 242  ℹ fail 0  ℹ skipped 0  ℹ duration_ms 30302
```

### 3.2 默认关闭的逐字节 A/B（`tools/ab-verify.mjs`）

```bash
$ node tools/ab-verify.mjs --baseline fc7bde5 --input C:/Users/hiliang/Documents/minecraft/build \
    --work C:/Users/hiliang/Documents/minecraft/_scratch-m3-1/ab2
✔ 01 machine-pipeline：2 个产出文件（300ms / 236ms）
✔ 02 sustain（默认输入 = 机器谱面）：2 个产出文件（1212ms / 1096ms）
✔ 03 velocity（换力度口径）：1 个产出文件（225ms / 208ms）
✔ 04 dedupe（默认输入 = v3 谱面）：2 个产出文件（81ms / 63ms）
✔ 05 fold（默认输入 = notes_fixed_v3）：1 个产出文件（51ms / 45ms）
✔ 06 arrange-all（整条链，验收口径）：12 个产出文件，2 个仅时间字段不同（manifest.json、pitch_fix_report.json）
✔ 07 chroma：1 个产出文件（535ms / 525ms）
✔ 08 octave-evidence：1 个产出文件（935ms / 946ms）
✔ 09 verify/score：1 个产出文件，1 个仅时间字段不同（score_report.json）
✔ 10 emit/playback（数据包函数）：367 个产出文件（427ms / 429ms）
✔ 11 emit/note-blocks：1 个产出文件（55ms / 61ms）
✔ 12 emit/undo-clone：18 个产出文件（53ms / 58ms）
✔ 13 emit/redo-chain：7 个产出文件（48ms / 54ms）
✔ 14 emit/lint-pack（静态自检）：1 个产出文件（226ms / 277ms）
✔ 15 arrange/octave-fix（八度修音）：2 个产出文件（60ms / 70ms）
✔ 16 analyze/onset-detect（分频带起音检测）：1 个产出文件（3080ms / 3026ms）
✔ 17 analyze/drums（打击乐检测）：1 个产出文件（2313ms / 2241ms）
✔ 18 layout/single-row-layout（剖面重算 + 灯位）：6 个产出文件（909ms / 917ms）
✔ 19 emit/playsound-hifi（自研音色派发链）：727 个产出文件（446ms / 671ms）
✔ 19/19 步逐字节一致；结果 → …/_scratch-m3-1/ab2/ab-result.json
```

`--inner off`（默认）时**一步不多、一个文件不多**：`pipeline_4b_inner.csv` 与
`inner-voice-report.json` 都不会产生（单测与 A/B 都覆盖了这一点）。

同一份输入的绝对 sha256（`_scratch-m3-1/accept-off/machine_pipeline.csv` 与
`build/machine_pipeline.csv`）：

```
6f2dc232d4a1acc54079e00f22982f9587503ac132b9c663e2a6591534dee782
6f2dc232d4a1acc54079e00f22982f9587503ac132b9c663e2a6591534dee782
```

### 3.3 `--inner on` 三档：链、emit、lint

```bash
$ node src/arrange/arrange-all.mjs --build …/accept-keep --inner on --inner-register keep
编曲链（工程 styx，输入基线 …/accept-keep/notes_fixed_v3.csv）
  ① 音级恢复: 3099 行 → pipeline_1_pitchfix.csv（797d9a4e8e873bab）
  ② 重折 0..24 行: 3099 行 → pipeline_2_refold.csv（39feab4aac01e462）
  ③ 力度 accent 口径: 3099 行 → pipeline_3_accent.csv（6c12e0109d7e5601）
  ④ 长音延音: 3209 行 → pipeline_4_sustain.csv（d6279a0d5b8809a4）
  ④b 内声部层: 3209 行 → pipeline_4b_inner.csv（47adddeab485004e）
  ⑤ 打击乐层: 138 行 → pipeline_5_percussion.csv（70d2749815cad252）
  ⑥ 合并主谱面 3209 + 打击乐 138 = 3347 行
  ⑦ 去撞格: 3053 行 → machine_pipeline.csv（53d31410a188f3df）

（模块自己打的明细，`inner-voice-report.json` 同源）
内声部层（工程 styx，register=keep，旋律判定=continuation）
  C:/…/pipeline_4_sustain.csv（3209 颗音 / 1831 个 step）
  ① 旋律层：1385 个 step 有 harp，其中 238 个是多音 step → 旋律 1385 颗 + 内声部 354 颗
     （独立和声音 222 / 与旋律同音高的重复 68 / 和弦内重复 64）
  ② 旋律线：平均音程 4.783 半音，>7 半音大跳 178 处，>12 半音 73 处
  ③ 音区映射：搬动 0 颗（向下 0 / 向上 0），仍落在已占格 124 颗
  ④ 撞格（同 step+row，机器上只能响一颗）：278 格 / 多 294 颗 → 278 格 / 多 294 颗
     撞格（同 step+instrument+row）：159 格 / 多 159 颗 → 91 格 / 多 91 颗

$ node src/emit/note-blocks.mjs --build …/accept-keep --notes …/accept-keep/machine_pipeline.csv
apply_notes_v3.mcfunction: 3053 个音符格 / 9159 条指令（{"bass":1300,"harp":1615,"basedrum":96,"hat":42}）
$ node src/emit/datapack-playback.mjs --build …/accept-keep --notes …/accept-keep/machine_pipeline.csv
lo（20 tps）：1831 个时刻 / 56 桶 / 4 组 / 单刻 20 次调用 / 末刻 5568（≈4.6 分）/ 触发 3053
hi（100 tps）：1831 个时刻 / 275 桶 / 19 组 / 单刻 35 次调用 / 末刻 27840（≈4.6 分）/ 触发 3053
$ node src/emit/lint-pack.mjs --build …/accept-keep
扫描 367 个函数文件 / 52696 行；tick 标签 OK
静态自检通过：无 tick rate、无悬空函数引用、note 范围合法

（relocate / band 同一条流水线，只有 ⑦ 的行数不同：3072 / 3131）
apply_notes_v3.mcfunction: 3072 个音符格（{"bass":1300,"harp":1634,…}）
apply_notes_v3.mcfunction: 3131 个音符格（{"bass":1300,"harp":1693,…}）
```

### 3.4 客观评分（`node src/verify/score.mjs --notes <machine_pipeline.csv>`）

```text
off      ① 起音 F1 0.969 ② chroma 0.957 ③ 八度 0.913（旋律 0.977 / 贝斯 0.928）
         ④ 力度 r=-0.109（mix-rms）⑤ 有支撑率 0.937（漏音 6.3%）→ 客观 0.8026
keep     ① 0.969 ② 0.957 ③ 0.912（旋律 0.983 / 贝斯 0.928 / 内声部 0.943）
         ④ r=-0.110 ⑤ 0.937（漏音 6.3%）→ 客观 0.8024
relocate ① 0.969 ② 0.957 ③ 0.907（内声部 0.871）④ r=-0.110 ⑤ 0.932（漏音 6.8%）→ 客观 0.8002
band     ① 0.969 ② 0.957 ③ 0.844（内声部 0.244）④ r=-0.132 ⑤ 0.882（漏音 11.8%）→ 客观 0.7772
```

### 3.5 去撞格（`dedupe` 的原始报告）

| 模式 | 合并前 | 合并后 | 合并掉 | 规则分布 | 被合并的声部 |
|---|---|---|---|---|---|
| `off` | 3347 | 3053 | 294 颗 / 278 格 | 完全重复 143 · 跨声部 135 | melody 100 · bass 194 |
| `keep` | 3347 | 3053 | 294 / 278 | 完全重复 82 · 跨声部 196 | **inner 124** · bass 170 |
| `relocate` | 3347 | 3072 | 275 / 261 | 完全重复 84 · 跨声部 177 | inner 105 · bass 170 |
| `band` | 3347 | 3131 | 216 / 208 | 完全重复 67 · 跨声部 141 | inner 46 · bass 170 |

`keep` 下"贝斯少被合并 24 颗"是设计口径的直接结果：跨声部撞格时声部优先级是
`melody > bass > inner > perc`（`dedupe.mjs` 的 `DEFAULT_VOICE_PRIORITY`，M1-3 就登记了 `inner`），
以前同刻的和声材料穿着 `harp` 的皮、按 melody 优先级抢格；现在它们自认 `inner`，
24 个格子让给了低音线（`bass` 存活 1276 → 1300）。

---

## 4. 未验证 / 未接线（如实划界）

1. **没做人耳验收**：本任务只做"数据层分层 + 客观指标"，"内声部换个音色是否更好听"必须靠耳朵，
   属 M4 与用户的人耳清单（`docs/M2-1-report.md` 的 A/B 试听同一条路）。
2. **`playsound-hifi` 还没读 `inner` 标签**（属 M3-2/M4 接线）：M2-1 的 hifi 路径自己按
   "同一 step 行号最高 = 旋律"判内声部，`inner` 现在会走它的 `unknownInstrument` 兜底
   （实测：`[警告] 230 颗音的乐器名不在映射表里，已退回 strings`，但音色结果仍是
   `bass 1300 / strings 1385 / bell 230`，即内声部实际按 `--inner bell` 渲染）。
   两条口径在 **85 / 238**（35.7%）个多音 step 上会选出**不同的旋律音**——接线时要让
   `planHifi` 直接认 `inner` 标签，否则 A/B 试听比的不是同一件事。本任务**没有**改
   `src/emit/playsound-hifi.mjs` 的既有行为（边界纪律）。
3. **`inner` 在机器上仍是 harp 甲板**：`layout-pos.mjs` 的 `DECK_BLOCK` 里没有 `inner`，
   `note-blocks.mjs` 会把它退回 `instrument=harp`（同一台机器的 sand 甲板）。也就是说
   **原版后端 B 听不出内声部**（和改造前一模一样），要在后端 A 听出来得等 M4 的音色映射。
4. **贝斯侧的 55 个完全重复撞格与 135 个贝斯×harp 跨声部撞格没动**：本模块只拆 harp 层
   （低音不是内声部）。`relocate` 的"救音"也只救和声音，贝斯侧要另立任务。
5. **只在 styx 这一首歌上验证**：所有数字都来自 `build/pipeline_4_sustain.csv`。
   换歌要重跑 §3.3 的三条命令；`register` 的结论（`keep` 优于 `band`）来自本曲的音频八度标定，
   别的曲子需要用 `--register band` 跑一遍再比一次内声部八度命中率。
6. **`inner` 的力度列语义**：`velocity.mjs` 的 `VOICE_OF_INSTRUMENT` 里 `inner → inner`，
   力度窗取 0.1s（同 melody）。本任务没有重算内声部的力度（它继承原 harp 音的力度），
   若 M4 要给内声部单独的音量包络，重跑第 ③ 步即可。

---

## 5. 复现命令（一条不落）

```bash
# 0) 前置：编曲链的输入（音频 + 转谱）在 <build>/ 里；本报告用真实 build 的副本：
#    notes_fixed_v3.csv / styx_helix_full.wav / single_row_profile.json / project.json

# 1) 单测（16 条，含真实数据 + emit 链路）
node --test tests/inner-voice.test.mjs
node --test "tests/*.test.mjs"                         # 242/242

# 2) 默认关闭的逐字节 A/B（19 步）
node tools/ab-verify.mjs --baseline fc7bde5 --input C:/Users/hiliang/Documents/minecraft/build \
  --work C:/Users/hiliang/Documents/minecraft/_scratch-m3-1/ab2

# 3) 默认链路（应与改造前逐字节相同）
node src/arrange/arrange-all.mjs --build <dir> --out <dir>/machine_pipeline.csv
sha256sum <dir>/machine_pipeline.csv                   # 6f2dc232d4a1acc54079e00f22982f9587503ac132b9c663e2a6591534dee782

# 4) 内声部链（三种音区映射）
for M in keep relocate band; do
  node src/arrange/arrange-all.mjs --build <dir> --inner on --inner-register $M --out <dir>/machine_pipeline.csv
  node src/emit/note-blocks.mjs --build <dir> --notes <dir>/machine_pipeline.csv
  node src/emit/datapack-playback.mjs --build <dir> --notes <dir>/machine_pipeline.csv
  node src/emit/lint-pack.mjs --build <dir>
  node src/verify/score.mjs --build <dir> --notes <dir>/machine_pipeline.csv --out <dir>/score_report_m31.json
done

# 5) 单模块（吃第 ④ 步的产物，幂等、可单独重跑）
node src/arrange/inner-voice.mjs --build <dir> --register keep          # npm run arrange:inner
node src/arrange/inner-voice.mjs --build <dir> --in <dir>/pipeline_4_sustain.csv \
  --out <dir>/pipeline_4b_inner.csv --report <dir>/inner-voice-report.json --register relocate
```

产物留在 `C:\Users\hiliang\Documents\minecraft\_scratch-m3-1\`：
`accept-off/`（默认链路）、`accept-keep|relocate|band/`（三档全链路 + 评分 + 数据包）、
`ab2/ab-result.json`（19 步 A/B 结果）、`ab/`（用旧提交 e06c773 当基线的那次，见 §4.7 备注）、
`summary.json`（本报告 §2.3 那张表的原始数字）。

> 备注（§3.2 的对照组）：第一次 A/B 我误把基线取成 `e06c773`，结果 09/10/11/14/19 共 5 步不一致——
> 差异全部来自根代理随后的 `fc7bde5`（M2-3 把 score/emit 的谱面口径从"未编排的 v3 谱面"改成
> "编排后的机器谱面"，见该提交信息），与本任务无关；换成当前 HEAD 当基线后 19/19 全绿。
