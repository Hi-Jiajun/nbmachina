package net.nbmachina.mod.audio;

import java.io.IOException;
import java.nio.file.Path;

import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;

/**
 * M3-16（P2）· WAV 解码成 float PCM（保留 24bit 精度）。
 *
 * <p>为什么要自己解：原版明明只认 Ogg（{@code OggAudioStream} 是唯一实现），
 * 而我们的钢琴母版是 **48kHz/24bit WAV**（Salamander）与 44.1kHz/16bit（Yamaha/VSCO）。
 * 走 mod 自己读文件 → 送进 OpenAL，才能既无损又不受资源包格式限制。
 *
 * <p>用 JDK 自带的 {@link AudioSystem} 解析 RIFF（能跨过 OLPC 那种带 BWF `bext` 块的头），
 * 但**转换自己做**：8/16/24/32bit → float，避免 JDK 混音器做多余的重采样。
 */
public final class NbmachinaWav {
	/** 解码结果：交错 float PCM（[-1,1]）+ 声道数 + 采样率 */
	public record Pcm(float[] samples, int channels, int sampleRate) {
		public int frames() {
			return channels > 0 ? samples.length / channels : 0;
		}

		public double seconds() {
			return sampleRate > 0 ? frames() / (double) sampleRate : 0;
		}
	}

	private NbmachinaWav() {
	}

	public static Pcm read(Path file) throws IOException {
		try (AudioInputStream in = AudioSystem.getAudioInputStream(file.toFile())) {
			AudioFormat fmt = in.getFormat();
			byte[] raw = in.readAllBytes();
			return decode(raw, fmt);
		} catch (javax.sound.sampled.UnsupportedAudioFileException e) {
			throw new IOException("不是可解析的 PCM WAV：" + file, e);
		}
	}

	/** 公开给单测/自检：给定原始字节与格式，转成 float PCM */
	public static Pcm decode(byte[] raw, AudioFormat fmt) throws IOException {
		if (fmt.getEncoding() != AudioFormat.Encoding.PCM_SIGNED
			&& fmt.getEncoding() != AudioFormat.Encoding.PCM_UNSIGNED) {
			throw new IOException("只支持未压缩 PCM，收到 " + fmt.getEncoding());
		}
		int channels = fmt.getChannels();
		int bits = fmt.getSampleSizeInBits();
		int frameBytes = channels * (bits / 8);
		if (channels <= 0 || bits == 0 || frameBytes == 0) {
			throw new IOException("非法格式：" + fmt);
		}
		int frames = raw.length / frameBytes;
		float[] out = new float[frames * channels];
		boolean big = fmt.isBigEndian();
		boolean unsigned = fmt.getEncoding() == AudioFormat.Encoding.PCM_UNSIGNED;
		for (int i = 0; i < out.length; i++) {
			int off = i * (bits / 8);
			out[i] = (float) sampleAt(raw, off, bits, big, unsigned);
		}
		return new Pcm(out, channels, Math.round(fmt.getSampleRate()));
	}

	private static double sampleAt(byte[] b, int off, int bits, boolean big, boolean unsigned) {
		switch (bits) {
			case 8: {
				int v = b[off] & 0xFF;
				return unsigned ? (v - 128) / 128.0 : v / 128.0;
			}
			case 16: {
				int v = big ? ((b[off] << 8) | (b[off + 1] & 0xFF)) : ((b[off + 1] << 8) | (b[off] & 0xFF));
				return (short) v / 32768.0;
			}
			case 24: {
				// 24bit 小端有符号：拼三字节再符号扩展（与 tools 侧 readWav 同一套口径）
				int v = big
					? ((b[off] & 0xFF) << 16) | ((b[off + 1] & 0xFF) << 8) | (b[off + 2] & 0xFF)
					: (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8) | ((b[off + 2] & 0xFF) << 16);
				if ((v & 0x800000) != 0) v -= 0x1000000;
				return v / 8388608.0;
			}
			case 32: {
				int v = big
					? ((b[off] & 0xFF) << 24) | ((b[off + 1] & 0xFF) << 16) | ((b[off + 2] & 0xFF) << 8) | (b[off + 3] & 0xFF)
					: (b[off] & 0xFF) | ((b[off + 1] & 0xFF) << 8) | ((b[off + 2] & 0xFF) << 16) | ((b[off + 3] & 0xFF) << 24);
				return v / 2147483648.0;
			}
			default:
				return 0;
		}
	}
}
