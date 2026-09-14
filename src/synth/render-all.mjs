// M2-1 · 渲染全部自研采样（零第三方采样）：WAV 无损中间件 → OGG 交付件 + FFT 自查报告
//
// 用法：node src/synth/render-all.mjs --out build/audio_nbforge
//   [--only strings,bell]  只渲染部分音色（默认全部 4 个）
//   [--vel 0.8]            采样烘死的力度层（默认 0.8 = 中强）
//   [--quality 4]          libvorbis -q:a（默认 4）
//   [--no-wav]             转完 ogg 后删掉 WAV 中间件（默认保留，方便人工核对）
// 相对路径（`--out build/audio_nbforge`）按 **minecraft 工程根** 解析（= 本仓库的上一级），
// 与其他模块（datapack-playback 等）的 <BUILD> 约定一致。
//
// 产物：
//   <out>/wav/<音色>/<音名>.wav        16bit PCM 44.1kHz 单声道（无损中间件）
//   <out>/ogg/<音色>/<音名>.ogg        资源包交付件
//   <out>/demo/<音色>_vel<NN>_<音名>.ogg 力度分层试听（证明"力度→亮度"，M4 才做整套多层采样）
//   <out>/synth-report.json            汇总（每条音色的最大/平均音准误差、包体积、时长）
//   <out>/synth-spectrum.csv           逐音频谱数据（峰值频率 vs 目标音高）——报告里的"频谱截图数据"
//
// 音准自查口径（与 tests/synth.test.mjs 完全同一份代码）：FFT 全局最强谱峰 vs 目标音高，误差 ≤1%。
import fs from 'node:fs';
import path from 'node:path';

import { encodeWav, readWav } from '../analyze/dsp.mjs';

import { encodeOgg, ffmpegAvailable } from './ogg.mjs';
import { SAMPLE_RATE, peak, rms } from './synth.mjs';
import { dominantPeak, spectralCentroid } from './spectrum.mjs';
import {
  REFERENCE_VEL, REGISTERS, TIMBRES, VOICE_PARAMS, listRenderJobs, noteFileName, registerSize, renderVoice,
} from './voices.mjs';
import { resolvePaths } from '../core/paths.mjs';

// M2-3：build 目录走 paths.mjs（输出目录仍是 `--out`，相对路径按 minecraft 工程根解析）
const BUILD = resolvePaths().build;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes(`--${n}`);

