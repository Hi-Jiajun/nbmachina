#!/usr/bin/env node
/**
 * STYX HELIX 开场三件套（封面 / 标题 / 副标题）资源包生成器。
 *
 * 背景：2026-09-24 起，开场画面不再用"一像素一颗粒子"的点阵，而是
 * **一张贴图 = 一颗 `minecraft:block` 粒子**（billboard 四边形）——
 * 这样清晰度 = 贴图分辨率，且不受粒子位置抖动影响（点阵在 dpb 高、size 恰好铺满时
 * 会被引擎/光影的抖动打散成彩纸屑）。
 *
 * 贴图挂在几个"正常世界里不会出现"的方块上（模型里**显式写了 particle 槽**，
 * 没有 particle 槽的方块覆盖贴图无效——实测 structure_block 就是无效的）：
 *   · 封面   → minecraft:jigsaw            贴图 assets/minecraft/textures/block/jigsaw_top.png
 *   · 标题   → minecraft:bamboo_fence_gate 贴图 …/block/bamboo_fence_gate_particle.png
 *   · 副标题 → minecraft:conduit           贴图 …/block/conduit.png
 *
 * ⚠ 本脚本把**专辑封面**渲染进资源包，因此产物**不进 git**：只在本地游戏目录生成。
 *   资源包目录：<gameDir>/resourcepacks/styx-plates/（需要装一个 ffmpeg 在 PATH 里）
 *
 * 用法：
 *   node tools/render-plate-pack.mjs \
 *     --game "C:\\Program Files\\PCL2\\.minecraft\\versions\\1.21.10-Fabric 0.19.5" \
 *     --cover "C:\\Users\\me\\Music\\…\\cover.png" \
 *     --title "STYX HELIX" --subtitle "MYTH & ROID"
 *
 * 之后在游戏里让资源包 styx-plates 生效（options.txt 的 resourcePacks 末尾加
 * "file/styx-plates"，或在"选项 → 资源包"里拖到右侧）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}
const gameDir = args.get('game');
const cover = args.get('cover');
if (!gameDir || !cover) {
  console.error('用法: node render-plate-pack.mjs --game "<游戏目录>" --cover "<封面png>" [--title "STYX HELIX"] [--subtitle "MYTH & ROID"]');
  process.exit(1);
}
const titleText = args.get('title') ?? 'STYX HELIX';
const subtitleText = args.get('subtitle') ?? 'MYTH & ROID';
const font = args.get('font') ?? 'C\\:/Windows/Fonts/NotoSansSC-VF.ttf';

const pack = path.join(gameDir, 'resourcepacks', 'styx-plates');
const blockTex = path.join(pack, 'assets', 'minecraft', 'textures', 'block');
fs.mkdirSync(blockTex, { recursive: true });

const run = (argv) => {
  const r = spawnSync('ffmpeg', ['-y', '-v', 'error', ...argv], { encoding: 'utf8' });
  if (r.status !== 0) {
    console.error('ffmpeg 失败:', r.stderr?.trim());
    process.exit(1);
  }
};
const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/:/g, '\\:').replace(/%/g, '\\%').replace(/,/g, '\\,');

// 1) 封面：2048²（源图 ~1424²，lanczos 上采样 + 轻锐化，让 4K 录制放大后仍够看）
run(['-i', cover, '-vf', 'scale=2048:2048:flags=lanczos,unsharp=5:5:0.7', '-frames:v', '1',
  path.join(blockTex, 'jigsaw_top.png')]);

// 2) 标题 / 副标题：1024² 方形贴图，文字居中、四周透明（quad 是正方形，靠透明留白控制视觉宽高比）
const textPlate = (out, text, fontSize) => run([
  '-f', 'lavfi', '-i', 'color=c=black@0.0:s=1024x1024:d=1,format=rgba',
  '-vf', `drawtext=fontfile='${font}':text='${esc(text)}':fontsize=${fontSize}:fontcolor=white:`
    + 'x=(w-text_w)/2:y=(h-text_h)/2:borderw=3:bordercolor=black@0.30',
  '-frames:v', '1', out,
]);
textPlate(path.join(blockTex, 'bamboo_fence_gate_particle.png'), titleText, 150);
textPlate(path.join(blockTex, 'conduit.png'), subtitleText, 110);

// 3) pack.mcmeta：1.21.10 的资源包格式是 69，且**必须**带 min_format / max_format
//    （只写 pack_format 会被判"声明了比 64 新的版本却缺字段"直接拒绝加载，2026-09-24 实测）
fs.writeFileSync(path.join(pack, 'pack.mcmeta'), JSON.stringify({
  pack: {
    pack_format: 69, min_format: 69, max_format: 81,
    description: 'STYX HELIX plates (cover / title / subtitle)',
  },
}, null, 2));

console.log('资源包已生成:', pack);
console.log('记得让资源包在游戏里生效（options.txt 的 resourcePacks 末尾加 "file/styx-plates"）。');
