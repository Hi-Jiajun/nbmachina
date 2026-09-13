// 无头服务器验收：铺单排 → 换 v3 音符 → 播放 → 核对"触发了多少音"(与 v3 数据对照) + 抽查方块
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const TS = 'C:/Users/hiliang/Documents/minecraft/testserver';
const SRC = 'C:/Users/hiliang/Documents/minecraft/build/styx_build';
const JAVA = 'C:/Users/hiliang/AppData/Roaming/.minecraft/runtime/java-runtime-delta/bin/java.exe';
const LOG = `${TS}/v3test.log`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 同步最新数据包
fs.rmSync(`${TS}/world/datapacks/styx_build`, { recursive: true, force: true });
fs.cpSync(SRC, `${TS}/world/datapacks/styx_build`, { recursive: true });

// 期望值：v3 数据里前 N 刻应有多少个音
const v3 = fs.readFileSync('C:/Users/hiliang/Documents/minecraft/build/styx_helix_notes_v3.csv', 'utf8').trim().split(/\r?\n/).slice(1)
  .map((l) => { const [step, tick, time, instr, midi, row, vol] = l.split(','); return { tick: +tick, instr, pitch: +row, vol: +vol }; });
const expectUpTo = (t) => v3.filter((n) => n.tick <= t).length;

const proc = spawn(JAVA, ['-Xms1G', '-Xmx2G', '-jar', 'server.jar', 'nogui'], { cwd: TS });
let out = '';
proc.stdout.on('data', (d) => { out += d.toString(); });
proc.stderr.on('data', (d) => { out += d.toString(); });
const send = (c) => { console.log('   >>> ' + c); proc.stdin.write(c + '\n'); };
const waitFor = async (re, t) => { const t0 = Date.now(); while (Date.now() - t0 < t) { if (re.test(out)) return true; await sleep(300); } return false; };
const said = (m) => out.includes(`[Server] ${m}`);
const scoreOf = (name) => { const m = [...out.matchAll(new RegExp(`${name} has (-?\\d+) \\[styx\\.flag\\]`, 'g'))]; return m.length ? +m[m.length - 1][1] : null; };

try {
  if (!(await waitFor(/Done \([\d.]+s\)!/, 240000))) throw new Error('启动超时');
  send('gamerule randomTickSpeed 0'); await sleep(400);
  send('gamerule doMobSpawning false'); await sleep(400);

  // 铺单排（前 39 段在 y=84，测的是机制，够用）
  send('forceload add 480 -176 1735 -136'); await sleep(9000);
  send('function styx:flat_build_v2a'); await sleep(6000);
  send('function styx:flat_build_v2b'); await sleep(6000);
  send('function styx:apply_notes_v3'); await sleep(20000);
  send('function styx:play/monitor_on'); await sleep(600);

  // 抽查：v3 第一颗音是 bass row=9 → z = -172+9+3 = -160
  send('execute if block 480 85 -160 minecraft:note_block[instrument=bass] run say V3_NOTE_OK'); await sleep(500);
  send('execute if block 480 84 -160 minecraft:oak_planks run say V3_UNDER_OK'); await sleep(500);
  send('execute if block 480 83 -160 minecraft:redstone_lamp run say V3_LAMP_OK'); await sleep(500);
  send('execute if block 480 86 -160 minecraft:air run say V3_TRIG_FREE_OK'); await sleep(500);

  // 播放 15 秒
  send('function styx:play/start'); await sleep(20000);
  send('scoreboard players get #t styx.t'); await sleep(600);
  send('scoreboard players get #hits styx.flag'); await sleep(600);
  send('function styx:play/report'); await sleep(800);
  send('function styx:play/stop'); await sleep(800);

  const tick = (() => { const m = [...out.matchAll(/#t has (\d+) \[styx\.t\]/g)]; return m.length ? +m[m.length - 1][1] : null; })();
  const hits = scoreOf('#hits');
  const exp = tick ? expectUpTo(tick) : null;
  console.log('\n===== 无头验收结果 =====');
  for (const m of ['V3_NOTE_OK', 'V3_UNDER_OK', 'V3_LAMP_OK', 'V3_TRIG_FREE_OK']) console.log(`${said(m) ? '✅' : '❌'} ${m}`);
  console.log(`播放刻数 #t = ${tick}`);
  console.log(`实际触发 #hits = ${hits}    v3 数据应有 ≈ ${exp}`);
  if (tick && hits !== null && exp !== null) {
    const diff = Math.abs(hits - exp);
    console.log(diff <= 2 ? `✅ 触发数量与 v3 数据一致（差 ${diff}）` : `⚠️ 触发数量差 ${diff}（检查是否有被挡住的触发位）`);
  }
} catch (e) {
  console.log('中断:', e.message);
} finally {
  send('stop'); await sleep(5000);
  try { proc.kill(); } catch {}
  fs.writeFileSync(LOG, out, 'utf8');
  console.log('日志:', LOG);
  process.exit(0);
}
