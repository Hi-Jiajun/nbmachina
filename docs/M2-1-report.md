# M2-1 实测报告 · 自研音色 MVP（零依赖合成器 + 资源包 + /playsound 后端）

任务书：`nbforge-m2-1.md`。背景：`docs/DESIGN.md`（后端 A：保留 MC 特色的增强音色）、
`docs/DISCUSSION-C-music.md` §11、用户要求 **零侵权、音色自研**。

**一句话结论**：三个音色家族（拨弦 / 铺底 / 钟琴，另加低音变体）全部由本仓库代码合成，
4 个音色 × 37 个半音（3 个八度）= 148 个采样，共 353.9 秒音频、**OGG 2.23MB / zip 2.09MB**，
基频误差 **最差 0.001%（strings）/ 0.002%（bell）/ 0.006%（bass）/ 0.840%（pad，颤音边带的测量效应）**，
20 条测试全绿；`styx:play/monitor_hifi_on` + `styx:play/hifi/tick` 在真机服务端跑通
（派发链实测：第 0 刻 4 颗音 → 计数器 +4、`#hifiBass` +3、`#hifiStr` +1）。

**唯一没做到的**是"用耳朵验"：本机没有可自动化的客户端，**没做听感 A/B**（详见 §7）。

---

## 0. 交付物

| 文件 | 作用 | 测试 |
|---|---|---|
| `src/synth/synth.mjs` | 合成器核心：Karplus–Strong 拨弦 / 加法（+轻微 FM）铺底 / 模态钟琴 + 双二阶 EQ、DC 阻断、峰值归一化 | `tests/synth.test.mjs`（§1~3） |
| `src/synth/voices.mjs` | 音色表（4 音色参数）、音域、行→midi 映射、事件命名 `nbforge:<音色>_<音名>` | 契约测试 |
| `src/synth/spectrum.mjs` | FFT 自查：全局最强谱峰（亚 bin 抛物线插值）+ 谱心 | 4 条音准测试 |
| `src/synth/ogg.mjs` | ffmpeg 编解码薄封装（WAV→OGG / OGG→样本） | ogg 回读测试 |
| `src/synth/render-all.mjs` | 一条命令渲染全部采样 + 力度试听件 + 报告（`synth-report.json` / `synth-spectrum.csv`） | 验收命令 ① |
| `src/emit/zip-writer.mjs` | 最小 ZIP 写入器（可复现：固定时间戳、条目顺序稳定） | 字节级可复现断言 |
| `src/emit/resource-pack.mjs` | 打包 `build/nbforge_resources/` + `build/nbforge_resources.zip`；`testserver/resourcepacks/` 存在就复制；客户端实例目录存在时把 zip 复制进去 | 结构/体积/交叉校验 |
| `src/emit/playsound-hifi.mjs` | 新文件：生成 `styx:play/monitor_hifi_on|off`、`styx:play/hifi/{tick,stop,report}`、`hifi/{lo,hi}/{tick,binNN,bNNN}`（**不改 `datapack-playback.mjs`**） | 映射/函数/真实谱面 |
| `build/audio_nbforge/` | 148 个 OGG + WAV 中间件 + 24 个力度试听件 + `synth-report.json` + `synth-spectrum.csv` | §4 |
| `build/nbforge_resources.zip` | 资源包（pack_format 69） | §5 |

**没有引用任何第三方采样/音源**：全部采样由 `src/synth/*` 现场合成；`NOTICE.md` 已登记。

---

## 1. 关键简化：不写 mod 也能听到自研音色

资源包可以加自定义音效（`assets/nbforge/sounds.json` + ogg），数据包用
`/playsound nbforge:<事件> master @s ~ ~ ~ <vol> <pitch>` 播放。于是：

* **本任务**先把"监听模式的高保真音色"做出来（不需要 mod、不改机器结构、随时可关）；
* 实体音符盒那一路（真机发声、方块/粒子/红石灯反馈）仍留给后续 mod —— 后端 A 的完整形态没变。

代价（显式声明）：`/playsound` 需要**客户端装资源包**（专用服不会替客户端放音）；
资源包只改音色、不改音高语义，所以 `score.json` / 谱面数据一行都不用动。

---

## 2. 算法（每个参数为什么是这个数）

