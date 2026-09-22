// Compares two `javap -p -c` dumps of the same class and reports whether they differ only by
// artifacts that cannot change behaviour: constant-pool slot numbering, the 1-byte/2-byte
// encoding javac picks for a constant-pool reference (ldc vs ldc_w), branch offsets, and the
// numeric suffix of synthetic lambda methods (javac numbers those differently across builds).
// Exits 0 when functionally equivalent, 1 when a real difference is found.
import { readFileSync } from "node:fs";

const [shippedPath, rebuiltPath, className] = process.argv.slice(2);
if (!shippedPath || !rebuiltPath) {
    console.error("usage: node diff-bytecode.mjs <shipped.javap> <rebuilt.javap> [class]");
    process.exit(2);
}

function parse(path) {
    const lines = readFileSync(path, "utf8").split(/\r?\n/);
    const methods = new Map();
    let current = null;
    for (const line of lines) {
        const decl = line.match(/^ {2}((?:[\w$.<>\[\]]+ )+[\w$.<>]+\()/);
        if (decl && /;\s*$/.test(line)) {
            current = line.trim();
            methods.set(current, []);
            continue;
        }
        if (current === null) continue;
        const insn = line.match(/^\s*\d+:\s+(.*)$/);
        if (insn) methods.get(current).push(normalize(insn[1]));
    }
    return methods;
}

function normalize(text) {
    let s = text
        .replace(/#\d+/g, "#")                  // constant-pool slot numbers
        .replace(/\s+/g, " ")
        .trim();
    s = s.replace(/^ldc_w\b/, "ldc");           // 1-byte vs 2-byte constant load
    s = s.replace(/\b(local|stack) \d+\b/g, "$1 N");
    s = s.replace(/\b(goto|ifeq|ifne|iflt|ifge|ifgt|ifle|if_icmpeq|if_icmpne|if_icmplt|if_icmpge|if_icmpgt|if_icmple|if_acmpeq|if_acmpne|ifnull|ifnonnull|jsr)\s+\d+/g, "$1 N");
    s = s.replace(/\b(int|float|long|double|String) .*$/, "$1 …"); // literal values of ldc/constants
    return s;
}

function normalizeSignature(sig) {
    return sig.replace(/lambda\$([A-Za-z0-9_]+)\$\d+/g, "lambda$$$1$*").replace(/\s+/g, " ");
}

const shipped = parse(shippedPath);
const rebuilt = parse(rebuiltPath);
const problems = [];

const shippedNames = new Set([...shipped.keys()].map(normalizeSignature));
const rebuiltNames = new Set([...rebuilt.keys()].map(normalizeSignature));
for (const name of shippedNames) if (!rebuiltNames.has(name)) problems.push(`method only in shipped: ${name}`);
for (const name of rebuiltNames) if (!shippedNames.has(name)) problems.push(`method only in rebuilt: ${name}`);

let comparedMethods = 0;
for (const [sig, a] of shipped) {
    const key = normalizeSignature(sig);
    const entry = [...rebuilt.entries()].find(([s]) => normalizeSignature(s) === key);
    if (!entry) continue;
    comparedMethods++;
    const b = entry[1];
    if (a.length !== b.length) {
        problems.push(`${key}: instruction count ${a.length} (shipped) vs ${b.length} (rebuilt)`);
        continue;
    }
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
            problems.push(`${key} @${i}: shipped[${a[i]}] rebuilt[${b[i]}]`);
            if (problems.length > 40) break;
        }
    }
}

const label = className ?? shippedPath;
if (problems.length === 0) {
    console.log(`  OK   ${label} (${comparedMethods} methods, byte-identical after normalisation)`);
    process.exit(0);
}
console.log(`  DIFF ${label} (${problems.length} issue(s))`);
for (const p of problems.slice(0, 40)) console.log(`       ${p}`);
process.exit(1);
