#!/usr/bin/env node
// 最小 SF2（SoundFont 2）解析：只看"这架钢琴到底录了哪些键、几层、什么采样率"。
//
// SF2 = RIFF 容器：`sdta/smpl`（16bit PCM 采样数据）+ `pdta/shdr`（每个采样的头：
// 名称/起止/循环点/采样率/**根音键 originalPitch**/音分修正）。判断"是否逐键采样"
// 只需要 shdr 的根音列表 —— 88 键各有独立根音 = 逐键；否则中间键要靠采样器变调。
//
//   node tools/sf2-info.mjs --sf2 <file.sf2>
import fs from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const SF2 = opt('sf2');
if (!SF2) { console.error('用法：node tools/sf2-info.mjs --sf2 <file.sf2>'); process.exit(2); }

const buf = fs.readFileSync(SF2);
if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'sfbk') {
  console.error('不是 SF2（缺少 RIFF/sfbk）'); process.exit(3);
}
/** 遍历 RIFF 子块 */
function* chunks(start, end) {
  let p = start;
  while (p + 8 <= end) {
    const id = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    yield { id, start: p + 8, size };
    p += 8 + size + (size % 2);
  }
}
let shdr = null;
let smpl = null;
for (const list of chunks(12, buf.length)) {
  if (!['LIST'].includes(list.id)) continue;
  const type = buf.toString('ascii', list.start, list.start + 4);
  for (const c of chunks(list.start + 4, list.start + list.size)) {
    if (type === 'pdta' && c.id === 'shdr') shdr = c;
    if (type === 'sdta' && c.id === 'smpl') smpl = c;
  }
}
if (!shdr) { console.error('找不到 pdta/shdr'); process.exit(4); }
const REC = 46;
const n = Math.floor(shdr.size / REC) - 1;              // 最后一条是终止记录
const samples = [];
for (let i = 0; i < n; i++) {
  const p = shdr.start + i * REC;
  const name = buf.toString('ascii', p, p + 20).replace(/\0.*$/, '').trim();
  samples.push({
    name,
    start: buf.readUInt32LE(p + 20),
    end: buf.readUInt32LE(p + 24),
    loopStart: buf.readUInt32LE(p + 28),
    loopEnd: buf.readUInt32LE(p + 32),
    sampleRate: buf.readUInt32LE(p + 36),
    rootKey: buf.readUInt8(p + 40),
    pitchCorrection: buf.readInt8(p + 41),
    sampleType: buf.readUInt16LE(p + 44),
  });
}
const roots = [...new Set(samples.map((s) => s.rootKey))].sort((a, b) => a - b);
const rates = [...new Set(samples.map((s) => s.sampleRate))];
console.log(`SF2: ${SF2.split(/[\\/]/).pop()}`);
console.log(`采样数=${samples.length}  唯一根音=${roots.length}  根音范围 ${roots[0]}..${roots.at(-1)}  采样率 ${rates.join('/')}`);
console.log(`根音列表：${roots.join(' ')}`);
const missing = [];
for (let k = 21; k <= 108; k++) if (!roots.includes(k)) missing.push(k);
console.log(`88 键里"没有自己根音"的键数=${missing.length}${missing.length ? '（例：' + missing.slice(0, 12).join(' ') + '）' : '（= 逐键采样 ✓ 零变调可行）'}`);
const dur = smpl ? ((smpl.size) / 2 / (rates[0] || 44100)).toFixed(1) : '?';
console.log(`采样数据总时长 ≈ ${dur}s（smpl 大小 ${smpl ? (smpl.size / 1048576).toFixed(1) : '?'}MB）`);
console.log('前 8 个采样：' + samples.slice(0, 8).map((s) => `${s.name}@root${s.rootKey}`).join(', '));
