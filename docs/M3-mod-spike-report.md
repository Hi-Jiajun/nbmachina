# M3 预研报告｜自研 Fabric mod「后端 A」在 1.21.10 上到底能不能做

- 日期：2026-09-14
- 目标版本：**Minecraft 1.21.10**（从 `testserver/logs/latest.log` 实测读出，不照抄文档）
- 结论：**可做（有条件）**。本机从零到「编译通过 → 产出可装载 jar → 真服务器加载 → 音色注册表 /
  命令树 / 服务端发声通路实测通过」已全部打通。**唯一没验的是「客户端耳朵听见」**，原因见 §8。

---

## 0. 一句话结论

后端 A 不需要换引擎、不需要外部构建服务：**这台机器（Windows + 启动器自带 JDK 21 + 代理）就能做完**。
代价是首次要下约 0.2 GB 工具链/依赖，并且这台机器上 **`libraries.minecraft.net` 的 TLS 握手会被中断**，
必须补一个国内 Maven 镜像仓库（已做成 `mod/gradle-mirror.init.gradle`，一条 `--init-script` 参数）。

---

## 1. 服务器版本与 Java 要求（实测）

| 项 | 值 | 证据 |
| --- | --- | --- |
| 服务端版本 | `1.21.10` | `testserver/logs/latest.log`：`[04:39:01] [Server thread/INFO]: Starting minecraft server version 1.21.10`；另 `testserver/versions/1.21.10/server-1.21.10.jar` |
| 真服启动方式 | `java.exe -Xms1G -Xmx2G -jar server.jar nogui` | `Get-CimInstance Win32_Process -Filter "ProcessId=43480"`（14:20 起在跑，端口 25565） |
| 用的 JDK | 启动器运行时 `AppData\Roaming\.minecraft\runtime\java-runtime-delta` | 真服进程命令行里的绝对路径就是它 |
| Java 版本 | **OpenJDK 21.0.7 LTS（Microsoft build，且是完整 JDK）** | `java-runtime-delta\bin\javac.exe -version` → `javac 21.0.7`；`release` 文件 `JAVA_VERSION="21.0.7"`、`MODULES` 含 `jdk.compiler` |
| 结论 | **1.21.10 + 启动器 JDK** 与 Fabric 要求的 Java 21 完全对齐，**不需要另下 JDK** | 任务里「若没有 javac 才下 Temurin」这一步直接跳过 |

## 2. Fabric 各版本支持性（代理走 `192.168.1.201:7890`，逐条查官方接口）

| 查询 | 接口 | 命中结果 |
| --- | --- | --- |
| 游戏版本 | `https://meta.fabricmc.net/v2/versions/game` | `1.21.10`，`stable: true`（共 525 条） |
| Loader | `https://meta.fabricmc.net/v2/versions/loader/1.21.10` | **253** 条；最新稳定 **0.19.5**；intermediary `1.21.10` |
| Yarn 映射 | `https://meta.fabricmc.net/v2/versions/yarn/1.21.10` | **3** 条：build.3 / build.2 / build.1 → 选 **1.21.10+build.3** |
| Fabric API | `https://api.modrinth.com/v2/project/fabric-api/version?game_versions=["1.21.10"]` | **7** 个版本，最新 **0.138.4+1.21.10**（release，2025-12-17，2,375,888 B） |
| Fabric Installer | `https://meta.fabricmc.net/v2/versions/installer` | 最新稳定 **1.1.2** |
| Loom | `https://maven.fabricmc.net/net/fabricmc/fabric-loom/maven-metadata.xml` | 最新稳定线 **1.17.20**；插件 id 为 `net.fabricmc.fabric-loom-remap` |
| 官方模板对照 | `fabric-example-mod` 的 `1.21.10` 分支 `gradle.properties` | `minecraft_version=1.21.10 / loader_version=0.19.5 / loom_version=1.17-SNAPSHOT / fabric_api_version=0.138.4+1.21.10` + wrapper `gradle-9.5.1` |

→ **我们选的版本组合与官方模板一致（只把 loom 从 SNAPSHOT 固定成 1.17.20、映射换成 Yarn）**：
`MC 1.21.10 + Loader 0.19.5 + Yarn 1.21.10+build.3 + Fabric API 0.138.4+1.21.10 + Loom 1.17.20`。

