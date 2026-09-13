// project.json 数据契约校验器（SPEC §3）
//
// 设计要点：
//  - 纯 JSON、零第三方依赖、纯函数：validateProject(data) → { ok, errors, stats }
//  - 报错精确到字段路径（`notes[3].midi`），可直接喂给人看或喂给机器修
//  - 只校验**已知字段的必需性与值域**；未知字段一律放行（契约只做加法演进）
//  - 附带 CLI：`node src/ingest/project-schema.mjs <project.json>`，失败退出码 1
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 声部枚举（与 SPEC §3 / score.json 一致） */
export const VOICES = ['melody', 'inner', 'bass', 'perc'];

/**
 * `meta.source.format` 允许的取值：
 *  - musicxml / midi / smf / dawproject：SPEC §3 的三个 foreign 标准
 *  - csv：**过渡用**来源（M0 阶段没有真正的 OMR/MIDI 解析器，先由 CSV 引导出 project.json）
 */
export const SOURCE_FORMATS = ['musicxml', 'midi', 'smf', 'dawproject', 'csv'];

const SHA256_RE = /^[0-9a-f]{64}$/;
const MIDI_MIN = 0;
const MIDI_MAX = 127;
const VELOCITY_MIN = 0;
const VELOCITY_MAX = 127;
const TEMPO_MIN = 1;
const TEMPO_MAX = 1000;

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isInt = (v) => isNum(v) && Number.isInteger(v);
const nonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';

export class ProjectValidationError extends Error {
  constructor(errors, source = '<object>') {
    super(`project.json 校验失败（${source}）：${errors.length} 处问题\n` + formatErrors(errors));
    this.name = 'ProjectValidationError';
    this.errors = errors;
    this.source = source;
  }
  toString() {
    return this.message;
  }
}

/** 把错误列表渲染成多行文本（每行一条，带字段路径） */
export function formatErrors(errors) {
  return errors.map((e) => `  ${e.path}: [${e.code}] ${e.message}`).join('\n');
}

/**
 * 校验一个 project.json 对象。
 * @param {unknown} data
 * @returns {{ok: boolean, errors: Array<{path: string, code: string, message: string, value?: unknown}>, stats: {notes: number, voices: number, tempoMapEntries: number, annotations: number, maxMidi: number|null, minMidi: number|null}}}
 */
