# Assembles the patched Flashback jar: official jar + the classes changed in this checkout.
# The Gradle/Loom build already produced intermediary-named classes, so no remap pass is needed
# here; the caller is expected to have verified that unmodified rebuilt classes are byte-identical
# to the official jar (diff-bytecode.mjs).
param(
    [string]$OfficialJar = "C:\Program Files\PCL2\.minecraft\versions\1.21.10-Fabric 0.19.5\mods\Flashback-0.39.9-for-MC1.21.10.jar.upstream",
    [string]$BuiltJar = "$PSScriptRoot\fb-src\build\libs\flashback-0.39.9.jar",
    [string]$OutputJar = "$PSScriptRoot\fb-gradle2\Flashback-0.39.9-nbm.jar"
)
$ErrorActionPreference = "Stop"
$jdk = "C:\Users\hiliang\AppData\Roaming\.minecraft\runtime\java-runtime-delta\bin"

$prefixes = @(
    "com/moulberry/flashback/combo_options/AudioCodec",
    "com/moulberry/flashback/combo_options/SampleRate",
    "com/moulberry/flashback/configuration/FlashbackConfigV1",
    "com/moulberry/flashback/editor/ui/windows/ExportScreenshotWindow",
    "com/moulberry/flashback/editor/ui/windows/StartExportWindow",
    "com/moulberry/flashback/exporting/AsyncFFmpegVideoWriter",
    "com/moulberry/flashback/exporting/ExportJob",
    "com/moulberry/flashback/exporting/ExportSettings",
    "com/moulberry/flashback/exporting/HdrExportBridge",
    "com/moulberry/flashback/exporting/PixelFormatHelper",
    "com/moulberry/flashback/exporting/SaveableFramebuffer",
    "com/moulberry/flashback/exporting/SaveableFramebufferQueue",
    "com/moulberry/flashback/mixin/audio/MixinAudioLibrary"
)

$stage = Join-Path $PSScriptRoot "fb-gradle2\stage"
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Path $stage | Out-Null

$entries = & "$jdk\jar.exe" tf $BuiltJar | Where-Object {
    $e = $_
    $prefixes | Where-Object { $e -like "$_.class" -or $e -like "$_`$*.class" }
}
Write-Host "injecting $($entries.Count) classes"
Push-Location $stage
& "$jdk\jar.exe" xf $BuiltJar @entries
Pop-Location

Copy-Item -LiteralPath $OfficialJar -Destination $OutputJar -Force
Push-Location $stage
& "$jdk\jar.exe" uf $OutputJar com
Pop-Location

$dump = (& "$jdk\javap.exe" -p -classpath $OutputJar com.moulberry.flashback.combo_options.SampleRate) -join "`n"
if ($dump -notmatch "HZ_192000") { throw "SampleRate missing from patched jar" }
$codecs = (& "$jdk\javap.exe" -p -classpath $OutputJar com.moulberry.flashback.combo_options.AudioCodec) -join "`n"
foreach ($c in @("FLAC", "ALAC", "PCM_S16LE", "PCM_S24LE", "PCM_S32LE", "PCM_F32LE")) {
    if ($codecs -notmatch "\b$c\b") { throw "AudioCodec.$c missing" }
}
$writer = (& "$jdk\javap.exe" -p -c -classpath $OutputJar com.moulberry.flashback.exporting.AsyncFFmpegVideoWriter) -join "`n"
if ($writer -notmatch "sampleFormat:\(\)I") { throw "writer does not use AudioCodec.sampleFormat()" }
if ($writer -notmatch "SampleRate.rate:\(\)I") { throw "writer does not use SampleRate.rate()" }
$job = (& "$jdk\javap.exe" -p -c -classpath $OutputJar com.moulberry.flashback.exporting.ExportJob) -join "`n"
if ($job -notmatch "ExportSettings.sampleRate:\(\)") { throw "ExportJob does not use the export sample rate" }
$mixin = (& "$jdk\javap.exe" -p -c -classpath $OutputJar com.moulberry.flashback.mixin.audio.MixinAudioLibrary) -join "`n"
if ($mixin -notmatch "SampleRate.rate:\(\)I") { throw "MixinAudioLibrary does not use the export sample rate" }
$bridge = (& "$jdk\javap.exe" -p -classpath $OutputJar com.moulberry.flashback.exporting.HdrExportBridge) -join "`n"
if ($bridge -notmatch "ColorTransform") { throw "HdrExportBridge missing from patched jar" }
$writerDump = (& "$jdk\javap.exe" -p -c -classpath $OutputJar com.moulberry.flashback.exporting.AsyncFFmpegVideoWriter) -join "`n"
if ($writerDump -notmatch "encodeHdr") { throw "writer has no encodeHdr (16-bit RGBA64) path" }
$pfh = (& "$jdk\javap.exe" -p -classpath $OutputJar com.moulberry.flashback.exporting.PixelFormatHelper) -join "`n"
if ($pfh -notmatch "supportsPixelFormat") { throw "PixelFormatHelper has no supportsPixelFormat (10-bit probe)" }
$fb = (& "$jdk\javap.exe" -p -c -classpath $OutputJar com.moulberry.flashback.exporting.SaveableFramebuffer) -join "`n"
if ($fb -notmatch "finishDownloadHdr") { throw "SaveableFramebuffer has no 16-bit readback" }
$q = (& "$jdk\javap.exe" -p -classpath $OutputJar 'com.moulberry.flashback.exporting.SaveableFramebufferQueue$DownloadedFrame') -join "`n"
if ($q -notmatch "hdrPointer") { throw "DownloadedFrame does not carry the HDR pointer" }

$sha = (Get-FileHash -LiteralPath $OutputJar -Algorithm SHA256).Hash
Write-Host "patched jar : $OutputJar"
Write-Host "size        : $((Get-Item $OutputJar).Length) bytes"
Write-Host "sha256      : $sha"
