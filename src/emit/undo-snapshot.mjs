// M1-6 · undo 前像快照 → `styx:undo`（逐格还原）+ 逐格对账函数 + 报告
//
// 为什么旧的 undo 不可信：`undo.mcfunction` 只有 3 行（undo_wall/deck/terrain 的硬编码 fill），
// 它假设"世界一定被改成了某个样子"，既不记录前像、也无法对账。按
// docs/superpowers/plans/2026-09-14-nbforge-m1.md Task 4：
//   ① 扫描将被改动的每一格 → 记下**方块 id + 状态**（前像）
//   ② 生成逐格 `setblock` 还原的 `styx:undo`
//   ③ 生成逐格 `execute unless block` 对账函数 `styx:undo/verify` → "#bad == 0" 就是 diff 0
//
// 输入是本仓库自有的**原始扫描日志**（build/undo-scan-raw.log，格式见 MINI-FORMAT 注释），
// 里面既有控制台 `/data get block` 的逐条回包（[console] 行，验证"这一格加载了吗"），
// 也有前像身份（[cell] 行，取自存档 region 的只读解析 —— 因为 1.21.10 的 /data get block
// 读不出非方块实体的 id/状态，见 docs/M1-6-report.md 的原始回包）。
//
// MINI-FORMAT（v1）
//   # nbforge undo-preimage v1          ← 版本行
//   # at <iso> / # notes <csv> / # cells <n>
//   [console] <x> <y> <z> :: <原样回包>
//   [cell] <x> <y> <z> <role> <state|-> <source> [issue...]
//     role   = lamp(y-1) | deck(y) | note(y+1) | trigger(y+2)
//     state  = minecraft:sand / minecraft:redstone_lamp[lit=false] / ...（属性按 key 排序）
//     source = region-nbt | console-block-entity | missing
//     issue  = missing-chunk | not-loaded | out-of-world | ...（读不到的原因，必须进报告）
//
// 纪律：**不许静默跳过**。任何读不到的格子（区块不存在 / 回包不认识 / 行格式坏掉）都要
// 出现在报告里，并让 `complete:false`、CLI 退出码非 0；绝不当成空气写进 undo。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const VERSION = 1;

/* ---------------- 方块状态 token ---------------- */

const TOKEN_RE = /^([a-z0-9_]+:[a-z0-9_/]+)(?:\[([^\]]*)\])?$/;

/** 'minecraft:note_block[note=15,instrument=harp]' → {name, properties}（属性按 key 排序） */
export function parseStateToken(tok) {
  const m = TOKEN_RE.exec(String(tok ?? '').trim());
  if (!m) throw new Error(`非法方块状态: ${tok}`);
  const properties = {};
  if (m[2] !== undefined) {
    for (const pair of m[2].split(',')) {
      const kv = /^([a-z0-9_]+)=(.*)$/.exec(pair.trim());
      if (!kv) throw new Error(`非法方块状态: ${tok}`);
      properties[kv[1]] = kv[2];
    }
  }
  return { name: m[1], properties: sortProps(properties) };
}

export function formatStateToken({ name, properties }) {
  const keys = Object.keys(properties ?? {});
  if (!keys.length) return name;
  return `${name}[${keys.sort().map((k) => `${k}=${properties[k]}`).join(',')}]`;
}

function sortProps(props) {
  const out = {};
  for (const k of Object.keys(props ?? {}).sort()) out[k] = String(props[k]);
  return out;
}

/* ---------------- 控制台回包分类 ---------------- */

/**
 * `/data get block <x> <y> <z>` 的回包（去掉日志前缀后的正文）分类。
 * 1.21.10 实测的真实四种 + 兜底 unknown（unknown 必须进报告，不能当"没关系"）。
 */
export function classifyDataGetReply(reply) {
  const r = String(reply ?? '').trim();
  if (/^That position is not loaded$/.test(r)) return { kind: 'not-loaded', raw: r };
  if (/^That position is out of this world!$/.test(r)) return { kind: 'out-of-world', raw: r };
  if (/^The target block is not a block entity$/.test(r)) return { kind: 'not-block-entity', raw: r };
  const be = /^(-?\d+), (-?\d+), (-?\d+) has the following block data: \{.*\bid: "([a-z0-9_]+:[a-z0-9_/]+)".*\}$/.exec(r);
  if (be) {
    return {
      kind: 'block-entity', raw: r,
      coord: { x: +be[1], y: +be[2], z: +be[3] },
      id: be[4],
    };
  }
  return { kind: 'unknown', raw: r };
}

