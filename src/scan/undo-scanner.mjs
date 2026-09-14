// M1-6 · 前像扫描 + 无头验收驱动（在 testserver 上真跑）
//
// 一次跑完：
//   ①（可选 --terrain）先铺地形 → 这就是"机器还没铺上"的世界
//   ② 对 --notes 里每颗音涉及的 4 格（灯 y-1 / 甲板 y / 音符盒 y+1 / 触发位 y+2）
//      发 `/data get block x y z`，**原样记录回包**（M1-6 要求的扫描方式）
//   ③ 存档 region 只读解析 → 逐格前像（方块 id + 状态），与控制台回包交叉校验
//   ④ 生成 styx:undo + styx:undo/verify（src/emit/undo-snapshot.mjs），写 build/undo-scan-raw.log
//   ⑤ 对账三连：扫完立刻 verify（前像 == 现场，应为 0）→ apply_notes_v3 → verify（应 >0）
//      → 手工改 3 处 → styx:undo → verify（必须回到 0）
//
// 用法：
//   node src/scan/undo-scanner.mjs --notes build/styx_helix_machine.csv --terrain
//   node src/scan/undo-scanner.mjs            # 不铺地形：前像就是当前世界的状态
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { makePos } from '../emit/layout-pos.mjs';
import { createRegionReader } from './region-nbt.mjs';
import { parseScanLog, buildUndoArtifacts, formatStateToken, VERSION } from '../emit/undo-snapshot.mjs';
import { resolvePaths, resolveExternal } from '../core/paths.mjs';

// M2-3：build/测试服/java 都从 paths.mjs 取（--build/--server/--java 或对应环境变量可覆盖）
const P = resolvePaths();
const EX = resolveExternal();
const B = P.build;
const TS = EX.server;
const JAVA = EX.java;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
// 相对路径按"工作区根"（build/ 的上一级）解析：任务里写的 `build/styx_helix_machine.csv` 就是这个意思
const WORKSPACE = path.resolve(B, '..');
const resolveIn = (p) => (path.isAbsolute(p) ? p : path.resolve(WORKSPACE, p));
const NOTES = resolveIn(opt('notes', P.machine));
const TERRAIN = argv.includes('--terrain');
const DAMAGE = +(opt('damage', '3'));
const SWEEP_CHUNK = +(opt('sweep-chunk', '400'));
const MAX_PART = +(opt('max-lines', '4000'));
const FRESH_TRIES = +(opt('fresh-tries', '10'));
const FRESH_WAIT_MS = +(opt('fresh-wait-ms', '6000'));
const FRESH_SAMPLE = +(opt('fresh-sample', '64'));
const WITH_WHERE = argv.includes('--where');
const SCAN_ONLY = argv.includes('--scan-only');
const OUT = resolveIn(opt('out', B));
const SCAN_LOG = path.join(OUT, 'undo-scan-raw.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

/* ---------------- 格子：与播放器/摆块器共用同一个坐标规则 ---------------- */
const profile = JSON.parse(fs.readFileSync(`${B}/single_row_profile.json`, 'utf8'));
const pos = makePos(profile);
const notes = (() => {
  const lines = fs.readFileSync(NOTES, 'utf8').trim().split(/\r?\n/);
  const h = lines[0].split(',');
  const iStep = h.indexOf('step'), iInstr = h.indexOf('instrument'), iRow = h.indexOf('row');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    return { step: +c[iStep], instr: c[iInstr], row: +c[iRow] };
  });
})();

const ROLES = [
  { role: 'lamp', dy: -1 },
  { role: 'deck', dy: 0 },
  { role: 'note', dy: +1 },
  { role: 'trigger', dy: +2 },
];
const cellsRaw = [];
for (const n of notes) {
  const p = pos(n.step, n.row);
  for (const r of ROLES) cellsRaw.push({ x: p.x, y: p.y + r.dy, z: p.z, role: r.role, step: n.step, instr: n.instr, row: n.row });
}
const cellMap = new Map();
for (const c of cellsRaw) {
  const k = `${c.x},${c.y},${c.z}`;
  if (!cellMap.has(k)) cellMap.set(k, c);
}
const cells = [...cellMap.values()];
console.log(`谱面 ${NOTES}：${notes.length} 颗音 → ${cellsRaw.length} 格（去重 ${cells.length}）`);

