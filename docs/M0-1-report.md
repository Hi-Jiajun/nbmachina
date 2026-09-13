# M0-1 实测报告 · 数据契约（T1）+ 去撞格（T4）

任务书：`docs/superpowers/plans/2026-09-14-nbforge-m0.md` 的 T1、T4。
规格：`docs/SPEC.md` §3（内部规范 `project.json`）、§2（模块只通过 JSON/CSV 通信）。
数据：`C:\Users\hiliang\Documents\minecraft\build\styx_helix_notes.csv`（v1）、
`styx_helix_notes_v3.csv`（v3，本次口径）、`styx_helix_full.wav`（原曲）。

---

## 0. 交付物

| 文件 | 作用 | 测试 |
|---|---|---|
| `src/ingest/project-schema.mjs` | `project.json` 契约校验器（字段级报错）+ CLI | `tests/contract.test.mjs`（12 条） |
| `src/ingest/project-from-notes-csv.mjs` | 把**现有** v3 CSV 引导成 `build/project.json`（M0 过渡件） | 同上（真实数据用例） |
| `tests/fixtures/project.valid.json`、`tests/fixtures/broken/*.json` | 1 个合法样本 + 3 个故意破坏的样本 | 同上 |
| `src/arrange/dedupe.mjs` | 撞格检测 + 合并 + 明细报告（纯函数 + CSV CLI） | `tests/dedupe.test.mjs`（14 条） |
| `package.json` | 新增 `npm test`、`npm run ingest:project`、`npm run validate:project` | — |

提交：

```
0f5d70e feat(contract): project.json 校验器（字段级报错）+ 现有数据引导导出
3e09f2a fix(contract): project.json 的 voices 顺序固定为 SPEC 枚举序（逐字节可复现）
c34a95a feat(arrange): 去撞格（撞格 276→0，含合并明细报告）
```

产物（不进 git，属 build 区）：

| 产物 | 大小 | 说明 |
|---|---|---|
| `build/project.json` | 876 KB | 3099 颗音、契约校验通过；来源 sha256 可追溯 |
| `build/notes_dedup.csv` | 97 KB | 列与 v3 **完全一致**（`step,tick,time_seconds,instrument,midi,row,volume`），可直接喂 layout；`src/test/run-headless.mjs` 是按**位置**读这 7 列的（`[step,tick,time,instr,midi,row,vol]`），列顺序不动才换得进去 |
| `build/dedupe-report.json` | 159 KB | 276 条合并明细（留哪颗 / 弃哪颗 / 依据哪条规则） |

---

## 1. 命令与原始输出

### 1.1 全部单测

```
> npm test
...
✔ 真实数据（build/project.json，由现有 v3 CSV 导出）通过校验
✔ 破坏样本 01-missing-tempo.json 只报出字段 meta.tempo
✔ 破坏样本 02-midi-out-of-range.json 只报出字段 notes[1].midi
✔ 破坏样本 03-undeclared-voice.json 只报出字段 notes[0].voice
✔ 真实数据：v3 CSV 的 276 个撞格 → 0
ℹ tests 26
ℹ pass 26
ℹ fail 0
```

（26 = 契约 12 + 去撞格 14。）

### 1.2 T1 · 现有数据 → `project.json` → 校验

```
> node src/ingest/project-from-notes-csv.mjs
C:/Users/hiliang/Documents/minecraft/build/styx_helix_notes_v3.csv → C:/Users/hiliang/Documents/minecraft/build/project.json
  notes=3099（melody=1739 bass=1360）tempo=125 来源 sha256=66679fd13444…
  契约校验：通过

> node src/ingest/project-schema.mjs C:/Users/hiliang/Documents/minecraft/build/project.json
✓ C:\Users\hiliang\Documents\minecraft\build\project.json: 契约通过（notes=3099 voices=2 tempoMap=1 annotations=3 midi=1..109）
```

来源可追溯性（写入 `meta.source`，sha256 由导出器现算）：

