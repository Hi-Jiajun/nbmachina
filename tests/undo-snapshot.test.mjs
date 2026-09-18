// M1-6 · undo 前像快照：解析器 + 生成器单测
//
// 纪律（来自 docs/DISCUSSION-B-architecture.md §5.3）：**不许静默跳过**。
// 读不到的格子（区块不存在 / 未加载 / 回包不认识）必须出现在报告里，并且让 `complete:false`，
// 而不是被当成空气写进 styx:undo —— 那正是旧 undo 不可信的原因。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  VERSION, classifyDataGetReply, parseStateToken, formatStateToken, parseScanLog, buildUndoArtifacts,
} from '../src/emit/undo-snapshot.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fx = (n) => fs.readFileSync(path.join(HERE, 'fixtures/undo', n), 'utf8');

test('回包分类：四种真实回包 + 不认识的回包', () => {
  const ok = classifyDataGetReply('The target block is not a block entity');
  assert.equal(ok.kind, 'not-block-entity');

  assert.equal(classifyDataGetReply('That position is not loaded').kind, 'not-loaded');
  assert.equal(classifyDataGetReply('That position is out of this world!').kind, 'out-of-world');

  const be = classifyDataGetReply('480, 86, -160 has the following block data: {components: {}, x: 480, y: 86, z: -160, id: "minecraft:chest"}');
  assert.equal(be.kind, 'block-entity');
  assert.equal(be.id, 'minecraft:chest');

  const bad = classifyDataGetReply('Something entirely unexpected');
  assert.equal(bad.kind, 'unknown');
  assert.equal(bad.raw, 'Something entirely unexpected');
});

test('方块状态 token：解析 / 序列化 / 属性排序 / 非法输入抛错', () => {
  assert.deepEqual(parseStateToken('minecraft:sand'), { name: 'minecraft:sand', properties: {} });
  assert.deepEqual(
    parseStateToken('minecraft:redstone_lamp[lit=false]'),
    { name: 'minecraft:redstone_lamp', properties: { lit: 'false' } },
  );
  // 属性按 key 排序输出（保证 emit 幂等：同一份前像两次生成的文件字节一致）
  const t = parseStateToken('minecraft:note_block[powered=false,note=15,instrument=harp]');
  assert.deepEqual(Object.keys(t.properties), ['instrument', 'note', 'powered']);
  assert.equal(formatStateToken(t), 'minecraft:note_block[instrument=harp,note=15,powered=false]');
  assert.equal(formatStateToken(parseStateToken('minecraft:air')), 'minecraft:air');

  assert.throws(() => parseStateToken('minecraft:air['), /非法方块状态/);
  assert.throws(() => parseStateToken('sand'), /非法方块状态/);
  assert.throws(() => parseStateToken('minecraft:sand[lit]'), /非法方块状态/);
});

test('parseScanLog：原始回包逐条分类，格子逐条解析，不留静默', () => {
  const s = parseScanLog(fx('scan-sample.txt'));
  assert.equal(s.version, VERSION);
  assert.equal(s.notes, 'build/styx_helix_machine.csv');
  assert.equal(s.console.length, 6);
  assert.deepEqual(s.counts.byKind, {
    'block-entity': 1, 'not-block-entity': 3, 'not-loaded': 1, 'out-of-world': 1,
  });
  assert.equal(s.cells.length, 6);
  assert.deepEqual(s.counts.bySource, { 'region-nbt': 6 });
  assert.equal(s.cells[0].role, 'lamp');
  assert.equal(s.cells[0].state.name, 'minecraft:redstone_lamp');
  assert.deepEqual(s.cells[3].state, { name: 'minecraft:chest', properties: { facing: 'north' } });
  assert.deepEqual(s.unknown, []);
  assert.deepEqual(s.errors, []);
  assert.deepEqual(s.counts.notLoaded, ['480,84,-160']);
  assert.deepEqual(s.counts.outOfWorld, ['480,85,-160']);
});

test('parseScanLog：缺失/未加载/不认识的回包都进报告，且不当作空气', () => {
  const s = parseScanLog(fx('scan-incomplete.txt'));
  assert.equal(s.cells.length, 3, '格式坏掉的 [cell] 行不算有效格子（读不到的那格仍要进 cells 并带着原因）');
  assert.equal(s.counts.unreadable.length, 1);
  assert.deepEqual(s.counts.unreadable[0], { x: 700, y: 84, z: -160, role: 'deck', issues: ['missing-chunk'] });
  assert.equal(s.counts.bySource.missing, 1);
  assert.deepEqual(s.counts.notLoaded, ['700,83,-160']);
  assert.equal(s.unknown.length, 1);
  assert.equal(s.unknown[0].reply, 'Something entirely unexpected');
  // 坏行必须报错：多出来的 [garbage] 行 + 只有 5 个 token 的 [cell] 行
  assert.equal(s.errors.length, 2);
  assert.match(s.errors.join('\n'), /\[garbage\]/);
  assert.match(s.errors.join('\n'), /token/);

  const { report } = buildUndoArtifacts(s);
  assert.equal(report.complete, false, '有读不到的格子时不许声称 complete');
  assert.equal(report.cells.restorable, 2);
  assert.equal(report.cells.unreadable.length, 1);
  assert.equal(report.scan.unknownConsoleReplies.length, 1);
  assert.equal(report.parseErrors.length, 2);
});