/* ---------------- 原始扫描日志解析 ---------------- */

export function parseScanLog(text) {
  const header = {};
  const consoleReplies = [];
  const cells = [];
  const unknown = [];
  const errors = [];
  let version = null;

  const lines = String(text ?? '').split(/\r?\n/);
  lines.forEach((rawLine, i) => {
    const line = rawLine.trim();
    if (!line) return;
    const ln = i + 1;

    if (line.startsWith('#')) {
      const m = /^#\s*([a-z_]+)\s+(.*)$/.exec(line);
      if (!m) return; // 纯注释
      if (m[1] === 'nbforge' && /^undo-preimage v(\d+)$/.test(m[2])) { version = +m[2].replace('undo-preimage v', ''); return; }
      header[m[1]] = m[2];
      return;
    }

    if (line.startsWith('[console] ')) {
      const m = /^\[console\] (-?\d+) (-?\d+) (-?\d+) :: (.*)$/.exec(line);
      if (!m) { errors.push(`L${ln} [console] 行格式坏掉: ${line}`); return; }
      const coord = { x: +m[1], y: +m[2], z: +m[3] };
      const cls = classifyDataGetReply(m[4]);
      const rec = { ...coord, ...cls };
      consoleReplies.push(rec);
      if (cls.kind === 'unknown') unknown.push({ line: ln, ...coord, reply: cls.raw });
      return;
    }

    if (line.startsWith('[cell] ')) {
      const tok = line.split(/\s+/);
      if (tok.length < 6) { errors.push(`L${ln} [cell] 行 token 数不足（需要 ≥6）: ${line}`); return; }
      const [, xs, ys, zs, role, stateTok, source, ...issues] = tok;
      try {
        const state = stateTok === '-' ? null : parseStateToken(stateTok);
        if (stateTok === '-' && !issues.length) throw new Error('缺 state 时必须在第 7 个字段写读不到的原因');
        cells.push({ x: +xs, y: +ys, z: +zs, role, state, source, issues });
      } catch (e) {
        errors.push(`L${ln} ${e.message}: ${line}`);
      }
      return;
    }

    errors.push(`L${ln} 无法识别的行（缺 [console]/[cell] 前缀）: ${line}`);
  });

  const byKind = {};
  for (const r of consoleReplies) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;
  const bySource = {};
  for (const c of cells) bySource[c.source] = (bySource[c.source] ?? 0) + 1;

  // 交叉校验：控制台认出来的方块实体 id，必须和存档前像一致（两边独立取得，能互证）
  const cellAt = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, c]));
  const crossCheck = { compared: 0, agreed: 0, disagreed: [] };
  for (const r of consoleReplies) {
    if (r.kind !== 'block-entity') continue;
    const cell = cellAt.get(`${r.x},${r.y},${r.z}`);
    if (!cell?.state) continue;
    crossCheck.compared++;
    if (cell.state.name === r.id) crossCheck.agreed++;
    else crossCheck.disagreed.push({ x: r.x, y: r.y, z: r.z, console: r.id, region: cell.state.name });
  }

  return {
    version: version ?? null,
    at: header.at ?? null,
    notes: header.notes ?? null,
    console: consoleReplies,
    cells,
    unknown,
    errors,
    counts: {
      byKind,
      bySource,
      notLoaded: consoleReplies.filter((r) => r.kind === 'not-loaded').map((r) => `${r.x},${r.y},${r.z}`),
      outOfWorld: consoleReplies.filter((r) => r.kind === 'out-of-world').map((r) => `${r.x},${r.y},${r.z}`),
      unreadable: cells.filter((c) => !c.state)
        .map((c) => ({ x: c.x, y: c.y, z: c.z, role: c.role, issues: c.issues })),
      crossCheck,
    },
  };
}

/* ---------------- 生成 styx:undo + 对账 + 报告 ---------------- */

const pad = (n, w = 3) => String(n).padStart(w, '0');

