import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = join(process.argv[2], "src/main/java/com/moulberry/flashback/exporting/AsyncFFmpegVideoWriter.java");
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const anchor = [
    "            if (settings.recordAudio()) {",
    "                recorder.setAudioCodec(settings.audioCodec().codecId());",
    ""
].join(eol);
if (raw.split(anchor).length - 1 !== 1) throw new Error("anchor matched " + (raw.split(anchor).length - 1));
const guard = [
    "            if (settings.recordAudio()) {",
    "                // FLAC at 192 kHz trips a swr_convert() bug inside the bundled javacv binding (the native",
    "                // ffmpeg flac encoder itself handles that rate fine). Fail fast with a readable message",
    "                // instead of dying in the middle of an export.",
    "                if (settings.audioCodec() == AudioCodec.FLAC && settings.sampleRate().rate() > 96000) {",
    "                    throw new RuntimeException(\"FLAC at \" + settings.sampleRate().rate() + \" Hz is not supported by the bundled javacv/ffmpeg binding - use PCM 24-bit or ALAC at that rate, or FLAC at 96 kHz or below\");",
    "                }",
    "                recorder.setAudioCodec(settings.audioCodec().codecId());",
    ""
].join(eol);
writeFileSync(file, raw.replace(anchor, guard));
console.log("FLAC@192k guard added");
