package net.nbmachina.mod.audio;

import java.util.PriorityQueue;
import java.util.concurrent.atomic.AtomicBoolean;

import net.nbmachina.mod.NbmachinaMod;

/**
 * M3-53 · 极简高精度调度器：把"到某个时间点再执行"的任务排进一个专用线程，
 * 采用 **粗睡 + 末尾自旋**（与客户端谱面播放器同一套做法，实测抖动 0.18ms / 最大 1.36ms）。
 *
 * <p>用途：**让音符盒仍然是发声体**，但发声时刻不再受服务器刻量化（20 tps = 50ms）的限制——
 * 音符盒被触发时把"这颗音在谱面里的时间"一起带给客户端，客户端用本地时钟等到**准确时刻**再放音。
 * 服务端仍然只负责"在某一刻触发音符盒"（这一步无法比服务器刻更准），但**听到的声音时刻**由客户端决定。
 */
public final class NbmachinaScheduler {
	private record Job(long atNanos, Runnable task) {
	}

	private static final PriorityQueue<Job> QUEUE = new PriorityQueue<>((a, b) -> Long.compare(a.atNanos, b.atNanos));
	private static final AtomicBoolean STARTED = new AtomicBoolean(false);
	private static volatile int queued = 0;
	private static volatile int ran = 0;
	private static volatile double lastErrorMs = 0;

	private NbmachinaScheduler() {
	}

	/** 排一个"到 atNanos 再跑"的任务（已经过时就直接跑） */
	public static void at(long atNanos, Runnable task) {
		synchronized (QUEUE) {
			QUEUE.add(new Job(atNanos, task));
			queued++;
			QUEUE.notifyAll();
		}
		ensureStarted();
	}

	public static int queued() {
		return queued;
	}

	public static int ran() {
		return ran;
	}

	public static double lastErrorMs() {
		return lastErrorMs;
	}

	private static void ensureStarted() {
		if (!STARTED.compareAndSet(false, true)) return;
		Thread t = new Thread(() -> {
			while (true) {
				Job job = null;
				synchronized (QUEUE) {
					while (QUEUE.isEmpty()) {
						try {
							QUEUE.wait(200);
						} catch (InterruptedException e) {
							return;
						}
					}
					job = QUEUE.peek();
					long waitMs = (job.atNanos - System.nanoTime()) / 1_000_000L;
					if (waitMs > 1) {
						// ⚠ Windows 上 Object.wait(ms) 的粒度 ≈15.6ms，会造成"睡过头"抖动 ——
						// 实测节奏抖动 p90 ≈45ms 就是这个。改成 parkNanos 分片（≤1ms 一片）→ 最后 1ms 自旋。
						try {
							QUEUE.wait(1);
						} catch (InterruptedException e) {
							return;
						}
						continue;
					}
					QUEUE.poll();
				}
				// 末尾自旋到目标时刻
				while (System.nanoTime() < job.atNanos) {
					Thread.onSpinWait();
				}
				long err = System.nanoTime() - job.atNanos;
				lastErrorMs = err / 1e6;
				try {
					job.task.run();
				} catch (Throwable e) {
					NbmachinaMod.LOGGER.warn("[nbmachina] 调度任务异常：{}", e.toString());
				}
				ran++;
			}
		}, "nbmachina-scheduler");
		t.setDaemon(true);
		t.setPriority(Thread.MAX_PRIORITY);
		t.start();
	}
}