/* ---------------- 服务器 ---------------- */
fs.rmSync(`${TS}/world/datapacks/styx_build`, { recursive: true, force: true });
fs.cpSync(`${B}/styx_build`, `${TS}/world/datapacks/styx_build`, { recursive: true });

const proc = spawn(JAVA, ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: TS });
let out = '';
proc.stdout.on('data', (d) => { out += d.toString(); });
proc.stderr.on('data', (d) => { out += d.toString(); });
let exitCode = 0;

const send = async (c, wait = 400, quiet = false) => {
  const mark = out.length;
  if (!quiet) console.log(`   >>> ${c}`);
  proc.stdin.write(c + '\n');
  await sleep(wait);
  return out.slice(mark);
};
const waitFor = async (re, timeout, from = 0) => {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (re.test(out.slice(from))) return true;
    await sleep(200);
  }
  return false;
};
const readScore = async (name, obj, tries = 5) => {
  for (let i = 0; i < tries; i++) {
    const mark = out.length;
    proc.stdin.write(`scoreboard players get ${name} ${obj}\n`);
    await sleep(400);
    const m = [...out.slice(mark).matchAll(new RegExp(`${name.replace('#', '\\#')} has (-?\\d+) \\[${obj}\\]`, 'g'))];
    if (m.length) return +m[m.length - 1][1];
  }
  return null;
};

const summary = { at: new Date().toISOString(), notes: NOTES, terrain: TERRAIN, cells: { notes: notes.length, raw: cellsRaw.length, unique: cells.length } };

