#!/usr/bin/env node
// Stamps HDR10 colour metadata onto a finished video without re-encoding the picture.
//
// Why this exists: the ffmpeg binding Flashback bundles (javacv 1.5.10) exposes no way to set
// colour metadata before the container header is written, and tagging during the encode is
// overridden by the encoder's own VUI (verified: libx265 leaves color_primaries/transfer as
// "unknown" even with -color_primaries/-color_trc). A stream-copy remux afterwards does stick.
//
// Refuses to tag anything that is not 10-bit, so an 8-bit SDR file can never be turned into
// "fake HDR" by running this.
//
//   node tools/hdr-tag.mjs <in.mkv> [--out <out.mkv>] [--primaries bt2020] [--trc smpte2084]
//                           [--space bt2020nc] [--range pc]
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

const args = process.argv.slice(2);
const input = args[0];
if (!input) {
    console.error("usage: node tools/hdr-tag.mjs <in.mkv> [--out <out.mkv>] [--primaries ..] [--trc ..] [--space ..] [--range ..]");
    process.exit(2);
}
function opt(name, fallback) {
    const i = args.indexOf("--" + name);
    return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}
const output = opt("out", join(dirname(input), basename(input, extname(input)) + "_hdr" + extname(input)));
const primaries = opt("primaries", "bt2020");
const trc = opt("trc", "smpte2084");
const space = opt("space", "bt2020nc");
const range = opt("range", "pc");

if (!existsSync(input)) {
    console.error("no such file: " + input);
    process.exit(2);
}

function probe(file) {
    const out = execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "v:0", "-show_entries",
        "stream=codec_name,profile,pix_fmt,color_primaries,color_transfer,color_space,color_range,width,height",
        "-of", "default=nw=1", file
    ], { encoding: "utf8" });
    const info = {};
    for (const line of out.trim().split(/\r?\n/)) {
        const [k, v] = line.split("=");
        info[k] = v;
    }
    return info;
}

const before = probe(input);
const bits = (before.pix_fmt.match(/(\d+)le$/) || [])[1];
if (!bits || Number(bits) < 10) {
    console.error(`refusing to tag ${input}: video is ${before.pix_fmt} (${bits ?? "8"}-bit).`);
    console.error("HDR10 needs a 10-bit picture; tagging an 8-bit SDR file would only make it look wrong.");
    console.error("Pick a 10-bit encoder (libx265 / hevc_nvenc / av1_nvenc / libsvtav1) and export again.");
    process.exit(1);
}

execFileSync("ffmpeg", [
    "-v", "error", "-i", input, "-c", "copy",
    "-color_primaries", primaries, "-color_trc", trc, "-colorspace", space, "-color_range", range,
    "-y", output
], { stdio: ["ignore", "inherit", "inherit"] });

const after = probe(output);
console.log(`input : ${before.pix_fmt} ${before.profile} | primaries=${before.color_primaries} trc=${before.color_transfer} space=${before.color_space} range=${before.color_range}`);
console.log(`output: ${after.pix_fmt} ${after.profile} | primaries=${after.color_primaries} trc=${after.color_transfer} space=${after.color_space} range=${after.color_range}`);
console.log("written: " + output);