全部采样：**单声道 44100Hz 16bit WAV → libvorbis -q:a 4**（Minecraft 要求 ogg/vorbis；WAV 只作中间件）。

### 2.1 `strings` / `bass`：Karplus–Strong 拨弦

```
激励   = 位移波形(三角 + β(v)·锯齿，按拨弦位置做零点) + 0.3·拨片噪声(梳状+低通)
延迟线 = fs/f − 0.5d（d = 环路阻尼）；读延迟用线性插值取 L + frac
环路滤波器 = 两抽头 FIR h=[1−0.5d, 0.5d]，每绕一圈乘 g = 10^(−3/(f·T60))
末端   = 琴体 EQ（peaking 260Hz +3.5dB / peaking 1450Hz +1.5dB / highshelf 3200Hz −4.5dB）
         + 两级低通 cutoff(v)（strings 900→9000Hz，bass 400→4200Hz）+ DC 阻断 + 峰值归一化
```

三个"为什么"：

1. **为什么延迟线要取小数**：44.1kHz 下 midi 19 = 24.5Hz 的延迟是 1800 采样、midi 78 = 740Hz 是 60 采样；
   整数取整会把高音区顶掉百分之几 —— 直接违反"基频误差 ≤1%"。取 L+frac 后实测 ≤0.006%。
2. **为什么环路不像教科书那样用一极点低通**：一极点低通在基频处的相位延迟随频率变化（本例可达 34 采样），
   补偿不当会把音准做成 5% 级误差；两抽头 FIR 在低频的相位延迟恰好是 0.5d，能精确扣掉。
3. **为什么 bass 额外叠同频正弦（subMix 0.3）**：bass 行 1..24 → midi 19..42（24.5~92.5Hz），
   小音箱放不出这个频段；同频正弦保证"根音"能被听出来。

### 2.2 `pad`：加法（+轻微 FM 味）铺底

6 个泛音（幅度 1 / .45 / .28 / .17 / .11 / .07，各自 ±4~10 音分失谐），每个泛音又是**一对**
相差 7 音分的振荡器（合唱感），150ms raised-cosine 慢起音、4.4Hz/±3.5 音分慢颤音、
一极点低通（1200→4200Hz，随力度）、高次泛音衰减更快（T60/(1+0.35k)）。

### 2.3 `bell`：模态合成钟琴

非谐分音比例 `[0.5, 1, 1.19, 1.56, 2, 2.66, 3.01]`（0.5 = 钟的哼音；2.66 是典型的
"第六分音"，是钟琴/编钟区别于正弦叠加的关键），每个分音由**一对**相差 ±0.7~1.4 音分的
阻尼正弦叠加（拍频 → "活的"钟声），T60 从 1.0s（高分音）到 2.6s（基频），外加 3ms 带通槌击噪声。
测试会验证 2.66× 分音**位置正确**（±2%）且**幅度 ≥ 基频的 1%、≥ 分音间谱底的 10 倍**。

---

## 3. 力度 → 亮度 / 响度（任务书"力度→亮度映射"的落点）

三条通道同时同向（力度越大越亮）：

| 通道 | 参数 | 作用 |
|---|---|---|
| 激励谐波斜率 | 位移波形里锯齿占比 β：strings 0.06→0.80、bass 0.20→0.85 | 起音"齿感" |
| 环路阻尼 | `damping`：strings 0.55→0.25、bass 0.80→0.55 | 延音里高次泛音保留多久 |
| 末端音色总闸 | 两级低通截止（对数插值）：strings 900→9000Hz、bass 400→4200Hz | 整体亮度 |

实测（`build/audio_nbforge/demo/`，谱心 = 0.19s 短窗的 Σf·|X|/Σ|X|，RMS 为响度）：

