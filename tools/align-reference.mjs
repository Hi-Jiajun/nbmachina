#!/usr/bin/env node
// 把"谱面时间轴"与"参考演奏（原曲录音/视频）"做全局对齐（M3-6）。
//
// 用途：谱面是在某个时间基上转的（本工程 = 0.12 s/step，全长 281.4 s），
// 而真正要对照的演奏可能是另一个速度/版本（例：Animenz 视频 298.75 s）。
// 只要两者是**同一演奏的不同速度**，就能用 t_ref = scale * t_score + lag 对齐；
// 这对齐是后面一切"用音频逐音标定八度/力度"的前提（窗口错位 6% 的话证据全是噪声）。
//
// 做法：两条包络（20 ms 帧、半波整流的一阶差分 = 起音强度）上做
// 尺度 scale + 偏移 lag 的网格搜索，取归一化互相关最大的组合。
//
//   node tools/align-reference.mjs --ref build/animenz_styx_helix.wav [--score build/styx_helix_full.wav]
import fs from 'node:fs';
import path from 'node:path';

import { readWav } from '../src/analyze/dsp.mjs';
import { resolvePaths } from '../src/core/paths.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const P = resolvePaths();

const REF = opt('ref', path.join(P.build, 'animenz_styx_helix.wav'));
const SCORE = opt('score', P.audio);
const HOP = 0.02;   // 20 ms

/** 起音强度包络（每秒 1/HOP 帧） */
function onsetEnvelope(file) {
  const { samples, sampleRate } = readWav(file);
  const hop = Math.round(HOP * sampleRate);
  const n = Math.floor(samples.length / hop);
  const rms = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let j = i * hop; j < (i + 1) * hop; j++) acc += samples[j] * samples[j];
    rms[i] = Math.sqrt(acc / hop);
  }
  const env = new Float64Array(n);
  for (let i = 1; i < n; i++) env[i] = Math.max(0, rms[i] - rms[i - 1]);
  // 归一化到均值 1，便于跨文件比较
  let mean = 0;
  for (const v of env) mean += v;
  mean = mean / n || 1;
  for (let i = 0; i < n; i++) env[i] /= mean;
  return env;
}

const ref = onsetEnvelope(REF);
const score = onsetEnvelope(SCORE);
console.log(`参考：${path.basename(REF)}  ${(ref.length * HOP).toFixed(1)}s / ${ref.length} 帧`);
console.log(`谱面：${path.basename(SCORE)}  ${(score.length * HOP).toFixed(1)}s / ${score.length} 帧`);

/** 在 (scale, lag) 处求归一化互相关；参考按 t_ref = scale*t + lag 采样（线性插值） */
function corr(scale, lag) {
  let sa = 0, sb = 0, saa = 0, sbb = 0, sab = 0, cnt = 0;
  // 只比较两者都覆盖的区间（跳过开头 1s 静音与结尾）
  for (let i = 50; i < score.length - 50; i++) {
    const tr = (i * HOP * scale + lag) / HOP;
    if (tr < 0 || tr >= ref.length - 1) continue;
    const i0 = Math.floor(tr);
    const w = tr - i0;
    const a = score[i];
    const b = ref[i0] * (1 - w) + ref[i0 + 1] * w;
    sa += a; sb += b; saa += a * a; sbb += b * b; sab += a * b; cnt++;
  }
  if (cnt < 100) return -1;
  const cov = sab / cnt - (sa / cnt) * (sb / cnt);
  const va = saa / cnt - (sa / cnt) ** 2;
  const vb = sbb / cnt - (sb / cnt) ** 2;
  return cov / Math.sqrt(va * vb || 1e-12);
}

let best = { r: -2 };
for (let scale = 0.90; scale <= 1.14; scale += 0.002) {
  for (let lag = -8; lag <= 8; lag += 0.1) {
    const r = corr(scale, lag);
    if (r > best.r) best = { r, scale, lag };
  }
}
// 细化
for (let scale = best.scale - 0.003; scale <= best.scale + 0.003; scale += 0.0002) {
  for (let lag = best.lag - 0.15; lag <= best.lag + 0.15; lag += 0.01) {
    const r = corr(scale, lag);
    if (r > best.r) best = { r, scale, lag };
  }
}

const refDur = ref.length * HOP, scoreDur = score.length * HOP;
console.log(`\n最佳对齐：scale=${best.scale.toFixed(4)}  lag=${best.lag.toFixed(2)}s  r=${best.r.toFixed(4)}`);
console.log(`→ 对应演奏总长 ≈ ${(scoreDur * best.scale).toFixed(1)}s（参考实际 ${refDur.toFixed(1)}s，比值 ${(refDur / scoreDur).toFixed(4)}）`);
const out = { ref: REF, score: SCORE, scale: best.scale, lag: best.lag, r: best.r, refSeconds: refDur, scoreSeconds: scoreDur };
fs.writeFileSync(path.join(P.build, 'align-reference.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
console.log(`结果 → ${path.join(P.build, 'align-reference.json').replace(/\\/g, '/')}`);
