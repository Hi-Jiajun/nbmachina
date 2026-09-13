# 参考与致谢（只借鉴思路，未使用其代码）

本项目（nbforge）的全部代码为自研。以下社区项目的**公开思路**影响了本项目的设计，
这里明确致谢；我们**没有**复制、移植或改写它们的任何代码/资源。

| 项目 | 借鉴的思路 |
|---|---|
| OpenNBS / NoteBlockStudio | 音符盒音乐的工作流：编曲 → 导出为可播放结构；`note` 值范围与乐器映射 |
| McMusicMaker | ① 机型分类（原地紧凑 / S 形折返 / 直线 / 自定义 / 多轨并行）；② **演奏期间提高 `/tick rate` 换取精确节奏**，结束后恢复；③ 「音频转录必然有错音，优先用 MIDI」的经验 |
| MineAudio、minecraft-audio-to-noteblocks | 音频/MIDI → 音符盒结构的流水线划分（分析 → 映射 → 生成） |
| NoteBetter（模组，Vince丷 视频中提及） | 给实体音符盒单独设置音量/音色的可行性 |
| nbs2schematic / NoteBlockTool | 结构/投影导出的思路 |

如果将来引入任何第三方代码或资源，会在本文件与 `LICENSE` 中单独注明其许可证。

---

## 音频资源（M2-1：自研音色资源包）

**`build/nbforge_resources.zip`（`assets/nbforge/**`，148 个 ogg）里没有任何第三方采样/音源/素材**：
全部音频由本仓库的 `src/synth/*.mjs` 现场合成（Karplus–Strong 拨弦、加法/FM 铺底、模态钟琴），
拨片噪声来自确定性伪随机数（`mulberry32`）—— 每个采样都能用同一条命令复算出来：

```bash
node src/synth/render-all.mjs --out build/audio_nbforge   # WAV → OGG（libvorbis），参数全在源码注释里
```

因此资源包的发声内容不涉及第三方版权（不采样原曲、不采样商业音源、不下载网络素材）。
合成算法与参数的取舍见 `docs/M2-1-report.md`。

Ogg/Vorbis 编码调用本机 `ffmpeg`（仓库不分发任何二进制）；若日后引入任何采样素材，
必须按设计文档 ⑦ 的要求逐条登记来源与许可证（CC0/公有领域优先）。