function chunk(list, n) {
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

/**
 * 由扫描结果生成数据包函数与报告。
 * 产出：`styx:undo`（派发 → 分片 setblock 还原 → 逐格对账 → 打印结果）
 */
export function buildUndoArtifacts(snapshot, opts = {}) {
  const maxLines = opts.maxLinesPerPart ?? 4000;
  const withWhere = !!opts.where;

  // 去重：同一格重复出现只保留第一条（并记数，进报告）
  const seen = new Map();
  let duplicatesDropped = 0;
  for (const c of snapshot.cells) {
    const k = `${c.x},${c.y},${c.z}`;
    if (seen.has(k)) { duplicatesDropped++; continue; }
    seen.set(k, c);
  }
  const unreadable = [];
  const restore = [];
  const flagged = [];
  for (const c of seen.values()) {
    if (!c.state) { unreadable.push({ x: c.x, y: c.y, z: c.z, role: c.role, issues: c.issues }); continue; }
    restore.push(c);
    if (c.issues?.length) flagged.push({ x: c.x, y: c.y, z: c.z, role: c.role, issues: c.issues });
  }
  // 稳定排序（x, y, z）：同一份前像两次生成必须字节一致
  restore.sort((a, b) => a.x - b.x || a.y - b.y || a.z - b.z);

  const files = {};
  const parts = chunk(restore, maxLines);
  parts.forEach((cells, i) => {
    files[`undo/p${pad(i + 1)}.mcfunction`] = [
      `# styx:undo 分片 ${i + 1}/${parts.length}（${cells.length} 格，前像还原）`,
      ...cells.map((c) => `setblock ${c.x} ${c.y} ${c.z} ${formatStateToken(c.state)}`),
      '',
    ].join('\n');
  });

  const verifyParts = chunk(restore, maxLines);
  verifyParts.forEach((cells, i) => {
    files[`undo/d${pad(i + 1)}.mcfunction`] = [
      `# 逐格对账分片 ${i + 1}/${verifyParts.length}：不匹配就 #bad +1（差 0 才叫还原）`,
      ...cells.map((c) => `execute unless block ${c.x} ${c.y} ${c.z} ${formatStateToken(c.state)} run scoreboard players add #bad styx.undo 1`),
      '',
    ].join('\n');
  });

  files['undo/verify.mcfunction'] = [
    '# 逐格对账：把当前世界和扫描时的前像逐格比一遍（不匹配计数进 #bad）',
    'scoreboard objectives add styx.undo dummy',
    'scoreboard players set #bad styx.undo 0',
    ...verifyParts.map((_, i) => `function styx:undo/d${pad(i + 1)}`),
    `tellraw @a {"text":"[Styx] undo 逐格对账：不匹配 ","color":"gray","extra":[{"score":{"name":"#bad","objective":"styx.undo"},"color":"yellow"},{"text":" / ${restore.length} 格（0 = diff 0）","color":"gray"}]}`,
    // 无头服没有玩家，tellraw @a 会静默失败 —— 所以对账结论还要用 say 打一份到日志里（有玩家时也看得见）
    `execute if score #bad styx.undo matches 0 run say [Styx] undo 逐格对账通过：${restore.length}/${restore.length} 格与扫描前像一致（diff 0）`,
    'execute if score #bad styx.undo matches 1.. run say [Styx] undo 逐格对账不通过：#bad > 0，逐格坐标见 styx:undo/where',
    '',
  ].join('\n');

  if (withWhere) {
    const whereParts = chunk(restore, maxLines);
    whereParts.forEach((cells, i) => {
      files[`undo/w${pad(i + 1)}.mcfunction`] = [
        `# 坐标诊断分片 ${i + 1}/${whereParts.length}：只在不匹配时打印坐标`,
        ...cells.map((c) => `execute unless block ${c.x} ${c.y} ${c.z} ${formatStateToken(c.state)} run say [undo/diff] ${c.x} ${c.y} ${c.z} 期望 ${formatStateToken(c.state)}`),
        '',
      ].join('\n');
    });
    files['undo/where.mcfunction'] = [
      '# 只打印不匹配坐标（默认不生成，--where 时才生成，避免数据包膨胀）',
      ...whereParts.map((_, i) => `function styx:undo/w${pad(i + 1)}`),
      '',
    ].join('\n');
  }

  files['undo.mcfunction'] = [
    `# 由 src/emit/undo-snapshot.mjs 生成（M1-6 前像快照）`,
    `# 前像：${restore.length} 格可还原；读不到 ${unreadable.length} 格（见 build/undo-report.json）`,
    ...parts.map((_, i) => `function styx:undo/p${pad(i + 1)}`),
    `tellraw @a {"text":"[Styx] undo 已按前像还原 ${restore.length} 格（${parts.length} 片）；下面自动逐格对账","color":"aqua"}`,
    'function styx:undo/verify',
    '',
  ].join('\n');

  const report = {
    version: VERSION,
    at: new Date().toISOString(),
    scanAt: snapshot.at,
    notes: snapshot.notes,
    scan: {
      consoleReplies: snapshot.console.length,
      byKind: snapshot.counts.byKind,
      notLoaded: snapshot.counts.notLoaded,
      outOfWorld: snapshot.counts.outOfWorld,
      unknownConsoleReplies: snapshot.unknown,
    },
    cells: {
      fromLog: snapshot.cells.length,
      unique: seen.size,
      duplicatesDropped,
      restorable: restore.length,
      flagged,
      unreadable,
      bySource: snapshot.counts.bySource,
    },
    crossCheck: snapshot.counts.crossCheck,
    output: {
      undo: 'styx:undo',
      files: Object.keys(files).sort(),
      parts: parts.length,
      verifyParts: verifyParts.length,
      setblockLines: restore.length,
      verifyLines: restore.length,
    },
    parseErrors: snapshot.errors,
    complete: unreadable.length === 0
      && snapshot.unknown.length === 0
      && snapshot.errors.length === 0
      && snapshot.counts.crossCheck.disagreed.length === 0,
    warnings: [
      ...(flagged.length ? [`${flagged.length} 格在控制台报过 not-loaded/其它异常，但存档前像可读，仍按存档还原`] : []),
      ...(unreadable.length ? [`${unreadable.length} 格读不到前像 → 不进 undo（绝不当作空气）`] : []),
      ...(snapshot.unknown.length ? [`${snapshot.unknown.length} 条控制台回包不认识 → 需要人看一眼`] : []),
      ...(snapshot.counts.crossCheck.disagreed.length ? [`${snapshot.counts.crossCheck.disagreed.length} 格"控制台方块实体 id ≠ 存档前像"→ 前像不可信`] : []),
    ],
  };

  return { files, report };
}

/* ---------------- CLI ---------------- */

const isMain = !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const argv = process.argv.slice(2);
  const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
  const B = 'C:/Users/hiliang/Documents/minecraft/build';
  const SCAN = opt('scan', `${B}/undo-scan-raw.log`);
  const DIR = opt('dir', `${B}/styx_build/data/styx/function`);
  const REPORT = opt('report', `${B}/undo-report.json`);
  const maxLinesPerPart = +(opt('max-lines', '4000'));
  const withWhere = argv.includes('--where');
  const allowIncomplete = argv.includes('--allow-incomplete');

  const snapshot = parseScanLog(fs.readFileSync(SCAN, 'utf8'));
  const { files, report } = buildUndoArtifacts(snapshot, { maxLinesPerPart, where: withWhere });

  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(DIR, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body, 'utf8');
  }
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2) + '\n', 'utf8');

  console.log(`扫描日志：${SCAN}`);
  console.log(`控制台回包 ${report.scan.consoleReplies} 条：${JSON.stringify(report.scan.byKind)}`);
  console.log(`前像格子：日志 ${report.cells.fromLog} → 去重后 ${report.cells.unique}（重复 ${report.cells.duplicatesDropped}）`);
  console.log(`可还原 ${report.cells.restorable} 格 / 读不到 ${report.cells.unreadable.length} 格；来源 ${JSON.stringify(report.cells.bySource)}`);
  console.log(`交叉校验：比对 ${report.crossCheck.compared}，一致 ${report.crossCheck.agreed}，不一致 ${report.crossCheck.disagreed.length}`);
  for (const w of report.warnings) console.log(`  ⚠ ${w}`);
  console.log(`已生成 ${Object.keys(files).length} 个函数文件 → ${DIR}`);
  console.log(`  styx:undo（${report.output.parts} 片 × setblock）+ styx:undo/verify（${report.output.verifyParts} 片 × unless block）`);
  console.log(`报告：${REPORT}（complete=${report.complete}）`);
  if (!report.complete && !allowIncomplete) {
    console.error('前像不完整 → 退出码 1（要强行生成请加 --allow-incomplete）');
    process.exit(1);
  }
}