| 试听件 | vel 0.35 | vel 0.65 | vel 1.0 | 谱心比 |
|---|---|---|---|---|
| strings c4 | 582Hz / 0.093 | 722Hz / 0.117 | 857Hz / 0.146 | **1.47×** |
| strings c5 | 913Hz / 0.069 | 1044Hz / 0.084 | 1159Hz / 0.103 | 1.27× |
| pad c4 | 345Hz / 0.094 | 401Hz / 0.116 | 494Hz / 0.132 | 1.43× |
| pad c5 | 872Hz / 0.110 | 1042Hz / 0.135 | 1255Hz / 0.158 | 1.44× |
| bell c4 | 295Hz / 0.067 | 297Hz / 0.087 | 299Hz / 0.109 | 1.01×（只有响度变） |
| bell c5 | 589Hz / 0.057 | 595Hz / 0.074 | 601Hz / 0.094 | 1.02× |
| bass cs2 | 210Hz / 0.129 | 324Hz / 0.168 | 488Hz / 0.211 | 2.32× |
| bass cs3 | 260Hz / 0.119 | 366Hz / 0.153 | 531Hz / 0.194 | 2.04× |

测试断言：strings 的谱心随力度**严格单调**且 vel 1.0 ≥ 1.25× vel 0.35、RMS 单调不降；
pad/bell 也随力度变亮；bell 的基频不随力度漂移。

> **踩过的坑（如实记录）**：第一版把"力度→亮度"做成**一极点低通**（6dB/oct）压在激励上，
> 实测 vel 0.35→1.0 的谱心只差 **7%**（1741→1947Hz）—— 压不动 −12dB/oct 的三角激励，测试直接判红。
> 改成"谐波斜率 + 环路阻尼 + 末端两级低通"三条同向通道后为 1.27~2.32×。

---

## 4. 音准自查（FFT，口径与代码都只有一份）

口径：取信号**开头 0.37s** 加 Hann 窗、零填充到 65536 点（bin 间隔 0.673Hz），
在 20Hz..Nyquist 内取**全局最强谱峰**，再用对数幅度做抛物线插值取亚 bin 精度。
刻意**不在目标频率附近开窗找峰** —— 否则"误差 ≤1%"是自己证明自己。

`build/audio_nbforge/synth-spectrum.csv`（148 行逐音数据，报告只节选）：

| 音色 | 音 | midi | 目标 Hz | FFT 峰值 Hz | 误差 | 时长 s |
|---|---|---|---|---|---|---|
| strings | fs2 | 42 | 92.499 | 92.499 | 0.000% | 2.20 |
| strings | fs3 | 54 | 184.997 | 184.997 | 0.000% | 2.20 |
| strings | fs4 | 66 | 369.994 | 369.994 | 0.000% | 2.20 |
| strings | fs5 | 78 | 739.989 | 739.991 | 0.000% | 1.90 |
| bass | g0 | 19 | **24.500** | 24.501 | 0.006% | 2.40 |
| bass | g1 | 31 | 48.999 | 48.999 | 0.001% | 2.40 |
| bass | fs2 | 42 | 92.499 | 92.499 | 0.000% | 2.40 |
| bass | g3 | 55 | 195.998 | 195.998 | 0.000% | 2.40 |
| bell | fs2 | 42 | 92.499 | 92.501 | 0.002% | 2.40 |
| bell | fs5 | 78 | 739.989 | 739.988 | 0.000% | 2.40 |
| pad | fs2 | 42 | 92.499 | 92.613 | 0.124% | 2.60 |
| pad | g4 | 67 | 391.995 | 395.288 | **0.840%** | 2.60 |
| pad | fs5 | 78 | 739.989 | 741.534 | 0.209% | 2.60 |

逐音色汇总（`build/audio_nbforge/synth-report.json`）：

| 音色 | 半音数 | 总时长 | OGG | 误差 max | 误差 mean | 最差音 | WAV 峰值 |
|---|---|---|---|---|---|---|---|
| strings | 37 | 80.1s | 0.58MB | **0.001%** | 0.000% | gs2 (103.83Hz) | 0.79 |
| pad | 37 | 96.2s | 0.56MB | **0.840%** | 0.279% | g4 (392.0Hz) | 0.71 |
| bell | 37 | 88.8s | 0.58MB | **0.002%** | 0.000% | g2 (98.0Hz) | 0.75 |
| bass | 37 | 88.8s | 0.52MB | **0.006%** | 0.001% | g0 (24.5Hz) | 0.79 |

