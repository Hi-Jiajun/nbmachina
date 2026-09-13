// 用 Node 搭建无头测试服（避免 PowerShell here-string 的坑）
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'C:/Users/hiliang/Documents/minecraft/testserver';
const SRC = 'C:/Users/hiliang/Documents/minecraft/build/styx_build';
const DST = path.join(DIR, 'world/datapacks/styx_build');

fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, 'eula.txt'), 'eula=true\n');
fs.writeFileSync(path.join(DIR, 'server.properties'), [
  'level-type=minecraft:flat',
  'online-mode=false',
  'spawn-protection=0',
  'view-distance=8',
  'simulation-distance=8',
  'max-players=2',
  'allow-nether=false',
  'enable-command-block=true',
  'sync-chunk-writes=false',
  'max-tick-time=-1',
  'spawn-monsters=false',
  'spawn-animals=false',
  'spawn-npcs=false',
  '',
].join('\n'));

fs.rmSync(DST, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DST), { recursive: true });
fs.cpSync(SRC, DST, { recursive: true });

fs.writeFileSync(path.join(DST, 'data/styx/function/test_trigger.mcfunction'), [
  'setblock 500 100 0 minecraft:note_block[instrument=harp,note=12,powered=false]',
  'setblock 500 101 0 minecraft:redstone_block',
  'execute if block 500 100 0 minecraft:note_block[powered=true] run say TEST_TRIGGER_POWERED_OK',
  'setblock 500 101 0 minecraft:air',
  'execute if block 500 100 0 minecraft:note_block[powered=false] run say TEST_TRIGGER_RELEASED_OK',
  '',
].join('\n'));

const count = (dir) => fs.readdirSync(dir, { withFileTypes: true }).reduce((n, e) => n + (e.isDirectory() ? count(path.join(dir, e.name)) : 1), 0);
console.log('测试服目录:', DIR);
console.log('数据包文件数:', count(DST));
console.log('tick 标签存在:', fs.existsSync(path.join(DST, 'data/minecraft/tags/function/tick.json')));
console.log('play 函数数:', fs.readdirSync(path.join(DST, 'data/styx/function/play')).length);
