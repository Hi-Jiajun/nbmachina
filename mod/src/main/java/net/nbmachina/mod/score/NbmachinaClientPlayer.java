package net.nbmachina.mod.score;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.locks.LockSupport;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;

import net.nbmachina.mod.NbmachinaMod;
import net.nbmachina.mod.audio.NbmachinaAudio;

/**
 * M3-29 · 客户端高精度播放：音符的**发声时刻**由客户端自己的时钟决定，不再受服务器刻率限制。
 *
 * <p>为什么需要：数据包/服务端的派发都只能落在服务器刻上（20 tps = 50ms、`/tick rate 100` = 10ms），
 * 而乐句里的细节（比如尾奏那段 0.1s 一颗的颤音）会被刻率量化。这里客户端自己读
 * `nbmachina/score.csv`（本来就随客户端部署，含精确到毫秒的 `time_seconds`），用一个
 * `System.nanoTime()` 调度线程逐颗发声 —— 分辨率只受线程唤醒抖动限制（实测毫秒级以下）。
 *
 * <p>与既有链路的关系：**不替代**服务端/数据包那条；服务器侧仍然负责机器视觉（灯/粒子）。
 * 想"视觉 + 高精度声音"同时跑，就用 `styx:play/sound_off` 把数据包的发声行关掉，避免双响。
 */
public final class NbmachinaClientPlayer {
	private NbmachinaClientPlayer() {
	}

	private static volatile NbmachinaScore score;
	private static volatile Path loadedFrom;
	private static volatile Thread thread;
	private static volatile boolean playing = false;
	private static volatile double startFromSec = 0.0;
	private static volatile long startNanos = 0L;

	private static final AtomicInteger scheduled = new AtomicInteger();
	private static final AtomicInteger played = new AtomicInteger();
	private static final AtomicInteger skipped = new AtomicInteger();
	private static final AtomicLong jitterCount = new AtomicLong();
	private static final AtomicLong jitterSumUs = new AtomicLong();
	private static volatile double maxJitterMs = 0.0;

	public static boolean isPlaying() {
		return playing;
	}

	public static double elapsed() {
		return playing ? (System.nanoTime() - startNanos) / 1e9 + startFromSec : startFromSec;
	}

	public static int noteCount() {
		NbmachinaScore s = score;
		return s == null ? 0 : s.size();
	}

	public static String sourceName() {
		Path p = loadedFrom;
		return p == null ? "(未载入)" : p.toString();
	}

	public static double maxJitterMs() {
		return maxJitterMs;
	}

	public static double meanJitterMs() {
		long n = jitterCount.get();
		return n == 0 ? 0.0 : jitterSumUs.get() / 1000.0 / n;
	}

	public static int scheduledCount() {
		return scheduled.get();
	}

	public static int playedCount() {
		return played.get();
	}

	public static int skippedCount() {
		return skipped.get();
	}

	/** 载入谱面（客户端游戏目录的 nbmachina/score.csv）；文件不变时复用已载入的。 */
	public static int load(Path file) throws IOException {
		if (!Files.exists(file)) throw new IOException("找不到谱面：" + file);
		if (score != null && file.equals(loadedFrom)) return score.size();
		NbmachinaScore s = NbmachinaScore.load(file);
		score = s;
		loadedFrom = file;
		NbmachinaMod.LOGGER.info("[nbmachina] 客户端谱面已载入：{} 颗音 / {} s ← {}", s.size(),
			String.format("%.1f", s.durationSec()), file);
		return s.size();
	}

	/** 从 fromSec 秒开始播放（默认 0）。返回 false = 没有谱面或引擎没就绪。 */
	public static boolean start(double fromSec) {
		stop();
		NbmachinaScore s = score;
		if (s == null || s.size() == 0) return false;
		startFromSec = Math.max(0.0, fromSec);
		scheduled.set(0);
		played.set(0);
		skipped.set(0);
		jitterCount.set(0);
		jitterSumUs.set(0);
		maxJitterMs = 0.0;
		playing = true;
		startNanos = System.nanoTime();
		List<NbmachinaScore.Note> notes = s.notes();
		Thread t = new Thread(() -> run(notes, startFromSec), "nbmachina-client-play");
		t.setDaemon(true);
		thread = t;
		t.start();
		return true;
	}

	public static void stop() {
		Thread t = thread;
		if (t != null) {
			t.interrupt();
			thread = null;
		}
		playing = false;
	}

	private static void run(List<NbmachinaScore.Note> notes, double fromSec) {
		int i = 0;
		while (i < notes.size() && notes.get(i).timeSec() < fromSec) i++;
		final long t0 = System.nanoTime();
		try {
			for (; i < notes.size(); i++) {
				if (Thread.currentThread().isInterrupted()) break;
				NbmachinaScore.Note n = notes.get(i);
				long target = t0 + (long) ((n.timeSec() - fromSec) * 1e9);
				// 先粗睡到目标前 1ms，再用自旋把最后一段走完（客户端专用线程，1ms 自旋代价可接受）
				while (true) {
					long remain = target - System.nanoTime();
					if (remain <= 0) break;
					if (remain > 1_000_000L) LockSupport.parkNanos(remain - 1_000_000L);
					else Thread.onSpinWait();
				}
				scheduled.incrementAndGet();
				double jitterMs = Math.abs(System.nanoTime() - target) / 1e6;
				jitterCount.incrementAndGet();
				jitterSumUs.addAndGet((long) (jitterMs * 1000));
				if (jitterMs > maxJitterMs) maxJitterMs = jitterMs;
				ClientPlayerEntity p = MinecraftClient.getInstance().player;
				if (p == null) {
					skipped.incrementAndGet();
					continue;
				}
				// 锚点 = 玩家自己（与 listen on 同口径）：站哪儿都能听全曲
				NbmachinaAudio.play(n.instrument(), n.voice(), n.midi(), n.velocity(), n.durMs(),
					p.getX(), p.getEyeY(), p.getZ());
				played.incrementAndGet();
			}
		} finally {
			playing = false;
		}
	}
}
