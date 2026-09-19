package net.nbmachina.mod.audio;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;

import org.lwjgl.openal.AL10;

/**
 * M3-61 · 校准脉冲：一个 3kHz、6ms 的锐利短脉冲（+ 一句视觉粒子）。
 *
 * <p>用途：**标定采集链路延迟**。游戏把脉冲按本地时钟（0.18ms 抖动）发出的同时，在玩家身边放一圈
 * 亮粒子；录屏里"粒子亮起的那一帧"是视觉真值，"音频里脉冲出现的位置"是听觉观测值，
 * 两者之差 = OpenAL 输出 + OBS 回环采集的固定延迟。把这个常数从节奏统计里扣掉，
 * 剩下的才是机器自己的抖动。
 */
public final class NbmachinaClick {
	private static int buffer = 0;
	private static final int SR = 48000;

	private NbmachinaClick() {
	}

	/** 生成（或复用）脉冲 buffer；需要在 OpenAL 上下文就绪后调用 */
	private static synchronized int buffer() {
		if (buffer != 0) return buffer;
		int n = (int) (SR * 0.006);
		ByteBuffer data = ByteBuffer.allocateDirect(n * 4).order(ByteOrder.nativeOrder());
		for (int i = 0; i < n; i++) {
			double t = i / (double) SR;
			// 指数衰减的 3kHz 正弦：起音陡、尾巴极短，便于在波形上找峰
			double env = Math.exp(-t * 900);
			data.putFloat((float) (Math.sin(2 * Math.PI * 3000 * t) * env * 0.95));
		}
		data.flip();
		int b = AL10.alGenBuffers();
		if (b == 0) return 0;
		// 32 位浮点格式属于 AL_EXT_float32 扩展，常量在 NbmachinaAudio 里探测并缓存过
		int format = NbmachinaAudio.float32FormatOrMono16();
		AL10.alBufferData(b, format, data, SR);
		buffer = b;
		return buffer;
	}

	/** 立即放一声（由调度器在精确时刻调用） */
	public static void playNow(double x, double y, double z) {
		int b = buffer();
		if (b == 0) return;
		int src = AL10.alGenSources();
		if (src == 0) return;
		AL10.alSourcei(src, AL10.AL_BUFFER, b);
		AL10.alSourcef(src, AL10.AL_GAIN, 1.0f);
		AL10.alSourcef(src, AL10.AL_ROLLOFF_FACTOR, 0.0f);
		AL10.alSource3f(src, AL10.AL_POSITION, (float) x, (float) y, (float) z);
		AL10.alSourcePlay(src);
		// 播放完自行回收（6ms 很短，这里简单起见延迟删除）
		new Thread(() -> {
			try { Thread.sleep(200); } catch (InterruptedException ignored) { }
			AL10.alDeleteSources(src);
		}, "nbmachina-click-gc").start();
	}
}