```json
{
  "format": "csv",
  "path": "styx_helix_notes_v3.csv",
  "sha256": "66679fd13444dc97241d01dd2d2b67dd53e02e06276cd4c8479d8ab52e448e91",
  "audio": { "path": "styx_helix_full.wav",
             "sha256": "a0361e07da3ade4e724c003ad6d4494d5ed02a11e9f14e0855ac41d10db81dd0",
             "bytes": 24819522 }
}
```

### 1.3 T1 验收 · 3 个故意破坏的样本（原始报错）

```
> node src/ingest/project-schema.mjs tests/fixtures/broken/01-missing-tempo.json
✗ tests/fixtures/broken/01-missing-tempo.json: 1 处契约问题
  meta.tempo: [MISSING] 缺少必填字段 meta.tempo
[exit=1]

> node src/ingest/project-schema.mjs tests/fixtures/broken/02-midi-out-of-range.json
✗ tests/fixtures/broken/02-midi-out-of-range.json: 1 处契约问题
  notes[1].midi: [RANGE] notes[1].midi 超出值域 0..127（实际 300）
[exit=1]

> node src/ingest/project-schema.mjs tests/fixtures/broken/03-undeclared-voice.json
✗ tests/fixtures/broken/03-undeclared-voice.json: 1 处契约问题
  notes[0].voice: [UNKNOWN_VOICE] notes[0].voice=lead 未在 voices[] 中声明（已声明：melody, bass）
[exit=1]
```

三个样本各自只报出**一个**错误，且路径精确到数组下标。
校验器还会聚合多个字段错误（`assertProject` 抛 `ProjectValidationError`，`errors[]` 逐条带
`path/code/message`，`toString()` 直接可打印），并在 `voices[]` 本身不合法时**不再刷衍生错误**
（避免一个根因刷出 3099 条 `notes[i].voice`）。

### 1.4 T4 验收 · 去撞格

```
> node src/arrange/dedupe.mjs
C:/Users/hiliang/Documents/minecraft/build/styx_helix_notes_v3.csv
  撞格前: 3099 颗音 / 2808 格，撞格 276 格（涉及 567 颗音）
  撞格后: 2808 颗音，撞格 0 格
  按规则合并掉的格数: {"exact-duplicate":2,"same-voice-octave":140,"same-voice-pitch-class":0,"cross-voice":134}
  被合并掉的音（按声部）: {"bass":193,"melody":98}
  → C:/Users/hiliang/Documents/minecraft/build/notes_dedup.csv
  → C:/Users/hiliang/Documents/minecraft/build/dedupe-report.json
```

**276 → 0**，音数 3099 → 2808（净减 291 颗 = 276 格里的 567 − 276）。

---

## 2. 口径与规则

### 2.1 撞格口径

同一 `(step, row)` 上 ≥2 颗音即为撞格。`row` = v3 CSV 的 `row` 列（旧的音符盒行号，0..24），
`step` = 0.12 秒一个的步进网格。**为什么必须处理**：机器上一格只有一颗音符盒，
`note` 属性决定它发什么音——两颗音落在同一 `(step,row)` 只有一个能响。
不去掉的话，谱面说 2 颗、机器只响 1 颗，"触发计数差 0"这条验收永远对不上。

### 2.2 合并决策顺序（可配置，默认值写在报告里）

| 优先级 | 判据 | 说明 |
|---|---|---|
| ① | 声部优先级 | 默认 `melody > bass > inner > perc`（`DEFAULT_VOICE_PRIORITY`，可用 `voicePriority` 覆盖，单测覆盖了"bass 优先"） |
| ② | 力度大者胜 | `velocity`（0..127）/ `volume`（0..1）两个口径都参与 |
| ③ | 离本声部音域中位数更近者 | 用全曲该声部 midi 中位数当"音域中心"，避免把音挑到不合理的八度 |
| ④ | `midi` 较小者 | 纯兜底，保证决定论（打乱输入顺序结果不变，有单测） |

