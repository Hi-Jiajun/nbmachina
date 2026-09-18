// M3-11 · SFZ 采样库读取层（"通用乐器导入器"的地基）
//
// 为什么需要它：自研音色的约定是"每半音一个文件、文件名=音名、音量当力度"；
// 真乐器库不是这样——它们用 SFZ 描述"哪个音高区间 / 哪个力度区间用哪个采样"，
// 常见形态是**每 2~3 个半音一个采样 × 多层力度 × rr 轮换**。要把它们接进管线，
// 就得老老实实解析区域（region）并按区域选样本，而不是猜文件名。
//
// 支持范围（够用就好，明确留档）：
//   · <control>/<global>/<group>/<region> 四层继承（region 覆盖 group 覆盖 global）
//   · 单行 region 写法（`<region> sample=x lokey=21 ...`）与多行块写法都认
//   · lokey/hikey/pitch_keycenter 支持音名（`A#0`）与数字
//   · lovel/hivel 力度分层（选层）、同区间多采样（rr1/rr2）按序号轮换
//   · volume（dB）与 tune（cent）按 SFZ 语义生效
//   · default_path 相对本文件解析（VSCO 的 SFZ 用的就是它）
// 不做：loop / 包络 / 滤波器 / CC 控制 —— 离线渲染用不到，别假装实现了。
import fs from 'node:fs';
import path from 'node:path';

const PC = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };

