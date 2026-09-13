// M1-6 · 存档 region/NBT 只读解析单测
//
// 为什么需要它：1.21.10 实测 `/data get block` 只能读**方块实体**（原始回包见 docs/M1-6-report.md），
// 读不到"方块 id + 状态"。前像要可信，必须直接读存档里的 palette（Name + Properties），
// 这个文件用手工构造的**合成 region 文件**验证解析器（不连服务器、不碰真存档）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRegionReader } from '../src/scan/region-nbt.mjs';

/* ---------- 最小 NBT 编码器（只够写本测试用到的类型） ---------- */
const ent = (type, name, payload) => {
  const n = Buffer.from(name, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(n.length);
  return Buffer.concat([Buffer.from([type]), len, n, payload]);
};
const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32BE(v); return b; };
const i16 = (v) => { const b = Buffer.alloc(2); b.writeInt16BE(v); return b; };
const str = (s) => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([i16(b.length), b]); };
const end = () => Buffer.from([0]);
const comp = (...entries) => Buffer.concat([...entries, end()]);
const cByte = (n, v) => ent(1, n, Buffer.from([v & 0xff]));
const cInt = (n, v) => ent(3, n, i32(v));
const cStr = (n, v) => ent(8, n, str(v));
const cLongArr = (n, vals) => {
  const longs = vals.map((v) => { const b = Buffer.alloc(8); b.writeBigInt64BE(BigInt.asIntN(64, v)); return b; });
  return ent(12, n, Buffer.concat([i32(longs.length), ...longs]));
};
const cList = (n, itemType, items) => ent(9, n, Buffer.concat([Buffer.from([itemType]), i32(items.length), ...items]));

/** 一个 section：palette [air, sand, redstone_lamp[lit=false]]，指定位打成 sand / lamp */
function synthSection(sectionY, sandAt, lampAt) {
  const palette = cList('palette', 10, [
    comp(cStr('Name', 'minecraft:air')),
    comp(cStr('Name', 'minecraft:sand')),
    comp(cStr('Name', 'minecraft:redstone_lamp'), ent(10, 'Properties', comp(cStr('lit', 'false')))),
  ]);
  const bits = 4;
  const longs = new Array((4096 * bits) / 64).fill(0n);
  const put = (x, y, z, v) => {
    const i = (y << 8) | (z << 4) | x;
    const bit = i * bits, li = (bit / 64) | 0, off = bit % 64;
    longs[li] |= BigInt(v) << BigInt(off);
  };
  put(sandAt[0], sandAt[1], sandAt[2], 1);
  put(lampAt[0], lampAt[1], lampAt[2], 2);
  return comp(
    cByte('Y', sectionY),
    ent(10, 'block_states', comp(palette, cLongArr('data', longs))),
  );
}

/**
 * 复刻 testserver 实测的那种 section：palette 22 条（>16 → bits=5），
 * data **342** 个 long = 每个 long 只放 12 个条目（末尾 4 位不用）的"填充"打包。
 * 紧凑打包同样 5 bits 只要 320 个 long —— 两者不能混。
 */
function synthPaddedSection(sectionY, at, idx) {
  const palette = [comp(cStr('Name', 'minecraft:air')), comp(cStr('Name', 'minecraft:redstone_lamp'), ent(10, 'Properties', comp(cStr('lit', 'false'))))];
  for (let i = 0; i < 20; i++) {
    palette.push(comp(cStr('Name', 'minecraft:note_block'), ent(10, 'Properties', comp(cStr('instrument', 'harp'), cStr('note', String(i)), cStr('powered', 'false')))));
  }
  const bits = 5, per = Math.floor(64 / bits);
  const longs = new Array(Math.ceil(4096 / per)).fill(0n);
  const i = (at[1] << 8) | (at[2] << 4) | at[0];
  longs[Math.floor(i / per)] |= BigInt(idx) << BigInt((i % per) * bits);
  assert.equal(longs.length, 342, '填充打包 5 bits = 342 个 long（紧凑是 320）');
  return comp(
    cByte('Y', sectionY),
    ent(10, 'block_states', comp(cList('palette', 10, palette), cLongArr('data', longs))),
  );
}

function writeRegionSections(dir, cx, cz, sections, compress = 1) {
  const chunkRoot = Buffer.concat([
    Buffer.from([10]), str(''),
    comp(
      cInt('DataVersion', 4556),
      cInt('xPos', cx),
      cInt('zPos', cz),
      cList('sections', 10, sections),
    ),
  ]);
  const payload = compress === 2 ? zlib.deflateSync(chunkRoot) : zlib.gzipSync(chunkRoot);
  const sectors = Math.ceil((payload.length + 5) / 4096);
  const header = Buffer.alloc(8192);
  const i = (cx & 31) + (cz & 31) * 32;
  header[i * 4] = 0; header[i * 4 + 1] = 0; header[i * 4 + 2] = 2; header[i * 4 + 3] = sectors;
  const body = Buffer.alloc(sectors * 4096);
  body.writeInt32BE(payload.length + 1, 0);
  body[4] = compress;
  payload.copy(body, 5);
  fs.writeFileSync(path.join(dir, `r.${cx >> 5}.${cz >> 5}.mca`), Buffer.concat([header, body]));
}