> **pad 的 0.840% 不是音高错误**：pad 有 4.4Hz/±3.5 音分的颤音，0.37s 窗会把 FM 第一边带
> （±4.4Hz）分辨出来，全局最强谱峰落在边带上（395.0Hz / 390.3Hz 双峰，中心 ≈392.6Hz）。
> 换成 0.74s 窗测中心频率就是 **0.207%**（同一份采样、同一个函数，只改窗长）。
> 换句话说：本表对"带颤音的音色"偏保守，pad 真实中心音高误差 ≈0.2%。

> **验收逼出来的真 bug（第二次踩坑）**：小数延迟一开始写成"在共 L 个槽的环形缓冲里取延迟 L 与延迟 L+1"，
> 但缓冲只有 L 槽时，第二个抽头实际落在**延迟 1**上 —— 环路里混进近距抽头，
> frac 接近 0 或 1 的音（midi 48 / 61 / 74 / 77）退化成亚音频漂移：**strings 误差一度达 97%**。
> 修法：缓冲区长度改成 **L+1**，两个抽头分别是 (w−L) 与 (w−L−1)。
> 这条要是只靠耳朵听，很可能被当成"音色不好"糊过去 —— 客观闸门的价值就在这里。

---

## 5. 资源包

```
build/nbforge_resources/
  pack.mcmeta                                  {"pack":{"pack_format":69, ...}}
  assets/nbforge/sounds.json                   148 条事件：nbforge:strings_fs4 → strings/fs4
  assets/nbforge/sounds/<音色>/<音名>.ogg
build/nbforge_resources.zip                    ★ 交付件（2.09MB，可复现字节）
```

* **pack_format = 69 不是猜的**：读的是 `testserver/server.jar` 里的 `version.json`
  （1.21.10 → `pack_version.resource_major = 69`）；测试里有一条断言拿 jar 复核这个常量。
* **每半音一个采样**（而不是"1 个采样 + pitch 参数"）：`/playsound` 的 pitch 只在 0.5~2.0 之间
  （±1 个八度），超出会有明显的"花栗鼠/慢放"失真；每半音一个采样把 pitch 恒定为 `1`，
  代价是文件数（148 个 ogg）—— 实测 zip 只有 2.09MB（< 15MB 上限的 14%）。
* **可复现**：ZIP 写入器固定时间戳（2026-01-01 00:00）、条目顺序 = 采样顺序，
  同一份采样两次打包**字节完全相同**（测试断言）。
* **自检**：sounds.json 里每个 `name` 都必须指向 zip 内真实存在的文件（测试逐条交叉校验）；
  另外抽 4 音色 × 3 音（音域两端 + 中间）把 ogg **解码回来**重测基频（误差 ≤1%）。

**安装（本机现状，如实说明）**：`testserver/resourcepacks/` 目录不存在 → 按任务书"若存在该目录"没有复制；
客户端实例目录 `C:\Program Files\PCL2\.minecraft\versions\1.21.10-Fabric 0.19.5\resourcepacks\` 存在但
**复制被拒绝（EPERM，Program Files 需要提权）**，所以本次**没有自动装到客户端**。两种可用做法：

1. 手动（或提权）把 `build/nbforge_resources.zip` 放进该实例的 `resourcepacks\`，进游戏"选项→资源包"启用；
2. 让测试服下发：`testserver/server.properties` 里 `resource-pack=file:///C:/Users/hiliang/Documents/minecraft/build/nbforge_resources.zip`
   （客户端连上自动下载；**本次没有改**，留给根代理决定，避免影响别人的 e2e 运行）。

---

## 6. `/playsound` 高保真后端（`src/emit/playsound-hifi.mjs`）

### 6.1 音色映射（唯一入口 `planHifi`）

| 谱面乐器 | 判定 | 音色 | 说明 |
|---|---|---|---|
| `harp` | 同一 step 上**行号最高**的那颗 | `strings` | 旋律（本次 1385 颗） |
| `harp` | 同 step 其余（内声部，默认） | `bell`（`--inner pad/strings` 可换） | 本次 254 颗 |
| `bass` | 全部 | `bass`（默认 **+1 八度**） | 24.5~92.5Hz 小音箱放不出；`--bass-octave 0` 关（本次 1276 颗） |
| `basedrum` / `hat` | 全部 | 原版 `minecraft:block.note_block.*` | 自研音色不含打击乐（M2-1 范围外）；音高沿用 `2^((row−12)/12)`，与原版机器一致（本次 138 颗） |
| `bell`/`chime`/`pad`/`violin`/`piano`… | 别名表 | 对应音色 | 给后续内声部预留 |
| 未知乐器 | — | 退回 `strings` 并计数（`stats.unknownInstrument`） | 不静默丢弃 |

