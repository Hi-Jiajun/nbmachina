# M5-43 · 导出期间的系统/进程监控（跑在另一个终端，导出崩溃后能回看是内存、显存还是磁盘先爆）
#
# 背景：2026-09-25 14:18 的导出在 42 分钟后崩在编码线程，真实异常被
# "Cannot encode after finish()" 盖住；同一次崩溃报告里系统的"虚拟内存/页面文件"
# 已经顶到上限（196 GB 上限、194 GB 已用，而 9-19～9-24 几次崩溃只有 50–73 GB），
# 随后机器连蓝屏 dump 都没有就硬重置了。所以下次导出要留下时间序列。
#
# 用法：pwsh -NoProfile -File tools/export-watch.ps1            # 每 10s 一行，java 进程退出自动收尾
#       pwsh -NoProfile -File tools/export-watch.ps1 -IntervalSec 5
param(
    [int]$IntervalSec = 10,
    [string]$OutDir = "$PSScriptRoot\..\_scratch-m3-78\export-watch"
)

$ErrorActionPreference = 'SilentlyContinue'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$csv = Join-Path $OutDir "watch-$stamp.csv"
"time,commitUsedGB,commitLimitGB,ramFreeGB,pagefileUsedGB,pagefilePeakGB,cFreeGB,gpuUsedMB,gpuTotalMB,gpuUtil,gpuTempC,gpuPowerW,gameWorkingSetGB,gamePrivateGB,handles" |
    Out-File -LiteralPath $csv -Encoding UTF8

function Sample {
    $mem = Get-CimInstance Win32_OperatingSystem
    $pf = Get-CimInstance Win32_PageFileUsage | Select-Object -First 1
    $disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
    $commitUsed = (Get-Counter '\Memory\Committed Bytes').CounterSamples.CookedValue
    $commitLimit = (Get-Counter '\Memory\Commit Limit').CounterSamples.CookedValue
    $gpu = $null
    if (Get-Command nvidia-smi -ErrorAction SilentlyContinue) {
        $gpu = (& nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw --format=csv,noheader,nounits 2>$null) -split ','
    }
    $game = Get-Process java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Minecraft' } | Select-Object -First 1
    [pscustomobject]@{
        time          = (Get-Date).ToString('HH:mm:ss')
        commitUsedGB  = [Math]::Round($commitUsed / 1GB, 2)
        commitLimitGB = [Math]::Round($commitLimit / 1GB, 2)
        ramFreeGB     = [Math]::Round($mem.FreePhysicalMemory / 1MB, 2)
        pagefileUsedGB = if ($pf) { [Math]::Round($pf.CurrentUsage / 1KB, 2) } else { 0 }
        pagefilePeakGB = if ($pf) { [Math]::Round($pf.PeakUsage / 1KB, 2) } else { 0 }
        cFreeGB       = [Math]::Round($disk.FreeSpace / 1GB, 1)
        gpuUsedMB     = if ($gpu) { [int]$gpu[0] } else { -1 }
        gpuTotalMB    = if ($gpu) { [int]$gpu[1] } else { -1 }
        gpuUtil       = if ($gpu) { [int]$gpu[2] } else { -1 }
        gpuTempC      = if ($gpu) { [int]$gpu[3] } else { -1 }
        gpuPowerW     = if ($gpu) { [int][double]$gpu[4] } else { -1 }
        gameWorkingSetGB = if ($game) { [Math]::Round($game.WorkingSet64 / 1GB, 2) } else { 0 }
        gamePrivateGB = if ($game) { [Math]::Round($game.PrivateMemorySize64 / 1GB, 2) } else { 0 }
        handles       = if ($game) { $game.HandleCount } else { 0 }
    }
}

Write-Host "监控开始 → $csv（每 ${IntervalSec}s 一行；导出结束/进程退出自动停）" -ForegroundColor Cyan
$peak = @{ commit = 0; gpu = 0; ws = 0 }
while ($true) {
    $s = Sample
    if (-not (Get-Process java -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -match 'Minecraft' })) {
        Write-Host "`nMinecraft 进程已退出，监控结束。" -ForegroundColor Yellow
        break
    }
    ($s.PSObject.Properties.Value -join ',') | Out-File -LiteralPath $csv -Append -Encoding UTF8
    $peak.commit = [Math]::Max($peak.commit, $s.commitUsedGB)
    $peak.gpu = [Math]::Max($peak.gpu, $s.gpuUsedMB)
    $peak.ws = [Math]::Max($peak.ws, $s.gameWorkingSetGB)
    Write-Host ("{0}  提交 {1,6:N1}/{2:N1} GB  RAM空 {3,5:N1} GB  页面文件 {4,5:N1} GB(峰 {5:N1})  C盘 {6,5:N1} GB  显存 {7}/{8} MB  游戏WS {9,5:N1} GB  句柄 {10}" -f `
        $s.time, $s.commitUsedGB, $s.commitLimitGB, $s.ramFreeGB, $s.pagefileUsedGB, $s.pagefilePeakGB, $s.cFreeGB,
        $s.gpuUsedMB, $s.gpuTotalMB, $s.gameWorkingSetGB, $s.handles)
    Start-Sleep -Seconds $IntervalSec
}
Write-Host ("峰值：提交 {0:N1} GB / 显存 {1} MB / 游戏工作集 {2:N1} GB" -f $peak.commit, $peak.gpu, $peak.ws) -ForegroundColor Cyan
Write-Host "CSV：$csv" -ForegroundColor Cyan
