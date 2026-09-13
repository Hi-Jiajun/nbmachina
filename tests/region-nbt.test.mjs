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