## 3. JDK / Gradle 工具链（本机现状核对）

- `java` / `javac` / `gradle` 都不在 PATH（任务描述属实）；但 `java-runtime-delta` 是完整 JDK 21 → **直接当 toolchain 用**。
- 本机已缓存 `gradle-9.1.0-bin`（`~\.gradle\wrapper\dists`），但 **Loom 1.17.20 要求 Gradle 插件 API 9.5.0**，
  用 9.1.0 直接报错（原文）：

```
No matching variant of net.fabricmc:fabric-loom:1.17.20 was found ...
  - Variant 'runtimeElements' ... attribute 'org.gradle.plugin.api-version' with value '9.5.0'
    and the consumer needed ... '9.1.0'
```

- 于是补 Gradle 9.5.1（与官方模板同版本）：
  - 官方 `services.gradle.org` 走代理只有 ~70 KB/s（10 分钟才 21 MB，已弃用）；
  - 改走腾讯镜像 `https://mirrors.cloud.tencent.com/gradle/gradle-9.5.1-bin.zip`：**7.5 s 下完 140,320,662 B**；
  - 校验：`Get-FileHash` = `bafc141b619ad6350fd975fc903156dd5c151998cc8b058e8c1044ab5f7b031f`，
    与官方 `gradle-9.5.1-bin.zip.sha256` **逐字符一致**；
  - 把 zip 预置进 wrapper 缓存目录（`wrapper` 的目录名 = MD5(URL) 转 base36，实测与已有 9.1.0 目录算法吻合：
    `iq79hdu3mqx29lgffhp8bfmx`），所以 `gradlew.bat` 之后**不再需要下发行包**。

## 4. 骨架：`mod/`（本次新增，可编译）

```
mod/
  build.gradle                    # Loom 1.17.20 + Yarn + Fabric API + runServer 配置
  gradle.properties               # 版本号与代理（systemProp）
  gradle-mirror.init.gradle       # 国内镜像仓库优先（绕过下面 §5 的 TLS 问题）
  gradlew / gradlew.bat / gradle/wrapper/*   # wrapper（distributionUrl=gradle-9.5.1）
  src/main/java/net/nbforge/mod/
    NbforgeMod.java               # 入口：注册 4 个自定义音色事件
    NbforgeSounds.java            # 音色 id 解析（注册表优先，资源包 id 兜底）
    NbforgeCommands.java          # /nbforge info|note|sustain|stopall
    NbforgeSustainQueue.java      # tick 级延音队列（重触发 + 包络衰减）
    NbforgeSelfTest.java          # -Dnbforge.selftest=true 自动自检后停服
  src/main/resources/fabric.mod.json
  src/main/resources/assets/nbforge/sounds.json   # demo_bell/pad/strings/bass
  src/main/resources/assets/nbforge/lang/{en_us,zh_cn}.json
```

设计要点（对应「自定义音色 + 独立力度/延音 + 保留 MC 特色」）：

1. **自定义音色绑定**：`Registry.register(Registries.SOUND_EVENT, nbforge:demo_*, SoundEvent.of(id))`
   —— 音色事件进注册表，数据包/命令可直接引用；
2. **独立力度/音高**：`World#playSound(Entity, x, y, z, SoundEvent, SoundCategory, float volume, float pitch)`
   的 volume（0–8）/pitch（0.25–4）**逐音指定**，不受 `/playsound` 的参数域和 master 耦合限制；
3. **独立延音**：`NbforgeSustainQueue` 每个音符一个 tick 作业，按间隔重触发采样、音量沿包络 `1.0→0.4`
   衰减；多条作业并行互不干扰（实测同 tick 3 条不同长度作业）；
4. **资源包是唯一采样来源**：mod 自己的 `sounds.json` 只做 `demo_* → bell/a3、pad/c4…` 的别名映射，
   其余音色按 `nbforge:<sounds.json 键名>`（如 `nbforge:strings_a3`）直接引用，**主线换采样不需要改 mod**；
5. **零 mixin**：本次不注入音符盒，先证明 Command API + SoundEvent 注册这两条通路可用（改动面最小）。

## 5. 构建（两次，失败→成功都留证）

