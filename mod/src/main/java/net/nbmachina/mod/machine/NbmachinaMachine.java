package net.nbmachina.mod.machine;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Blocks;
import net.minecraft.block.RedstoneLampBlock;
import net.minecraft.particle.ParticleTypes;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.math.BlockPos;

import net.nbmachina.mod.NbmachinaMod;
import net.nbmachina.mod.note.NbmachinaNoteBlocks;

/**
 * M3-39 · **由 mod 自己驱动机器**（替数据包逐刻表），一次解决三件事：
 *
 * <ol>
 *   <li><b>速度不受服务器刻率影响</b>：用 {@link System#nanoTime()} 对齐真实时间。
 *       数据包是按"刻"计数的，世界一旦不是 20 tps（例如 `/tick rate 100`）整曲就会快 5 倍；
 *       这里每刻检查"真实时间到了哪些音"，所以 20 tps 世界照样按原速播（刻率只影响精度，
 *       100 tps 更精细、20 tps 是 ±50ms；不会整曲变速）。</li>
 *   <li><b>粒子按真实音高</b>：原版音符盒只有 25 档（note 0..24），粒子颜色也只有 25 种；
 *       这里直接用谱面的真实 MIDI（21..108）算粒子参数（0..1 浮点），不受 25 档限制。</li>
 *   <li><b>触发 / 灯 / 粒子全部由 mod 负责</b>，数据包只要把方块摆好即可；
 *       想回到数据包驱动就 `/nbm machine stop` + `/function styx:play/start`。</li>
 * </ol>
 *
 * 发声方式不变：在音符盒**水平相邻**的空位放红石块 → 音符盒响 → mixin 掐掉原版声音换无损采样。
 * 没有严格触发位的那几颗音（见 docs/M3-38）直接走引擎派发。
 */
public final class NbmachinaMachine {
	/** 一条谱面音（来自 `<游戏目录>/nbmachina/machine_map.csv`） */
	public record Note(int x, int y, int z, String instrument, String voice, int midi, int velocity, int durMs,
					double timeSec, int tx, int ty, int tz, boolean strict) {
	}

	private static final List<Note> NOTES = new ArrayList<>();
	private static boolean running = false;
	private static long anchorNanos = 0L;
	private static double startSec = 0.0;
	private static int cursor = 0;
	private static int firedCount = 0;
	private static int tickCount = 0;
	private static String lastError = null;
	/** 这一刻放下的红石块，下一刻拆掉 */
	private static final List<BlockPos> PENDING_TRIGGERS = new ArrayList<>();
	/** 这一刻点亮的灯，下一刻熄灭 */
	private static final List<BlockPos> PENDING_LAMPS = new ArrayList<>();
	/**
	 * M3-41：机器长 2400 格，**只有已加载的区块才能放红石块**（`ServerWorld.setBlockState` 对未加载区块
	 * 会静默失败）。玩家一走远、或曲子的后段超出加载范围，触发就没了 → 用户听到"播到某个时间就没声音"。
	 * 这里跟着播放进度**滚动强加载**：始终保持"当前音 + 未来 40 秒"这段区块是强加载的，走过就释放。
	 */
	private static final java.util.Set<Long> FORCED = new java.util.HashSet<>();
	private static final int FORCELOAD_AHEAD_SEC = 40;

	private NbmachinaMachine() {
	}