export function validateProject(data) {
  const errors = [];
  const stats = { notes: 0, voices: 0, tempoMapEntries: 0, annotations: 0, minMidi: null, maxMidi: null };
  const add = (p, code, message, value) => errors.push({ path: p, code, message, value });

  const reqStr = (obj, key, p) => {
    if (!(key in obj)) return add(p, 'MISSING', `缺少必填字段 ${p}`);
    if (typeof obj[key] !== 'string') return add(p, 'TYPE', `${p} 必须是字符串，实际是 ${typeName(obj[key])}`, obj[key]);
    if (obj[key].trim() === '') return add(p, 'EMPTY', `${p} 不能为空字符串`, obj[key]);
  };
  const reqNum = (obj, key, p, { min, max, integer = false } = {}) => {
    if (!(key in obj)) return add(p, 'MISSING', `缺少必填字段 ${p}`);
    const v = obj[key];
    if (!isNum(v)) return add(p, 'TYPE', `${p} 必须是数字，实际是 ${typeName(v)}`, v);
    if (integer && !Number.isInteger(v)) return add(p, 'RANGE', `${p} 必须是整数，实际是 ${v}`, v);
    const lo = min ?? -Infinity;
    const hi = max ?? Infinity;
    if (v < lo || v > hi) {
      const range = `${Number.isFinite(lo) ? lo : '-∞'}..${Number.isFinite(hi) ? hi : '+∞'}`;
      return add(p, 'RANGE', `${p} 超出值域 ${range}（实际 ${v}）`, v);
    }
  };

  if (!isPlainObject(data)) {
    add('$', 'TYPE', `project.json 顶层必须是对象，实际是 ${typeName(data)}`, data);
    return { ok: false, errors, stats };
  }

  /* ---------- meta ---------- */
  // null = voices[] 本身有问题，此时不再逐音做交叉校验（避免一个根因刷出一堆衍生错误）
  let declaredVoices = null;
  if (!('meta' in data)) {
    add('meta', 'MISSING', '缺少必填字段 meta');
  } else if (!isPlainObject(data.meta)) {
    add('meta', 'TYPE', `meta 必须是对象，实际是 ${typeName(data.meta)}`, data.meta);
  } else {
    const m = data.meta;
    reqStr(m, 'title', 'meta.title');
    reqStr(m, 'author', 'meta.author');
    reqNum(m, 'tempo', 'meta.tempo', { min: TEMPO_MIN, max: TEMPO_MAX });
    reqStr(m, 'license', 'meta.license');

    if (!('source' in m)) {
      add('meta.source', 'MISSING', '缺少必填字段 meta.source');
    } else if (!isPlainObject(m.source)) {
      add('meta.source', 'TYPE', `meta.source 必须是对象，实际是 ${typeName(m.source)}`, m.source);
    } else {
      const s = m.source;
      if (!('format' in s)) {
        add('meta.source.format', 'MISSING', '缺少必填字段 meta.source.format');
      } else if (typeof s.format !== 'string') {
        add('meta.source.format', 'TYPE', `meta.source.format 必须是字符串，实际是 ${typeName(s.format)}`, s.format);
      } else if (!SOURCE_FORMATS.includes(s.format)) {
        add('meta.source.format', 'UNKNOWN_FORMAT', `meta.source.format 不在标准表内（允许：${SOURCE_FORMATS.join(' / ')}），实际 ${s.format}`, s.format);
      }
      reqStr(s, 'path', 'meta.source.path');
      if (!('sha256' in s)) {
        add('meta.source.sha256', 'MISSING', '缺少必填字段 meta.source.sha256');
      } else if (typeof s.sha256 !== 'string' || !SHA256_RE.test(s.sha256)) {
        add('meta.source.sha256', 'RANGE', `meta.source.sha256 必须是 64 位小写十六进制（实际 ${JSON.stringify(s.sha256)}）`, s.sha256);
      }
    }
  }

  /* ---------- voices ---------- */
  if (!('voices' in data)) {
    add('voices', 'MISSING', '缺少必填字段 voices');
  } else if (!Array.isArray(data.voices)) {
    add('voices', 'TYPE', `voices 必须是数组，实际是 ${typeName(data.voices)}`, data.voices);
  } else if (data.voices.length === 0) {
    add('voices', 'EMPTY', 'voices 至少要声明一个声部', data.voices);
  } else {
    const seen = new Set();
    data.voices.forEach((v, i) => {
      const p = `voices[${i}]`;
      if (typeof v !== 'string') return add(p, 'TYPE', `${p} 必须是字符串，实际是 ${typeName(v)}`, v);
      if (!VOICES.includes(v)) return add(p, 'UNKNOWN_VOICE', `${p} 不在声部枚举内（允许：${VOICES.join(' / ')}），实际 ${v}`, v);
      if (seen.has(v)) return add(p, 'DUPLICATE', `${p} 重复声明了声部 ${v}`, v);
      seen.add(v);
    });
    declaredVoices = seen.size > 0 ? [...seen] : null;
    stats.voices = seen.size;
  }

  /* ---------- notes ---------- */
  if (!('notes' in data)) {
    add('notes', 'MISSING', '缺少必填字段 notes');
  } else if (!Array.isArray(data.notes)) {
    add('notes', 'TYPE', `notes 必须是数组，实际是 ${typeName(data.notes)}`, data.notes);
  } else {
    data.notes.forEach((n, i) => {
      const p = `notes[${i}]`;
      if (!isPlainObject(n)) return add(p, 'TYPE', `${p} 必须是对象，实际是 ${typeName(n)}`, n);

      if (!('voice' in n)) {
        add(`${p}.voice`, 'MISSING', `缺少必填字段 ${p}.voice`);
      } else if (typeof n.voice !== 'string') {
        add(`${p}.voice`, 'TYPE', `${p}.voice 必须是字符串，实际是 ${typeName(n.voice)}`, n.voice);
      } else if (declaredVoices === null) {
        // voices[] 本身不合法：根因已在 voices[] 报过，这里不再刷衍生错误
      } else if (!declaredVoices.includes(n.voice)) {
        add(`${p}.voice`, 'UNKNOWN_VOICE', `${p}.voice=${n.voice} 未在 voices[] 中声明（已声明：${declaredVoices.join(', ') || '无'}）`, n.voice);
      }

      reqNum(n, 'onsetSec', `${p}.onsetSec`, { min: 0 });
      reqNum(n, 'durSec', `${p}.durSec`, { min: 1e-6 });
      reqNum(n, 'midi', `${p}.midi`, { min: MIDI_MIN, max: MIDI_MAX, integer: true });
      reqNum(n, 'velocity', `${p}.velocity`, { min: VELOCITY_MIN, max: VELOCITY_MAX, integer: true });

      for (const flag of ['tie', 'slur']) {
        if (flag in n && typeof n[flag] !== 'boolean') {
          add(`${p}.${flag}`, 'TYPE', `${p}.${flag} 必须是布尔值，实际是 ${typeName(n[flag])}`, n[flag]);
        }
      }

      if (isInt(n.midi)) {
        stats.minMidi = stats.minMidi === null ? n.midi : Math.min(stats.minMidi, n.midi);
        stats.maxMidi = stats.maxMidi === null ? n.midi : Math.max(stats.maxMidi, n.midi);
      }
    });
    stats.notes = data.notes.length;
  }

  /* ---------- tempoMap ---------- */
  if (!('tempoMap' in data)) {
    add('tempoMap', 'MISSING', '缺少必填字段 tempoMap');
  } else if (!Array.isArray(data.tempoMap)) {
    add('tempoMap', 'TYPE', `tempoMap 必须是数组，实际是 ${typeName(data.tempoMap)}`, data.tempoMap);
  } else if (data.tempoMap.length === 0) {
    add('tempoMap', 'EMPTY', 'tempoMap 至少要有一个 {sec,bpm} 条目', data.tempoMap);
  } else {
    data.tempoMap.forEach((e, i) => {
      const p = `tempoMap[${i}]`;
      if (!isPlainObject(e)) return add(p, 'TYPE', `${p} 必须是对象，实际是 ${typeName(e)}`, e);
      reqNum(e, 'sec', `${p}.sec`, { min: 0 });
      reqNum(e, 'bpm', `${p}.bpm`, { min: TEMPO_MIN, max: TEMPO_MAX });
      if (i === 0 && isNum(e.sec) && e.sec !== 0) {
        add(`${p}.sec`, 'RANGE', `${p}.sec 必须是 0（tempoMap 第一项代表起始速度），实际 ${e.sec}`, e.sec);
      }
    });
    stats.tempoMapEntries = data.tempoMap.length;
  }

  /* ---------- annotations（可选，但出现即校验） ---------- */
  if ('annotations' in data) {
    if (!Array.isArray(data.annotations)) {
      add('annotations', 'TYPE', `annotations 必须是数组，实际是 ${typeName(data.annotations)}`, data.annotations);
    } else {
      data.annotations.forEach((a, i) => {
        const p = `annotations[${i}]`;
        if (!isPlainObject(a)) return add(p, 'TYPE', `${p} 必须是对象，实际是 ${typeName(a)}`, a);
        if ('type' in a) reqStr(a, 'type', `${p}.type`);
        if ('text' in a && typeof a.text !== 'string') add(`${p}.text`, 'TYPE', `${p}.text 必须是字符串，实际是 ${typeName(a.text)}`, a.text);
        if ('sec' in a) reqNum(a, 'sec', `${p}.sec`, { min: 0 });
      });
      stats.annotations = data.annotations.length;
    }
  }

  return { ok: errors.length === 0, errors, stats };
}

