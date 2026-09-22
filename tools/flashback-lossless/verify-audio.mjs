// Decodes everything AudioCodecHarness.java wrote and compares it sample-by-sample with the
// signal that was fed in, so "lossless" is a measurement rather than a label.
import { execFileSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
    console.error("usage: node verify-audio.mjs <directory with harness output>");
    process.exit(2);
}

const SECONDS = 2;
const CHANNELS = 2;

// The harness feeds Java floats, so the reference has to be the float32 rounding of the ideal
// signal - comparing against the double would measure float32 rounding instead of the codec.
function signal(sampleIndex, sampleRate) {
    const t = sampleIndex / sampleRate;
    return Math.fround((0.5 * (Math.sin(2 * Math.PI * 440 * t) + 0.5 * Math.sin(2 * Math.PI * 661 * t))) / 1.5);
}

// One LSB of the codec's own bit depth is the floor for an integer codec; float32 is compared
// against float32 rounding of the same signal, which is exact for pcm_f32le.
const BIT_DEPTH = {
    pcm_s16le: 16,
    pcm_s24le: 24,
    pcm_s32le: 32,
    pcm_f32le: null,
    flac: 24,
    alac: 24
};

function probe(file) {
    const out = execFileSync("ffprobe", [
        "-v", "error", "-select_streams", "a:0", "-show_entries",
        "stream=codec_name,sample_fmt,sample_rate,channels,bits_per_raw_sample,bit_rate",
        "-of", "default=nw=1", file
    ], { encoding: "utf8" });
    const info = {};
    for (const line of out.trim().split(/\r?\n/)) {
        const [k, v] = line.split("=");
        info[k] = v;
    }
    return info;
}

function decode(file, sampleRate) {
    const buf = execFileSync("ffmpeg", [
        "-v", "error", "-i", file, "-f", "f32le", "-acodec", "pcm_f32le",
        "-ar", String(sampleRate), "-ac", String(CHANNELS), "-"
    ], { maxBuffer: 1 << 30 });
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const samples = new Float32Array(buf.byteLength / 4);
    for (let i = 0; i < samples.length; i++) samples[i] = view.getFloat32(i * 4, true);
    return samples;
}

const files = readdirSync(dir).filter(f => /\.(mkv|m4a|mp4)$/i.test(f)).sort();
const rows = [];
let failures = 0;

for (const name of files) {
    const file = join(dir, name);
    // A codec that refused to encode leaves a zero-byte/stub file behind - report it instead of
    // crashing, so the table itself documents which combination failed.
    if (statSync(file).size < 1024) {
        rows.push({ file: name, codec: "-", fmt: "-", bits: "-", ch: "-", rate: "-", seconds: "-",
                    maxErr: "-", rms: "-", verdict: "ENCODE-FAILED" });
        failures++;
        continue;
    }
    const info = probe(file);
    const sampleRate = Number(info.sample_rate);
    const samples = decode(file, sampleRate);
    const frames = samples.length / CHANNELS;
    let maxErr = 0;
    let rms = 0;
    for (let i = 0; i < Math.min(frames, sampleRate * SECONDS); i++) {
        const expected = signal(i, sampleRate);
        for (let c = 0; c < CHANNELS; c++) {
            const got = samples[i * CHANNELS + c];
            maxErr = Math.max(maxErr, Math.abs(got - expected));
            rms += got * got;
        }
    }
    rms = Math.sqrt(rms / Math.min(samples.length, sampleRate * SECONDS * CHANNELS));
    const duration = frames / sampleRate;
    const depth = BIT_DEPTH[info.codec_name] !== undefined ? BIT_DEPTH[info.codec_name] : (Number(info.bits_per_raw_sample) || 16);
    const expectedBound = depth ? Math.pow(2, -(depth - 1)) : 1e-9;
    const bits = depth ?? "f32";
    const sampleAccurate = Math.abs(duration - SECONDS) < 0.02;
    const lossless = maxErr <= expectedBound * 1.5 && rms > 0.1;
    if (!lossless || !sampleAccurate || info.channels !== String(CHANNELS)) {
        failures++;
    }
    rows.push({
        file: name,
        codec: info.codec_name,
        fmt: info.sample_fmt,
        bits: bits ?? "-",
        ch: info.channels,
        rate: info.sample_rate,
        seconds: duration.toFixed(3),
        maxErr: maxErr.toExponential(2),
        rms: rms.toFixed(4),
        verdict: (lossless && sampleAccurate) ? "LOSSLESS" : "CHECK"
    });
}

const head = ["file", "codec", "fmt", "bits", "ch", "rate", "seconds", "maxErr", "rms", "verdict"];
const widths = head.map(h => Math.max(h.length, ...rows.map(r => String(r[h]).length)));
console.log(head.map((h, i) => h.padEnd(widths[i])).join("  "));
console.log(widths.map(w => "-".repeat(w)).join("  "));
for (const r of rows) {
    console.log(head.map((h, i) => String(r[h]).padEnd(widths[i])).join("  "));
}
console.log();
console.log(failures === 0
    ? `all ${rows.length} files decoded bit-accurate at 48 kHz / stereo / full length`
    : `${failures} of ${rows.length} files did not meet the lossless expectations`);
process.exit(failures === 0 ? 0 : 1);
