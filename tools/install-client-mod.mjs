// M3-70 · 把**构建出来的** nbmachina jar 装到客户端/测试服的 mods 目录。
//
// 两条硬规则（都是踩过坑换来的）：
//   ① 同一个 mod **只能留一个 jar**（新旧各一份会双加载，见 docs/INSTALL.md）；旧的移进 `mods/_old_mods/`。
//   ② **游戏/服务器在跑时绝不替换**：JVM 惰性读 jar，换掉之后可能 `ZipFile invalid LOC header` 直接崩世界
//      （docs 里 M3-43 的教训）。脚本先检测目标 jar 是否被锁，锁着就直接报错退出。
//
// 用法：
//   node tools/install-client-mod.mjs                  # 客户端 + 两个副本测试服
//   node tools/install-client-mod.mjs --target client   # 只装客户端（server|all）
//   node tools/install-client-mod.mjs --dir <mods目录>  # 手动指定
import fs from 'node:fs';
import path from 'node:path';

import { REPO_ROOT } from '../src/core/paths.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };

const MODS = {
  client: 'C:/Program Files/PCL2/.minecraft/versions/1.21.10-Fabric 0.19.5/mods',
  server: 'C:/Users/hiliang/Documents/minecraft/_toolchain/spike-testserver/mods',
  void: 'C:/Users/hiliang/Documents/minecraft/_toolchain/spike-void/mods',
  uservoid: 'C:/Users/hiliang/Documents/minecraft/_toolchain/spike-user-void/mods',
};
const target = opt('target', 'all');
const dirs = opt('dir', '')
  ? [normalize(opt('dir'))]
  : target === 'all' ? [MODS.client, MODS.server] : [MODS[target] ?? MODS.client];

function normalize(p) {
  return path.resolve(p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/** 构建产物：取 mod/build/libs 里最新的 nbmachina-*.jar（不要 sources） */
function newestJar() {
  const libs = path.join(REPO_ROOT, 'mod', 'build', 'libs');
  if (!fs.existsSync(libs)) throw new Error(`没有构建产物：${libs}（先跑 build-mod.ps1）`);
  const jars = fs.readdirSync(libs).filter((f) => /^nbmachina-.*\.jar$/.test(f) && !f.includes('sources'));
  if (!jars.length) throw new Error(`没有构建产物：${libs}`);
  jars.sort();
  const jar = jars[jars.length - 1];
  return { name: jar, file: path.join(libs, jar) };
}

/**
 * 这个 jar 现在能不能被替换？做法跟真正的替换一样：**试着改名再改回来**。
 * （Windows 上「能 r+ 打开」不等于「能删/改名」——JVM 把 jar 映射成镜像之后，
 *  `openSync(r+)` 会成功但 `rmSync/renameSync` 报 EPERM，所以只能实测改名。）
 */
function inUse(file) {
  const probe = `${file}.probe`;
  try {
    fs.renameSync(file, probe);
    fs.renameSync(probe, file);
    return false;
  } catch {
    try { if (fs.existsSync(probe)) fs.renameSync(probe, file); } catch { /* ignore */ }
    return true;
  }
}

const { name, file } = newestJar();
console.log(`构建产物：${file}（${fs.statSync(file).size} B）`);
let failed = 0;
for (const dir of dirs) {
  if (!fs.existsSync(dir)) {
    console.log(`跳过（目录不存在）：${dir}`);
    continue;
  }
  const existing = fs.readdirSync(dir).filter((f) => /^nb(machina|forge)-.*\.jar$/i.test(f));
  const blocked = existing.filter((f) => inUse(path.join(dir, f)));
  if (blocked.length) {
    console.error(`✘ ${dir}：${blocked.join(', ')} 正被进程占用（游戏/服务器在跑）——先关掉再来，绝不热换 jar`);
    failed++;
    continue;
  }
  try {
    const oldDir = path.join(dir, '_old_mods');
    if (existing.length) fs.mkdirSync(oldDir, { recursive: true });
    for (const f of existing) {
      if (f === name) {
        fs.rmSync(path.join(dir, f));
        continue;
      }
      fs.renameSync(path.join(dir, f), path.join(oldDir, f));
      console.log(`  归档旧 jar：${f} → _old_mods/`);
    }
    fs.copyFileSync(file, path.join(dir, name));
    console.log(`✔ 已装：${dir}/${name}`);
  } catch (e) {
    console.error(`✘ ${dir} 安装失败：${e.message}`);
    failed++;
  }
}
process.exit(failed ? 1 : 0);
