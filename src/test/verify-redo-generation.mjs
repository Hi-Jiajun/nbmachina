// M3-70 · 无头验收：**证明 `styx:redo` 真的把音符盒铺到世界里了**。
//
// 为什么要有它：2026-09-22 用户在虚空存档跑 redo，收到"重做完成"提示，但世界里**一个音符盒都没有**。
// 真因是 redo 链的 `forceload` 范围还写着旧原点（480..2880 / z −176..−136）→ 机器所在的区块压根没加载
// → `setblock` 静默失败。这种"提示成功、世界没变"的故障只能靠**扫存档**抓，所以验收必须落到方块层：
//
//   1. 起一个**全新的虚空世界**测试服（`_toolchain/spike-void`），装上当前数据包 + 当前 mod jar；
//   2. 控制台跑 `function styx:redo`，按 20 tps **真节奏**等整条链跑完（约 40 秒）；
//   3. 停服后直接读 `<世界>/region/*.mca`，把音符盒坐标集合与 `machine_map.csv` **逐个对账**；
//   4. 结果写 `build/verify-redo-generation.json`，退出码 0/1（失败时打印差集样本）。
//
// 用法：
//   node src/test/verify-redo-generation.mjs                                  # 全新虚空世界（最干净）
//   node src/test/verify-redo-generation.mjs --world-src <存档目录>            # 复现真实存档（连地形一起拷）
//   可选：--server <测试服目录> --java <exe>
//
// ⚠ 关键：**不能靠 `tick sprint` 压缩时间**。区块加载要真实时间（forceload 之后几秒里区块才真正准备好），
// 2026-09-22 实测：sprint 把 1200 刻压到 1 秒内跑完 → setblock 全落在"还没加载好"的区块上 → 0 个音符盒。
// 所以这里按 20 tps 真节奏跑完整条链（约 40 秒），只在最后抽查阶段额外强加载等区块就绪。
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths, resolveExternal, REPO_ROOT } from '../core/paths.mjs';
import { makeSaveReader } from '../scan/mca.mjs';

const P = resolvePaths();
const EX = resolveExternal();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n) => argv.includes(`--${n}`);

const SERVER = path.resolve(opt('server', 'C:/Users/hiliang/Documents/minecraft/_toolchain/spike-void'));
const JAVA = opt('java', EX.java);
/** 要复现的真实存档（给了就连地形/方块一起拷；不给就造全新虚空世界） */
const WORLD_SRC = opt('world-src', '');
const WORLD = path.join(SERVER, 'world');
const MAP = opt('map', path.join(P.build, 'nbmachina_machine_map.csv'));
const REPORT = path.join(P.build, 'verify-redo-generation.json');
const LOG = path.join(P.build, 'verify-redo-generation.log');
/** 共用的大件（libraries / versions / .fabric）从一个现成测试服 junction 过来，省几百 MB 复制 */
const DONOR = opt('donor', 'C:/Users/hiliang/Documents/minecraft/_toolchain/spike-testserver');
/** 客户端 mods 目录：用户存档靠 2032-world-height 才能到 y < −64，复现真实存档时要带上它 */
const CLIENT_MODS = 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5/mods';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 安全检查：只允许删自己测试服目录下的 world/（绝不碰用户存档） */
function assertOwnWorld() {
  const norm = WORLD.replace(/\\/g, '/').toLowerCase();
  if (!norm.includes('_toolchain') || !/spike|void|test/.test(norm)) {
    throw new Error(`拒绝清空 ${WORLD}：测试世界必须位于 _toolchain 下的 spike/void/test 目录里`);
  }
}