	/** 从 machine_map.csv 读谱面（新表头：x,y,z,instrument,voice,midi,velocity,dur_ms,time_sec,tx,ty,tz） */
	public static synchronized int load(Path file) throws IOException {
		List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
		NOTES.clear();
		lastError = null;
		for (int i = 1; i < lines.size(); i++) {
			String line = lines.get(i).trim();
			if (line.isEmpty()) continue;
			String[] c = line.split(",");
			if (c.length < 12) continue;
			try {
				int x = Integer.parseInt(c[0].trim()), y = Integer.parseInt(c[1].trim()), z = Integer.parseInt(c[2].trim());
				int midi = Integer.parseInt(c[5].trim()), vel = Integer.parseInt(c[6].trim());
				int dur = c[7].isBlank() ? 0 : Math.round(Float.parseFloat(c[7].trim()));
				double t = Double.parseDouble(c[8].trim());
				int tx = Integer.parseInt(c[9].trim()), ty = Integer.parseInt(c[10].trim()), tz = Integer.parseInt(c[11].trim());
				// 触发位写成"音符盒上方"（y+2）表示这颗音没有严格水平触发位 → 走引擎兜底
				boolean strict = ty == y + 1;
				NOTES.add(new Note(x, y, z, c[3].trim(), c[4].trim(), midi, vel, dur, t, tx, ty, tz, strict));
			} catch (RuntimeException ignored) {
				// 坏行跳过
			}
		}
		NOTES.sort((a, b) -> Double.compare(a.timeSec, b.timeSec));
		return NOTES.size();
	}

	public static int size() {
		return NOTES.size();
	}

	public static boolean running() {
		return running;
	}

	public static String lastError() {
		return lastError;
	}

	public static int fired() {
		return firedCount;
	}

	public static int ticks() {
		return tickCount;
	}

	public static double elapsedSec() {
		return running ? startSec + (System.nanoTime() - anchorNanos) / 1e9 : 0.0;
	}

	public static synchronized String start(ServerWorld world, double fromSec) {
		if (NOTES.isEmpty()) return "没有谱面：先 /nbm reloadmap（或确认 nbmachina/machine_map.csv 存在）";
		cursor = 0;
		firedCount = 0;
		tickCount = 0;
		releaseForceload(world);
		PENDING_TRIGGERS.clear();
		PENDING_LAMPS.clear();
		while (cursor < NOTES.size() && NOTES.get(cursor).timeSec() < fromSec) cursor++;
		startSec = fromSec;
		anchorNanos = System.nanoTime();
		running = true;
		maintainForceload(world);
		NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动开始：从 {}s 起（谱面 {} 颗音，第 {} 颗）", fromSec, NOTES.size(), cursor);
		return null;
	}

	public static synchronized void stop(ServerWorld world) {
		if (!running) return;
		running = false;
		for (BlockPos p : PENDING_TRIGGERS) world.setBlockState(p, Blocks.AIR.getDefaultState(), 3);
		PENDING_TRIGGERS.clear();
		for (BlockPos p : PENDING_LAMPS) {
			world.setBlockState(p, Blocks.REDSTONE_LAMP.getDefaultState().with(RedstoneLampBlock.LIT, Boolean.FALSE), 2);
		}
		PENDING_LAMPS.clear();
		releaseForceload(world);
		NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动停止：已触发 {} 颗 / 走过 {} 刻 / 用时 {}s", firedCount, tickCount, String.format("%.1f", elapsedSec()));
	}