合并后的响度取**组内最大**（`velocityPolicy: 'max'`，`len` 同样取 max）：
一格只响一次，就按"最响的那次"响。规则与统计原文可从 `build/dedupe-report.json` 的
`policy` / `summary` 读出，逐条明细在 `merged[]`。

### 2.3 276 个撞格的真实构成

| 规则 | 格数 | 保留声部 | 被弃声部 | 音高关系（保留 vs 被弃） |
|---|---|---|---|---|
| `exact-duplicate` 同声部完全重复 | 2 | melody 2 | melody 2 | 完全同音（相差 0 半音） |
| `same-voice-octave` 同声部相差整数八度 | 140 | melody 84 / bass 56 | melody 84 / bass 56 | **全部正好 12 半音** |
| `same-voice-pitch-class` 同音级不同音高 | 0 | — | — | — |
| `cross-voice` 跨声部撞格 | 134 | melody 134 | bass 137 / melody 12 | 全部是 12 的整数倍（12~84 半音） |

两个关键事实（都是从 `dedupe-report.json` 统计出来的，不是推断）：

1. **每一格的保留音与被弃音音级完全相同**（276/276 格、291/291 对，`pcSame` 全中）。
   也就是说，合并**不会改变该时刻听到的音级**，只会改变"哪一个八度、哪一件乐器在响"，
   以及减少同时发声的音符数量。这决定了这次降级的性质：不是错音，是**配器/八度层面的损失**。
2. 一格里挤进 3 颗音的有 13 格、4 颗音的有 1 格（如 `(1616,13)` 保留 1 颗、弃 3 颗），
   全部按同一套规则处理；`(1514,13)`、`(1516,13)` 这两格是真正的完全重复（midi 85 / 73）。

### 2.4 三条明细（原文摘自 `build/dedupe-report.json`）

```json
{ "step": 32, "row": 8, "rule": "cross-voice",
  "ruleText": "跨声部撞格：按声部优先级 + 力度决策，低优先级那颗被合并",
  "kept":    { "voice": "melody", "instrument": "harp", "midi": 80, "velocity": 63, "volume": 0.497 },
  "dropped": [{ "voice": "bass", "instrument": "bass", "midi": 44, "velocity": 63, "step": 32, "row": 8, "reason": "cross-voice" }] }

{ "step": 64, "row": 13, "rule": "same-voice-octave",
  "kept":    { "voice": "melody", "instrument": "harp", "midi": 73, "velocity": 44, "volume": 0.35 },
  "dropped": [{ "voice": "melody", "instrument": "harp", "midi": 61, "velocity": 44, "step": 64, "row": 13, "reason": "same-voice-octave" }] }

{ "step": 1514, "row": 13, "rule": "exact-duplicate",
  "kept":    { "voice": "melody", "instrument": "harp", "midi": 85, "velocity": 121, "volume": 0.952 },
  "dropped": [{ "voice": "melody", "instrument": "harp", "midi": 85, "velocity": 121, "step": 1514, "row": 13, "reason": "exact-duplicate" }] }
```

---

## 3. 验收对照

| 验收项 | 结果 | 证据 |
|---|---|---|
| 校验器对现有数据通过 | ✅ | §1.2：`build/project.json`（3099 音）通过，`npm test` 真实数据用例通过 |
| 3 个破坏样本报出准确字段名 | ✅ | §1.3：`meta.tempo` / `notes[1].midi` / `notes[0].voice`，各只报 1 条 |
| v3 撞格数归零 | ✅ | §1.4：276 → 0（去撞格后 CSV 再检测 = 0，单测断言） |
| 报告列出"合并了哪些、依据什么规则" | ✅ | `build/dedupe-report.json` 276 条明细 + §2.2/2.3/2.4 |
| TDD（先失败测试后实现） | ✅ | 两次红灯：`Cannot find module src/ingest/project-schema.mjs`、`... src/arrange/dedupe.mjs` |
| 零第三方依赖、产物纯文本可 diff | ✅ | 只用 `node:*`；产物 JSON/CSV，同一输入逐字节可复现（声部顺序已固定为 SPEC 枚举序） |

