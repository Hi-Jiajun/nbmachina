# M3-16（P2）· mod 无损音频引擎（2026-09-15）

用户："你继续做mod吧"。这一轮把 P2 的核心（**绕开原版音频栈、直接播 WAV 母版**）打通。

## 1. 为什么必须绕开原版音频栈

- 客户端解码只有 `OggAudioStream` 一个实现（此前 javap 实证）→ 资源包路线**必然有损**；
- 我们的钢琴母版是 **48kHz/24bit WAV**（Salamander）与 44.1kHz/16bit WAV（Yamaha OLPC / VSCO）；
- 所以 mod 自己读文件 → 自己送进 OpenAL，才能做到无损 + 用上"每个力度层一段独立采样"。

## 2. 这一轮做了什么

| 模块 | 文件 | 说明 |
|---|---|---|
| WAV 解码 | `audio/NbforgeWav.java` | 8/16/**24**/32bit PCM → float（保精度）；用 JDK 的 `AudioSystem` 解析 RIFF，能跨过 OLPC 那种带 BWF `bext` 块的头 |
| 音频引擎 | `audio/NbforgeAudio.java` | **自己的 OpenAL 设备 + 自己的线程**：原版上下文只在它的 "Sound engine" 线程 current，抢不得也共不得。采样缓存按**字节**上限（512MB）+ LRU，采样**截断 10s**（Salamander 单采样最长 25.7s）并做 0.5s 淡出；128 路并发、超出偷最早的一路 |
| 乐器库 | `audio/NbforgeInstruments.java` | 读 `config/nbforge/instruments.json`；`(乐器, midi, 力度)` → 采样文件 + 变调比 + 增益；选层规则与离线渲染同一套（精确命中 → 键位最近 → 力度最近，绝不静音） |
| 音符协议 | `net/NbforgePlayPayload.java` | S2C 自定义包 `nbforge:play`（乐器 / midi / 力度 / 坐标）；服务端不需要任何采样 |
| 客户端入口 | `NbforgeClient.java` | 加载乐器库、启动引擎、登记收包、每刻同步听者位姿与原版主音量；客户端命令 `/nbfc status\|instruments\|note\|demo\|reload` |
| 服务端命令 | `NbforgeCommands.java` | 新增 `/nbforge play <乐器> <midi> [力度]` → 发 `nbforge:play` 给执行者 |
| 乐器导出 | `tools/export-mod-instruments.mjs` | 从我们的 SFZ 索引生成 `instruments.json`（4 个乐器 / 1487 个区域 / 0.37MB），`--deploy` 直接落到客户端 config |

## 3. 已验证（都是实跑，不是"应该能行"）

| 验证 | 方法 | 结果 |
|---|---|---|
| **第二次开 OpenAL 设备**（MC 之外） | `_scratch-m3-16/AlProbe.java`：不启动 MC，直接 LWJGL | `device` 打开成功；`OpenAL Soft 1.23.1` |
| **float32 支持**（无损通路） | 同上 | `AL_EXT_FLOAT32=true` |
| **24bit 母版解码** | 同上：`A0v12.wav` | `2ch / 48000Hz / 25.69s / 1233199 帧` |
| **带 bext 块的 44.1k/16bit** | 同上：`pno057v43leg.wav` | `1ch / 44100Hz / 8.20s` |
| **上传 + 播放** | 同上：`alBufferData`+`alSourcePlay` | `state=4114(PLAYING)`，`alError=0` |
| **服务端不炸** | 副本服 `-Dnbforge.selftest=true` | `已注册 S2C 音符协议 nbforge:play`；命令树 `info,note,sustain,stopall,play`；自检通过（36 次击发 / 峰值 3 / 残留 0） |
| **编译** | `gradlew build --init-script gradle-mirror.init.gradle` | `BUILD SUCCESSFUL` → `nbforge-0.1.0.jar`（42KB） |
| **部署** | 复制到 PCL2 实例 | `mods/nbforge-0.1.0.jar`（43008 B）+ `config/nbforge/instruments.json`（385KB） |