function prepare() {
  assertOwnWorld();
  fs.mkdirSync(SERVER, { recursive: true });
  for (const n of ['libraries', 'versions', '.fabric']) {
    const dst = path.join(SERVER, n), src = path.join(DONOR, n);
    if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
    fs.symlinkSync(src, dst, 'junction');
  }
  for (const f of ['fabric-server-launch.jar', 'server.jar']) {
    const dst = path.join(SERVER, f), src = path.join(DONOR, f);
    if (fs.existsSync(dst) || !fs.existsSync(src)) continue;
    fs.copyFileSync(src, dst);
  }
  fs.writeFileSync(path.join(SERVER, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(SERVER, 'server.properties'), [
    'level-name=world',
    'level-type=minecraft:flat',
    'generator-settings={"layers":[],"biome":"minecraft:the_void"}',
    'online-mode=false',
    'spawn-protection=0',
    'view-distance=8',
    'simulation-distance=8',
    'max-players=2',
    'allow-nether=false',
    'enable-command-block=true',
    'sync-chunk-writes=false',
    'max-tick-time=-1',
    'spawn-monsters=false',
    'spawn-animals=false',
    'spawn-npcs=false',
    'level-seed=styx-void-redo-verify',
    '',
  ].join('\n'));
  // mods：**保留目标测试服已有的其它 mod**（世界高度 mod 之类），只替换 nbmachina 自己
  const mods = path.join(SERVER, 'mods');
  fs.mkdirSync(mods, { recursive: true });
  for (const f of fs.readdirSync(mods)) {
    if (/^nb(machina|forge)-.*\.jar$/i.test(f)) fs.rmSync(path.join(mods, f));
  }
  const modFiles = () => fs.readdirSync(mods);
  if (!modFiles().some((f) => /^fabric-api-.*\.jar$/i.test(f))) {
    const api = fs.existsSync(path.join(DONOR, 'mods'))
      ? fs.readdirSync(path.join(DONOR, 'mods')).find((f) => /^fabric-api-.*\.jar$/i.test(f))
      : undefined;
    if (api) fs.copyFileSync(path.join(DONOR, 'mods', api), path.join(mods, api));
  }
  if (!modFiles().some((f) => /^2032-world-height.*\.jar$/i.test(f)) && fs.existsSync(CLIENT_MODS)) {
    const wh = fs.readdirSync(CLIENT_MODS).find((f) => /^2032-world-height.*\.jar$/i.test(f));
    if (wh) fs.copyFileSync(path.join(CLIENT_MODS, wh), path.join(mods, wh));
  }
  const built = path.join(REPO_ROOT, 'mod', 'build', 'libs');
  const jars = fs.existsSync(built) ? fs.readdirSync(built).filter((f) => /^nbmachina-.*\.jar$/.test(f) && !f.includes('sources')) : [];
  if (!jars.length) throw new Error(`找不到构建产物：${built}`);
  jars.sort();
  const jar = jars[jars.length - 1];
  fs.copyFileSync(path.join(built, jar), path.join(mods, jar));
  // 谱面映射：mod 从 `server.getRunDirectory()/nbmachina/machine_map.csv` 读
  fs.mkdirSync(path.join(SERVER, 'nbmachina'), { recursive: true });
  fs.copyFileSync(MAP, path.join(SERVER, 'nbmachina', 'machine_map.csv'));
  // 世界：`--world-src` 给真存档就复制它（跳过被客户端占用的 session.lock），否则全新虚空
  fs.rmSync(WORLD, { recursive: true, force: true });
  if (WORLD_SRC) {
    fs.cpSync(path.resolve(WORLD_SRC), WORLD, {
      recursive: true,
      filter: (src) => !/session\.lock$/i.test(src) && !/[\\/]voxy[\\/]/i.test(src),
    });
  } else {
    fs.mkdirSync(WORLD, { recursive: true });
  }
  const dstPack = path.join(WORLD, 'datapacks', 'styx_build');
  fs.mkdirSync(path.dirname(dstPack), { recursive: true });
  fs.cpSync(P.packDir, dstPack, { recursive: true });
  return jar;
}

/** 读 machine_map.csv → 音符盒坐标集合（csv 的行是"甲板"坐标，音符盒在 y+1） */
function expectedNoteBlocks() {
  const lines = fs.readFileSync(MAP, 'utf8').trim().split(/\r?\n/);
  const h = lines[0].split(',');
  const ix = h.indexOf('x'), iy = h.indexOf('y'), iz = h.indexOf('z');
  const set = new Set();
  for (const l of lines.slice(1)) {
    const c = l.split(',');
    set.add(`${+c[ix]},${+c[iy] + 1},${+c[iz]}`);
  }
  return set;
}

const out = [];
let proc = null;
const send = async (c, wait = 500) => {
  console.log('   >>> ' + c);
  proc.stdin.write(c + '\n');
  await sleep(wait);
};
const waitFor = async (re, t) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (re.test(out.join(''))) return true; await sleep(400); } return false; };

async function runServer(expected, windows) {
  const log = fs.createWriteStream(LOG, { flags: 'w' });
  proc = spawn(JAVA, ['-Xmx2G', '-jar', 'fabric-server-launch.jar', 'nogui'], { cwd: SERVER });
  const onData = (d) => { const s = d.toString(); out.push(s); log.write(s); process.stdout.write(s.replace(/^/gm, '     | ')); };
  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData);
  const exited = new Promise((r) => proc.on('exit', r));

  if (!(await waitFor(/Done \([\d.]+s\)!/, 300000))) throw new Error('服务器启动超时');
  await send('gamerule randomTickSpeed 0', 300);
  await send('gamerule doMobSpawning false', 300);
  await send('gamerule doDaylightCycle false', 300);
  await send('function styx:redo', 800);
  // 真节奏跑完整条链：轮询 forceload 状态判断"链跑完了"（s4 结尾 forceload remove all）
  const deadline = Date.now() + 300000;
  let sawForceload = false, done = false;
  while (Date.now() < deadline) {
    const mark = out.length;
    proc.stdin.write('forceload query\n');
    await sleep(5000);
    const chunk = out.slice(mark).join('');
    const none = /No force loaded chunks were found/.test(chunk);
    if (!none && /force loaded|Marked \d+ chunks/.test(chunk + out.join(''))) sawForceload = true;
    if (sawForceload && none) { done = true; break; }
  }
  console.log(`   链执行完毕=${done}`);
  // 抽查前先把整条机器强加载好，并**留真实时间**给区块加载（否则 setblock/抽查都会落空）
  for (const w of windows) await send(`forceload add ${w[0]} ${w[2]} ${w[1]} ${w[3]}`, 400);
  await sleep(30000);
  const samples = [...expected].filter((_, i) => i % Math.max(1, Math.floor(expected.size / 10)) === 0).slice(0, 10);
  for (const s of samples) {
    const [x, y, z] = s.split(',');
    // 先报"这一步的区块到底加载了没有"——两种情况（区块没加载 / 方块没铺）要分得清
    await send(`execute if loaded ${x} ${y} ${z} run say NB_LOADED ${x} ${y} ${z}`, 150);
    await send(`execute if block ${x} ${y} ${z} minecraft:note_block run say NB_PROBE_OK ${x} ${y} ${z}`, 250);
  }
  await send('save-all flush', 3000);
  await send('stop', 500);
  await exited;
  log.end();
  const text = out.join('');
  return {
    done,
    loadErrors: [...text.matchAll(/Failed to load function[^\n]*/g)].map((m) => m[0]),
    probes: [...text.matchAll(/\[Server\] NB_PROBE_OK (\S+ \S+ \S+)/g)].map((m) => m[1]),
    loadedProbes: [...text.matchAll(/\[Server\] NB_LOADED (\S+ \S+ \S+)/g)].map((m) => m[1]),
    sampleCount: samples.length,
  };
}