/** 写一个只有 1 个区块的 region 文件；compress: 1=gzip / 2=zlib */
function writeRegion(dir, cx, cz, compress = 1) {
  const chunkRoot = Buffer.concat([
    Buffer.from([10]), str(''),
    comp(
      cInt('DataVersion', 4189),
      cInt('xPos', cx),
      cInt('zPos', cz),
      cList('sections', 10, [synthSection(5, [1, 2, 3], [4, 5, 6])]),
    ),
  ]);
  const payload = compress === 2 ? zlib.deflateSync(chunkRoot) : zlib.gzipSync(chunkRoot);
  const sectors = Math.ceil((payload.length + 5) / 4096);
  const header = Buffer.alloc(8192);
  const i = (cx & 31) + (cz & 31) * 32;
  header[i * 4] = 0; header[i * 4 + 1] = 0; header[i * 4 + 2] = 2; header[i * 4 + 3] = sectors;
  const body = Buffer.alloc(sectors * 4096);
  body.writeInt32BE(payload.length + 1, 0);
  body[4] = compress;
  payload.copy(body, 5);
  fs.writeFileSync(path.join(dir, `r.${cx >> 5}.${cz >> 5}.mca`), Buffer.concat([header, body]));
}

function withTempRegion(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nbforge-region-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('region 解析：palette 的 Name + Properties 都能读出来', () => {
  withTempRegion((dir) => {
    writeRegion(dir, 30, -14);
    const r = createRegionReader(dir);
    // section Y=5 → 世界 y 80..95；区块 (30,-14) 覆盖 x 480..495 / z -224..-209
    assert.deepEqual(r.blockAt(480 + 1, 80 + 2, -224 + 3), { name: 'minecraft:sand', properties: {} });
    assert.deepEqual(r.blockAt(480 + 4, 80 + 5, -224 + 6), { name: 'minecraft:redstone_lamp', properties: { lit: 'false' } });
    assert.deepEqual(r.blockAt(480 + 0, 80 + 0, -224 + 0), { name: 'minecraft:air', properties: {} });
  });
});

test('region 解析：没有 section 的高度 = 空气；没有的区块 = null（必须区分）', () => {
  withTempRegion((dir) => {
    writeRegion(dir, 30, -14);
    const r = createRegionReader(dir);
    assert.deepEqual(r.blockAt(481, 200, -221), { name: 'minecraft:air', properties: {} }, '区块在、section 不在 → 空气');
    assert.equal(r.blockAt(5000, 84, -160), null, '区块文件/条目不存在 → null（调用方要记成读不到）');
    assert.deepEqual(r.blockAt(480, -80, -224), { name: 'minecraft:air', properties: {} }, '不存在的 section（含负 y）= 空气');
    assert.ok(r.stats.chunksRead >= 1);
    assert.ok(r.stats.chunksMissing >= 1);
  });
});

test('region 解析：gzip 与 zlib 两种压缩都能解', () => {
  withTempRegion((dir) => {
    writeRegion(dir, 30, -14, 1);
    assert.equal(createRegionReader(dir).blockAt(481, 82, -221).name, 'minecraft:sand');
  });
  withTempRegion((dir) => {
    writeRegion(dir, 30, -14, 2);
    assert.equal(createRegionReader(dir).blockAt(481, 82, -221).name, 'minecraft:sand');
  });
});

test('region 解析：palette >16 条的 section 用"填充"打包也要读对（实测 testserver 就是这种）', () => {
  withTempRegion((dir) => {
    // 区块 (45,-10)：世界坐标 x 720..735 / z -160..-145，section Y=5 → y 80..95
    writeRegionSections(dir, 45, -10, [synthPaddedSection(5, [4, 3, 2], 1)]);
    const r = createRegionReader(dir);
    assert.deepEqual(
      r.blockAt(45 * 16 + 4, 5 * 16 + 3, -10 * 16 + 2),
      { name: 'minecraft:redstone_lamp', properties: { lit: 'false' } },
      '填充打包下这一格是红石灯（用紧凑打包解会读成索引 0 = 空气）',
    );
    assert.deepEqual(r.blockAt(45 * 16 + 0, 5 * 16 + 0, -10 * 16 + 0), { name: 'minecraft:air', properties: {} });
    assert.equal(r.stats.modes.padded, 1);
    assert.equal(r.stats.modes.compact, 0);
    assert.equal(r.paletteAt(45 * 16 + 4, 5 * 16 + 3, -10 * 16 + 2).length, 22);
  });
});

test('region 解析：section 的 Y 是**有符号** byte（y<0 的 section 也要能定位）', () => {
  withTempRegion((dir) => {
    // Y=-4 → 世界 y -64..-49（区块 (30,-14)）
    writeRegionSections(dir, 30, -14, [synthSection(-4, [1, 2, 3], [4, 5, 6])]);
    const r = createRegionReader(dir);
    assert.equal(r.blockAt(480 + 1, -64 + 2, -224 + 3).name, 'minecraft:sand');
    assert.equal(r.blockAt(480 + 4, -64 + 5, -224 + 6).name, 'minecraft:redstone_lamp');
    assert.deepEqual(r.blockAt(480, 100, -224), { name: 'minecraft:air', properties: {} }, '别的高度仍是空气');
  });
});
