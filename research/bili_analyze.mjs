// 分析 Vince丷 的投稿：分类 + 技术关键词统计 + 红石音乐作品的简介
import fs from 'node:fs';

const FILE = 'C:/Users/hiliang/Documents/minecraft/build/bili_videos.json';
const vids = JSON.parse(fs.readFileSync(FILE, 'utf8')).sort((a, b) => b.created - a.created);

const TECH = [
  '命令方块', '数据包', 'datapack', '红石', '音符盒', '音源', '音源机', '走带', '读头', '活塞',
  '飞行器', '时钟', '节拍', '音墙', '音柱', '频谱', '波形', '可视化', '建筑', '光影', '材质',
  'MIDI', 'midi', '转录', '扒谱', '谱面', '自制', '原创', '延迟', '串联', '并联', '分轨',
  '鼓', '打击乐', '贝斯', 'bass', '和声', '混响', '立体声', '左右声道', '声道',
];
const isMusic = (v) => /红石音乐|红乐|音源|音符盒|音乐可视化|演奏|复刻|还原/.test(v.title + ' ' + v.tags.join(' ') + ' ' + v.desc);

const music = vids.filter(isMusic);
console.log(`投稿总数 ${vids.length}，其中音乐类 ${music.length}\n`);
console.log('=== 技术关键词命中次数（全部投稿简介+标签）===');
const blob = vids.map((v) => v.title + ' ' + v.desc + ' ' + v.tags.join(' ')).join('\n');
for (const k of TECH) {
  const n = (blob.match(new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')) ?? []).length;
  if (n) console.log(`  ${k}: ${n}`);
}

console.log('\n=== 音乐类作品（按时间倒序）===');
for (const v of music) {
  const d = new Date(v.created * 1000).toLocaleDateString('zh-CN');
  console.log(`\n[${v.bvid}] ${v.title}`);
  console.log(`   ${d} | ${v.length} | 播放 ${v.play} | 标签: ${v.tags.join('/')}`);
  if (v.desc) console.log('   简介: ' + v.desc.replace(/\s+/g, ' ').slice(0, 700));
}