/** 相对路径按 minecraft 工程根解析（`--out build/audio_nbforge` → <minecraft>/build/audio_nbforge） */
const MC_ROOT = path.resolve(BUILD, '..');
const resolvePath = (p) => (path.isAbsolute(p) ? p : path.resolve(MC_ROOT, p));
const OUT = resolvePath(opt('out', path.join(BUILD, 'audio_nbforge')));
const ONLY = (opt('only', '') || TIMBRES.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const VEL = Number(opt('vel', REFERENCE_VEL));
const QUALITY = Number(opt('quality', 4));
const DEMO_VELS = [0.35, 0.65, 1.0];
/** 力度试听用的两个音：取该音色音域的中段与上方八度（每个音色都在自己音域内，bass 不会被顶出去） */
const demoMidisOf = (timbre) => {
  const [lo, hi] = REGISTERS[timbre];
  const a = Math.round((lo + hi) / 2);
  return [a, Math.min(hi, a + 12)];
};

for (const t of ONLY) if (!TIMBRES.includes(t)) throw new Error(`未知音色：${t}（可用：${TIMBRES.join(',')}）`);
const hasFfmpeg = ffmpegAvailable();
const errPct = (m, t) => (Math.abs(m - t) / t) * 100;

fs.mkdirSync(path.join(OUT, 'wav'), { recursive: true });
if (hasFfmpeg) fs.mkdirSync(path.join(OUT, 'ogg'), { recursive: true });

const jobs = listRenderJobs({ timbres: ONLY, vel: VEL });
console.log(`渲染 ${jobs.length} 个采样（${ONLY.length} 个音色 × ${ONLY.map((t) => registerSize(t)).join('/')} 个半音）`
  + `；采样率 ${SAMPLE_RATE}Hz；参考力度 ${VEL}；ffmpeg=${hasFfmpeg ? '有（出 ogg）' : '无（只出 WAV）'}`);

const rows = [];
const byTimbre = new Map();
let wavBytes = 0;
let oggBytes = 0;

for (const job of jobs) {
  const dirWav = path.join(OUT, 'wav', job.timbre);
  fs.mkdirSync(dirWav, { recursive: true });
  const wavPath = path.join(dirWav, `${job.note}.wav`);
  const samples = renderVoice(job.timbre, job.midi, { vel: VEL });
  fs.writeFileSync(wavPath, encodeWav({ samples, sampleRate: SAMPLE_RATE }));
  const wavSize = fs.statSync(wavPath).size;
  wavBytes += wavSize;

  let oggSize = null;
  if (hasFfmpeg) {
    const dirOgg = path.join(OUT, 'ogg', job.timbre);
    fs.mkdirSync(dirOgg, { recursive: true });
    oggSize = encodeOgg({ wavPath, oggPath: path.join(dirOgg, `${job.note}.ogg`), quality: QUALITY });
    oggBytes += oggSize;
  }

  // 音准自查：读回**文件**再测（不测内存里的浮点，免得"报告里的数"与"交付的件"不是一回事）
  const back = readWav(wavPath);
  const { freq } = dominantPeak(back.samples);
  // 钢琴类允许"最强峰 = 某个整数倍泛音"：真钢琴的 2/3 次分音常常比基频还强
  // （实测 C#4 的 2 次分音最强 → 按"最强峰必须等于基频"算会报 100% 的假误差）。
  // 判据改成：找一个整数 k∈1..10，使 freq/k 落在基频 ±1% 内；其它音色仍按老口径（k=1）。
  let err = errPct(freq, job.freq);
  let harmonic = 1;
  if (job.timbre === 'piano' || VOICE_PARAMS[job.timbre]?.eq) {
    for (let k = 1; k <= 10; k++) {
      const e = errPct(freq / k, job.freq);
      if (e < err) { err = e; harmonic = k; }
    }
  }
  rows.push({
    timbre: job.timbre,
    note: job.note,
    midi: job.midi,
    event: job.event,
    targetHz: job.freq,
    peakHz: freq,
    errPct: err,
    harmonic,
    durationSec: samples.length / SAMPLE_RATE,
    rms: rms(back.samples),
    peak: peak(back.samples),
    wavBytes: wavSize,
    oggBytes: oggSize,
  });
  const agg = byTimbre.get(job.timbre) ?? { timbre: job.timbre, notes: 0, seconds: 0, wavBytes: 0, oggBytes: 0, errors: [], worst: null };
  agg.notes++;
  agg.seconds += samples.length / SAMPLE_RATE;
  agg.wavBytes += wavSize;
  agg.oggBytes += oggSize ?? 0;
  agg.errors.push(err);
  if (!agg.worst || err > agg.worst.errPct) agg.worst = { note: job.note, midi: job.midi, targetHz: job.freq, peakHz: freq, errPct: err };
  byTimbre.set(job.timbre, agg);
}

/* ---------- 力度分层试听件：证明"力度→亮度"真的落在交付件上 ---------- */
const velocity = [];
if (hasFfmpeg) {
  const demoDir = path.join(OUT, 'demo');
  fs.mkdirSync(demoDir, { recursive: true });
  const tmp = path.join(demoDir, '_tmp.wav');
  for (const timbre of ONLY) {
    for (const midi of demoMidisOf(timbre)) {
      for (const vel of DEMO_VELS) {
        const samples = renderVoice(timbre, midi, { vel });
        fs.writeFileSync(tmp, encodeWav({ samples, sampleRate: SAMPLE_RATE }));
        const file = `${timbre}_vel${String(Math.round(vel * 100)).padStart(2, '0')}_${noteFileName(midi)}.ogg`;
        encodeOgg({ wavPath: tmp, oggPath: path.join(demoDir, file), quality: QUALITY });
        velocity.push({
          timbre, midi, note: noteFileName(midi), vel, file,
          centroidHz: spectralCentroid(samples),
          rms: rms(samples),
          peak: peak(samples),
        });
      }
    }
  }
  fs.rmSync(tmp, { force: true });
}

if (flag('no-wav')) fs.rmSync(path.join(OUT, 'wav'), { recursive: true, force: true });

const timbres = [...byTimbre.values()].map((a) => ({
  timbre: a.timbre,
  register: [Math.min(...rows.filter((r) => r.timbre === a.timbre).map((r) => r.midi)),
    Math.max(...rows.filter((r) => r.timbre === a.timbre).map((r) => r.midi))],
  semitones: a.notes,
  seconds: Number(a.seconds.toFixed(2)),
  wavBytes: a.wavBytes,
  oggBytes: a.oggBytes,
  errPctMax: Math.max(...a.errors),
  errPctMean: a.errors.reduce((s, x) => s + x, 0) / a.errors.length,
  worst: a.worst,
}));

const report = {
  at: new Date().toISOString(),
  generator: 'src/synth/render-all.mjs（自研合成，零第三方采样）',
  sampleRate: SAMPLE_RATE,
  referenceVel: VEL,
  quality: QUALITY,
  ffmpeg: hasFfmpeg,
  timbres,
  velocity,
  totals: {
    files: jobs.length,
    seconds: Number(rows.reduce((s, r) => s + r.durationSec, 0).toFixed(2)),
    wavBytes,
    oggBytes,
    errPctMax: Math.max(...rows.map((r) => r.errPct)),
  },
  spectrumCsv: path.join(OUT, 'synth-spectrum.csv'),
};

const csvHeader = 'timbre,note,midi,event,target_hz,peak_hz,err_pct,duration_sec,rms,peak,wav_bytes,ogg_bytes';
const csv = [csvHeader, ...rows.map((r) => [
  r.timbre, r.note, r.midi, r.event,
  r.targetHz.toFixed(3), r.peakHz.toFixed(3), r.errPct.toFixed(4),
  r.durationSec.toFixed(3), r.rms.toFixed(4), r.peak.toFixed(4), r.wavBytes, r.oggBytes ?? '',
].join(','))].join('\n') + '\n';
fs.writeFileSync(path.join(OUT, 'synth-spectrum.csv'), csv, 'utf8');
fs.writeFileSync(path.join(OUT, 'synth-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

/* ---------- 控制台小结 ---------- */
console.log('\n音色        半音  时长(s)   ogg(MB)   音准误差 max/mean');
for (const t of timbres) {
  console.log(`${t.timbre.padEnd(10)}  ${String(t.semitones).padStart(3)}  ${t.seconds.toFixed(1).padStart(7)}  `
    + `${(t.oggBytes / 1048576).toFixed(2).padStart(7)}   ${t.errPctMax.toFixed(3)}% / ${t.errPctMean.toFixed(3)}%`);
}
if (velocity.length) {
  console.log('\n力度→亮度（谱心 Hz，越高越亮）：');
  for (const timbre of ONLY) {
    for (const midi of demoMidisOf(timbre)) {
      const row = velocity.filter((v) => v.timbre === timbre && v.midi === midi)
        .map((v) => `vel${v.vel}:${v.centroidHz.toFixed(0)}Hz/${v.rms.toFixed(3)}`).join('  ');
      console.log(`  ${timbre} ${noteFileName(midi)}  ${row}`);
    }
  }
}
console.log(`\n合计：${jobs.length} 个采样 / ${report.totals.seconds}s 音频 / WAV ${(wavBytes / 1048576).toFixed(1)}MB`
  + `${hasFfmpeg ? ` / OGG ${(oggBytes / 1048576).toFixed(2)}MB` : ''} / 音准误差 max ${report.totals.errPctMax.toFixed(3)}%`);
console.log(`报告：${path.join(OUT, 'synth-report.json')}；频谱数据：${path.join(OUT, 'synth-spectrum.csv')}`);
