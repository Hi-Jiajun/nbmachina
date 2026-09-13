// 用 GitHub API 搜「红石音乐 / 音符盒」相关项目，看看别人怎么做的
const QUERIES = [
  'noteblock studio',
  'note block studio minecraft',
  'minecraft note block music generator',
  '红石音乐',
  '音符盒',
  'nbs to schematic minecraft',
  'minecraft music datapack noteblock',
  'noteblock api minecraft',
  'minecraft redstone music',
  'midi to minecraft noteblock',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

for (const q of QUERIES) {
  const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=6`;
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'codex-research', Accept: 'application/vnd.github+json' } });
    const j = await r.json();
    if (j.message) { console.log(`\n### ${q}: ${j.message}`); await sleep(2000); continue; }
    console.log(`\n### 关键词「${q}」（共 ${j.total_count} 个结果，取 star 最多的 6 个）`);
    for (const it of j.items ?? []) {
      console.log(`  ⭐${String(it.stargazers_count).padStart(6)}  ${it.full_name}  [${it.language ?? '-'}]  ${(it.description ?? '').slice(0, 110)}`);
    }
  } catch (e) {
    console.log(`\n### ${q}: 请求失败 ${e.message}`);
  }
  await sleep(1500);
}
