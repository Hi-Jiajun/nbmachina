// 直接验"短音选 sta、长音选 leg"这条规则：对同一颗音分别给 durMs=200 / 3000，看选中的采样文件
import fs from 'node:fs';
import path from 'node:path';
import { loadSfz, pickRegion } from '../../nbm/src/sample/sfz.mjs';

const DIR = 'C:/Users/hiliang/Documents/minecraft/_toolchain/olpc/x/yamahaGrandPiano44';
const leg = loadSfz(path.join(DIR, 'yamaha_disklavier_olpc.sfz'));

function scanSta(dir) {
  const byRoot = new Map();
  for (const f of fs.readdirSync(dir)) {
    const m = f.match(/^pno(\d+)v(\d+)sta\.wav$/i);
    if (!m) continue;
    const root = Number(m[1]);
    if (!byRoot.has(root)) byRoot.set(root, []);
    byRoot.get(root).push({ vel: Number(m[2]), file: path.join(dir, f).replace(/\\/g, '/') });
  }
  const out = [];
  for (const [root, list] of byRoot) {
    list.sort((a, b) => a.vel - b.vel);
    for (let i = 0; i < list.length; i++) {
      out.push({
        file: list[i].file, loKey: root, hiKey: root, root,
        loVel: i === 0 ? 1 : Math.floor((list[i - 1].vel + list[i].vel) / 2) + 1,
        hiVel: i === list.length - 1 ? 127 : Math.floor((list[i].vel + list[i + 1].vel) / 2),
        gainDb: 0, tuneCents: 0, staccato: true,
      });
    }
  }
  return out;
}

const all = [...leg.regions, ...scanSta(DIR)];
console.log(`disklavier 区域：leg ${leg.regions.length} + sta ${all.length - leg.regions.length} = ${all.length}`);
for (const [midi, vel] of [[60, 95], [40, 60], [84, 110]]) {
  for (const dur of [200, 3000]) {
    const r = pickRegion(all, midi, vel, 0, dur);
    console.log(`  midi ${midi} vel ${vel} durMs ${String(dur).padStart(4)} → ${path.basename(r.file)}${r.staccato ? '（sta）' : '（leg）'}`);
  }
}
