# nbforge mod（后端 A 骨架）

1.21.10 / Fabric 的最小可编译骨架：**自定义音色事件 + 每音独立力度/延音**，用来验证
「资源包 + `/playsound`」之外的注入点。

> **P2（M3-16）起新增：无损音频引擎**——mod 自己开 OpenAL 设备播 WAV 母版，
> 不吃资源包、不走原版「只认 Ogg」的音频栈。详见 `docs/M3-16-mod-audio-engine.md`。

## 构建

需要 JDK 21（本机用 Minecraft 启动器自带的 `java-runtime-delta`）：

```powershell
$env:JAVA_HOME = "C:\Users\hiliang\AppData\Roaming\.minecraft\runtime\java-runtime-delta"
cd C:\Users\hiliang\Documents\minecraft\nbforge\mod
.\gradlew.bat build --no-daemon
```

产物：`build/libs/nbforge-0.1.0.jar`（remap 后的可装载 jar）。

## 游戏内命令

**服务端（原版通道，走客户端原版音频栈）**

```
/nbforge info
/nbforge note <音色id> [音量 0-8] [音高 0.25-4]
/nbforge sustain <音色id> <音量> <音高> <总刻数> <间隔刻数>   # 重触发 + 包络衰减模拟延音
/nbforge stopall
/nbforge play <乐器> <midi 0-127> [力度 1-127]              # P2：让执行者客户端用**无损引擎**播
```

**客户端（无损引擎，命令字是 `/nbfc`，避免顶掉服务端的 `/nbforge`）**

```
/nbfc status                      引擎状态（就绪/采样缓存/活跃声部/播放计数/最后错误）
/nbfc instruments                 列出已加载乐器
/nbfc note <乐器> <midi> [力度]    试听一颗音（同一套"力度→采样层+增益"映射）
/nbfc demo [乐器]                 试听 C4 G4 C5 E5 G5 × 力度 30/70/110
/nbfc reload                      改完 instruments.json 后热加载
```

乐器库来自 `config/nbforge/instruments.json`（由 `node tools/export-mod-instruments.mjs --deploy` 生成）：
区域 = 录音根音 × 力度区间，与离线渲染 `render-ensemble` **同一套映射**（同一批母版文件）。

音色 id 三种写法都认：`demo_bell`（mod 注册）、`nbforge:demo_bell`、`nbforge:strings_e4`
（资源包 `nbforge_resources` 里已有的 148 个音色，mod 直接按 id 引用）。

**不要给音色 id 加引号**——参数类型是 `IdentifierArgumentType`（与 vanilla `/playsound` 同款），
直接 `/nbforge note nbforge:demo_bell 1 1` 即可。注意 `sustain` 是 5 个参数：
`/nbforge sustain nbforge:demo_pad 0.8 1 60 10`（音色 音量 音高 总刻数 重触发间隔）。

## 自检

加 `-Dnbforge.selftest=true` 起服（或 `gradlew runServer -Dnbforge.selftest=true`），
mod 会在服务器启动后自动跑一遍：注册表检查 → 命令节点检查 → 直接调用 `playSound`
（不走命令）→ 执行命令 → 延音队列 → 120 刻后打印统计并停服。