	/** 每服务器刻调用一次（ServerTickEvents.END_SERVER_TICK） */
	public static synchronized void tick(MinecraftServer server) {
		if (!running) return;
		tickCount++;
		ServerWorld world = server.getOverworld();
		if (tickCount % 10 == 0) maintainForceload(world);
		// ① 拆掉上一刻的触发位、熄灭上一刻的灯
		for (BlockPos p : PENDING_TRIGGERS) world.setBlockState(p, Blocks.AIR.getDefaultState(), 3);
		PENDING_TRIGGERS.clear();
		for (BlockPos p : PENDING_LAMPS) {
			world.setBlockState(p, Blocks.REDSTONE_LAMP.getDefaultState().with(RedstoneLampBlock.LIT, Boolean.FALSE), 2);
		}
		PENDING_LAMPS.clear();

		// ② 真实时间到了哪些音就触发哪些（提前一刻，方块事件下一 tick 才执行）
		final double now = elapsedSec();
		final double tickSec = server.getTickManager().getNanosPerTick() / 1e9;
		int firedThisTick = 0;
		while (cursor < NOTES.size()) {
			Note n = NOTES.get(cursor);
			if (n.timeSec() > now + tickSec) break;
			final BlockPos notePos = new BlockPos(n.x(), n.y() + 1, n.z());
			if (n.strict()) {
				BlockPos trig = new BlockPos(n.tx(), n.ty(), n.tz());
				world.setBlockState(trig, Blocks.REDSTONE_BLOCK.getDefaultState(), 3);
				PENDING_TRIGGERS.add(trig);
			} else {
				// 没有严格水平触发位 → 直接走引擎（力度/时值/音高都来自谱面）
				NbmachinaNoteBlocks.playAt(world, notePos,
					new NbmachinaNoteBlocks.Mapped(n.instrument(), n.voice(), n.midi(), n.velocity(), n.durMs()));
			}
			// 粒子：真实音高 → 0..1（钢琴 A0=21 .. C8=108）
			float pitch01 = (float) Math.max(0.0, Math.min(1.0, (n.midi() - 21) / 87.0));
			world.spawnParticles(ParticleTypes.NOTE, n.x() + 0.5, n.y() + 1.2, n.z() + 0.5,
				1, pitch01, 0.0, 0.0, 1.0);
			BlockPos lamp = new BlockPos(n.x(), n.y() - 1, n.z());
			world.setBlockState(lamp, Blocks.REDSTONE_LAMP.getDefaultState().with(RedstoneLampBlock.LIT, Boolean.TRUE), 2);
			PENDING_LAMPS.add(lamp);
			cursor++;
			firedCount++;
			firedThisTick++;
		}
		if (firedThisTick > 0 && firedCount % 200 < firedThisTick) {
			NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动：已触发 {} 颗（谱面时间 {}s，刻率 {}）",
				firedCount, String.format("%.2f", now), server.getTickManager().getTickRate());
		}
		if (cursor >= NOTES.size() && PENDING_TRIGGERS.isEmpty() && PENDING_LAMPS.isEmpty()) {
			NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动：全曲结束（{} 颗 / {} 刻）", firedCount, tickCount);
			running = false;
			releaseForceload(world);
		}
	}

	/** 滚动强加载：当前音 .. 未来 {@link #FORCELOAD_AHEAD_SEC} 秒涉及的区块（z 取机器那条带的 6 个 chunk） */
	private static void maintainForceload(ServerWorld world) {
		if (NOTES.isEmpty()) return;
		int i = Math.min(cursor, NOTES.size() - 1);
		double until = NOTES.get(i).timeSec() + FORCELOAD_AHEAD_SEC;
		int x0 = NOTES.get(i).x(), x1 = x0;
		for (int k = i; k < NOTES.size() && NOTES.get(k).timeSec() <= until; k++) {
			x0 = Math.min(x0, NOTES.get(k).x());
			x1 = Math.max(x1, NOTES.get(k).x());
		}
		int cx0 = (x0 >> 4) - 2, cx1 = (x1 >> 4) + 2;
		int cz0 = (-200 >> 4) - 1, cz1 = (-110 >> 4) + 1;
		for (int cx = cx0; cx <= cx1; cx++) {
			for (int cz = cz0; cz <= cz1; cz++) {
				long key = ((long) cx << 32) | (cz & 0xFFFFFFFFL);
				FORCED.add(key);
				// 每次都重申一次：数据包的 `/forceload remove all` 会把强加载全部撤掉（包括这里的），
				// 只靠"新加入时才设置"会在那种情况下静默失效。
				world.setChunkForced(cx, cz, true);
			}
		}
		java.util.Iterator<Long> it = FORCED.iterator();
		while (it.hasNext()) {
			long key = it.next();
			int cx = (int) (key >> 32);
			if (cx < cx0 - 6) {
				world.setChunkForced(cx, (int) key, false);
				it.remove();
			}
		}
	}

	private static void releaseForceload(ServerWorld world) {
		for (long key : FORCED) world.setChunkForced((int) (key >> 32), (int) key, false);
		FORCED.clear();
	}
}
