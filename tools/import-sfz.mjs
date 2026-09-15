#!/usr/bin/env node
// 最小 SFZ 解析器（M3-11）：只读"能把采样按(音高,力度层)取出来"所需的 opcode。
//
// 为什么要它：VSCO 2 CE 是 SFZ + WAV 的库（CC0 ✓ 无损 ✓），每件乐器的"音符↔采样↔力度层"
// 关系写在 .sfz 里。解析出这张映射表后，**任何** VSCO 乐器都能按同一套规则导入我们的管线
// （最近采样 + 变调 + 按力度选层），不必为每件乐器写代码。
//
// 支持：<region> / <group>（group 级默认值继承到 region）、sample= / lokey= / hikey= /
//        pitch_keycenter= / lovel= / hivel= / tune=（音分）/ volume=（dB，可写 -6 或 -6.0）
//   node tools/import-sfz.mjs --sfz <file.sfz> [--json out.json]
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

/** 音名 → midi（c4 = 60；SFZ 里常见 c3=48 的约定由 pitch_keycenter 覆盖，这里只做兜底换算） */
const NAMES = { c: 0, cs: 1, db: 1, d: 2, ds: 3, eb: 3, e: 4, f: 5, fs: 6, gb: 6, g: 7, gs: 8, ab: 8, a: 9, as: 10, bb: 10, b: 11 };
export function keyToMidi(tok, base = 60) {
  if (tok === undefined || tok === null) return null;
  if (/^-?\d+$/.test(String(tok).trim())) return parseInt(String(tok).trim(), 10);   // VSCO 部分 sfz 用数字键
  const m = /^([a-g][sb]?)(-?\d+)$/i.exec(String(tok).trim());
  if (!m) return null;
  const semi = NAMES[m[1].toLowerCase()];
  if (semi === undefined) return null;
  return semi + (parseInt(m[2], 10) + 1) * 12;   // c4 = 60 的约定
}
const num = (v, d = 0) => (v === undefined ? d : Number(v));

/**
 * 解析一个 sfz 文件 → region 列表（已解析出绝对采样路径与 (音域, 力度域, 变调, 增益)）。
 * @returns {{regions: Array, groups: number, baseDir: string}}
 */
export function parseSfz(sfzPath) {
  const baseDir = path.dirname(path.resolve(sfzPath));
  const text = fs.readFileSync(sfzPath, 'utf8');
  const regions = [];
  let group = {};
  let cur = null;
  let groups = 0;
  // SFZ 的 `<control> default_path=...` 是**采样根目录**（VSCO 全靠它）——不处理它就会
  // 报"采样全缺失"（实测 ContrabassPizz：152/152 缺失，实际采样都在 default_path 下）。
  let defaultPath = '';
  let inControl = false;
  for (let rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (/^<\s*control\s*>/i.test(line)) { inControl = true; cur = null; continue; }
    if (/^<\s*group\s*>/i.test(line)) { inControl = false; group = {}; groups++; cur = group; continue; }
    if (/^<\s*region\s*>/i.test(line)) { inControl = false; cur = { ...group }; regions.push(cur); continue; }
    if (/^<\s*global\s*>/i.test(line)) { inControl = false; cur = group; continue; }
    if (/^</.test(line)) { inControl = false; continue; }  // 其它段（curve…）跳过
    if (inControl) {
      const m = /^default_path\s*=\s*(.+)$/i.exec(line);
      if (m) defaultPath = m[1].trim().replace(/\\/g, '/');
      continue;
    }
    if (!cur) { cur = group; }
    for (const part of line.split(/(?=\b[a-z_0-9]+\s*=)/i)) {
      const m = /^([a-z_0-9]+)\s*=\s*(.+)$/i.exec(part.trim());
      if (!m) continue;
      cur[m[1].toLowerCase()] = m[2].trim();
    }
  }
  const out = [];
  for (const r of regions) {
    if (!r.sample) continue;
    const rel = r.sample.replace(/\\/g, '/');
    const file = path.isAbsolute(rel) ? rel : path.resolve(baseDir, defaultPath, rel);
    const lo = keyToMidi(r.lokey) ?? keyToMidi(r.pitch_keycenter) ?? 0;
    const hi = keyToMidi(r.hikey) ?? keyToMidi(r.pitch_keycenter) ?? 127;
    const center = keyToMidi(r.pitch_keycenter) ?? keyToMidi(r.lokey) ?? lo;
    out.push({
      file,
      lo, hi, center,
      lovel: num(r.lovel, 0),
      hivel: num(r.hivel, 127),
      tuneCents: num(r.tune, 0),
      gainDb: num(r.volume, 0),
      group: r.group ?? null,
    });
  }
  return { regions: out, groups, baseDir };
}

/* CLI */
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/import-sfz.mjs');
if (isMain) {
  const sfz = opt('sfz');
  if (!sfz) { console.error('用法：node tools/import-sfz.mjs --sfz <file.sfz> [--json out.json]'); process.exit(2); }
  const { regions, groups } = parseSfz(sfz);
  const missing = regions.filter((r) => !fs.existsSync(r.file));
  const byCenter = new Map();
  for (const r of regions) { if (!byCenter.has(r.center)) byCenter.set(r.center, 0); byCenter.set(r.center, byCenter.get(r.center) + 1); }
  const centers = [...byCenter.keys()].sort((a, b) => a - b);
  console.log(`SFZ: ${path.basename(sfz)}  region=${regions.length}  group=${groups}`);
  console.log(`采样缺失: ${missing.length}${missing.length ? '（例：' + path.basename(missing[0].file) + '）' : ''}`);
  console.log(`音高中心: ${centers.length} 个，范围 ${centers[0]}..${centers.at(-1)}；每音层数示例 ${[...byCenter.entries()].slice(0, 5).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  const layers = [...regions].sort((a, b) => a.lovel - b.lovel);
  console.log(`力度域示例: ${layers.slice(0, 6).map((r) => `${r.lovel}-${r.hivel}`).join(' / ')}`);
  if (opt('json')) {
    fs.writeFileSync(opt('json'), JSON.stringify({ sfz, regions: regions.length, centers, byCenter: Object.fromEntries(byCenter), regionsList: regions }, null, 1) + '\n', 'utf8');
    console.log(`索引 → ${opt('json')}`);
  }
}