```powershell
$env:JAVA_HOME = "C:\Users\hiliang\AppData\Roaming\.minecraft\runtime\java-runtime-delta"
cd C:\Users\hiliang\Documents\minecraft\nbforge\mod
.\gradlew.bat build --no-daemon --init-script gradle-mirror.init.gradle
```

- **第 1 次失败**（`:remapJar`，日志 `build/m3-mod-spike/build-attempt1-tls-fail.log`）：

```
> Could not download lwjgl-freetype-3.3.3-natives-windows.jar (org.lwjgl:lwjgl-freetype:3.3.3)
> Could not GET 'https://libraries.minecraft.net/org/lwjgl/lwjgl-freetype/3.3.3/lwjgl-freetype-3.3.3-natives-windows.jar'
> The server may not support the client's requested TLS protocol versions: (TLSv1.2, TLSv1.3)
  Caused by: javax.net.ssl.SSLHandshakeException: Remote host terminated the handshake
```

  对照实验：同一 URL 用 `curl.exe -x http://192.168.1.201:7890` **HTTP 200（1,035,586 B，0.5 s）**，直连也是 200
  → 不是网络不通，是本机 JDK+Gradle 走代理访问该域名时的 TLS 问题；受影响的是 LWJGL natives 等几个 jar。

  处理：`gradle-mirror.init.gradle` 把 **Maven Central 镜像（华为云）插到所有仓库最前面**，
  这些运行库在 Central 上都有同版本同名文件，命中后就不会再碰 `libraries.minecraft.net`；其余
  Fabric/Mojang 专有仓库保持原样（找不到时自动回落）。

- **第 2 次成功**（日志 `build/m3-mod-spike/build-success.log`）：

```
BUILD SUCCESSFUL in 42s
> Task :compileJava   > Task :processResources   > Task :classes   > Task :jar
> Task :processIncludeJars   > Task :sourcesJar   > Task :remapJar   > Task :remapSourcesJar
> Task :assemble      > Task :build
```

  产物：`mod/build/libs/nbforge-0.1.0.jar`（**15,409 B**，remap 后）+ `nbforge-0.1.0-sources.jar`（9,754 B）。
  jar 内容实测：`fabric.mod.json`、`assets/nbforge/sounds.json`、`assets/nbforge/lang/{en_us,zh_cn}.json`、
  `net/nbforge/mod/*.class`（6 个）。

## 6. 起服只读验证（在 testserver 的**副本**里，真档真服没动）

准备（全部落在 `_toolchain/`，仓库外）：

```powershell
robocopy testserver _toolchain\spike-testserver /E          # 202 MB 副本
# 副本 server.properties 改三行：server-port=25599 / level-name=nbforge_spike / motd=nbforge mod spike (copy)
# mods\ 放：nbforge-0.1.0.jar + fabric-api-0.138.4+1.21.10.jar
java -Xms1G -Xmx2G -Dnbforge.selftest=true <proxy props> -jar fabric-server-launch.jar nogui
```

关键日志（全文 `build/m3-mod-spike/selftest-server-latest.log`，另 `testserver` 原件未改）：

