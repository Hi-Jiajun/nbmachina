// 无头端到端验收（确定性版）：
//   铺前半段单排 → 换音符 → 抽查方块 → styx:play/start → `tick step N` 确定性步进
//   → 断言：#t 推进 = N、#hits = 数据里 tick ≤ N 的音数、0 条 Failed to load function、MSPT ≤ 50
//   → 结果写 tests/e2e-run.json，退出码 0/1 反映真实结果（旧版永远 exit 0，等于没验收）
//
// 用法：node src/test/run-headless.mjs [--ticks 600] [--mode lo|hi] [--notes <csv>] [--segments 39]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { tickOfStep, buildTickGroups } from '../emit/tick-map.mjs';
import { makePos, DECK_BLOCK, noteBlockOf } from '../emit/layout-pos.mjs';
import { resolvePaths, resolveExternal } from '../core/paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../..');
// M2-3：build/工程名/测试服/java 全部走 paths.mjs（--build/--project/--server/--java 可覆盖）
const P = resolvePaths();
const EX = resolveExternal();
const B = P.build;
const TS = EX.server;
const SRC = P.packDir;
const JAVA = EX.java;

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const TICKS = +(opt('ticks', '600'));
const MODE = opt('mode', 'lo');
const TPS = MODE === 'hi' ? 100 : 20;
// 口径修正（M2-3）：默认用 arrange-all 的最终机器谱面；末尾还有一条"数据包与谱面同源"的护栏
const NOTES_CSV = opt('notes', P.machineScore);
const LOG = `${TS}/e2e-${MODE}.log`;
const PROPS = `${TS}/server.properties`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- 期望值：按模式刻率把 step 换成 tick，统计 tick ≤ TICKS 的音数 ---------- */
const rows = fs.readFileSync(NOTES_CSV, 'utf8').trim().split(/\r?\n/);
const header = rows[0].split(',');
const notes = rows.slice(1).map((l) => {
  const c = l.split(',');
  return { step: +c[header.indexOf('step')], instr: c[header.indexOf('instrument')], pitch: +c[header.indexOf('row')] };
});
const groups = buildTickGroups(notes, TPS);
const profile = JSON.parse(fs.readFileSync(`${B}/single_row_profile.json`, 'utf8'));
const pos = makePos(profile);
/** 统计 (fromTick, toTick] 区间内的音数（#t 是"已推进到的刻"，区间用开区间左端） */
function expectedInRange(fromTick, toTick) {
  let hits = 0, bass = 0, harp = 0;
  for (const [tick, list] of groups) {
    if (tick > toTick) break;
    if (tick <= fromTick) continue;
    for (const n of list) { hits++; if (n.instr === 'bass') bass++; else harp++; }
  }
  return { hits, bass, harp };
}

/**
 * 数据包里**实际派发**的触发数（同一区间口径）。用来抓"装错谱面"这类静默故障：
 * 数据包里的 `play/<mode>/bNNN` 是生成时写死的，和 `--notes` 给的谱面对不上就说明两者不同源
 * （2026-09-14 实测：数据包装的是 v3 谱面 279 音，e2e 按 machine_pipeline 期望 295 音 → 差 16）。
 */
function packTriggersInRange(fromTick, toTick) {
  const dir = `${SRC}/data/styx/function/play/${MODE}`;
  if (!fs.existsSync(dir)) return null;
  let n = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!/^b\d+\.mcfunction$/.test(f)) continue;
    for (const line of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      const m = line.match(/^execute if score #t styx\.t matches (\d+) run scoreboard players add #hits styx\.flag 1$/);
      if (!m) continue;
      const t = +m[1];
      if (t > fromTick && t <= toTick) n++;
    }
  }
  return n;
}

