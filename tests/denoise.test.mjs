// M3-8 · 谱减降噪的**重建恒等性**（先证明 STFT→ISTFT 不损伤信号，再谈降噪力度）
//
// 教训：第一版直接对共轭对称谱再调一次 fftInPlace，没验证往返，结果"增益全 1"时
// 各频带仍有 5–8dB 失真（各档参数指标完全一致 = 失真来自重建而非算法），白调了半天。
import assert from 'node:assert/strict';
import test from 'node:test';

import { spectralDenoise } from '../src/analyze/denoise.mjs';
import { SAMPLE_RATE } from '../src/synth/synth.mjs';

const tone = (freq, n, sampleRate = SAMPLE_RATE) => {
  const s = new Float64Array(n);
  for (let i = 0; i < n; i++) s[i] = 0.4 * Math.sin((2 * Math.PI * freq * i) / sampleRate) + 0.15 * Math.sin((2 * Math.PI * 3 * freq * i) / sampleRate);
  return s;
};

test('增益全 1（oversub=0）时：输出必须与输入逐样本一致（往返恒等）', () => {
  const x = tone(220, SAMPLE_RATE);   // 1 秒
  const y = spectralDenoise(x, { sampleRate: SAMPLE_RATE, oversub: 0, floorDb: 0 });
  let maxErr = 0;
  for (let i = 0; i < x.length; i++) maxErr = Math.max(maxErr, Math.abs(y[i] - x[i]));
  assert.ok(maxErr < 1e-9, `往返最大误差 ${maxErr.toExponential(2)}（应 < 1e-9）`);
});

test('降噪不改变总长度；安静段噪声被压、响段基频能量保留', () => {
  const n = SAMPLE_RATE * 2;
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    x[i] = 0.0015 * Math.sin((2 * Math.PI * 5000 * i) / SAMPLE_RATE);            // 前 1 秒：只有噪声
    if (i >= SAMPLE_RATE) x[i] += 0.4 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE); // 后 1 秒：噪声 + 乐音
  }
  const y = spectralDenoise(x, { sampleRate: SAMPLE_RATE, noiseWindow: { startSec: 0.1, endSec: 0.9 }, oversub: 2, floorDb: -20, mode: 'subtract' });
  assert.equal(y.length, x.length);
  const rms = (s, a, b) => { let acc = 0; for (let i = a; i < b; i++) acc += s[i] * s[i]; return Math.sqrt(acc / (b - a)); };
  const noiseBefore = rms(x, 0, Math.round(SAMPLE_RATE * 0.3)), noiseAfter = rms(y, 0, Math.round(SAMPLE_RATE * 0.3));
  assert.ok(noiseAfter < noiseBefore * 0.4, `安静段噪声应显著下降：${noiseBefore.toExponential(2)} → ${noiseAfter.toExponential(2)}`);
  const toneBefore = rms(x, Math.round(SAMPLE_RATE * 1.1), Math.round(SAMPLE_RATE * 1.9)), toneAfter = rms(y, Math.round(SAMPLE_RATE * 1.1), Math.round(SAMPLE_RATE * 1.9));
  assert.ok(toneAfter > toneBefore * 0.8, `乐音段不该被削太多：${toneBefore.toFixed(4)} → ${toneAfter.toFixed(4)}`);
});