function scanWorld(expected) {
  const reader = makeSaveReader(WORLD);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const s of expected) {
    const [x, y, z] = s.split(',').map(Number);
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y + 1);
    z0 = Math.min(z0, z); z1 = Math.max(z1, z);
  }
  const box = { x0: x0 - 2, x1: x1 + 2, y0: y0 - 2, y1: y1 + 2, z0: z0 - 2, z1: z1 + 2 };
  const hits = reader.scan(box, ['minecraft:note_block']).get('minecraft:note_block');
  const found = new Set(hits.map((p) => p.join(',')));
  const missing = [...expected].filter((s) => !found.has(s));
  const extra = [...found].filter((s) => !expected.has(s));
  return { box, foundCount: found.size, missing, extra };
}

const result = { ok: false, startedAt: new Date().toISOString(), server: SERVER, world: WORLD, map: MAP };
try {
  const jar = prepare();
  result.jar = jar;
  result.worldSrc = WORLD_SRC || '(新建虚空世界)';
  const expected = expectedNoteBlocks();
  result.expectedCount = expected.size;
  console.log(`虚空无头验收：${SERVER}`);
  console.log(`  世界来源：${result.worldSrc}`);
  console.log(`  期望音符盒 ${expected.size} 个（来自 ${MAP}）`);
  // 强加载窗口：与 redo 链同一套推导（x 均分三段 + z 带留 3 格余量）
  const xs = [...expected].map((s) => +s.split(',')[0]);
  const zs = [...expected].map((s) => +s.split(',')[2]);
  const wx0 = Math.min(...xs), wx1 = Math.max(...xs);
  const wz0 = Math.min(...zs) - 3, wz1 = Math.max(...zs) + 3;
  const step = Math.ceil((wx1 - wx0 + 1) / 3);
  const windows = [[wx0, wx0 + step - 1], [wx0 + step, wx0 + 2 * step - 1], [wx0 + 2 * step, wx1]]
    .map(([a, b]) => [a, b, wz0, wz1]);
  result.windows = windows;
  const run = await runServer(expected, windows);
  Object.assign(result, run);
  result.probeOk = run.probes.length;
  const scan = scanWorld(expected);
  result.foundCount = scan.foundCount;
  result.missingCount = scan.missing.length;
  result.extraCount = scan.extra.length;
  result.missingSample = scan.missing.slice(0, 8);
  result.extraSample = scan.extra.slice(0, 8);
  result.box = scan.box;
  result.ok = run.done && scan.missing.length === 0 && scan.extra.length === 0;
  console.log(`\n结果：铺出 ${scan.foundCount}/${result.expectedCount} 个音符盒；缺 ${result.missingCount}、多 ${result.extraCount}`);
  console.log(`  抽查 ${run.probes.length}/${run.sampleCount} 颗命中（区块已加载 ${run.loadedProbes.length}/${run.sampleCount}）`
    + (run.loadErrors.length ? `；函数加载错误 ${run.loadErrors.length} 条` : ''));
  if (result.missingSample.length) console.log('  缺失样本：' + result.missingSample.join(' | '));
  if (result.extraSample.length) console.log('  多余样本：' + result.extraSample.join(' | '));
  if (run.loadErrors.length) console.log('  函数加载错误：' + run.loadErrors.slice(0, 5).join(' | '));
  if (!run.done) console.log('  没有等到"重做完成"提示（调度链可能没跑完）');
} catch (e) {
  result.error = String(e && e.message || e);
  console.error('验收失败：' + result.error);
} finally {
  try { if (proc && !proc.killed) proc.kill(); } catch { /* ignore */ }
  result.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REPORT), { recursive: true });
  fs.writeFileSync(REPORT, JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(`报告：${REPORT}${result.ok ? ' —— ✅ 通过' : ' —— ❌ 未通过'}`);
}
process.exit(result.ok ? 0 : 1);