### 6.2 函数与调用量

| 函数 | 内容 |
|---|---|
| `styx:play/monitor_hifi_on` | 建目标 `styx.flag/styx.t/styx.hifi`、`#hifi=1`、计数器清零、`#hi`/`#on`/`#t` 存在性占位（`add 0`）、**播放中**立刻 `#ht=#t`、未播放 `#ht=-1`、提示语 |
| `styx:play/monitor_hifi_off` | `#hifi=0`、`#ht=-1` |
| `styx:play/hifi/tick` | 每刻入口：`#ht += 1`；若 `#on=1` 则 `#ht = #t`（与机器同刻，方便 A/B）；按 `#hi` 选 20/100tps 表 |
| `styx:play/hifi/{lo,hi}/{tick,binNN,bNNN}` | 两级派发：单刻只碰当前组（与 `datapack-playback` 同口径） |
| `styx:play/hifi/stop` / `report` | 收尾；`report` 打印 `#hifiPlays` 与每音色计数 |

跑真实机器谱面（`build/machine_pipeline.csv`，3053 颗音）：

| 表 | 时刻数 | 桶 | 组 | **单刻函数调用** | 末刻 | playsound 行 |
|---|---|---|---|---|---|---|
| lo（20tps，默认） | 1831 | 56 | 4 | **20** | 5568 | 3053 |
| hi（100tps） | 1831 | 275 | 19 | **35** | 27840 | 3053 |

映射结果：`strings 1385 / bell 254 / bass 1276 / 原版打击乐 138`（合计 3053 ✓）。
**接线由根代理做**（本文件一行都不改 `datapack-playback.mjs`）：把 `styx:play/hifi/tick`
挂进 `styx:play/tick` 或 `minecraft:tick` 标签即可；CLI 会打印当前接线状态（未接线时给警告 + 两种做法）。
⚠️ `play/` 目录是 `datapack-playback.mjs` 生成时**整个重建**的，所以**重跑 emit:playback 之后要再跑一次本文件**。

### 6.3 和原版 harp 的差异（结构性对比，不是听感 A/B）

| 维度 | 原版音符盒 harp（后端 B） | 本任务 strings（自研） |
|---|---|---|
| 音高数 | 25 个 `note`（两个八度，F#3~F#5） | **37 个半音（3 个八度 93~740Hz）**，每半音一个采样 |
| 力度 | 机器路径固定音量；监听路径只有 `/playsound` 音量 | **力度→亮度**（谱心 1.27~2.32×）+ 音量；采样里烘死单层力度（M4 做多层） |
| 延音 | 固定衰减（约 1 秒） | 按音高给 T60（0.8~2.2s），时长表在 `synth-report.json` |
| 频谱 | 固定采样，不可改 | 参数化：泛音斜率 / 拨弦位置零点 / 琴体 EQ 全部可复算 |
| 依赖 | 人人都有 | **需要客户端装资源包**（专用服不替客户端放音） |
| 可关性 | — | `monitor_hifi_off` 一键回原版音色；机器路径完全不受影响 |

为什么没做原版 A/B **实录**：本机唯一的实录音频 `testserver/capture.wav` 是一段**空录音**
（峰值 0.0000），没有可用的原版 note_block 样本；本任务不新建"客户端录音"链路，所以
"像不像"只能留给用户在游戏里人耳判断（见 §7）。上表所有对比都基于**代码与数据**，不是听感结论。

---

## 7. 验收对照（任务书四条）