```
[14:31:19] [main/INFO]: Loading Minecraft 1.21.10 with Fabric Loader 0.19.5
[14:31:19] [main/INFO]: Loading 42 mods:
	- fabric-api 0.138.4+1.21.10
	   |-- fabric-api-base 1.0.0+14b92d896f
	- minecraft 1.21.10
	- nbforge 0.1.0                      <-- 自研 jar 被真加载器装载
[14:31:25] [main/INFO]: [nbforge] onInitialize：已注册自定义音色事件 demo_bell/demo_pad/demo_strings/demo_bass
[14:31:26] [Server thread/INFO]: [nbforge][selftest] sound_event 注册表条目数=1775
[14:31:26] [Server thread/INFO]: [nbforge][selftest] 注册表命中 nbforge:demo_bell -> true
[14:31:26] [Server thread/INFO]: [nbforge][selftest] 注册表命中 nbforge:demo_pad -> true
[14:31:26] [Server thread/INFO]: [nbforge][selftest] 注册表命中 nbforge:demo_strings -> true
[14:31:26] [Server thread/INFO]: [nbforge][selftest] 注册表命中 nbforge:demo_bass -> true
[14:31:26] [Server thread/INFO]: [nbforge][selftest] /nbforge 命令节点存在=true 子命令=info,note,sustain,stopall
[14:31:26] [Server thread/INFO]: [nbforge][selftest] 直接调用 playSound 2 次完成，累计击发=2
[14:31:26] [Server thread/INFO]: [nbforge] note nbforge:demo_bell vol=1.00 pitch=1.00 @ 0.0/-60.0/0.0
[14:31:26] [Server thread/INFO]: [nbforge] note nbforge:strings_a3 vol=0.35 pitch=2.00 @ 0.0/-60.0/0.0
[14:31:26] [Server thread/INFO]: [nbforge] sustain nbforge:demo_pad vol=0.80 pitch=1.00 共 60 刻 / 每 10 刻重触发（包络 1.0→0.4）
[14:31:26] [Server thread/INFO]: [nbforge] sustain nbforge:demo_bell vol=0.50 pitch=1.50 共 100 刻 / 每 5 刻重触发（包络 1.0→0.4）
[14:31:26] [Server thread/INFO]: [nbforge] sustain nbforge:demo_bass vol=0.90 pitch=0.50 共 40 刻 / 每 8 刻重触发（包络 1.0→0.4）
[14:31:28] [Server thread/INFO]: [nbforge][selftest] t=40 活跃延音作业=3 累计击发=22
[14:31:32] [Server thread/INFO]: [nbforge][selftest] 结束：累计击发=36 峰值并发作业=3 残留作业=0
[14:31:32] [Server thread/INFO]: [nbforge][selftest] === 自检通过，停服 ===
[14:31:32] [Server thread/INFO]: Stopping server
```

数字自洽：2 次直接播放 + 3 次 note + 31 次延音击发（60/10 + 100/5 + 40/8 = 6+20+5） = **36**；
峰值并发 3 条、退出时残留 0、服务器自行干净停服。
**这证明**：mod 侧注入点（注册表、命令树、playSound 调用）在真服务端环境全部可用，且
「同一时刻多条不同力度/不同长度的延音」在服务端调度层是成立的。

## 7. Yarn 映射侧证据（写代码前先查表，不靠猜 API）

从 `yarn-1.21.10+build.3-v2.jar` 解出 `mappings/mappings.tiny` 后逐条确认（命令见 §10）：

```
net/minecraft/registry/Registries   f  Lnet/minecraft/class_2378;            field_41172  SOUND_EVENT
net/minecraft/sound/SoundEvent      m  (Lnet/minecraft/class_2960;)…         method_47908 of
                                    m  (Lnet/minecraft/class_2960;F)…        method_47909 of
                                    m  ()Lnet/minecraft/class_2960;          id
net/minecraft/world/World           m  (class_1297;DDDLclass_3414;class_3419;FF)V            playSound
                                    m  (class_1297;DDDLclass_6880;class_3419;FFJ)V           playSound
net/minecraft/registry/Registry     m  (class_2378;class_2960;Object)Object                  register
                                    m  (class_2960;)Z                                            containsId
net/minecraft/server/command/CommandManager  m  (class_2168;Ljava/lang/String;)V             parseAndExecute
net/minecraft/server/command/ServerCommandSource m ()Lnet/minecraft/class_3218;             getWorld
net/minecraft/server/MinecraftServer m  ()Lnet/minecraft/class_3218;                         getOverworld / stop(Z)V
```

Fabric API 侧（从 Modrinth 的 0.138.4+1.21.10 胖 jar 里数出 43 个嵌套模块）：
`fabric-command-api-v2-2.4.0+c0ab2d5d6f`、`fabric-lifecycle-events-v1-2.6.9+33df5e6e6f` 均在，
`CommandRegistrationCallback` / `ServerTickEvents` / `ServerLifecycleEvents` 就是本次用的三个入口。

## 8. 未验证项（如实声明）

1. **客户端实际发声未验证**（最重要的一条）：本次是无客户端连接的无人值守验证，服务端只做到
   「调用成功 + 无异常 + 调度数字自洽」，**没有耳朵层面的证据**。要出声必须人开一个 1.21.10-Fabric 客户端进服
   （PCL2 里已有 `1.21.10-Fabric 0.19.5` 实例）听一次；单人（集成服务器）路径同理。
2. **采样来源依赖资源包**：`demo_*` 指向的 ogg 在 `nbforge_resources` 里（M2-1 已就位）。只装 mod 不装资源包
   会静默无声，这是设计如此（mod 不打包音频）。
