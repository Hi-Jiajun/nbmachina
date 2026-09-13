// 抓全这位 UP 的所有投稿（简介 + 标签），带重试
import fs from 'node:fs';
import crypto from 'node:crypto';

const MID = process.argv[2] ?? '171531610';
const OUT = 'C:/Users/hiliang/Documents/minecraft/build/bili_videos.json';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MIXIN = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52];
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let COOKIE = '';
async function api(url, referer = `https://space.bilibili.com/${MID}`) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Referer: referer, ...(COOKIE ? { Cookie: COOKIE } : {}) } });
  let j = null;
  try { j = await r.json(); } catch { j = { code: -999, message: 'bad json' }; }
  return { status: r.status, json: j };
}
async function apiRetry(url, tries = 5, referer) {
  for (let i = 0; i < tries; i++) {
    const res = await api(url, referer);
    if (res.json?.code === 0) return res.json.data;
    await sleep(600 * (i + 1));
  }
  return null;
}

const spi = await api('https://api.bilibili.com/x/frontend/finger/spi');
COOKIE = `buvid3=${spi.json?.data?.b_3}; buvid4=${spi.json?.data?.b_4};`;
const nav = await api('https://api.bilibili.com/x/web-interface/nav');
const wbi = nav.json?.data?.wbi_img;
const keyOf = (u) => u.split('/').pop().split('.')[0];
const rawKey = keyOf(wbi.img_url) + keyOf(wbi.sub_url);
const mixinKey = MIXIN.map((i) => rawKey[i]).join('').slice(0, 32);
function sign(params) {
  const wts = Math.floor(Date.now() / 1000);
  const p = { ...params, wts };
  const q = Object.keys(p).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(p[k]).replace(/[!'()*]/g, ''))}`).join('&');
  return `${q}&w_rid=${md5(q + mixinKey)}`;
}

// --- 投稿列表：按页抓，页间用「最新一条的 pubdate 作为下一页的排序锚点」不行，直接分页 + 重试
const list = [];
let total = 0;
for (let pn = 1; pn <= 5; pn++) {
  const data = await apiRetry(`https://api.bilibili.com/x/space/wbi/arc/search?${sign({ mid: MID, ps: 30, pn, order: 'pubdate', platform: 'web', web_location: 1550101 })}`);
  if (!data) { console.log(`第 ${pn} 页失败`); continue; }
  total = data.page?.count ?? total;
  const vlist = data.list?.vlist ?? [];
  list.push(...vlist);
  console.log(`第 ${pn} 页: +${vlist.length}（累计 ${list.length}/${total}）`);
  if (list.length >= total) break;
  await sleep(1200);
}
// 去重
const seen = new Set();
const uniq = list.filter((v) => (seen.has(v.bvid) ? false : seen.add(v.bvid)));

// --- 详情 + 标签
const out = [];
for (const v of uniq) {
  const d = await apiRetry(`https://api.bilibili.com/x/web-interface/view?bvid=${v.bvid}`, 3, `https://www.bilibili.com/video/${v.bvid}`) ?? {};
  const tg = await apiRetry(`https://api.bilibili.com/x/tag/archive/tags?bvid=${v.bvid}`, 2, `https://www.bilibili.com/video/${v.bvid}`);
  out.push({
    bvid: v.bvid, aid: v.aid, title: v.title, length: v.length ?? '', created: v.created, pubdate: v.pubdate ?? v.created,
    play: v.play, comment: v.comment, desc: (d.desc ?? '').trim(), tags: (tg ?? []).map((t) => t.tag_name), tname: d.tname ?? '',
  });
  process.stdout.write('.');
  await sleep(350);
}
console.log('');
fs.writeFileSync(OUT, JSON.stringify(out, null, 1), 'utf8');
console.log(`已保存 ${out.length} 条到 ${OUT}`);
