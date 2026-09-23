#!/usr/bin/env node
// 提前量 A/B：把两段录音（例如 lead 0 与 lead 8）各自跑一遍逐音对账，并排对比。
//
//   node tools/ab-lead.mjs --a <take0.mkv> --b <take8.mkv> [--master <母版>] [--score <谱面csv>]
//
// 判据（全部来自 audit-strict 的逐音 ±150ms 扫描，不依赖听感）：
//   · 真缺失（±150ms 内找不到该音谐波）：两种提前量都不该多
//   · 偏移分布：提前量不足时载荷过期 → 客户端只能"立即播" → 偏移整体右移（正=录音更晚）
//   · 漂移拟合：速度是否一致
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const A = opt("a"), B = opt("b");
if (!A || !B) throw new Error("用法: node tools/ab-lead.mjs --a <录音A> --b <录音B> [--master ..] [--score ..]");
const ROOT = path.join(import.meta.dirname, "..");
const MASTER = opt("master", path.join(ROOT, "..", "build", "master_v2", "styx_master_v2_48k24bit.wav"));
const SCORE = opt("score", path.join(ROOT, "..", "build", "nbmachina_machine_map.csv"));
const LEAD_A = opt("lead-a", "0");
const LEAD_B = opt("lead-b", "8");

function run(file) {
  const r = spawnSync(process.execPath, ["tools/audit-strict.mjs", "--record", file, "--master", MASTER, "--score", SCORE],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 28 });
  const out = (r.stdout || "") + (r.stderr || "");
  const pick = (re) => { const m = out.match(re); return m ? m.slice(1).map(Number) : null; };
  const found = pick(/找到 (\d+) 颗 \/ 扫不到（±150ms 内无该音谐波，真缺失）(\d+) 颗/);
  const off = pick(/偏移（正=录音比母版晚）：p10 (-?\d+)ms \/ 中位 (-?\d+)ms \/ p90 (-?\d+)ms/);
  const drift = pick(/漂移拟合：(-?[\d.]+) ms\/s/);
  return { file, found: found ? found[0] : null, notFound: found ? found[1] : null,
           p10: off ? off[0] : null, med: off ? off[1] : null, p90: off ? off[2] : null,
           drift: drift ? drift[0] : null, raw: out };
}

const ra = run(A), rb = run(B);
const row = (label, la, lb) => `${label.padEnd(22)} ${String(la).padStart(10)}   ${String(lb).padStart(10)}`;
console.log("");
console.log(`提前量 A/B 对比    A = lead ${LEAD_A}    B = lead ${LEAD_B}`);
console.log(`A: ${path.basename(A)}`);
console.log(`B: ${path.basename(B)}`);
console.log("");
console.log(row("指标", `lead ${LEAD_A}`, `lead ${LEAD_B}`));
console.log(row("找到（逐音命中）", ra.found ?? "-", rb.found ?? "-"));
console.log(row("真缺失（扫不到）", ra.notFound ?? "-", rb.notFound ?? "-"));
console.log(row("偏移 p10 (ms)", ra.p10 ?? "-", rb.p10 ?? "-"));
console.log(row("偏移 中位 (ms)", ra.med ?? "-", rb.med ?? "-"));
console.log(row("偏移 p90 (ms)", ra.p90 ?? "-", rb.p90 ?? "-"));
console.log(row("漂移 (ms/分钟)", ra.drift === null ? "-" : (ra.drift * 60).toFixed(1), rb.drift === null ? "-" : (rb.drift * 60).toFixed(1)));
console.log("");
const better = (x, y) => (x === null || y === null) ? null : (x < y ? "A" : y < x ? "B" : "持平");
console.log(`判据：偏越正 = 越晚 → 中位数更小者更准  →  ${better(ra.med, rb.med) ?? "数据不足"}`);
console.log(`（另：真缺失更少者  →  ${better(ra.notFound, rb.notFound) ?? "数据不足"}）`);