3. **延音是「重触发 + 包络」，不是循环采样**：现有 ogg 是一次性 ~0.3 s 采样、没有 loop 点，
   长音靠每 N 刻重触发堆叠；听感上会有轻微「音头重复」，真正连续延音需要采样级 loop（见 §9 建议 b）。
4. **未知音色 id 不报错**：`SoundEvent.of(id)` 会造出动态事件，所以 `/nbforge note not_a_sound 1 1` 也会“成功”
   （日志里可见），客户端找不到采样时静默。若要严格校验，需要在命令层拦白名单。
5. **多人/带宽未测**：没验证 10+ 人同时听同一条延音作业的包量。
6. **未测项还包括**：`/reload` 后注册表行为、与数据包 tick 函数的时序耦合、mod 在客户端侧的资源包加载顺序。

## 9. 下一步：给 nbforge 主线接什么接口（1 页草案）

现状（M2-1/M2-2）：主线 Node 工具链产出**资源包（148 个音色）+ 数据包函数**，靠 `styx:play/...` 里的
`/playsound` 出声。后端 A 的价值只有两条：**每音独立力度/音高** 和 **能跨越单采样长度的延音**。
所以接口要围着这两条设计，其余保持不动。

**9.1 双通路分工（建议）**

| | 通路 0（现状，保留） | 通路 A（mod，本次） |
| --- | --- | --- |
| 出声方式 | 资源包 + `/playsound` | `/nbforge note` / `/nbforge sustain` |
| 力度 | 命令 volume（与 master 耦合） | 逐音 volume 0–8 |
| 音高 | 0.5–2.0 硬限制 | 0.25–4.0 |
| 延音 | 无（单次采样） | ticks + interval 重触发，包络 1.0→0.4 |
| 依赖 | 原版 | 服务端 + 客户端都要装 mod |
| 用途 | 兼容/无 mod 环境、快速试听 | 正式编曲的力度/延音表达 |

**9.2 数据契约（主线唯一需要产出的东西）**

每个音符一行，字段沿用现有 manifest：`{ tick, sound: "nbforge:strings_a3", volume: 0.35, pitch: 2.0, durationTicks?: 40 }`

- `sound` 规则：**永远 `<namespace>:<资源包 sounds.json 键名>`**，mod 不认识新键也不会崩
  （查不到注册表就动态引用），所以主线加音色不需要动 mod；
- `durationTicks` 缺省 → 翻译成 `/nbforge note <sound> <volume> <pitch>`；
  有值 → 翻译成 `/nbforge sustain <sound> <volume> <pitch> <durationTicks> <interval>`（建议 interval = 5–10 刻）。

**9.3 主线改动点（都很小）**

1. `src/emit/**`：生成资源包时**额外**生成一份 mod 版函数树 `data/nbforge/function/play/*`，
   与现有 `styx:play/*` 并行（同一 build 目录、同一 manifest，便于 A/B 对比）；
2. 派发仍走 M2-1 已验证的 tick 链（`styx:play/hifi/tick` 那种“每刻 dispatcher”），只是把
   `/playsound` 换成 `/nbforge note|sustain`；
3. `manifest` 增两个字段：`backend: "vanilla" | "mod"`、`durationTicks`，让 `npm run verify` 能分别验收；
4. 现有 `tests/` 里的资源包/合成器契约测试不动，新增一条「命令文本快照」测试防止两条通路漂移。

**9.4 mod 侧建议的后续接口（按收益排序）**

- a. `/nbforge schedule <name>`：一次读 `data/nbforge/scores/<name>.json` 注册整曲，
  避免「每音一条命令」在大型曲目上的函数开销；
- b. **采样级 loop**：给 `sounds.json` 的条目加循环配置或让 mod 侧指定 loop 段，
  把「重触发延音」升级成真正连续延音（当前最大听感短板）；
- c. `/nbforge tone <id> attack=… release=… curve=…`：把包络参数化，主线就能写力度曲线；
- d. 播放完成事件（供 DESIGN 里的粒子/灯光可视化消费）。

**9.5 建议的验收用例（M4 起）**

