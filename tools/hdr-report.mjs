#!/usr/bin/env node
// Answers "is this actually HDR, or just an SDR picture in an HDR-tagged container?"
//
// Samples one frame per second as raw 10-bit YUV, reads the luma plane, converts the code values
// through the PQ (ST2084) EOTF into nits and reports the distribution:
//   * peak ≈ 203 nits  -> nothing above SDR white: the光影 tonemapped before the capture, so the
//                         container is HDR but the picture has no extra headroom
//   * peak well above 203 nits (a few hundred to ~1000) -> real highlight headroom captured
//
//   node tools/hdr-report.mjs <video>
import { execFileSync } from "node:child_process";

const file = process.argv[2];
if (!file) {
    console.error("usage: node tools/hdr-report.mjs <video>");
    process.exit(2);
}

const info = {};
for (const line of execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries",
    "stream=codec_name,profile,pix_fmt,color_primaries,color_transfer,color_space,color_range,width,height,r_frame_rate",
    "-of", "default=nw=1", file
], { encoding: "utf8" }).trim().split(/\r?\n/)) {
    const [k, v] = line.split("=");
    info[k] = v;
}

const width = Number(info.width);
const height = Number(info.height);
if (!/yuv.*10/.test(info.pix_fmt || "")) {
    console.error(`video is ${info.pix_fmt} - not a 10-bit stream, nothing to measure.`);
    process.exit(1);
}
const range = info.color_range === "pc" ? "pc" : "tv";
const sampleRate = 1; // one frame per second

const raw = execFileSync("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `fps=${sampleRate}`, "-f", "rawvideo", "-pix_fmt", "yuv420p10le", "-"
], { maxBuffer: 1 << 30 });

// PQ (ST2084) EOTF: code value in [0,1] -> display luminance in nits.
function pqToNits(e) {
    const m1 = 2610 / 4096 / 4, m2 = 2523 / 4096 * 128, c1 = 3424 / 4096, c2 = 2413 / 4096 * 32, c3 = 2392 / 4096 * 32;
    const p = Math.max(e, 1e-8);
    const num = Math.max(p ** (1 / m2) - c1, 0);
    const den = c2 - c3 * p ** (1 / m2);
    return 10000 * (num / den) ** (1 / m1);
}

// 10-bit luma is stored little-endian in 16-bit words; limited range maps 64..940 to 0..1.
function lumaToFloat(code) {
    const v = code / 1023;
    return range === "pc" ? v : Math.max(0, Math.min(1, (v * 1023 - 64) / (940 - 64)));
}

const frameBytes = width * height * 3; // yuv420p10le: 2 bytes per sample, 4:2:0 => 1.5 samples/px
const frames = Math.floor(raw.length / frameBytes);
if (frames === 0) {
    console.error("no frames decoded");
    process.exit(1);
}

const luma = new Uint16Array(width * height);
const histogram = new Float64Array(1024);
let peak = 0;
for (let f = 0; f < frames; f++) {
    const base = f * frameBytes;
    for (let i = 0; i < width * height; i++) {
        luma[i] = raw.readUInt16LE(base + i * 2);
        histogram[luma[i]]++;
        if (luma[i] > peak) peak = luma[i];
    }
}
const total = histogram.reduce((a, b) => a + b, 0);

function percentile(p) {
    let acc = 0;
    for (let code = 0; code < 1024; code++) {
        acc += histogram[code];
        if (acc / total >= p) return pqToNits(lumaToFloat(code));
    }
    return pqToNits(lumaToFloat(1023));
}

const peakNits = pqToNits(lumaToFloat(peak));
const p999 = percentile(0.999);
const p99 = percentile(0.99);
const p50 = percentile(0.5);

console.log(`${file}`);
console.log(`  ${info.codec_name} ${info.profile} ${info.pix_fmt}  ${width}x${height}  ${info.color_primaries}/${info.color_transfer}/${info.color_space}/${info.color_range}`);
console.log(`  frames sampled     : ${frames} (1/s)`);
console.log(`  peak               : ${peak} (${peakNits.toFixed(0)} nits)`);
console.log(`  p99.9 / p99 / p50  : ${p999.toFixed(0)} / ${p99.toFixed(0)} / ${p50.toFixed(0)} nits`);

let verdict;
if (info.color_transfer !== "smpte2084") {
    verdict = "not PQ-tagged - the player will not treat this as HDR";
} else if (peakNits <= 240) {
    verdict = "PQ-tagged but nothing above SDR white: the picture was tonemapped before capture (no extra headroom)";
} else if (peakNits <= 400) {
    verdict = "modest highlight headroom captured";
} else {
    verdict = "real highlight headroom captured";
}
console.log("  verdict            : " + verdict);
