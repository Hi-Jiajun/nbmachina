# 安装与排错（M3-36 · 2026-09-19）

目标：**只装 jar + 一份采样库** 就能跑，不需要手工改路径、不需要重新导出索引。

## 0. 前置

| 组件 | 要求 |
|---|---|
| Minecraft | 1.21.10（Fabric） |
| Fabric Loader | ≥ 0.19.5；另需 **Fabric API** |
| Node.js | ≥ 20.11（跑 `tools/*.mjs`；本项目在 v24 上验证） |
| 7-Zip | 只在需要解 `olpc-sound-samples-v2.7z` 时用到（默认装到 `C:\Program Files\7-Zip`） |
| ffmpeg | 采样后处理（高通）与出片链路用；需在 PATH 里 |

**服务端与每个想听到声音的客户端都要装 mod**：声音是客户端引擎放的，服务端负责按谱面派发。

## 1. 装 jar

把 `nbmachina-<版本>.jar` 放进 `<游戏目录>/mods/`。

> 注意：**同一个 mod 不要留两个 jar**（新旧各一份会双加载），替换时先把旧的移出去。

## 2. 准备采样库（三种方式，任选）

采样库不进仓库（约 5.7GB），但**索引在 jar 里**：jar 内置的 `nbmachina-instruments.json`
用的是相对采样根的路径，所以采样放哪、换机器、换用户名都不影响。

### 方式 A：就地接管（已有采样目录 · 最快）

```bash
node tools/install-samples.mjs --root <你的采样根> --adopt <你的采样根> --deploy
```

它只写 `config/nbmachina/samples.json`（指向采样根）+ 部署一份相对路径的乐器索引，**不复制任何文件**。

### 方式 B：一键下载

```bash
node tools/install-samples.mjs --download all --deploy     # 三套全下
node tools/install-samples.mjs --download salamander       # 只下钢琴
node tools/install-samples.mjs --from-olpc <本地7z或目录>   # 用本地归档代替下载
node tools/install-samples.mjs --check                     # 只看现状
```

| 包 | 内容 | 体积 | 上游（2026-09-19 实测） |
|---|---|---|---|
| `salamander` | Salamander Grand Piano V3 48kHz/24bit（CC-BY 3.0） | 1.38GB（tar.xz） | FreePats 官方重打包 ✅；GitHub 镜像 `sfzinstruments/SalamanderGrandPiano`（FLAC，714MB）✅ |
| `vsco` | VSCO 2 CE 全集（CC0，3168 个 wav） | ~3.0GB | GitHub `sgossner/VSCO-2-CE` ✅（`git clone --depth 1`） |
| `olpc` | Yamaha Disklavier Pro 完整合集（CC-BY 3.0，1212 个 wav） | 4.58GB（7z） | archive.org 条目 **已 404**；脚本退路是 FreePats 的 YDP SF2 子集（118MB，121 区域），或用 `--from-olpc <你手上的归档>` |

> 下载走 `HTTPS_PROXY` / `HTTP_PROXY` 环境变量（脚本会把它转给 `curl.exe`）。
> 实测经代理约 90KB/s，1.38GB 需要数小时 —— 有本地归档优先用 `--from-*`。

### 方式 C：手工放

按下面的布局放好，再跑一次方式 A 的 `--adopt` 即可：

```
<采样根>/
  piano/salamander48_hp/A0v1.wav … SalamanderGrandPianoV3_hp.sfz     ← 48Hz 高通 + 24bit WAV
  piano/vsco2ce/VSCO-2-CE-SFZ/…                                     ← VSCO 原样（含子目录）
  piano/disklavier_sfz/…                                            ← SF2 子集（可选）
  olpc/x/yamahaGrandPiano44/pno000v…leg.wav … yamaha_disklavier_olpc.sfz
```

> `salamander48_hp` 是原始母版过了"按音高分档高通"后的产物（去掉采样自带的 20–40Hz 隆隆声，
> 见 `docs/M3-26-*.md`）。用方式 B 时脚本会自动生成。

## 3. 采样根怎么被找到

mod 按这个顺序解析（第一个存在的目录生效）：

1. JVM 参数 `-Dnbmachina.samples=<目录>`
2. 环境变量 `NBMACHINA_SAMPLES`
3. `config/nbmachina/samples.json` 里的 `{"root": "..."}`（方式 A/B 会写）
4. `<游戏目录>/nbmachina-samples`、`<游戏目录>/config/nbmachina/samples`、
   `<游戏目录>/../nbmachina-samples`

索引里如果写的是**绝对路径**（老版本导出），只要文件存在就原样使用 —— 向后兼容。

## 4. 验证

```
/nbmc samples        # 采样根 + 逐乐器"在位 ✔ / 缺 N"
/nbmc instruments    # 70 件乐器分组统计
/nbmc demo salamander48   # 试听琶音
/nbmc status         # 引擎 / 缓存 / 抖动 / 音色映射
```

采样缺文件时命令会直接告诉你缺在哪个乐器，并提示脚本位置。

## 5. 游戏内录音 vs 离线母版：一致性怎么测

1. **录制**：OBS → 音频源用「桌面音频 / WASAPI 回环」（**不要用麦克风**），
   48kHz / 立体声 / 24bit 或 32bit float；游戏内音乐音量固定；关掉其他会出声的程序。
2. 进游戏 `/nbmc play 30`，同时开始录，录 40~60 秒。
3. 跑对比：

```bash
node tools/compare-ingame-vs-master.mjs --record <录音.wav> \
     --master build/master/styx_master_48k24bit.wav --at 30 --len 40
```

输出：① 对齐误差（毫秒）；② 电平差（dB）；③ 1/3 倍频程逐带差值 + 波形相关 r。
判读：±1.5dB 内＝链路一致；某带 2~6dB 偏差＝音量/编码差异；频带形状整体不同＝录的不是同一段。

## 6. 排错

| 现象 | 原因 / 处置 |
|---|---|
| 进游戏没声音、`/nbmc samples` 说缺文件 | 采样根不对：`config/nbmachina/samples.json` 指向的目录里没有 `piano/…`、`olpc/…` |
| `/nbmc` 报"错误的命令参数，位于第 5 个字符：nbmc" | 只输了 `/nbmc`（不带子命令）。现在会打印用法清单 |
| 日志里 `Ambiguity between arguments` / `Syntax exception for client-sided command` | 客户端命令树有问题（历史踩坑），把日志发给作者 |
| 声音是原版音符盒音 | 说明当前走的是"原版降级路径"或没装 mod；本机机器布局里音符盒本体不出声，正常声音来自 `/nbm playat` |
| 装了资源包反而变难听 | 资源包是**遗留可选**路线（Ogg 有损），mod 引擎不依赖它，建议关掉 |
| 换 jar 后没变化 | jar 在启动时加载，必须**重启游戏**；数据包改动用 `/reload`；`instruments.json` 改动用 `/nbmc reload` |
| 采样缓存涨到几百 MB | 正常：引擎有 512MB LRU 上限，超出会自动淘汰最旧的采样 |
