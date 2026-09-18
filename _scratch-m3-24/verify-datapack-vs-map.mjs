// M3-24 校验：**数据包真正会触发的坐标** ↔ **mod 读的 machine_map.csv** 是否一一对上。
// 这是"游戏内会不会响、响得对不对"的最后一道静态检查：
//   数据包 play/lo（20tps）与 play/hi（100tps）里所有 `nbforge playat x y z` 的坐标，
//   必须都能在 machine_map.csv 里查到，且查到的音符与谱面完全一致。
import fs from 'node:fs';

const B = 'C:/Users/hiliang/Documents/minecraft/build';
const DP = `${B}/styx_build/data/styx/function/play`;

const map = new Map();
for (const line of fs.readFileSync(`${B}/nbforge_machine_map.csv`, 'utf8').trim().split(/\r?\n/).slice(1)) {
  const c = line.split(',');
  map.set(`${c[0]},${c[1]},${c[2]}`, { instr: c[3], voice: c[4], midi: +c[5], vel: +c[6], dur: +c[7] });
}
const score = new Map();   // (x,y,z) → 谱面音符（由 step/row 反推）
const profile = JSON.parse(fs.readFileSync(`${B}/single_row_profile.json`, 'utf8'));
const stepOfX = (x) => {
  for (let k = 0; k < profile.length; k++) {
    const off = x - profile[k].x0;
    if (off >= 0 && off < 48) return k * 48 + off;
  }
  return -1;
};
for (const line of fs.readFileSync(`${B}/machine_from_reference.csv`, 'utf8').trim().split(/\r?\n/).slice(1)) {
  const c = line.split(',');
  const h = fs.readFileSync(`${B}/machine_from_reference.csv`, 'utf8').split(/\r?\n/)[0].split(',');
  const i = Object.fromEntries(h.map((x, k) => [x, k]));
  const step = +c[i.step], row = +c[i.row];
  const seg = Math.floor(step / 48), lx = step % 48;
  const r = profile[Math.min(seg, profile.length - 1)];
  score.set(`${r.x0 + lx},${r.y},${-172 + row + 3}`, { midi: +c[i.midi], vel: +c[i.velMidi], dur: +c[i.durMs] });
}

let total = 0, missing = 0, wrong = 0, dup = 0;
const seen = new Set();
for (const mode of ['lo', 'hi']) {
  const dir = `${DP}/${mode}`;
  let modeTotal = 0, modeMissing = 0;
  for (const f of fs.readdirSync(dir)) {
    if (!f.startsWith('b')) continue;
    for (const line of fs.readFileSync(`${dir}/${f}`, 'utf8').split('\n')) {
      const m = line.match(/nbforge playat (-?\d+) (-?\d+) (-?\d+)/);
      if (!m) continue;
      const key = `${m[1]},${m[2]},${m[3]}`;
      total++; modeTotal++;
      if (mode === 'lo') seen.add(key);
      const got = map.get(key);
      const want = score.get(key);
      if (!got) { missing++; modeMissing++; continue; }
      if (!want || got.midi !== want.midi || got.vel !== want.vel) wrong++;
    }
  }
  console.log(`play/${mode}：触发 ${modeTotal} 条 → 映射缺失 ${modeMissing}`);
}
console.log(`machine_map 条目 ${map.size}；谱面格位 ${score.size}；lo 模式触发的去重坐标 ${seen.size}`);
console.log(`合计触发 ${total} 条：缺失 ${missing}；音符不一致 ${wrong}`);

// 20/100 tps 下的触发时刻误差（相对谱面精确时间）
const rows = fs.readFileSync(`${B}/machine_from_reference.csv`, 'utf8').trim().split(/\r?\n/).slice(1);
const h = fs.readFileSync(`${B}/machine_from_reference.csv`, 'utf8').split(/\r?\n/)[0].split(',');
const it = h.indexOf('time_seconds');
const errs = { 20: [], 100: [] };
for (const line of rows) {
  const t = +line.split(',')[it];
  for (const tps of [20, 100]) errs[tps].push(Math.abs(Math.round(t * tps) / tps - t) * 1000);
}
for (const tps of [20, 100]) {
  const a = errs[tps].sort((x, y) => x - y);
  console.log(`${tps} tps：触发时刻误差 中位 ${a[a.length >> 1].toFixed(1)}ms / p90 ${a[Math.floor(a.length * 0.9)].toFixed(1)}ms`
    + ` / 最大 ${a.at(-1).toFixed(1)}ms`);
}