test('交叉校验：console 给出的方块实体 id 与 region 前像必须一致', () => {
  const agree = parseScanLog(fx('scan-sample.txt'));
  assert.equal(agree.counts.crossCheck.compared, 1);
  assert.equal(agree.counts.crossCheck.agreed, 1);
  assert.deepEqual(agree.counts.crossCheck.disagreed, []);
  assert.equal(buildUndoArtifacts(agree).report.complete, true);

  const disagree = parseScanLog(fx('scan-disagree.txt'));
  assert.equal(disagree.counts.crossCheck.compared, 2);
  assert.equal(disagree.counts.crossCheck.agreed, 1);
  assert.equal(disagree.counts.crossCheck.disagreed.length, 1);
  assert.equal(disagree.counts.crossCheck.disagreed[0].console, 'minecraft:barrel');
  assert.equal(disagree.counts.crossCheck.disagreed[0].region, 'minecraft:sand');
  assert.equal(buildUndoArtifacts(disagree).report.complete, false);
});

test('buildUndoArtifacts：逐格 setblock 还原 + 可执行的逐格对账函数', () => {
  const s = parseScanLog(fx('scan-sample.txt'));
  const { files, report } = buildUndoArtifacts(s);
  const undo = files['undo.mcfunction'];
  const part = files['undo/p001.mcfunction'];
  const verify = files['undo/verify.mcfunction'];
  const dpart = files['undo/d001.mcfunction'];

  assert.ok(undo.includes('function styx:undo/p001'), 'undo 是派发器');
  assert.ok(undo.includes('function styx:undo/verify'), 'undo 末尾自带逐格对账');
  assert.ok(part.includes('setblock 480 83 -160 minecraft:redstone_lamp[lit=false]'));
  assert.ok(part.includes('setblock 480 84 -160 minecraft:sand'));
  assert.ok(part.includes('setblock 480 86 -160 minecraft:chest[facing=north]'));
  assert.ok(!part.includes('700 84'), '读不到的格子不许写进 undo');

  assert.ok(verify.includes('scoreboard objectives add styx.undo dummy'));
  assert.ok(verify.includes('scoreboard players set #bad styx.undo 0'));
  assert.ok(verify.includes('function styx:undo/d001'));
  assert.ok(dpart.includes('execute unless block 480 83 -160 minecraft:redstone_lamp[lit=false] run scoreboard players add #bad styx.undo 1'),
    '逐格对账：每格都要有 unless block 断言，差 0 才叫还原');
  assert.ok(verify.includes('"score":{"name":"#bad","objective":"styx.undo"}'), '对账结果以计数器收口');
  assert.ok(verify.includes('run say [Styx] undo 逐格对账通过'), '无头服没有玩家，结论要用 say 打进日志');
  assert.ok(verify.includes('run say [Styx] undo 逐格对账不通过'), '不通过时也要留痕（指向 styx:undo/where）');

  assert.equal(report.complete, true);
  assert.equal(report.output.setblockLines, 6);
  assert.equal(report.output.verifyLines, 6);
  assert.equal(report.cells.unique, 6);
});

test('buildUndoArtifacts：分片阈值、重复格去重、幂等（两次生成字节一致）', () => {
  const s = parseScanLog(fx('scan-sample.txt'));
  // 手动塞一个重复格（同一格重复扫描：apply_notes_v3 的旧清空坐标会撞上）
  s.cells.push({ ...s.cells[0], issues: [], state: { ...s.cells[0].state } });
  const a = buildUndoArtifacts(s, { maxLinesPerPart: 2 });
  const dup = a.report.cells.duplicatesDropped;
  assert.equal(dup, 1);
  assert.equal(a.report.cells.unique, 6);
  assert.equal(Object.keys(a.files).filter((f) => /^undo\/p\d+/.test(f)).length, 3, '6 格 / 每片 2 行 = 3 片');

  const b = buildUndoArtifacts(parseScanLog(fx('scan-sample.txt')), { maxLinesPerPart: 3 });
  const c = buildUndoArtifacts(parseScanLog(fx('scan-sample.txt')), { maxLinesPerPart: 3 });
  assert.deepEqual(b.files, c.files);
  assert.equal(Object.keys(b.files).filter((f) => /^undo\/p\d+/.test(f)).length, 2);
});

test('buildUndoArtifacts：--where 才生成逐格坐标诊断函数（默认不生成，避免数据包膨胀）', () => {
  const s = parseScanLog(fx('scan-sample.txt'));
  assert.equal(buildUndoArtifacts(s).files['undo/w001.mcfunction'], undefined);
  const w = buildUndoArtifacts(s, { where: true });
  // say 而不是 tellraw @a：无头服没有玩家，tellraw @a 打不进日志（实测）
  assert.ok(w.files['undo/w001.mcfunction'].includes('execute unless block 480 84 -160 minecraft:sand run say [undo/diff] 480 84 -160'));
  assert.ok(w.files['undo/where.mcfunction'].includes('function styx:undo/w001'));
});

test('buildUndoArtifacts：全 air 前像也照写（宁可显式清空，不许"跳过等于没改"）', () => {
  const log = [
    '# nbmachina undo-preimage v1',
    '# notes build/x.csv',
    '[cell] 1 2 3 lamp minecraft:air region-nbt',
    '[cell] 1 3 3 deck minecraft:air region-nbt',
    '',
  ].join('\n');
  const { files, report } = buildUndoArtifacts(parseScanLog(log));
  assert.ok(files['undo/p001.mcfunction'].includes('setblock 1 2 3 minecraft:air'));
  assert.equal(report.complete, true);
});