/** 校验失败即抛 ProjectValidationError（错误信息带全部字段路径） */
export function assertProject(data, source = '<object>') {
  const { ok, errors } = validateProject(data);
  if (!ok) throw new ProjectValidationError(errors, source);
  return data;
}

/** 读文件 → 校验 → 返回对象（JSON 解析错误也会带上下文抛出） */
export function loadProject(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`读不到 ${file}：${e.message}`);
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${file} 不是合法 JSON：${e.message}`);
  }
  return assertProject(data, file);
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/* ---------- CLI ---------- */
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const file = process.argv[2];
  if (!file) {
    console.error('用法: node src/ingest/project-schema.mjs <project.json>');
    process.exit(2);
  }
  const { ok, errors, stats } = validateProject(
    (() => {
      try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (e) {
        console.error(`读不到/解析失败 ${file}：${e.message}`);
        process.exit(2);
      }
    })(),
  );
  if (!ok) {
    console.error(`✗ ${file}: ${errors.length} 处契约问题`);
    console.error(formatErrors(errors));
    process.exit(1);
  }
  console.log(
    `✓ ${file}: 契约通过（notes=${stats.notes} voices=${stats.voices} tempoMap=${stats.tempoMapEntries} ` +
      `annotations=${stats.annotations} midi=${stats.minMidi}..${stats.maxMidi}）`,
  );
}