/* ---------- 同步数据包 ---------- */
// 空服 60 秒后服务器会 "Server empty for 60 seconds, pausing" —— 刻轴直接停住，
// 这正是之前 `#t` 读到 485/216 等怪值的根因。无头验收必须关掉它。
{
  const p = fs.readFileSync(PROPS, 'utf8');
  const fixed = /^pause-when-empty-seconds=.*$/m.test(p)
    ? p.replace(/^pause-when-empty-seconds=.*$/m, 'pause-when-empty-seconds=0')
    : p.replace(/^max-tick-time=.*$/m, (m) => `${m}\npause-when-empty-seconds=0`);
  if (fixed !== p) { fs.writeFileSync(PROPS, fixed, 'utf8'); console.log('已把 pause-when-empty-seconds 改为 0（防空服暂停冻结刻轴）'); }
}
fs.rmSync(`${TS}/world/datapacks/styx_build`, { recursive: true, force: true });
fs.cpSync(SRC, `${TS}/world/datapacks/styx_build`, { recursive: true });

const proc = spawn(JAVA, ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: TS });
let out = '';
proc.stdout.on('data', (d) => { out += d.toString(); });
proc.stderr.on('data', (d) => { out += d.toString(); });
const send = async (c, wait = 400) => {
  const mark = out.length;
  console.log('   >>> ' + c);
  proc.stdin.write(c + '\n');
  await sleep(wait);
  return out.slice(mark);
};
const waitFor = async (re, t) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (re.test(out)) return true; await sleep(300); } return false; };
const said = (m) => out.includes(`[Server] ${m}`);
const scoreOf = (name, obj) => {
  const m = [...out.matchAll(new RegExp(`${name} has (-?\\d+) \\[${obj}\\]`, 'g'))];
  return m.length ? +m[m.length - 1][1] : null;
};
/** 可靠读数：只解析本次命令之后新增的输出，且失败重试（服务器忙时 300ms 可能还没回包） */
const readScore = async (name, obj, tries = 6) => {
  for (let i = 0; i < tries; i++) {
    const mark = out.length;
    proc.stdin.write(`scoreboard players get ${name} ${obj}\n`);
    await sleep(400);
    const m = [...out.slice(mark).matchAll(new RegExp(`${name} has (-?\\d+) \\[${obj}\\]`, 'g'))];
    if (m.length) return +m[m.length - 1][1];
  }
  console.log(`   !! 读不到 ${name} [${obj}]`);
  return null;
};

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`); };

let mspt = null, tick = null, hits = null, mh = null, mb = null, fatal = null;
let exp = { hits: 0, harp: 0, bass: 0 };
let base = { t: 0, on: null, hits: 0, mh: 0, mb: 0 };
let posChecks = [];

try {
  if (!(await waitFor(/Done \([\d.]+s\)!/, 300000))) throw new Error('服务器启动超时');
  await send('gamerule randomTickSpeed 0');
  await send('gamerule doMobSpawning false');
  await send('gamerule doDaylightCycle false');

  // 铺前 39 段（y=84）并换音符：600 刻只走到第 6 段，够用且省时间
  await send('forceload add 480 -176 1735 -136', 9000);
  await send('function styx:flat_build_v2a', 7000);
  await send('function styx:flat_build_v2b', 7000);
  await send('function styx:apply_notes_v3', 22000);

  // 抽查 3 颗音：**位置 + 音色 + 音高 + 灯 + 触发位空闲**五项都要对
  //   （这一条专门抓"播放器算的坐标"与"apply_notes_v3 摆的音符盒"错位——错位时 #hits 照样涨，但听不到声）
  const samples = [
    ['首音', notes[0]],
    ['首个钢琴', notes.find((n) => n.instr !== 'bass')],
    ['中段(step≈1248)', notes.slice().sort((a, b) => Math.abs(a.step - 1248) - Math.abs(b.step - 1248))[0]],
  ].filter(([, n]) => n);
  posChecks = [];
  for (let i = 0; i < samples.length; i++) {
    const [label, n] = samples[i];
    const { x, y, z } = pos(n.step, n.pitch);
    const tag = `E2E_POS${i}_OK`;
    await send(`execute if block ${x} ${y + 1} ${z} ${noteBlockOf(n.instr, n.pitch)} run say ${tag}`, 400);
    await send(`execute if block ${x} ${y} ${z} ${DECK_BLOCK[n.instr]} run say ${tag}`, 400);
    await send(`execute if block ${x} ${y - 1} ${z} minecraft:redstone_lamp run say ${tag}`, 400);
    await send(`execute if block ${x} ${y + 2} ${z} minecraft:air run say ${tag}`, 400);
    posChecks.push({ label, x, y, z, instr: n.instr, row: n.pitch, tag, ok: null });
  }
  // 每个 tag 会被 say 4 次；只要出现 4 次就说明四项全对
  for (const c of posChecks) {
    c.ok = (out.match(new RegExp(`\\[Server\\] ${c.tag}`, 'g')) || []).length >= 4;
  }
  check(`抽查 ${posChecks.length} 颗音的位置/音色/音高/灯/触发位`, posChecks.every((c) => c.ok),
    posChecks.map((c) => `${c.label}(x${c.x},z${c.z},${c.instr}${c.row})${c.ok ? '✔' : '✘'}`).join(' '));

  // 开播 + 确定性步进
  // 监听计数（#mh/#mb）只在 #mon=1 时累加：这里显式打开，避免"靠存档里残留的 #mon 状态"
  // 导致下面两条断言随世界状态飘（实测出现过增量恒 0 的假失败）。
  await send('function styx:play/monitor_on', 400);
  // M3-4：自研音色那条链（styx:play/hifi/*）过去**没有接线**，玩家开监听听不到任何自研音色
  // （2026-09-14 客户端实测）。这里显式打开高保真监听并断言它每刻真的在触发。
  await send('function styx:play/monitor_hifi_on', 400);
  if (MODE === 'hi') {
    await send('tick rate 100', 800); // 控制台是权限等级 4，只有玩家聊天里受等级 3 限制的 /tick 能在控制台做
  }
  const startCmd = MODE === 'hi' ? 'function styx:play/start_hi' : 'function styx:play/start';
  await send(startCmd, 800);
  // 先冻结再取基线：冻结状态下 #t 不会走动，区间就是干净的 [base.t, base.t+N]
  await send('tick freeze', 600);
  base = {};
  const baselineReads = [];
  for (const [k, obj] of [['t', 'styx.t'], ['on', 'styx.flag'], ['hits', 'styx.flag'], ['mh', 'styx.flag'], ['mb', 'styx.flag'], ['hifiPlays', 'styx.hifi']]) {
    base[k] = await readScore(`#${k}`, obj);
    baselineReads.push(`${k}=${base[k]}`);
  }
  console.log('   基线：' + baselineReads.join(' '));
  check(`${startCmd} 执行成功（#on = 1）`, base.on === 1, `#on=${base.on}、#t=${base.t}`);
  // `/tick step` 要求先冻结，而且是**按实时 20 tps 走**（实测 600 刻要 30 秒）；`tick sprint` 才是全速。
  await send(`tick sprint ${TICKS}`, 1000);
  // sprint 异步，等 #t 到位
  let waited = 0;
  while (waited < 60000) {
    tick = await readScore('#t', 'styx.t', 1);
    if (tick !== null && tick >= base.t + TICKS) break;
    waited += 400;
  }
  hits = await readScore('#hits', 'styx.flag');
  mh = await readScore('#mh', 'styx.flag');
  mb = await readScore('#mb', 'styx.flag');
  const hifiPlays = await readScore('#hifiPlays', 'styx.hifi');
  // MSPT 要在"真实跑"的状态下量：解冻跑 ~5 秒再查（`tick query` 的行是 "Average time per tick: X ms"）
  await send('tick unfreeze', 500);
  await sleep(5000);
  const q = await send('tick query', 600);
  const mm = q.match(/Average time per tick:\s*([0-9]+(?:\.[0-9]+)?)\s*ms/i);
  if (mm) mspt = +mm[1];
  await send('function styx:play/report', 600);
  await send('function styx:play/doctor', 2500); // 自检的刻率对比靠 /schedule 20t，必须在"跑"的状态下

  exp = expectedInRange(base.t, tick ?? base.t);
  // 实测：`tick sprint N` 会多跑 1 刻（收尾冻结那一拍），所以接受 N 与 N+1；刻窗口一律按实际 #t 算
  const advanced = tick !== null ? tick - base.t : null;
  check(`#t 推进 = ${TICKS}（允许 +1，sprint 收尾）`, advanced === TICKS || advanced === TICKS + 1, `基线 ${base.t} → ${tick}（+${advanced}）`);
  check(`#hits 增量 = 期望 ${exp.hits}（差 ≤1）`, hits !== null && Math.abs((hits - base.hits) - exp.hits) <= 1, `实际 ${hits - base.hits}`);
  const packCount = packTriggersInRange(base.t, tick ?? base.t);
  check(`数据包 ${MODE === 'hi' ? '100 tps' : '20 tps'} 派发表与 --notes 同源（防装错谱面）`,
    packCount !== null && Math.abs(packCount - exp.hits) <= 1,
    packCount === null ? '读不到数据包派发表' : `数据包 ${packCount} vs 谱面 ${exp.hits}`);
  if (mh !== null) check(`监听 钢琴 增量 = 期望 ${exp.harp}`, Math.abs((mh - base.mh) - exp.harp) <= 1, `实际 ${mh - base.mh}`);
  if (mb !== null) check(`监听 贝斯 增量 = 期望 ${exp.bass}`, Math.abs((mb - base.mb) - exp.bass) <= 1, `实际 ${mb - base.mb}`);
  // 自研音色链：每个音符一条 /playsound，增量应当等于同一窗口的音符数（接不上线时恒为 0）
  check(`自研音色 每刻触发增量 = 期望 ${exp.hits}`, hifiPlays !== null && Math.abs(hifiPlays - base.hifiPlays) >= exp.hits - 1,
    hifiPlays === null ? '读不到 #hifiPlays' : `实际 ${hifiPlays - base.hifiPlays}`);
  const loadErrors = (out.match(/Failed to load function/g) || []).length;
  check('0 条 Failed to load function', loadErrors === 0, `实际 ${loadErrors}`);
  const msptBudget = TPS === 100 ? 10 : 50;
  check(`MSPT ≤ ${msptBudget}（${TPS} tps 的单刻预算）`, mspt !== null && mspt <= msptBudget, mspt === null ? '未能从 tick query 解析到 ms' : `${mspt} ms`);
} catch (e) {
  fatal = e.message;
  check('端到端流程未中断', false, e.message);
} finally {
  await send('tick unfreeze', 300).catch(() => {});
  if (MODE === 'hi') await send('tick rate 20', 300).catch(() => {});
  await send('stop', 5000).catch(() => {});
  try { proc.kill(); } catch {}
  fs.writeFileSync(LOG, out, 'utf8');
}

