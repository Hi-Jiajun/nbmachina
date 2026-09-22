<#
  flashback-lossless - build-patch.ps1

  Turns a stock Flashback jar into a build that can export lossless audio.

  What the patch changes (two upstream files, one new method):
    combo_options/AudioCodec.java          + six enum constants (FLAC, ALAC, PCM 16/24/32, PCM f32)
                                           + AudioCodec.sampleFormat()
    exporting/AsyncFFmpegVideoWriter.java  recorder.setSampleFormat(fltp) -> settings.audioCodec().sampleFormat()

  Upstream hard-codes AV_SAMPLE_FMT_FLTP for every audio codec, which is exactly why the author
  left FLAC commented out ("Removed because it doesn't support fltp sample format"). ffmpeg's
  FLAC/ALAC/PCM encoders reject fltp at avcodec_open2; each of them wants s16/s32/s32p/flt.

  How the patched classes get into the jar:
    Flashback publishes its jar with intermediary Minecraft names, and AsyncFFmpegVideoWriter
    references exactly one Minecraft class (com.mojang.blaze3d.platform.NativeImage). Instead of
    running a remap pass, the patched source is compiled against a tiny stub whose members carry
    the intermediary names already present in the shipped jar (stub/net/minecraft/class_1011.java),
    so the emitted bytecode matches the rest of the jar.

  Fails loudly instead of guessing: the pristine upstream sources are compiled with the same
  toolchain and compared against the shipped classes (see diff-bytecode.mjs). The script aborts if
  the recompiled upstream code is not bytecode-equivalent to the jar being patched, so a jar built
  from different sources never gets silently mixed with this patch.
#>
[CmdletBinding()]
param(
    # A checkout of https://github.com/Moulberry/Flashback at the branch matching the jar
    # (branch 1.21.10 == 0.39.9 at the time of writing).
    [Parameter(Mandatory = $true)][string]$UpstreamSource,
    # The stock Flashback jar that is going to be patched.
    [Parameter(Mandatory = $true)][string]$FlashbackJar,
    [string]$OutputJar = "",
    [string]$JavaHome = "C:\Users\hiliang\AppData\Roaming\.minecraft\runtime\java-runtime-delta",
    [string]$LwjglJar = "C:\Program Files\PCL2\.minecraft\libraries\org\lwjgl\lwjgl\3.3.3\lwjgl-3.3.3.jar",
    [string]$Slf4jJar = "C:\Program Files\PCL2\.minecraft\libraries\org\slf4j\slf4j-api\2.0.16\slf4j-api-2.0.16.jar",
    [string]$AnnotationsJar = "",
    [switch]$Verify
)

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$work = Join-Path $root "work"

if (-not $OutputJar) { $OutputJar = Join-Path $work "Flashback-lossless.jar" }
if (-not $AnnotationsJar) {
    $AnnotationsJar = (Get-ChildItem "$env:USERPROFILE\.gradle\caches\modules-2\files-2.1\org.jetbrains\annotations" -Recurse -Filter "annotations-*.jar" -ErrorAction SilentlyContinue |
        Sort-Object { [version]($_.BaseName -replace '^annotations-','') } | Select-Object -Last 1).FullName
}

$javac = Join-Path $JavaHome "bin\javac.exe"
$javap = Join-Path $JavaHome "bin\javap.exe"
$jarExe = Join-Path $JavaHome "bin\jar.exe"
$codecSrc = Join-Path $UpstreamSource "src\main\java\com\moulberry\flashback\combo_options\AudioCodec.java"
$writerSrc = Join-Path $UpstreamSource "src\main\java\com\moulberry\flashback\exporting\AsyncFFmpegVideoWriter.java"

foreach ($tool in @($javac, $javap, $jarExe, $FlashbackJar, $LwjglJar, $Slf4jJar, $AnnotationsJar, $codecSrc, $writerSrc)) {
    if (-not (Test-Path $tool)) { throw "missing required file: $tool" }
}

function Edit-Source {
    param([string]$Text, [string]$From, [string]$To, [string]$What)
    $count = ([regex]::Matches($Text, [regex]::Escape($From))).Count
    if ($count -ne 1) { throw "anchor for $What matched $count times (expected 1) - upstream source has changed" }
    return $Text.Replace($From, $To)
}

# git checkout on Windows may produce either CRLF or LF, so the anchors follow the file's own style.
function Get-Eol {
    param([string]$Text)
    if ($Text -match "`r`n") { return "`r`n" }
    return "`n"
}

# ---- the patch itself -------------------------------------------------------------------------

