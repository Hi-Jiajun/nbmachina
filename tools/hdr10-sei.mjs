#!/usr/bin/env node
// 往 Annex-B 裸 HEVC 里**无损注入 HDR10 静态元数据 SEI**（不重编码，像素一个字节都不动）。
//
// 为什么需要它：`hdr-tag.mjs` 只能写容器/VUI 的 colour primaries/transfer/matrix/range，
// 写不了 **mastering display** 与 **MaxCLL/MaxFALL**（ffmpeg 8.1 的 hevc_metadata bsf 也没有这两个选项，
// 2026-09-25 实测：Option 'mastering_display' not found）。而 Flashback 导出的 HDR10 里本来就没有这组 SEI。
//
// 做法：流式扫 NAL，每遇到 PPS(type 34) 就在其后插一个 prefix SEI(type 39)，带
//   · payload 137 mastering_display_colour_volume（BT.2020 原色 + D65 + 母版峰值/黑位）
//   · payload 144 content_light_level_info（MaxCLL / MaxFALL）
// 带内参数集每个 IRAP 都会重复 → 每个关键帧前都有静态元数据，跳转到任意位置都能读到。
//
// 用法（全流程示例，源 MKV → 注入 → 回封装成 MKV）：
//   ffmpeg -i in.mkv -an -c:v copy -f hevc - \
//     | node tools/hdr10-sei.mjs --cll 867,84 --master 1000 \
//     | ffmpeg -r 120 -f hevc -i - -c copy -f mp4 tmp_v.mp4        # 裸流没时间戳，先过一遍 MP4 才有 PTS
//   ffmpeg -i tmp_v.mp4 -i in.mkv -map 0:v -map 1:a -c copy \
//     -color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc -color_range pc out.mkv
//   （MKV 复用器拒绝没有时间戳的包，所以中间那步 MP4 不能省；若只要 MOV/MP4 输出可一步到位）
//
// 校验：`ffprobe -select_streams v:0 -show_entries frame_side_data=side_data_type -read_intervals "%+#1" out.mkv`
//   应看到 "Mastering display metadata" + "Content light level metadata"。
import process from 'node:process';

const arg = (name, dflt) => {
    const i = process.argv.indexOf('--' + name);
    return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : dflt;
};

const [maxCll, maxFall] = arg('cll', '867,84').split(',').map(Number);
const masterMaxNits = parseFloat(arg('master-max', '1000'));
const masterMinNits = parseFloat(arg('master-min', '0.0001'));
// BT.2020 原色 + D65（0.00002 为单位）
const G = [8500, 39850], B = [6550, 2300], R = [35400, 14600], WP = [15635, 16450];

const u16 = (v) => Buffer.from([(v >> 8) & 0xff, v & 0xff]);
const u32 = (v) => Buffer.from([(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]);

function emulationPrevent(bytes) {
    const out = [];
    let zeros = 0;
    for (const b of bytes) {
        if (zeros >= 2 && b <= 0x03) { out.push(0x03); zeros = 0; }
        out.push(b);
        zeros = b === 0 ? zeros + 1 : 0;
    }
    return Buffer.from(out);
}

function buildSei() {
    const md = Buffer.concat([
        u16(G[0]), u16(G[1]), u16(B[0]), u16(B[1]), u16(R[0]), u16(R[1]),
        u16(WP[0]), u16(WP[1]),
        u32(Math.round(masterMaxNits * 10000)),   // 0.0001 cd/m² 单位
        u32(Math.round(masterMinNits * 10000)),
    ]);
    const cll = Buffer.concat([u16(maxCll), u16(maxFall)]);
    const body = Buffer.concat([
        Buffer.from([137, md.length]), md,
        Buffer.from([144, cll.length]), cll,
        Buffer.from([0x80]),                       // rbsp_trailing_bits
    ]);
    return Buffer.concat([Buffer.from([0, 0, 0, 1, 0x4e, 0x01]), emulationPrevent(body)]);
}

const SEI = buildSei();
let buf = Buffer.alloc(0);
let nalStart = 0;
let insertedForAu = false;
let inserted = 0;

const findStartCode = (from) => {
    for (let i = from; i + 2 < buf.length; i++) {
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) return i;
    }
    return -1;
};

function drain(flush) {
    let next;
    while ((next = findStartCode(nalStart + 3)) >= 0) {
        const nal = buf.subarray(nalStart, next);
        const at = nal.indexOf(Buffer.from([0, 0, 1]));
        if (at >= 0 && at + 3 < nal.length) {
            const type = (nal[at + 3] >> 1) & 0x3f;
            process.stdout.write(nal);
            if (type === 34 && !insertedForAu) { process.stdout.write(SEI); insertedForAu = true; inserted++; }
            else if (type <= 31) insertedForAu = false;   // 遇到 slice = 进入下一个 AU
        }
        nalStart = next;
    }
    if (flush && nalStart < buf.length) {
        process.stdout.write(buf.subarray(nalStart));
        nalStart = buf.length;
    }
    if (nalStart > 0) { buf = Buffer.from(buf.subarray(nalStart)); nalStart = 0; }
}

process.stdin.on('data', (chunk) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    drain(false);
});
process.stdin.on('end', () => {
    drain(true);
    process.stderr.write(`[hdr10-sei] 插入 ${inserted} 个 SEI（母版显示 ${masterMaxNits}nit，MaxCLL=${maxCll}，MaxFALL=${maxFall}）\n`);
});
