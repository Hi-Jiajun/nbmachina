// Adds the lossless audio codecs (FLAC / ALAC / PCM 16 / 24 / 32 / float32) to a Flashback
// checkout. Same change as tools/flashback-lossless/build-patch.ps1, but applied to the source
// tree so the Gradle build can produce the remapped classes directly.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2];
if (!root) throw new Error("usage: node apply-fb-lossless.mjs <flashback checkout>");
const SRC = join(root, "src/main/java/com/moulberry/flashback");

function edit(relPath, replacements) {
    const file = join(SRC, relPath);
    const raw = readFileSync(file, "utf8");
    const eol = raw.includes("\r\n") ? "\r\n" : "\n";
    let text = raw;
    for (const [name, from, to] of replacements) {
        const needle = from.replaceAll("\n", eol);
        const repl = to.replaceAll("\n", eol);
        const count = text.split(needle).length - 1;
        if (count !== 1) throw new Error(`${relPath}: anchor "${name}" matched ${count} times (expected 1)`);
        text = text.replace(needle, repl);
    }
    writeFileSync(file, text);
    console.log("patched", relPath);
}

edit("combo_options/AudioCodec.java", [
    ["avutil import", "import org.bytedeco.ffmpeg.global.avcodec;\n",
                      "import org.bytedeco.ffmpeg.global.avcodec;\nimport org.bytedeco.ffmpeg.global.avutil;\n"],
    ["enum constants", "    VORBIS(\"Vorbis\", avcodec.AV_CODEC_ID_VORBIS);",
`    VORBIS("Vorbis", avcodec.AV_CODEC_ID_VORBIS),
    // Lossless codecs. The four entries above keep their ordinals (appended at the end).
    // FLAC/ALAC/PCM encoders reject the fltp sample format the others use - which is why the
    // FLAC line above is commented out - so sampleFormat() below returns a format each of them
    // actually supports.
    FLAC("FLAC", avcodec.AV_CODEC_ID_FLAC),
    ALAC("ALAC", avcodec.AV_CODEC_ID_ALAC),
    PCM_S16LE("PCM 16-bit", avcodec.AV_CODEC_ID_PCM_S16LE),
    PCM_S24LE("PCM 24-bit", avcodec.AV_CODEC_ID_PCM_S24LE),
    PCM_S32LE("PCM 32-bit", avcodec.AV_CODEC_ID_PCM_S32LE),
    PCM_F32LE("PCM float32", avcodec.AV_CODEC_ID_PCM_F32LE);`],
    ["sampleFormat()", "    public int codecId() {\n        return this.codecId;\n    }",
`    public int codecId() {
        return this.codecId;
    }

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
    }`]
]);

edit("exporting/AsyncFFmpegVideoWriter.java", [
    ["sample format", "                recorder.setSampleFormat(avutil.AV_SAMPLE_FMT_FLTP);",
                      "                recorder.setSampleFormat(settings.audioCodec().sampleFormat());"]
]);

console.log("done");
