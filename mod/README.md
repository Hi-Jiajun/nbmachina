# nbforge mod（后端 A 骨架）

1.21.10 / Fabric 的最小可编译骨架：**自定义音色事件 + 每音独立力度/延音**，用来验证
「资源包 + `/playsound`」之外的注入点。

## 构建

需要 JDK 21（本机用 Minecraft 启动器自带的 `java-runtime-delta`）：

```powershell
$env:JAVA_HOME = "C:\Users\hiliang\AppData\Roaming\.minecraft\runtime\java-runtime-delta"
cd C:\Users\hiliang\Documents\minecraft\nbforge\mod
.\gradlew.bat build --no-daemon
```

产物：`build/libs/nbforge-0.1.0.jar`（remap 后的可装载 jar）。

## 游戏内命令

```
/nbforge info
/nbforge note <音色id> [音量 0-8] [音高 0.25-4]
/nbforge sustain <音色id> <音量> <音高> <总刻数> <间隔刻数>   # 重触发 + 包络衰减模拟延音
/nbforge stopall
```

音色 id 三种写法都认：`demo_bell`（mod 注册）、`nbforge:demo_bell`、`nbforge:strings_e4`
（资源包 `nbforge_resources` 里已有的 148 个音色，mod 直接按 id 引用）。

## 自检

加 `-Dnbforge.selftest=true` 起服（或 `gradlew runServer -Dnbforge.selftest=true`），
mod 会在服务器启动后自动跑一遍：注册表检查 → 命令节点检查 → 直接调用 `playSound`
（不走命令）→ 执行命令 → 延音队列 → 120 刻后打印统计并停服。
