// Rewrites a fresh Moulberry/Flashback checkout so it can be built locally without the
// ~2 GB javacv-platform download: the released jar already bundles bytedeco/javacv, imgui and
// lwjgl-nfd, so those come from local files / plain compileOnly deps instead. The build is only
// used to produce the classes that get injected back into the released jar.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const file = join(process.argv[2], "build.gradle");
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const lines = raw.split(/\r?\n/);

// 1. the bytedeco block: from its comment down to the first line that is just "    })"
const ffmpegIdx = lines.findIndex(l => l.trim() === "// FFmpeg");
if (ffmpegIdx < 0) throw new Error("// FFmpeg comment not found");
let endIdx = -1;
for (let i = ffmpegIdx; i < lines.length; i++) {
    if (lines[i] === "    })") { endIdx = i; break; }
}
if (endIdx < 0) throw new Error("end of bytedeco block not found");
lines.splice(ffmpegIdx, endIdx - ffmpegIdx + 1,
    "    // Local build: bytedeco/javacv is already bundled inside the released jar, so the",
    "    // classes are taken from a local file instead of pulling javacv-platform (~2 GB of natives).",
    "    compileOnly files('deps/bytedeco-shaded.jar')");

// 2. imgui -> local files
const swap = [
    ["    shadow(implementation(rootProject.files('deps/imgui-binding-1.90.0.jar')))",
     "    compileOnly files('deps/imgui-binding-1.90.0.jar')"],
    ["    shadow(api(rootProject.files('deps/imgui-natives.jar')))",
     "    compileOnly files('deps/imgui-natives.jar')"],
    ["    shadow(implementation(nfdVersion) {", "    compileOnly(nfdVersion) {"]
];
for (const [from, to] of swap) {
    const i = lines.findIndex(l => l.trim() === from.trim());
    if (i < 0) throw new Error("line not found: " + from);
    lines[i] = to;
}

// the nfd block used to be a shadow(...) call, so its closing line has to lose the ")"
const nfdStart = lines.findIndex(l => l.trim() === "compileOnly(nfdVersion) {");
if (nfdStart < 0) throw new Error("nfd compileOnly block not found");
for (let i = nfdStart; i < lines.length; i++) {
    if (lines[i] === "    })") { lines[i] = "    }"; break; }
}

// 3. drop the six natives-* classifier blocks (only needed when packaging a full mod jar)
for (const platform of ["macos", "linux", "windows", "macos-arm64", "linux-arm64", "windows-arm64"]) {
    const start = lines.findIndex(l => l.includes(`shadow(api("org.lwjgl:lwjgl-nfd::natives-${platform}")`));
    if (start < 0) throw new Error("nfd natives block not found: " + platform);
    let end = -1;
    for (let i = start; i < lines.length; i++) {
        if (lines[i] === "    })") { end = i; break; }
    }
    if (end < 0) throw new Error("end of nfd block not found: " + platform);
    lines.splice(start, end - start + 1);
}

writeFileSync(file, lines.join(eol));
console.log("build.gradle rewritten for local build");