function Get-PatchedAudioCodec {
    param([string]$Text)
    $eol = Get-Eol $Text
    $text = Edit-Source $Text "import org.bytedeco.ffmpeg.global.avcodec;$eol" "import org.bytedeco.ffmpeg.global.avcodec;${eol}import org.bytedeco.ffmpeg.global.avutil;$eol" "avutil import"
    $constants = @'
    VORBIS("Vorbis", avcodec.AV_CODEC_ID_VORBIS),
    // Lossless codecs (added by nbmachina). The four entries above keep their ordinals.
    // FLAC/ALAC/PCM encoders do not accept the fltp sample format the others use - which is why
    // the FLAC line above is commented out - so sampleFormat() below returns a format each of
    // them actually supports.
    FLAC("FLAC", avcodec.AV_CODEC_ID_FLAC),
    ALAC("ALAC", avcodec.AV_CODEC_ID_ALAC),
    PCM_S16LE("PCM 16-bit", avcodec.AV_CODEC_ID_PCM_S16LE),
    PCM_S24LE("PCM 24-bit", avcodec.AV_CODEC_ID_PCM_S24LE),
    PCM_S32LE("PCM 32-bit", avcodec.AV_CODEC_ID_PCM_S32LE),
    PCM_F32LE("PCM float32", avcodec.AV_CODEC_ID_PCM_F32LE);
'@
    $text = Edit-Source $text "    VORBIS(`"Vorbis`", avcodec.AV_CODEC_ID_VORBIS);" $constants.TrimEnd("`r", "`n") "enum constants"
    $method = @'

    /**
     * Sample format handed to the ffmpeg encoder. Lossless encoders reject fltp, so each one gets
     * a format it accepts; ffmpeg resamples the captured float samples into it.
     */
    public int sampleFormat() {
        return switch (this) {
            case FLAC, PCM_S24LE, PCM_S32LE -> avutil.AV_SAMPLE_FMT_S32;
            case ALAC -> avutil.AV_SAMPLE_FMT_S32P;
            case PCM_S16LE -> avutil.AV_SAMPLE_FMT_S16;
            case PCM_F32LE -> avutil.AV_SAMPLE_FMT_FLT;
            default -> avutil.AV_SAMPLE_FMT_FLTP;
        };
    }
'@
    $anchor = "    public int codecId() {$eol        return this.codecId;$eol    }"
    return Edit-Source $text $anchor ($anchor + $method.TrimEnd("`r", "`n")) "sampleFormat() method"
}

function Get-PatchedWriter {
    param([string]$Text)
    Edit-Source $Text "recorder.setSampleFormat(avutil.AV_SAMPLE_FMT_FLTP);" "recorder.setSampleFormat(settings.audioCodec().sampleFormat());" "setSampleFormat call"
}

# Compiles AsyncFFmpegVideoWriter against intermediary-named Minecraft members instead of running
# a yarn/intermediary remap pass. Names/descriptors come from the shipped jar.
function Convert-ToIntermediaryText {
    param([string]$Text, [string]$What)
    $text = Edit-Source $text 'import com.mojang.blaze3d.platform.NativeImage;' 'import net.minecraft.class_1011;' "NativeImage import"
    $text = Edit-Source $text 'public void encode(NativeImage src,' 'public void encode(class_1011 src,' "encode() signature"
    $text = Edit-Source $text 'new ImageFrame(src.pixels, (int) src.size, src.getWidth(), src.getHeight(),' 'new ImageFrame(src.field_4988, (int) src.field_4987, src.method_4307(), src.method_4323(),' "ImageFrame construction"
    $text = Edit-Source $text '4, Frame.DEPTH_INT, src.getWidth(),' '4, Frame.DEPTH_INT, src.method_4307(),' "frame width"
    if ($text -match 'NativeImage|src\.pixels') { throw "intermediary rewrite incomplete ($What)" }
    return $text
}

function Save-Javap {
    param([string]$ClassPath, [string]$ClassName, [string]$OutFile)
    $raw = & $env:ComSpec /c "`"$javap`" -p -c -classpath `"$ClassPath`" $ClassName 2>&1"
    if ($LASTEXITCODE -ne 0) { throw "javap failed for $ClassName in $ClassPath`n$raw" }
    Set-Content -LiteralPath $OutFile -Value ($raw -join "`n") -NoNewline
}

$jvmLocale = @("-J-Duser.language=en", "-J-Duser.country=US")
$stubDir = Join-Path $work "stub-classes"
$classDir = Join-Path $work "classes"
$origDir = Join-Path $work "classes-orig"
$genDir = Join-Path $work "gen"
$genOrigDir = Join-Path $work "gen-orig"
$outDump = Join-Path $work "javap"
foreach ($dir in @($stubDir, $classDir, $origDir, $genDir, $genOrigDir, $outDump)) {
    if (Test-Path $dir) { Remove-Item -Recurse -Force $dir }
    New-Item -ItemType Directory -Path $dir | Out-Null
}

$patchedCodec = Join-Path $genDir "AudioCodec.java"
$patchedWriter = Join-Path $genDir "AsyncFFmpegVideoWriter.java"
$origCodec = Join-Path $genOrigDir "AudioCodec.java"
$origWriter = Join-Path $genOrigDir "AsyncFFmpegVideoWriter.java"

Write-Host "== 1/6 generate patched sources (upstream stays untouched) =="
Set-Content -LiteralPath $patchedCodec -Value (Get-PatchedAudioCodec (Get-Content -Raw -LiteralPath $codecSrc)) -NoNewline
Set-Content -LiteralPath $patchedWriter -Value (Convert-ToIntermediaryText -Text (Get-PatchedWriter (Get-Content -Raw -LiteralPath $writerSrc)) -What "patched writer") -NoNewline
Copy-Item -LiteralPath $codecSrc -Destination $origCodec -Force
Set-Content -LiteralPath $origWriter -Value (Convert-ToIntermediaryText -Text (Get-Content -Raw -LiteralPath $writerSrc) -What "pristine writer") -NoNewline