/** 音名 → midi（`A#0` = 22、`C4` = 60、`Bb-1` = 10）；纯数字原样取整；认不出返回 null */
export function keyToMidi(v) {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.round(n);
  const m = /^([a-gA-G])([#b]?)(-?\d+)$/.exec(String(v).trim());
  if (!m) return null;
  const pc = PC[m[1].toLowerCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return (((pc % 12) + 12) % 12) + (parseInt(m[3], 10) + 1) * 12;
}

// 一行里可能并排多个 opcode（单行 region 写法）；只在"空白 + key="前切断，
// 这样 `default_path=Keys\Upright Piano\` 这种**含空格的值**不会被切坏。
const SPLIT_OP = /\s+(?=[A-Za-z_][A-Za-z_0-9]*\s*=)/;

/** SFZ 文本 → { defaultPath, regions }（regions 为**未解析路径**的归一化区域） */
export function parseSfzText(text) {
  const regions = [];
  let defaultPath = '';
  let section = '';
  let globals = {};
  let groups = {};
  let cur = null;
  const flush = () => { if (cur && cur.sample) regions.push(cur); cur = null; };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    let rest = line;
    const tag = /^<([A-Za-z_][A-Za-z_0-9]*)>\s*(.*)$/.exec(line);
    if (tag) {
      const name = tag[1].toLowerCase();
      rest = tag[2] ?? '';
      if (name === 'control' || name === 'global') { flush(); section = name; globals = {}; groups = {}; }
      else if (name === 'group') { flush(); section = name; groups = {}; }
      else if (name === 'region') { flush(); section = name; cur = { ...globals, ...groups }; }
      else { flush(); section = name; }
    }
    if (!rest) continue;
    for (const tok of rest.split(SPLIT_OP)) {
      const eq = tok.indexOf('=');
      if (eq < 0) continue;
      const key = tok.slice(0, eq).trim().toLowerCase();
      const val = tok.slice(eq + 1).trim();
      if (section === 'control' && key === 'default_path') { defaultPath = val; continue; }
      if (section === 'region' && cur) cur[key] = val;
      else if (section === 'group') groups[key] = val;
      else if (section === 'global') globals[key] = val;
    }
  }
  flush();
  return { defaultPath, regions: regions.map(toRegion) };
}

function toRegion(raw) {
  const loKey = keyToMidi(raw.lokey) ?? keyToMidi(raw.key) ?? 0;
  const hiKey = keyToMidi(raw.hikey) ?? keyToMidi(raw.key) ?? 127;
  const root = keyToMidi(raw.pitch_keycenter) ?? keyToMidi(raw.key) ?? 60;
  return {
    sample: String(raw.sample),
    loKey, hiKey, root,
    loVel: Number(raw.lovel ?? 0),
    hiVel: Number(raw.hivel ?? 127),
    gainDb: Number(raw.volume ?? 0),
    tuneCents: Number(raw.tune ?? 0),
    trigger: String(raw.trigger ?? 'attack').toLowerCase(),
  };
}

/** 读一个 SFZ 文件，并把 region 的 sample 解析成**绝对路径**（用 default_path） */
export function loadSfz(file) {
  const { defaultPath, regions } = parseSfzText(fs.readFileSync(file, 'utf8'));
  const base = path.dirname(file);
  const dir = defaultPath ? path.resolve(base, defaultPath.replace(/\\/g, '/')) : base;
  // 丢掉"不是按键触发"的区域，两类都要丢（都实测污染过音色）：
  //   ① `trigger=release`：弦共振释放采样（Salamander 的 rel*.ogg），只在松键时响，
  //      且没有 pitch_keycenter → 被当音高采样会得到"42 半音变调"的怪声；
  //   ② `lokey=-1 hikey=-1`：CC 开关控制的踏板噪声（pedalD/U），没有音高键位。
  const playable = regions.filter((r) => r.trigger === 'attack' && r.hiKey >= 0 && r.loKey <= 127);
  return {
    file,
    dir,
    droppedRange: regions.filter((r) => r.hiKey < 0 || r.loKey > 127).length,
    droppedTrigger: regions.filter((r) => r.trigger !== 'attack').length,
    regions: playable.map((r) => ({ ...r, file: path.resolve(dir, r.sample.replace(/\\/g, '/')) })),
  };
}

/** 距 midi 最近的区域（音域外兜底：变调解决，不做静音——静音会被误当成"漏音"） */
function nearestKey(regions, midi) {
  let best = regions[0];
  let bestD = Infinity;
  for (const r of regions) {
    const d = midi < r.loKey ? r.loKey - midi : midi > r.hiKey ? midi - r.hiKey : 0;
    if (d < bestD) { bestD = d; best = r; }
  }
  return best;
}

/**
 * 选区域：先按音高区间筛，再按力度区间筛，最后同区间多条按 `seq` 轮换（rr 交替）。
 * @param {Array} regions loadSfz().regions
 * @param {number} midi 目标音高
 * @param {number} vel127 力度（0..127）
 * @param {number} seq 触发序号（同一音高多次触发轮换 rr1/rr2，避免机关枪感）
 */
export function pickRegion(regions, midi, vel127 = 100, seq = 0, durMs = 0) {
  if (!regions || !regions.length) return null;
  // M3-31：短音用 sta（断奏）、长音用 leg —— OLPC 合集同一颗音录了两套。
  // 必须**互斥**：sta 区域的 loKey==hiKey（span 0），会赢下"音域最窄者优先"那条规则，
  // 若不排除，长音也会被 sta 抢走（实测：midi60/durMs3000 选到 pno060v95sta.wav ✗）。
  const hasSta = regions.some((r) => r.staccato);
  if (hasSta) {
    const useSta = durMs > 0 && durMs <= 300;
    const pool = regions.filter((r) => !!r.staccato === useSta);
    if (pool.length) return pickRegionInner(pool, midi, vel127, seq);
  }
  return pickRegionInner(regions, midi, vel127, seq);
}

function pickRegionInner(regions, midi, vel127 = 100, seq = 0) {
  const inKey = regions.filter((r) => midi >= r.loKey && midi <= r.hiKey);
  const pool = inKey.length ? inKey : [nearestKey(regions, midi)];
  const inVel = pool.filter((r) => vel127 >= r.loVel && vel127 <= r.hiVel);
  const use = inVel.length ? inVel : pool;
  // **音域最窄者优先**：真库常有"整琴通配区域"（无 lokey/hikey 的加料层、锤击噪声等）与
  // 精确键位区域同时命中——不先收紧就会被通配区域抢走，出现离谱变调。
  // 同为最窄的才是 rr 兄弟（rr1/rr2），它们之间按 seq 轮换。
  const span = (r) => r.hiKey - r.loKey;
  const minSpan = Math.min(...use.map(span));
  const sorted = use.filter((r) => span(r) === minSpan).sort((a, b) => a.file.localeCompare(b.file));
  return sorted[((seq % sorted.length) + sorted.length) % sorted.length];
}