---

## 4. 必须说清楚的限制（如实定级，不夸大）

1. **"力度"这一层决策在真实数据上是空转的。** 3099 颗音里，同一步的所有音共享同一个
   `volume`（实测：`distinct volume > 1` 的 step 数 = **0**）——因为 v3 的力度本来就来自
   0.12 秒混音 RMS，同刻取的是同一段音频。所以跨声部撞格里两侧力度**恒相等**，
   实际决策由声部优先级决定。该分支有单测覆盖（`bass` 优先 / CSV 里被弃音更响时取更响的响度），
   但要等 T5 把力度换成"该音级该八度的窄带能量"之后，力度才会真正参与撞格决策。
2. **合并 = 真实降级，291 颗音从谱面上消失了。** 这不是静默丢弃：每一条都在
   `dedupe-report.json` 的 `merged[]` 里逐条记录（留哪颗、弃哪颗、为什么）。
   但要提醒打分器：如果拿**未去撞格**的 v3 当基准、拿去撞格后的谱面当结果，
   `verify` 会把这里算成 291 颗漏音（漏音率 9.4%）——基准必须同为去撞格口径。
3. **同声部异八度的 140 格，占位规则不算权威。** 它们的形态（同一音级、同一刻、正好差 12 半音）
   看起来是转谱/折叠留下的重复音；我用"离本声部音域中位数更近"挑一颗，只是为了决定论可复现。
   更可信的判据是 T2 的音频八度证据。**建议流水线顺序：`octave-fix` → `velocity` → `dedupe`**，
   让合并决策吃到修好的 midi/力度，再重跑（`dedupe` 幂等，单测断言二次运行无变化）。
4. **损失更小的替代方案本轮没做**：把被弃音移到同音级的另一个 `row`（`row±12`）若那格空着，
   就把"丢一颗音"换成"换一个八度"。它需要和 T2/T3 的八度标定统一口径，还要知道机器上
   哪些 `row` 真的摆着音符盒——那属于 layout 的职责，且会改变音高归属，本轮不擅自做。
5. **`project.json` 里有两处占位值**（已写进 `annotations`，不假装精确）：
   `durSec` 无来源时值，统一取一个步长 0.12s；`velocity = round(混音 RMS × 127)`。
   `meta.source.format` 暂用过渡值 `csv`（`SOURCE_FORMATS` 里显式列出，含 SPEC 的三个
   foreign 标准 `musicxml/midi/smf/dawproject`），等真正的 MIDI/MusicXML/OMR 输入通路落地后替换。
6. 校验器**放行未知字段**（契约只做加法演进，方便各模块带自己的溯源字段），
   只对已知字段做必需性与值域检查。

---

## 5. 给其他组的接口

| 谁 | 拿什么 | 注意 |
|---|---|---|
| T2/T3（八度） | `build/project.json`（每颗音带 `src.step/src.row/src.mixRms`，可与 CSV 对齐） | 建议修完之后跑一次 `node src/arrange/dedupe.mjs --in <修好的CSV>` |
| T5（力度） | 同上；`src.mixRms` 就是当前"混音 RMS"口径的原值 | 换口径后撞格决策里的力度项才生效 |
| T6/T7（评分/回归） | `build/notes_dedup.csv`、`build/dedupe-report.json` | 评分基准必须同为去撞格口径 |
| layout | `build/notes_dedup.csv`（列名与 v3 完全一致） | 直接用，撞格已归零 |

命令速查：

```bash
npm test                                        # 契约 + 去撞格 26 条单测
npm run ingest:project                          # v3 CSV → build/project.json
npm run validate:project -- <project.json>       # 契约校验（失败退出码 1）
node src/arrange/dedupe.mjs                     # v3 CSV → notes_dedup.csv + dedupe-report.json
node src/arrange/dedupe.mjs --in <csv> --out <csv> --report <json>
```