Write-Host "== 2/6 compile NativeImage stub (intermediary names) =="
& $javac @jvmLocale --release 21 -nowarn -d $stubDir (Join-Path $root "stub\net\minecraft\class_1011.java")
if ($LASTEXITCODE -ne 0) { throw "stub compile failed" }

$cp = @($FlashbackJar, $LwjglJar, $Slf4jJar, $AnnotationsJar) -join ";"

Write-Host "== 3/6 compile patched classes =="
& $javac @jvmLocale --release 21 -nowarn -d $classDir -cp "$cp;$stubDir" $patchedCodec $patchedWriter
if ($LASTEXITCODE -ne 0) { throw "patched compile failed" }

Write-Host "== 4/6 compile pristine upstream sources (drift check) =="
& $javac @jvmLocale --release 21 -nowarn -d $origDir -cp "$cp;$stubDir" $origCodec $origWriter
if ($LASTEXITCODE -ne 0) { throw "pristine compile failed" }

$targets = @(
    "com.moulberry.flashback.exporting.AsyncFFmpegVideoWriter",
    "com.moulberry.flashback.exporting.AsyncFFmpegVideoWriter`$ImageFrame",
    "com.moulberry.flashback.exporting.AsyncFFmpegVideoWriter`$1",
    "com.moulberry.flashback.exporting.AsyncFFmpegVideoWriter`$2",
    "com.moulberry.flashback.combo_options.AudioCodec"
)
$diffTool = Join-Path $root "diff-bytecode.mjs"
$driftOk = $true
Write-Host "== 5/6 drift check: recompiled upstream vs shipped jar =="
foreach ($t in $targets) {
    $safe = ($t -replace '[^\w]', '_')
    $shipDump = Join-Path $outDump "$safe.shipped.txt"
    $rebDump = Join-Path $outDump "$safe.rebuilt.txt"
    Save-Javap -ClassPath $FlashbackJar -ClassName $t -OutFile $shipDump
    Save-Javap -ClassPath $origDir -ClassName $t -OutFile $rebDump
    & node $diffTool $shipDump $rebDump $t
    if ($LASTEXITCODE -ne 0) { $driftOk = $false }
}
if (-not $driftOk) { throw "recompiled upstream code differs from the shipped jar - refusing to inject silently" }

Write-Host "== 6/6 inject patched classes into jar copy and verify =="
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $OutputJar) | Out-Null
Copy-Item -LiteralPath $FlashbackJar -Destination $OutputJar -Force
& $jarExe uf $OutputJar -C $classDir com
if ($LASTEXITCODE -ne 0) { throw "jar update failed" }

$codecDump = & $env:ComSpec /c "`"$javap`" -p -classpath `"$OutputJar`" com.moulberry.flashback.combo_options.AudioCodec"
$expected = 'AAC', 'MP3', 'OPUS', 'VORBIS', 'FLAC', 'ALAC', 'PCM_S16LE', 'PCM_S24LE', 'PCM_S32LE', 'PCM_F32LE'
foreach ($name in $expected) {
    if (-not ($codecDump -match "public static final com\.moulberry\.flashback\.combo_options\.AudioCodec $name;")) {
        throw "AudioCodec.$name missing from patched jar"
    }
}
$writerDump = & $env:ComSpec /c "`"$javap`" -p -c -classpath `"$OutputJar`" com.moulberry.flashback.exporting.AsyncFFmpegVideoWriter"
if (-not ($writerDump -match 'AudioCodec\.sampleFormat:\(\)I')) { throw "patched writer does not call AudioCodec.sampleFormat()" }
if ($writerDump -match 'AV_SAMPLE_FMT_FLTP') { throw "patched writer still hard-codes AV_SAMPLE_FMT_FLTP" }

Write-Host ""
Write-Host "patched jar : $OutputJar"
Write-Host "size        : $((Get-Item $OutputJar).Length) bytes"
Write-Host "sha256      : $((Get-FileHash -LiteralPath $OutputJar -Algorithm SHA256).Hash)"
Write-Host "codecs      : $($expected -join ', ')"

if ($Verify) {
    Write-Host ""
    Write-Host "== extra: encode/decode every lossless codec and compare samples =="
    $harness = Join-Path $work "harness"
    $audio = Join-Path $work "audio-test"
    New-Item -ItemType Directory -Force -Path $harness, $audio | Out-Null
    & $javac @jvmLocale --release 21 -nowarn -d $harness -cp $OutputJar (Join-Path $root "AudioCodecHarness.java")
    if ($LASTEXITCODE -ne 0) { throw "harness compile failed" }
    & (Join-Path $JavaHome "bin\java.exe") -cp "$harness;$OutputJar" AudioCodecHarness $audio
    & node (Join-Path $root "verify-audio.mjs") $audio
}