const report = {
  at: new Date().toISOString(), mode: MODE, tps: TPS, ticks: TICKS, notesCsv: NOTES_CSV,
  baseline: base,
  positions: posChecks,
  expected: exp,
  actual: { t: tick, hits, mh, mb, mspt },
  delta: { t: tick !== null ? tick - base.t : null, hits: hits !== null ? hits - base.hits : null, mh: mh !== null ? mh - base.mh : null, mb: mb !== null ? mb - base.mb : null },
  loadErrors: (out.match(/Failed to load function/g) || []).length,
  fatal, checks,
};
fs.mkdirSync(`${REPO}/tests`, { recursive: true });
fs.writeFileSync(`${REPO}/tests/e2e-run.json`, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n===== 汇总（${MODE} / ${TPS} tps / ${TICKS} 刻）=====`);
console.log(`期望增量 ${exp.hits} 音（钢琴 ${exp.harp} / 贝斯 ${exp.bass}），实际 #hits 增量 ${hits !== null ? hits - base.hits : null}，MSPT=${mspt}`);
console.log(`日志：${LOG}；报告：${REPO}/tests/e2e-run.json`);
const failed = checks.filter((c) => !c.ok);
console.log(failed.length === 0 && !fatal ? '全部通过' : `未通过 ${failed.length + (fatal ? 1 : 0)} 项`);
process.exit(failed.length === 0 && !fatal ? 0 : 1);
