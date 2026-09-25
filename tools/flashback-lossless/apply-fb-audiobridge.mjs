#!/usr/bin/env node
// M5-41 · 给 Flashback 加一条**导出音频桥**：外部 mod 可以把样本直接混进导出音轨。
//
// 为什么需要它（2026-09-25 实测取证）：nbmachina 的音频引擎走**自有 OpenAL 设备**（M3-16），
// 而 Flashback 的 `Record Audio` 抓的是原版 SoundEngine 设备上的 `SOFTLoopback.alcRenderSamplesSOFT`
// → 我们挂在回放里的音频轨、以及 mod 自己播的实时音，**都不会进导出成片**。
// 实测：2026-09-25 的 `StyxHelix.mkv` 有 pcm_s24le 48k/2ch 音轨，但逐样本是 0（volumedetect -91 dB）。
//
// 这条桥的做法：Flashback 每导出一帧，问一次已注册的 Provider 要（相对导出时间轴的）样本，
// 直接加进这一帧的 float 缓冲。样本来自无损文件，**不经过任何设备/回环/编码损耗**，
// 也不依赖用户有没有在回放中心挂音频轨；裁剪/变速/多分辨率导出都自动跟随（因为它是按导出时间轴取的）。
//
// 用法（对一份 Flashback 上游 clone 运行，可重复跑）：
//   node apply-fb-audiobridge.mjs <flashback checkout>
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const root = process.argv[2];
if (!root) throw new Error('usage: node apply-fb-audiobridge.mjs <flashback checkout>');
const SRC = join(root, 'src/main/java/com/moulberry/flashback');

function create(relPath, content) {
  const file = join(SRC, relPath);
  if (existsSync(file)) {
    console.log('already exists, skipping', relPath);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content.replaceAll('\n', '\r\n'));
  console.log('created', relPath);
}

function edit(relPath, replacements) {
  const file = join(SRC, relPath);
  const raw = readFileSync(file, 'utf8');
  const eol = raw.includes('\r\n') ? '\r\n' : '\n';
  let text = raw;
  for (const [name, from, to] of replacements) {
    const needle = from.replaceAll('\n', eol);
    const repl = to.replaceAll('\n', eol);
    const count = text.split(needle).length - 1;
    if (count === 0 && text.includes(repl.split(eol)[0])) {
      console.log('already patched, skipping', relPath, name);
      continue;
    }
    if (count !== 1) throw new Error(relPath + ': anchor "' + name + '" matched ' + count + ' times');
    text = text.replace(needle, repl);
    console.log('patched', relPath, name);
  }
  writeFileSync(file, text);
}

create('exporting/NbmAudioBridge.java', `package com.moulberry.flashback.exporting;

import java.nio.FloatBuffer;

/**
 * Opt-in hook that lets an external mod mix its own lossless audio into the exported file.
 *
 * <p>Flashback's own audio capture renders the vanilla SoundEngine's device through
 * {@code SOFTLoopback}: anything that plays on a different OpenAL device (for example a mod that
 * feeds 48kHz/24-bit samples straight to its own device) is invisible to it. A mod can register a
 * provider here and add samples for every exported frame instead - that path never touches a
 * device, so it cannot lose precision, and it follows cuts/retimes automatically because Flashback
 * asks per exported frame with the frame's position on the export timeline.
 */
public class NbmAudioBridge {

    public interface Provider {
        /**
         * @param dst          interleaved float samples for one exported frame (write-only, zeroed)
         * @param frames       number of sample frames in {@code dst}
         * @param channels     channels per frame (1 = mono, 2 = stereo)
         * @param startSeconds position of {@code dst[0]} on the export's audio timeline, in seconds
         * @param sampleRate   sample rate of the export's audio track
         */
        void fillAudio(FloatBuffer dst, int frames, int channels, double startSeconds, int sampleRate);
    }

    private static volatile Provider provider;

    public static void register(Provider newProvider) {
        provider = newProvider;
    }

    public static void unregister() {
        provider = null;
    }

    public static boolean available() {
        return provider != null;
    }

    public static Provider get() {
        return provider;
    }
}
`);

const before = `            // Capture audio if necessary
            FloatBuffer audioBuffer = null;
            if (this.settings.recordAudio()) {
                long device = Minecraft.getInstance().getSoundManager().soundEngine.library.currentDevice;

                audioSamples += this.settings.sampleRate().rate() / this.settings.framerate();
                int renderSamples = (int) audioSamples;
                audioSamples -= renderSamples;

                int channels = this.settings.stereoAudio() ? 2 : 1;

                audioBuffer = ByteBuffer.allocateDirect(renderSamples * 4 * channels).order(ByteOrder.nativeOrder()).asFloatBuffer();
                SOFTLoopback.alcRenderSamplesSOFT(device, audioBuffer, renderSamples);
            }`;

const after = `            // Capture audio if necessary (or when an external audio bridge wants to mix in)
            FloatBuffer audioBuffer = null;
            NbmAudioBridge.Provider audioBridge = NbmAudioBridge.get();
            if (this.settings.recordAudio() || audioBridge != null) {
                long device = Minecraft.getInstance().getSoundManager().soundEngine.library.currentDevice;

                int exportSampleRate = this.settings.sampleRate().rate();
                audioSamples += exportSampleRate / this.settings.framerate();
                int renderSamples = (int) audioSamples;
                audioSamples -= renderSamples;

                int channels = this.settings.stereoAudio() ? 2 : 1;

                audioBuffer = ByteBuffer.allocateDirect(renderSamples * 4 * channels).order(ByteOrder.nativeOrder()).asFloatBuffer();
                if (this.settings.recordAudio()) {
                    SOFTLoopback.alcRenderSamplesSOFT(device, audioBuffer, renderSamples);
                }

                if (audioBridge != null) {
                    try {
                        audioBridge.fillAudio(audioBuffer, renderSamples, channels,
                            this.settings.startTick() / 20.0 + this.exportedAudioFrames / (double) exportSampleRate,
                            exportSampleRate);
                    } catch (Throwable t) {
                        if (!this.audioBridgeErrorLogged) {
                            this.audioBridgeErrorLogged = true;
                            Flashback.LOGGER.error("Audio bridge threw an exception - exporting without it", t);
                        }
                    }
                }

                this.exportedAudioFrames += renderSamples;
            }`;

edit('exporting/ExportJob.java', [
  ['audio bridge fields', '    private double audioSamples = 0.0;',
    '    private double audioSamples = 0.0;\n    /** Samples already handed to the writer - keeps the audio bridge on the frame grid. */\n    private long exportedAudioFrames = 0L;\n    private boolean audioBridgeErrorLogged = false;'],
  ['audio bridge mix', before, after],
]);
