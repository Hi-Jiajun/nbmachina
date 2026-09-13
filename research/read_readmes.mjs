// 拉几个最相关项目的 README，看他们的技术路线
const REPOS = [
  'mateusz-kosciolek-ds/minecraft-audio-to-noteblocks',
  'tremblestarman/MineAudio',
  'Cohenjikan/McMusicMaker',
  'sun123zxy/redstone-music-generator',
  'OpenNBS/NoteBlockStudio',
  'COM1919/NBSTByMC-Visual',
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const repo of REPOS) {
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers: { 'User-Agent': 'codex-research', Accept: 'application/vnd.github.raw' } });
    const txt = await r.text();
    console.log(`\n\n===================== ${repo} =====================`);
    console.log(txt.replace(/\r/g, '').split('\n').slice(0, 60).join('\n').slice(0, 2200));
  } catch (e) { console.log(`\n${repo}: ${e.message}`); }
  await sleep(1200);
}