1. 客户端装 mod + 资源包进服，`/nbforge note demo_bell 1 1` 能听到钟琴；
2. 同一 tick 发 3 条 `0.2 / 0.6 / 1.0` 的同一音色，人耳可分档；
3. `/nbforge sustain demo_pad 0.8 1 60 10` 明显持续约 3 秒且渐弱；
4. 与通路 0 的 `/playsound` 同曲 A/B，力度/延音差异可辨；
5. 大型曲目（>500 音）下服务端 MSPT 与函数调用次数不超标。

## 10. 复现步骤（命令级）

```powershell
# 0) 前提：外网走代理
$p = "http://192.168.1.201:7890"

# 1) 查版本（结果见 §2）
curl.exe -s -x $p -L https://meta.fabricmc.net/v2/versions/game
curl.exe -s -x $p -L https://meta.fabricmc.net/v2/versions/loader/1.21.10
curl.exe -s -x $p -L https://meta.fabricmc.net/v2/versions/yarn/1.21.10
curl.exe -s -x $p -L "https://api.modrinth.com/v2/project/fabric-api/version?game_versions=%5B%221.21.10%22%5D"

# 2) 构建（JDK 用启动器运行时；镜像 init 脚本解决 TLS 问题）
$env:JAVA_HOME = "C:\Users\hiliang\AppData\Roaming\.minecraft\runtime\java-runtime-delta"
cd C:\Users\hiliang\Documents\minecraft\nbforge\mod
.\gradlew.bat build --no-daemon --init-script gradle-mirror.init.gradle
# → build\libs\nbforge-0.1.0.jar

# 3) 只读验证：副本起服 + 自检（真 testserver / 真存档不动）
robocopy C:\Users\hiliang\Documents\minecraft\testserver C:\Users\hiliang\Documents\minecraft\_toolchain\spike-testserver /E
#   副本 server.properties：server-port=25599、level-name=nbforge_spike
#   副本 mods\：nbforge-0.1.0.jar、fabric-api-0.138.4+1.21.10.jar、fabric-server-launch.jar 放副本根
cd C:\Users\hiliang\Documents\minecraft\_toolchain\spike-testserver
& "$env:JAVA_HOME\bin\java.exe" "-Xms1G" "-Xmx2G" "-Dnbforge.selftest=true" `
  "-Dhttp.proxyHost=192.168.1.201" "-Dhttp.proxyPort=7890" `
  "-Dhttps.proxyHost=192.168.1.201" "-Dhttps.proxyPort=7890" `
  -jar fabric-server-launch.jar nogui     # 120 刻后自动停服
```

> 注意：`-Dkey=value` 在 PowerShell 里必须**加引号**，否则会被拆成两段（本次踩过：
> `找不到或无法加载主类 .selftest=true`）。

## 11. 下载量与落位

| 物 | 大小 | 位置 |
| --- | --- | --- |
| Gradle 9.5.1 发行包 | 140.3 MB（+ 预置进 wrapper 缓存） | `_toolchain/gradle-9.5.1-mirror.zip`、`~\.gradle\wrapper\dists\gradle-9.5.1-bin\…` |
| Fabric API | 2.4 MB | `_toolchain/fabric-api-0.138.4+1.21.10.jar` |
| Fabric 服务端启动器 | 0.18 MB | `_toolchain/fabric-server-launch.jar` |
| MC/Fabric 运行库（Gradle 缓存） | ≈ 50 MB 级 | `~\.gradle\caches`、`~\.gradle\caches\fabric-loom` |
| testserver 副本（非下载） | 202 MB | `_toolchain/spike-testserver` |

**单次最大下载 140 MB（Gradle 发行包），全程未触及 1.5 GB 上限**；所有下载物都在仓库外的
`C:\Users\hiliang\Documents\minecraft\_toolchain\`（不在 nbforge 仓库里，`.gitignore` 另加了 `_toolchain/` 兜底）。

## 12. 交付物清单

- 本报告：`docs/M3-mod-spike-report.md`
- 可编译骨架：`mod/**`（含 `gradlew`、wrapper、`gradle-mirror.init.gradle`、5 个 Java 类、资源文件）
- 构建产物：`mod/build/libs/nbforge-0.1.0.jar`（15,409 B，remap 后可装载）
- 证据日志（`.gitignore` 已排除，不入库）：`build/m3-mod-spike/{build-success,build-attempt1-tls-fail,selftest-server-latest}.log`
