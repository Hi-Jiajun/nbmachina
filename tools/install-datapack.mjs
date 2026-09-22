// M3-73 · 把 `build/styx_build` **镜像**到某个存档（或测试服）的 `datapacks/styx_build`。
//
// 为什么需要它：`Copy-Item -Recurse -Force` 只覆盖、不删除 —— redo 链换过一次结构（w1/w2/w3 → wait/go/check/…）之后，
// 存档里会留着一堆**已废弃但还能跑**的旧函数（例如旧的 `styx:redo/s4`），哪天手滑直接跑旧段就又回到老 bug。
// 这里做**镜像**：目标里多出来的文件一律删掉，保证"存档里的数据包 == 仓库里的数据包"。
//
// 安全：只允许目标是 `.../datapacks/styx_build`（结尾必须匹配），其余路径一律拒绝。
//
// 用法：node tools/install-datapack.mjs --save "<存档目录>"            # 客户端存档
//       node tools/install-datapack.mjs --dir "<datapacks/styx_build>"  # 手动指定（副本服世界）
import fs from 'node:fs';
import path from 'node:path';

import { resolvePaths, resolveExternal } from '../src/core/paths.mjs';

const P = resolvePaths();
const EX = resolveExternal();
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const targets = [];
const dirOpt = opt('dir', '');
if (dirOpt) {
  targets.push(path.resolve(dirOpt));
} else {
  const save = opt('save', EX.save);
  targets.push(path.join(path.resolve(save), 'datapacks', 'styx_build'));
}

const norm = (p) => path.resolve(p).replace(/\\/g, '/');
const SRC = norm(P.packDir);
for (const t of targets.map(norm)) {
  if (!/\/datapacks\/styx_build$/i.test(t)) throw new Error(`拒绝写入 ${t}：只允许 ...\\datapacks\\styx_build`);
}

/** 递归列文件（相对路径） */
function listFiles(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  if (fs.existsSync(root)) walk(root, '');
  return out;
}

const srcFiles = new Set(listFiles(SRC));
let removed = 0, copied = 0;
for (const dst of targets.map(norm)) {
  fs.mkdirSync(dst, { recursive: true });
  // ① 删掉目标里多出来的文件（= 仓库里已经不存在的老函数）
  for (const f of listFiles(dst)) {
    if (srcFiles.has(f)) continue;
    fs.rmSync(path.join(dst, f));
    removed++;
  }
  // ② 覆盖/补上仓库里的文件
  for (const f of srcFiles) {
    const s = path.join(SRC, f), d = path.join(dst, f);
    if (!fs.existsSync(s)) continue;
    if (fs.existsSync(d) && fs.readFileSync(s).equals(fs.readFileSync(d))) continue;
    fs.mkdirSync(path.dirname(d), { recursive: true });
    fs.copyFileSync(s, d);
    copied++;
  }
  console.log(`✔ 已镜像到 ${dst}（更新 ${copied} 个 / 删除 ${removed} 个旧文件，共 ${srcFiles.size} 个）`);
}
