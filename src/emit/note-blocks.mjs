// 生成 styx:apply_notes_v3 —— 按【最终谱面 CSV】把音符盒摆到世界里（音色 + 音高 + 灯）。
// 这是播放器的对偶：datapack-playback.mjs 用同一个 pos() 规则算触发坐标。
//
// 为什么要它：apply_notes_v3 原来是 arrange-notes.mjs 按**旧折叠**（v3 的 row）生成的；
// T3 修八度后 row 变了，若不同步重摆，播放器触发的是新坐标、世界里音符盒还在旧坐标 → 听不到声。
//
// 用法：node src/emit/note-blocks.mjs --notes <machine csv> [--old <旧 v3 csv>]
//   --old 用来生成"清掉旧坐标"的指令（旧 row 与新 row 不同时先把旧位置清空）
import fs from 'node:fs';
import { makePos, DECK_BLOCK, noteBlockOf } from './layout-pos.mjs';
import { buildTriggerMapFromPoints } from './trigger-map.mjs';
import { resolvePaths } from '../core/paths.mjs';

const P = resolvePaths();
const DP = P.functionsDir;
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
// 口径修正（M2-3）：摆块也要用 arrange-all 的最终机器谱面，否则世界里的音符盒与派发表不同源
const NOTES = opt('notes', P.machineScore);
const OLD = opt('old', P.notesV3);

const profile = JSON.parse(fs.readFileSync(P.profile, 'utf8'));
const pos = makePos(profile);

const readCsv = (p) => {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, 'utf8').trim().split(/\r?\n/);
  const h = lines[0].split(',');
  const iStep = h.indexOf('step'), iInstr = h.indexOf('instrument'), iRow = h.indexOf('row');
  return lines.slice(1).map((l) => {
    const c = l.split(',');
    // 保留真实音色（打击乐层用 basedrum/hat），未知值退回 harp
    const raw = c[iInstr];
    const instr = ['harp', 'bass', 'basedrum', 'hat'].includes(raw) ? raw : 'harp';
    return { step: +c[iStep], instr, row: +c[iRow] };
  });
};

const notes = readCsv(NOTES);
const old = readCsv(OLD);

// 旧位置（用于清空）：按 (x,z) 去重
const oldCells = [...new Set(old.map((n) => { const p = pos(n.step, n.row); return `${p.x},${p.y},${p.z}`; }))];
// 新位置：同一格只写一次（去撞格后理论上一格一音，这里仍去重以防 CSV 例外）
const newCells = new Map();
for (const n of notes) {
  const p = pos(n.step, n.row);
  newCells.set(`${p.x},${p.y},${p.z}`, { ...p, instr: n.instr, row: n.row });
}

const lines = [
  `# 由 src/emit/note-blocks.mjs 生成：来源 ${NOTES}`,
  `# ${newCells.size} 个音符格（旧坐标清空 ${oldCells.length} 格）`,
];
for (const k of oldCells) {
  const [x, y, z] = k.split(',');
  // 先清旧位置的音符盒 + 灯；甲板留原样（本来就是 sand/oak_planks，不碍事）
  lines.push(`setblock ${x} ${+y + 1} ${z} minecraft:air`);
  lines.push(`setblock ${x} ${+y - 1} ${z} minecraft:air`);
}
for (const { x, y, z, instr, row } of newCells.values()) {
  lines.push(`setblock ${x} ${y} ${z} ${DECK_BLOCK[instr]}`);                        // 甲板（决定音色）
  lines.push(`setblock ${x} ${y + 1} ${z} ${noteBlockOf(instr, row)}`);             // 音符盒
  lines.push(`setblock ${x} ${y - 1} ${z} minecraft:redstone_lamp[lit=false]`);      // 灯
}

// M3-37：触发位 —— 每个音符盒要有一个**水平相邻**的空格放红石块（实验见 docs/M3-37）。
// 这里把它们清成空气（保证"放红石块 → 拆掉"之后恢复成空气，而不是把地形挖出个洞）。
const triggerMap = buildTriggerMapFromPoints([...newCells.values()]);
if (triggerMap.missing > 0) throw new Error(`有 ${triggerMap.missing} 个音符找不到水平触发位，布局需要改造`);
for (const cell of triggerMap.cells) {
  lines.push(`setblock ${cell.x} ${cell.y} ${cell.z} minecraft:air`);   // 触发位（音符盒同层，水平相邻）
}

fs.mkdirSync(DP, { recursive: true });
fs.writeFileSync(`${DP}/apply_notes_v3.mcfunction`, lines.join('\n') + '\n', 'utf8');
const byVoice = notes.reduce((a, n) => ((a[n.instr] = (a[n.instr] ?? 0) + 1), a), {});
console.log(`apply_notes_v3.mcfunction: ${newCells.size} 个音符格 / ${lines.length - 2} 条指令（${JSON.stringify(byVoice)}）`);
console.log(`  谱面 ${NOTES}（${notes.length} 颗音）；旧坐标清空 ${oldCells.length} 格（来源 ${OLD}）`);
