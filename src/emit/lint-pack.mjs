// 数据包静态自检（不需要起服务器）：
//   1) 不允许出现 `tick rate`（函数权限等级 2 < 3，含它的函数会整文件加载失败）
//   2) 所有 `function <ns:path>` 引用必须存在对应文件
//   3) 所有 `note=<n>` 必须在 0..24（实测 25 会让整个函数加载失败）
//   4) tick 标签必须指向 styx:play/tick
import fs from 'node:fs';
import path from 'node:path';
import { findFlag, resolvePaths } from '../core/paths.mjs';

const P = resolvePaths();
const argv = process.argv.slice(2);
// 数据包目录：位置参数（历史用法 `node src/emit/lint-pack.mjs <datapack dir>`）> `--root <dir>` > paths.mjs 解析结果
const positional = argv.find((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1].startsWith('--')));
const rootFlag = findFlag(argv, 'root');
if (rootFlag === true) throw new Error('--root 需要一个目录参数：--root <datapack dir>');
const root = positional ?? rootFlag ?? P.packDir;
const dpRoot = `${root}/data`;
const problems = [];
let files = 0, lines = 0;

// 新工程骨架刚建出来时数据包目录还是空的：这不是"自检失败"，而是"还没产出"——
// 给下一步该跑哪条命令，并且不报错（M2-2 §验收：空目录里也要有提示、不报错）。
if (!fs.existsSync(dpRoot)) {
  console.log(`数据包还没产出（${root} 下没有 data/）`);
  console.log(`  下一步：node src/emit/note-blocks.mjs --build ${P.build} && node src/emit/datapack-playback.mjs --build ${P.build}`);
  process.exit(0);
}

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = path.join(dir, e.name);
  return e.isDirectory() ? walk(p) : [p];
});

const fnName = (file) => {
  const rel = path.relative(dpRoot, file).replace(/\\/g, '/'); // styx/function/play/lo/b000.mcfunction
  const m = rel.match(/^([^/]+)\/function\/(.+)\.mcfunction$/);
  return m ? `${m[1]}:${m[2]}` : null;
};

const present = new Set();
for (const f of walk(dpRoot)) if (f.endsWith('.mcfunction')) present.add(fnName(f));

for (const f of walk(dpRoot)) {
  if (!f.endsWith('.mcfunction')) continue;
  files++;
  const text = fs.readFileSync(f, 'utf8');
  const ls = text.split(/\r?\n/);
  lines += ls.length;
  const me = fnName(f);
  ls.forEach((l, i) => {
    if (/(^|\s)tick\s+rate(\s|$)/.test(l)) problems.push(`${me}:${i + 1} 含 tick rate（会整文件加载失败）`);
    for (const m of l.matchAll(/(?:^|\s)function\s+([a-z0-9_.-]+:[a-z0-9_/.-]+)/g)) {
      if (!present.has(m[1])) problems.push(`${me}:${i + 1} 引用不存在的函数 ${m[1]}`);
    }
    for (const m of l.matchAll(/note=(\d+)/g)) if (+m[1] > 24) problems.push(`${me}:${i + 1} note=${m[1]} 超出 0..24`);
  });
}

const tickTag = `${dpRoot}/minecraft/tags/function/tick.json`;
const tickTagOk = fs.existsSync(tickTag) && JSON.parse(fs.readFileSync(tickTag, 'utf8')).values?.includes('styx:play/tick');
if (!tickTagOk) problems.push('minecraft/tags/function/tick.json 未指向 styx:play/tick');

console.log(`扫描 ${files} 个函数文件 / ${lines} 行（${root}）；tick 标签 ${tickTagOk ? 'OK' : '错误'}`);
if (files === 0) {
  console.log('函数目录还是空的：自检没什么可看（下一步先跑 emit/note-blocks + emit/datapack-playback）');
  process.exit(0);
}
if (problems.length) {
  console.log(`发现 ${problems.length} 个问题：`);
  for (const p of problems.slice(0, 40)) console.log('  - ' + p);
  if (problems.length > 40) console.log(`  … 其余 ${problems.length - 40} 条省略`);
  process.exit(1);
}
console.log('静态自检通过：无 tick rate、无悬空函数引用、note 范围合法');