try {
  if (!(await waitFor(/Done \([\d.]+s\)!/, 300000))) throw new Error('服务器启动超时');
  await send('gamerule randomTickSpeed 0');
  await send('gamerule doMobSpawning false');
  await send('gamerule doDaylightCycle false');
  await send('forceload remove all', 800);
  await send('forceload add 480 -176 1735 -136', 9000);
  await send('forceload add 1728 -176 2880 -136', 9000);

  if (TERRAIN) {
    for (const f of ['flat_build_v2a', 'flat_build_v2b', 'flat_build_v2c']) {
      await send(`function styx:${f}`, 9000);
    }
  }
  await send('save-all flush', 4000);

  /* ---------- ② 控制台 /data get block 扫描（逐格原样记录回包） ---------- */
  const consoleReplies = [];
  let framingErrors = 0;
  const tSweep = Date.now();
  for (let i = 0; i < cells.length; i += SWEEP_CHUNK) {
    const part = cells.slice(i, i + SWEEP_CHUNK);
    const idx = i / SWEEP_CHUNK;
    const mark = out.length;
    for (const c of part) proc.stdin.write(`data get block ${c.x} ${c.y} ${c.z}\n`);
    proc.stdin.write(`say __SWEEP_${idx}_END__\n`);
    if (!(await waitFor(new RegExp(`\\[Server\\] __SWEEP_${idx}_END__`), 120000, mark))) throw new Error(`扫描分片 ${idx} 没回包`);
    const seg = out.slice(mark);
    const lines = [];
    for (const l of seg.split(/\r?\n/)) {
      const m = /\[Server thread\/INFO\]: (.*)$/.exec(l);
      if (m && !m[1].startsWith('[Not Secure]')) lines.push(m[1]);
    }
    if (lines.length !== part.length) {
      framingErrors++;
      console.log(`   !! 分片 ${idx} 回包 ${lines.length} 条 / 期望 ${part.length} 条（对不上，按读不到处理）`);
    }
    part.forEach((c, j) => consoleReplies.push({ ...c, reply: lines[j] ?? '(no reply)' }));
  }
  console.log(`控制台扫描：${cells.length} 格 / ${((Date.now() - tSweep) / 1000).toFixed(1)}s，分片对不上 ${framingErrors} 次`);

  /* ---------- ③④ 存档前像（region 只读）+ 生成，带"新鲜度闸门" ---------- */
  // 坑（实测）：`save-all flush` 打完 "Saved the game" 只代表"已提交给 IO 线程"，
  // 区域文件实际落盘会晚 30~45s（见 build/undo-accept.log 的时间戳 + docs/M1-6-report.md）。
  // 所以前像读出来之后**必须逐格验过"等于现场"**才允许用；抽样不齐就等一会儿重读。
  const FN_DIR = `${B}/styx_build/data/styx/function`;
  const notLoaded = new Set(consoleReplies.filter((r) => /not loaded/.test(r.reply)).map((r) => `${r.x},${r.y},${r.z}`));
  const outOfWorld = new Set(consoleReplies.filter((r) => /out of this world/.test(r.reply)).map((r) => `${r.x},${r.y},${r.z}`));
  const sampleStep = Math.max(1, Math.ceil(cells.length / FRESH_SAMPLE));
  const sampleCells = cells.filter((_, i) => i % sampleStep === 0).slice(0, FRESH_SAMPLE);

  await send('scoreboard objectives add styx.undo dummy', 300);

  /** 逐格对账：世界 vs 期望（生成好的 styx:undo/verify，全量 11208 格） */
  const verify = async (label) => {
    await send('scoreboard players set #bad styx.undo 0', 300, true);
    const mark = out.length;
    await send('function styx:undo/verify', 8000, true);
    const bad = await readScore('#bad', 'styx.undo');
    const tail = out.slice(mark).split(/\r?\n/).filter((l) => l.includes('[Styx] undo')).pop() ?? '';
    console.log(`   [${label}] #bad = ${bad}   ${tail.split('INFO]: ').pop() ?? ''}`);
    return bad;
  };

  /** 新鲜度抽样：只在内存里比"region 读到的状态 vs 现场"（每条 1 个 if block，64 格 ≈ 瞬间） */
  const probeCells = async (list) => {
    await send('scoreboard players set #probe styx.undo 0', 200, true);
    const mark = out.length;
    const lines = ['scoreboard players set #probe styx.undo 0'];
    for (const c of list) {
      if (!c.state) continue; // 读不到的格子不在计数里 → 必然对不上，继续等
      lines.push(`execute if block ${c.x} ${c.y} ${c.z} ${formatStateToken(c.state)} run scoreboard players add #probe styx.undo 1`);
    }
    lines.push('say __PROBE_END__');
    proc.stdin.write(lines.join('\n') + '\n');
    if (!(await waitFor(/\[Server\] __PROBE_END__/, 120000, mark))) throw new Error('新鲜度抽样没回包');
    return await readScore('#probe', 'styx.undo');
  };

  const saveFlushAndWait = async () => {
    const from = out.length;
    proc.stdin.write('save-all flush\n');
    await waitFor(/Saved the game/, 120000, from);
    await sleep(1500);
  };

  await saveFlushAndWait();

  let preBad = null;
  let acceptedReader = null;
  let snapshot = null, files = null, report = null;
  const freshAttempts = [];
  for (let attempt = 1; attempt <= FRESH_TRIES; attempt++) {
    const reader = createRegionReader(`${TS}/world/region`);
    const states = new Map(cells.map((c) => [`${c.x},${c.y},${c.z}`, reader.blockAt(c.x, c.y, c.z)]));
    const sampleOk = await probeCells(sampleCells.map((c) => ({ ...c, state: states.get(`${c.x},${c.y},${c.z}`) })));
    const rec = { attempt, sampleOk, sampleTotal: sampleCells.length, chunksRead: reader.stats.chunksRead, chunksMissing: reader.stats.chunksMissing, preBad: null };
    freshAttempts.push(rec);
    console.log(`   前像新鲜度第 ${attempt} 次：抽样 ${sampleCells.length} 格一致 ${sampleOk}；区块 ${reader.stats.chunksRead} 读 / ${reader.stats.chunksMissing} 缺`);
    if (sampleOk === sampleCells.length) {
      /* ---------- 写原始扫描日志（build/undo-scan-raw.log） ---------- */
      const logLines = [
        `# nbforge undo-preimage v${VERSION}`,
        `# at ${summary.at}`,
        `# notes ${NOTES}`,
        `# cells ${cells.length}`,
        `# freshness attempt ${attempt}（抽样 ${sampleOk}/${sampleCells.length} 一致；下面全量对账必须 #bad = 0）`,
        '# 说明: [console] 行为 /data get block 在 testserver 上的原始回包；[cell] 行为前像（存档 region 只读解析）',
      ];
      for (const r of consoleReplies) logLines.push(`[console] ${r.x} ${r.y} ${r.z} :: ${r.reply}`);
      for (const c of cells) {
        const st = states.get(`${c.x},${c.y},${c.z}`);
        const issues = [];
        if (!st) issues.push('missing-chunk');
        if (notLoaded.has(`${c.x},${c.y},${c.z}`)) issues.push('not-loaded');
        if (outOfWorld.has(`${c.x},${c.y},${c.z}`)) issues.push('out-of-world');
        logLines.push(`[cell] ${c.x} ${c.y} ${c.z} ${c.role} ${st ? formatStateToken(st) : '-'} ${st ? 'region-nbt' : 'missing'}${issues.length ? ' ' + issues.join(' ') : ''}`);
      }
      fs.mkdirSync(OUT, { recursive: true });
      fs.writeFileSync(SCAN_LOG, logLines.join('\n') + '\n', 'utf8');

      // 走 CLI 同一条路径：从文件读回来解析 → 生成 → 写报告（保证产物可重放）
      snapshot = parseScanLog(fs.readFileSync(SCAN_LOG, 'utf8'));
      ({ files, report } = buildUndoArtifacts(snapshot, { maxLinesPerPart: MAX_PART, where: WITH_WHERE }));
      for (const [rel, body] of Object.entries(files)) {
        const p = path.join(FN_DIR, rel);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, body, 'utf8');
      }
      fs.writeFileSync(`${OUT}/undo-report.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');

      // 同步到测试服 + reload 才能看见新函数
      fs.cpSync(`${B}/styx_build`, `${TS}/world/datapacks/styx_build`, { recursive: true });
      await send('reload', 4000);
      preBad = await verify(`全量对账（第 ${attempt} 次前像 vs 现场）`);
      rec.preBad = preBad;
      if (preBad === 0) { acceptedReader = reader; break; }
      console.log(`   !! 抽样通过但全量对账 #bad=${preBad} → 前像仍不新，重读`);
    }
    await saveFlushAndWait();
    await sleep(FRESH_WAIT_MS);
  }
  if (preBad !== 0) throw new Error(`前像新鲜度闸门没过（${FRESH_TRIES} 次尝试后 #bad=${preBad}）——不许拿过期前像生成 undo`);
  console.log(`原始扫描日志：${SCAN_LOG}；生成 styx:undo：可还原 ${report.cells.restorable} 格 / 读不到 ${report.cells.unreadable.length} 格 / complete=${report.complete}`);

  /* ---------- ⑤ 对账三连（--scan-only 只跑 ①②③④ 与"前像 == 现场"那一次对账） ---------- */
  let appliedBad = null;
  let undoBad = null;
  let diffCells = [];
  const damage = [];
  if (!SCAN_ONLY) {
    await send('function styx:apply_notes_v3', 25000);
    appliedBad = await verify('apply_notes_v3 之后');

    // 手工改 3 处
    const preState = new Map(snapshot.cells.map((c) => [`${c.x},${c.y},${c.z}`, c.state]));
    const damagePlan = [
      { cell: cells.find((c) => c.role === 'lamp'), block: 'minecraft:diamond_block' },
      { cell: cells[Math.floor(cells.length / 2)], block: 'minecraft:bedrock' },
      { cell: cells.filter((c) => c.role === 'note').pop(), block: 'minecraft:gold_block' },
    ].slice(0, DAMAGE);
    for (const [i, d] of damagePlan.entries()) {
      const { x, y, z } = d.cell;
      await send(`setblock ${x} ${y} ${z} ${d.block}`);
      await send(`execute if block ${x} ${y} ${z} ${d.block} run say __DAMAGE_${i + 1}_OK__`);
      const st = preState.get(`${x},${y},${z}`);
      damage.push({ i: i + 1, x, y, z, role: d.cell.role, broken: d.block, expect: st ? formatStateToken(st) : null });
    }

    await send('function styx:undo', 12000);
    undoBad = await verify('styx:undo 之后');
    // 有落差就把"哪一格不对"打进日志（无头服里 tellraw @a 是静默的，所以用 say）
    if (WITH_WHERE && undoBad !== 0) {
      const mark = out.length;
      await send('function styx:undo/where', 8000, true);
      diffCells = out.slice(mark).split(/\r?\n/)
        .map((l) => /\[undo\/diff\] (-?\d+) (-?\d+) (-?\d+) 期望 (\S+)/.exec(l))
        .filter(Boolean)
        .map((m) => ({ x: +m[1], y: +m[2], z: +m[3], expect: m[4] }));
      console.log(`   [styx:undo/where] 不匹配 ${diffCells.length} 格：${diffCells.slice(0, 8).map((d) => `(${d.x},${d.y},${d.z})`).join(' ')}`);
    }
    for (const [i, d] of damagePlan.entries()) {
      const st = preState.get(`${d.cell.x},${d.cell.y},${d.cell.z}`);
      await send(`execute if block ${d.cell.x} ${d.cell.y} ${d.cell.z} ${formatStateToken(st)} run say __UNDO_CELL_${i + 1}_OK__`);
    }
  }

  summary.scan = {
    consoleReplies: consoleReplies.length,
    framingErrors,
    byKind: report.scan.byKind,
    notLoaded: report.scan.notLoaded.length,
    outOfWorld: report.scan.outOfWorld.length,
    unknown: report.scan.unknownConsoleReplies.length,
  };
  summary.region = { chunksRead: acceptedReader.stats.chunksRead, chunksMissing: acceptedReader.stats.chunksMissing };
  summary.freshness = freshAttempts;
  summary.preimage = {
    restorable: report.cells.restorable,
    unreadable: report.cells.unreadable.length,
    bySource: report.cells.bySource,
    crossCheck: report.crossCheck,
    complete: report.complete,
  };
  summary.phases = { preBad, appliedBad, undoBad };
  if (WITH_WHERE) summary.diffCells = diffCells;
  summary.damage = damage;
  summary.hashes = { scanLog: sha256(SCAN_LOG), undoFunction: sha256(`${FN_DIR}/undo.mcfunction`) };
  summary.pass = preBad === 0 && report.complete
    && (SCAN_ONLY || (undoBad === 0 && (appliedBad === null || appliedBad > 0)));
  if (SCAN_ONLY) summary.scanOnly = true;
} catch (e) {
  summary.fatal = e.message;
  summary.pass = false;
  console.error('!! 中断:', e.message);
} finally {
  await send('save-all flush', 3000, true).catch(() => {});
  await send('stop', 4000, true).catch(() => {});
  try { proc.kill(); } catch {}
  fs.writeFileSync(`${OUT}/undo-accept.log`, out, 'utf8');
  fs.writeFileSync(`${OUT}/undo-accept.json`, JSON.stringify(summary, null, 2) + '\n', 'utf8');
  console.log('\n===== M1-6 无头验收汇总 =====');
  console.log(JSON.stringify(summary, null, 2));
  console.log(`原始控制台日志：${OUT}/undo-accept.log`);
  console.log(summary.pass ? '全部通过' : '未通过');
  exitCode = summary.pass ? 0 : 1;
}

process.exit(exitCode);