| 验收项 | 目标 | 实测 | 判定 |
|---|---|---|---|
| `node --test tests/synth.test.mjs` | 全绿 | **20 条全绿**（合成 / 映射 / 函数 / 资源包 / ogg 回读 / 真实谱面交叉校验） | 通过 |
| `node src/synth/render-all.mjs --out build/audio_nbforge` | ≥3 音色 × ≥12 半音 | 4 音色 × 37 半音 = **148 个采样**；带 `synth-report.json` / `synth-spectrum.csv` | 通过 |
| `node src/emit/resource-pack.mjs && node src/emit/playsound-hifi.mjs` | 资源包 + 函数 | 148 条事件、zip **2.09MB（<15MB）**；361 个函数文件、两套刻率表 | 通过 |
| 基频误差 ≤1%（FFT 自查，数值贴报告） | ≤1% | strings 0.001% / bell 0.002% / bass 0.006% / pad 0.840%（中心 0.207%） | 通过 |
| 资源包能被原版加载 | — | **部分验证**：pack_format 取自服务端 `version.json`(69)；sounds.json 每个 name 都指向包内真实文件；zip 条目可回读；ogg 回读基频正确。**未做**：真实客户端加载 | **未完全验证** |
| 服务端能加载/执行新函数 | — | **已验证**（`build/m21_server_verify*.log`）：`monitor_hifi_on`、`hifi/tick`、`hifi/report`、`hifi/stop` 全部执行成功、无 Unknown function / ERROR；派发链实测走到 playsound 行（第 0 刻 4 颗音 → `#hifiPlays` 4→8、`#hifiBass` 3、`#hifiStr` 1） | 通过 |
| 服务端接受自定义音效 id | — | **已验证**：`/playsound nbforge:strings_a3 …`、`/playsound nbforge:bass_ds2 …` 与原版 harp 一样只报 `No player was found`（没有 Unknown sound event） | 通过 |

### 未验证 / 需要人耳的部分（如实声明）

1. **听感**：自研音色"像不像钢琴/弦乐/钟琴"、力度曲线是否自然 —— **需要用户在游戏里听**。
   资源包装好后用 `styx:play/monitor_hifi_on` + `styx:play/start` 即可 A/B；
   `build/audio_nbforge/demo/` 里另有 24 个力度试听件，可直接用任意播放器听。
2. **资源包在真实客户端的加载**：只验证了结构、格式号、文件对应与 ogg 可解码，没跑过客户端。
3. **`pad` 默认没有接入**：内声部默认 `bell`（`--inner pad` 可切）。`pad` 已渲染、已测试、可试听，
   但"谱面里哪一层该用 pad"要等编排层给出内声部标签。
4. **打击乐仍是原版**：`basedrum/hat` 走 `minecraft:block.note_block.*`，自研打击乐不在 M2-1 范围内。
5. **力度是单层采样**：采样里烘死 vel=0.8，播放时用 `/playsound` 的音量近似；
   设计文档要求的"≥3 层力度 + 循环点"属于 M4。

---

## 8. 复现

```bash
cd C:/Users/hiliang/Documents/minecraft/nbforge
node --test tests/synth.test.mjs                          # 20 条测试（音准 / 映射 / 包结构 / ogg 回读）
node src/synth/render-all.mjs --out build/audio_nbforge    # 148 个采样 + 报告（≈20s，需要 ffmpeg）
node src/emit/resource-pack.mjs                           # build/nbforge_resources(.zip)，pack_format 69
node src/emit/playsound-hifi.mjs                          # styx:play/hifi/* + monitor_hifi_on|off
```

* 相对路径（`build/...`、`testserver/...`）一律按 **minecraft 工程根**解析（= 本仓库的上一级），与其它模块的 `<BUILD>` 约定一致。
* 没有 ffmpeg 时只出 WAV（`--no-wav` 可删中间件）；此时资源包不能出声，CLI 会明确警告。
* 服务端验证脚本（一次性）：`build/m21_server_verify.mjs`、`build/m21_server_verify2.mjs`，
  日志 `build/m21_server_verify.log` / `build/m21_server_verify2.log`。

## 9. 没有碰的文件（任务书硬约束）

本次两个 commit 只包含：`src/synth/*`（新）、`src/emit/{playsound-hifi,resource-pack,zip-writer}.mjs`（新）、
`tests/synth.test.mjs`（新）、`docs/M2-1-report.md`（新）以及 `NOTICE.md` / `package.json` 的登记与脚本行。
**没有改** `src/emit/datapack-playback.mjs`、`note-blocks.mjs`、`layout-pos.mjs`、`src/layout/*`、`src/test/*` 与任何 arrange 模块。
