// 工作目录 + 工程名的**唯一**解析入口（M2-2）
//
// 改造前：每个脚本都写死 `C:/Users/hiliang/Documents/minecraft/build` 与 `styx_helix_*` 文件名
// → 换机器、换目录、换一首歌都要手改代码（见 docs/DISCUSSION-B-architecture.md §1.2）。
//
// 解析顺序（高优先级在前）：
//   build 目录：`--build <dir>` → `NBFORGE_BUILD` → 默认 `<仓库上层>/build`
//   工程名：    `--project <name>` → `NBFORGE_PROJECT` → `<build>/project.json` 的 `nbforge.project` → `styx`
//
// 两条硬约束（M2-2 验收）：
//   1) **默认取值与历史硬编码逐字符一致**：不传任何参数时解析出来的路径必须等于改造前写死的那串字符串，
//      否则"改造前后产出 sha256 一致"就无从谈起。
//   2) 路径一律绝对 + 正斜杠：路径会出现在报告 JSON 与生成的 mcfunction 注释里，分隔符变了产出就不是逐字节相同。
//
// 工程名 → 文件名前缀：
//   `styx`（历史参考曲）是别名，映射到历史前缀 `styx_helix`；其他工程名直接用自己当前缀。
//   带前缀的是"工程身份"文件（音频 / 转谱 / v3 谱面 / 机器谱面 / 数据包目录）；
//   其余中间产物（`pipeline_*.csv`、`notes_*.csv`、`*-report.json`…）沿用固定文件名——一个 build 目录 = 一首歌。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** 仓库根（`<repo>/src/core/paths.mjs` → `<repo>`） */
export const REPO_ROOT = path.resolve(HERE, '..', '..').replace(/\\/g, '/');

/** 历史参考曲的工程名与它的历史文件名前缀 */
export const LEGACY_PROJECT = 'styx';
export const LEGACY_PREFIX = 'styx_helix';
/** 工程名 → 前缀别名（历史遗留名字在这里收口） */
const PREFIX_ALIASES = { [LEGACY_PROJECT]: LEGACY_PREFIX };

/** 工程名允许的字符集：会变成文件名前缀，限制成 ASCII 安全集（中文名请在 project.json 的 meta.title 里写） */
export const PROJECT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** 目录路径归一化：绝对 + 正斜杠 + 无末尾斜杠（Windows 与历史写法同形） */
export function normalizeDir(p, cwd = process.cwd()) {
  return path.resolve(cwd, p).replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * 取 `--name <value>` / `--name=value`。找不到返回 undefined；
 * 写了 flag 但没给值（下一个 token 又是 `--x`）返回 true（由调用方决定是否报错）。
 */
export function findFlag(argv, name) {
  const long = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === long) {
      const next = argv[i + 1];
      return next === undefined || next.startsWith('--') ? true : next;
    }
    if (a.startsWith(`${long}=`)) return a.slice(long.length + 1);
  }
  return undefined;
}

/** 默认 build 目录 = 仓库上层的 `build/`（与历史硬编码 `C:/Users/hiliang/Documents/minecraft/build` 同一目录） */
export function defaultBuildDir() {
  return normalizeDir(path.resolve(REPO_ROOT, '..', 'build'));
}

const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined;

/** `<build>/project.json` 里的 `nbforge.project`（工程清单，可选）；读不到就当没有，绝不因为它的坏掉而炸掉调用方 */
function projectFromManifest(buildDir) {
  try {
    const p = `${buildDir}/project.json`;
    if (!fs.existsSync(p)) return undefined;
    return nonEmpty(JSON.parse(fs.readFileSync(p, 'utf8'))?.nbforge?.project);
  } catch {
    return undefined;
  }
}

/**
 * 解析 build 目录 + 工程名，并给出所有"工程身份"路径。
 *
 * @param {object} [opts]
 * @param {string[]} [opts.argv] 命令行（默认 process.argv.slice(2)）
 * @param {Record<string,string|undefined>} [opts.env] 环境变量（默认 process.env）
 * @param {string} [opts.cwd] 相对路径的基准目录（默认 process.cwd()）
 * @param {string} [opts.build] 显式 build 目录（优先级最高，便于模块调用方直接传值）
 * @param {string} [opts.project] 显式工程名（优先级最高）
 * @returns {{
 *   build: string, project: string, prefix: string,
 *   packDir: string, packDataDir: string, datapackDir: string,
 *   functionsDir: string, structuresDir: string, tagDir: string,
 *   audio: string, notes: string, notesV3: string, machine: string, profile: string,
 *   file: (name: string) => string, prefixed: (name: string) => string,
 * }}
 */
export function resolvePaths({ argv = process.argv.slice(2), env = process.env, cwd = process.cwd(), build, project } = {}) {
  const flagBuild = build ?? findFlag(argv, 'build');
  const flagProject = project ?? findFlag(argv, 'project');
  if (flagBuild === true) throw new Error('--build 需要一个目录参数：--build <dir>');
  if (flagProject === true) throw new Error('--project 需要一个工程名：--project <name>');

  const buildDir = normalizeDir(nonEmpty(flagBuild) ?? nonEmpty(env.NBFORGE_BUILD) ?? defaultBuildDir(), cwd);

  // `--project ''` / `--project=` 视为"显式给了空名字"→ 报错，而不是静默退回默认工程
  const requested = typeof flagProject === 'string' ? flagProject.trim() : undefined;
  const name = requested ?? nonEmpty(env.NBFORGE_PROJECT) ?? projectFromManifest(buildDir) ?? LEGACY_PROJECT;
  if (!PROJECT_NAME_RE.test(name)) {
    throw new Error(`工程名不合法：${JSON.stringify(name)}（只允许字母/数字/._-，且以字母或数字开头）`);
  }
  const prefix = PREFIX_ALIASES[name] ?? name;
  // 数据包目录：历史参考曲保留 `styx_build/`（历史产物、文档、无头脚本都按这个名字找）
  const packBase = name === LEGACY_PROJECT ? LEGACY_PROJECT : prefix;

  const packDir = `${buildDir}/${packBase}_build`;
  const packDataDir = `${packDir}/data`;
  const datapackDir = `${packDataDir}/${LEGACY_PROJECT}`; // 数据包命名空间（函数名 `styx:play/tick`）与文件路径无关，本阶段不动
  return {
    build: buildDir,
    project: name,
    prefix,
    packDir,
    packDataDir,
    datapackDir,
    functionsDir: `${datapackDir}/function`,
    structuresDir: `${datapackDir}/structure`,
    tagDir: `${packDataDir}/minecraft/tags/function`,
    audio: `${buildDir}/${prefix}_full.wav`,
    notes: `${buildDir}/${prefix}_notes.csv`,
    notesV3: `${buildDir}/${prefix}_notes_v3.csv`,
    machine: `${buildDir}/${prefix}_machine.csv`,
    profile: `${buildDir}/single_row_profile.json`,
    file: (n) => `${buildDir}/${n}`,
    prefixed: (n) => `${buildDir}/${prefix}_${n}`,
  };
}