## 4. 需要人耳的（如实声明）

**客户端实听还没验证**：`/nbfc demo salamander48` 能不能听到、力度 30/70/110 三档是否明显不同、
和"资源包 `/playsound`"那条链路比是否更干净——这些要用户进游戏听。

如果进游戏后 `/nbfc status` 显示 `引擎就绪=false`，说明这台机器不允许开第二个 OpenAL 设备，
那就退到"共用原版上下文"的备选方案（要在 MC 的声音线程上执行，成本更高）。

## 5. 下一步（P2 余下）

1. **谱面直读**：服务端读 `machine_pipeline.csv`，按 tick 派发 `nbforge:play`（替掉"数据包 + playsound"那条链路）；
2. **多乐器/多声部**：现在旋律走钢琴库，内声部/贝斯/打击乐仍是合成音色——把 VSCO 的竖琴/低音提琴拨弦/鼓也导进 `instruments.json`；
3. **延音与断奏**：`sta` 短奏采样已经在库里（OLPC 有 360 个），接上"音符时值 → 用哪套采样"；
4. **游戏内录制**：把播放的音频按总线录成 WAV（无损存档 + B 站 hi-res），对应 P3。

## 6. 落地测试清单（2026-09-15，用户执行）

**前置**：重启游戏（mod jar 变了，`/reload` 不够）。资源包只在测**老链路**时才需要。

自动侧已跑绿（见下），需要人耳/客户端的是这 6 步——**照抄即可**：

```
1) /nbfc status
   期望：引擎就绪=true 乐器=4 采样缓存=0 个/0MB 活跃声部=0 ...
         OpenAL：OpenAL Community / OpenAL Soft / 1.1 ALSOFT ... / float32=true

2) /nbfc instruments
   期望：4 个乐器（salamander48 / disklavier / vsco_upright / disklavier_sf2），带区域数与许可

3) /nbfc selftest salamander48 60 100
   期望：打印采样文件路径（存在=true）、区域（loKey..hiKey / root / 力度区间 / 增益）、
         解码（2ch / 48000Hz / 10.00s / 480000 帧）；1.2s 后再打印"采样缓存=1 个 … 活跃声部=1"
   ⇒ 这一条同时验证"选层 + 解码 + 上传 + 播放"

4) /nbfc demo salamander48
   期望：听到 C4 G4 C5 E5 G5 各三遍（力度 30 / 70 / 110 递增），**强的那遍应该明显更亮更响**

5) /nbforge play salamander48 60 100
   期望：服务端回显"→ 客户端无损引擎（nbforge:play）"，并听到一颗 C4
   ⇒ 这一条验证"服务端 → 网络包 → 客户端引擎"整条链路

6) A/B（有资源包时）：/nbforge note nbforge:strings_gs5 1 1   （老链路：资源包 Ogg）
   对比：/nbfc note salamander48 79 100                        （新链路：48k/24bit 母版）
```

**出问题就把这两行的原文发回来**：`/nbfc status` 与 `/nbfc selftest salamander48 60 100`。

### 本轮自动验证结果（2026-09-15 09:1x）

| 项 | 结果 |
|---|---|
| `AlProbe`（不启 MC 开第二个 OpenAL 设备） | ✅ `OpenAL Soft 1.23.1`，`AL_EXT_FLOAT32=true`，24bit/16bit 两种母版解码正常，`state=PLAYING / alError=0` |
| `TruncateProbe`（采样截断） | ✅ Salamander `25.69s → 10.00s`，淡出段峰值单调 `0.0198→0.0117→0.0103→0.0060→0.0027`，尾帧 0；Yamaha 8.2s 不截断 |
| 副本服自检（新 jar 44916 B） | ✅ `S2C 协议已注册`、命令树 `info,note,sustain,stopall,play`、36 击发 / 峰值 3 / 残留 0 |
| 构建 + 部署 | ✅ `BUILD SUCCESSFUL` → 客户端 `mods/`（44916 B）+ `config/nbforge/instruments.json`（385590 B） |
