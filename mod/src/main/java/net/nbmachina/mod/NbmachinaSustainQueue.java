package net.nbmachina.mod;

import java.util.ArrayList;
import java.util.List;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.sound.SoundCategory;
import net.minecraft.sound.SoundEvent;
import net.minecraft.util.math.Vec3d;

/**
 * 每音「独立力度 + 独立延音」的调度器。
 *
 * <p>原版 {@code /playsound} 只能一次性触发一个采样（音量/音高写死在命令里，且无法续音）。
 * 这里把每个音符做成一个 tick 级作业：按 interval 重触发采样，音量沿包络衰减，
 * 于是同一 tick 可以并行跑多条不同力度、不同长度的延音，互相不干扰。
 *
 * <p>已知限制（如实记录）：现有采样是 ~0.3s 的一次性 ogg，没有 loop 点，
 * 长延音靠重触发堆叠，不是真正的循环采样。
 */
public final class NbmachinaSustainQueue {
	private static final List<Job> JOBS = new ArrayList<>();

	private static int totalPlays;
	private static int peakActiveJobs;

	private NbmachinaSustainQueue() {
	}

	public static void register() {
		ServerTickEvents.END_SERVER_TICK.register(NbmachinaSustainQueue::onEndTick);
	}

	public static void enqueue(ServerWorld world, Vec3d pos, SoundEvent sound,
							   float volume, float pitch, int totalTicks, int intervalTicks) {
		JOBS.add(new Job(world, pos, sound, volume, pitch, totalTicks, intervalTicks));
		peakActiveJobs = Math.max(peakActiveJobs, JOBS.size());
	}

	/** 单次播放（不走命令解析），返回 false 表示世界为空。 */
	public static boolean playAt(ServerWorld world, Vec3d pos, SoundEvent sound, float volume, float pitch) {
		if (world == null || sound == null) {
			return false;
		}
		world.playSound(null, pos.x, pos.y, pos.z, sound, SoundCategory.RECORDS, volume, pitch);
		totalPlays++;
		return true;
	}

	public static int stopAll() {
		int dropped = JOBS.size();
		JOBS.clear();
		return dropped;
	}

	public static int activeJobs() {
		return JOBS.size();
	}

	public static int totalPlays() {
		return totalPlays;
	}

	public static int peakActiveJobs() {
		return peakActiveJobs;
	}

	private static void onEndTick(MinecraftServer server) {
		if (JOBS.isEmpty()) {
			return;
		}
		for (int i = JOBS.size() - 1; i >= 0; i--) {
			if (!JOBS.get(i).tick()) {
				JOBS.remove(i);
			}
		}
	}

	private static final class Job {
		private final ServerWorld world;
		private final Vec3d pos;
		private final SoundEvent sound;
		private final float baseVolume;
		private final float pitch;
		private final int totalTicks;
		private final int intervalTicks;
		private int elapsed;

		private Job(ServerWorld world, Vec3d pos, SoundEvent sound,
					float baseVolume, float pitch, int totalTicks, int intervalTicks) {
			this.world = world;
			this.pos = pos;
			this.sound = sound;
			this.baseVolume = baseVolume;
			this.pitch = pitch;
			this.totalTicks = totalTicks;
			this.intervalTicks = intervalTicks;
		}

		/** @return false 表示作业结束 */
		private boolean tick() {
			elapsed++;
			if (elapsed > totalTicks) {
				return false;
			}
			if (elapsed % intervalTicks != 0) {
				return true;
			}
			float progress = Math.min(1.0F, (float) elapsed / (float) totalTicks);
			float envelope = 1.0F - 0.6F * progress;
			playAt(world, pos, sound, baseVolume * envelope, pitch);
			return true;
		}
	}
}
