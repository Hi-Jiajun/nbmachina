package net.nbmachina.mod.machine;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.BlockState;
import net.minecraft.block.Blocks;
import net.minecraft.block.NoteBlock;
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
 * 发声方式（M3-71 起）：**直接把音符盒的"同步方块事件"排进队列**（原版 `NoteBlock` 被红石激活时走的就是
 * 这一句 `world.addSyncedBlockEvent(pos, this, 0, note)`）→ 音符盒本体照常"响" → mixin 掐掉原版声音换无损采样。
 *
 * <p>为什么不再放红石块（2026-09-22 用户："红石块的渲染可不可以隐藏掉；感觉突然冒出来丑丑的"）：
 * 红石块要提前 {@link #leadTicks} 刻出现、下一刻拆掉，客户端就会看到方块凭空闪一下；改成直接排队后
 * **世界里没有任何方块被改动**，视觉上干干净净，也顺带消掉了"红石块残留/存档落盘时被写进世界"这一类风险。
 * 音符盒本体不在（没铺/被挖）的那几颗音才退回引擎直接派发。
 */
public final class NbmachinaMachine {
	/** 一条谱面音（来自 `<游戏目录>/nbmachina/machine_map.csv`） */
	public record Note(int x, int y, int z, String instrument, String voice, int midi, int velocity, int durMs,
					double timeSec, int tx, int ty, int tz, boolean strict) {
	}

	private static final List<Note> NOTES = new ArrayList<>();
	/** 音符盒方块坐标（packed）→ 这颗音在谱面里的时间：给"音符盒发声 + 客户端精确时刻"用 */
	private static final java.util.Map<Long, Double> TIME_BY_POS = new java.util.HashMap<>();
	private static boolean running = false;
	private static long anchorNanos = 0L;
	private static double startSec = 0.0;
	/** 全局时间偏移（毫秒，正数 = 整曲提前触发）：用来把游戏内与母版对齐（由 compare-ingame-vs-master 量出来） */
	private static double offsetMs = 0.0;
	/** 速率系数（1.0 = 原速）：把整曲时间轴按这个系数缩放，用来压平"游戏内 vs 母版"的微小漂移 */
	private static double rate = 1.0;
	/** 触发提前量（服务器刻）：默认 3。运行时可用 `/nbm machine lead <0..6>` 改，用于现场 A/B。
	 *  提前量越大 → 载荷越早到客户端 → 客户端越能"等到准确时刻"再发声（代价是红石块更早出现）。 */
	// M3-65（用户 2026-09-19）：默认改为 **0 刻**。实测同一配置两次测出的 p90 差 2.3 倍
	// （lead 6：24.6ms vs 57.2ms）→ 剩余抖动由服务器负载/采集链路主导，提前量在 0~12 之间已不构成
	// 可辨差异；用户明确"用固定 0 刻"。运行时仍可用 `/nbm machine lead <0..20>` 临时提高。
	// M3-67（用户 2026-09-20）：默认 0 → **8 刻**。两轮 A/B 里 8 刻的单次表现最好（p90 1.7ms），
	// 而 6 刻两次测出 24.6ms / 57.2ms（噪声主导）；用户判断"0 还是不太好"，取更大的安全余量。
	private static volatile int leadTicks = 8;

	public static int leadTicks() {
		return leadTicks;
	}

	public static void setLeadTicks(int v) {
		leadTicks = Math.max(0, Math.min(20, v));   // M3-64：上限 6 → 20（用户要试更大提前量）
	}
	private static int cursor = 0;
	private static int firedCount = 0;
	private static int tickCount = 0;
	private static String lastError = null;
	/** 待放的粒子：触发位提前放（提前量），但视觉必须等这颗音真正到点 */
	private record PendingVisual(int x, int y, int z, int midi, double dueSec) {
	}
	/** M3-71：收尾用——最后一颗音排进"方块事件队列"后要多跑一刻，等事件被处理完再撤强加载 */
	private static int endTicks = 0;
	private static final List<PendingVisual> pendingVisual = new ArrayList<>();
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
				// M3-70（用户 2026-09-22："让 mod 的红石块放置在音符盒下方激活"）：
				// 触发位现在记的是**音符盒正下方**那一格（音符盒本体在 y+1）；旧的"水平相邻"（ty == y+1）也认。
				// 判据直接用几何：红石块与音符盒"相邻"（曼哈顿距离 1）才算真触发位；
				// 没有触发位的音会被写成 y+2（距离 2）→ 走引擎兜底（见 tick）。
				boolean strict = Math.abs(tx - x) + Math.abs(ty - (y + 1)) + Math.abs(tz - z) == 1;
				NOTES.add(new Note(x, y, z, c[3].trim(), c[4].trim(), midi, vel, dur, t, tx, ty, tz, strict));
				TIME_BY_POS.put(net.minecraft.util.math.BlockPos.asLong(x, y + 1, z), t);
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

	/** 某个音符盒（方块坐标 packed）对应的谱面时间；没有就返回 0（= 立即播） */
	public static double scoreTimeAt(long packedPos) {
		Double v = TIME_BY_POS.get(packedPos);
		return v == null ? 0.0 : v;
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
		return running ? songTimeSec() : 0.0;
	}

	/** 自启动以来的真实秒数（不含速率/偏移） */
	private static double realElapsedSec() {
		return (System.nanoTime() - anchorNanos) / 1e9;
	}

	/** 当前"谱面时间"秒 = 起始秒 + 真实经过 × 速率 + 偏移 */
	private static double songTimeSec() {
		return startSec + realElapsedSec() * rate + offsetMs / 1000.0;
	}

	public static synchronized String start(ServerWorld world, double fromSec) {
		return start(world, fromSec, 0.0);
	}

	public static synchronized String start(ServerWorld world, double fromSec, double leadMs) {
		return start(world, fromSec, leadMs, 1.0);
	}

	public static synchronized String start(ServerWorld world, double fromSec, double leadMs, double rateScale) {
		if (NOTES.isEmpty()) return "没有谱面：先 /nbm reloadmap（或确认 nbmachina/machine_map.csv 存在）";
		offsetMs = leadMs;
		rate = rateScale > 0.5 && rateScale < 2.0 ? rateScale : 1.0;
		cursor = 0;
		firedCount = 0;
		tickCount = 0;
		endTicks = 0;
		releaseForceload(world);
		while (cursor < NOTES.size() && NOTES.get(cursor).timeSec() < fromSec) cursor++;
		startSec = fromSec;
		anchorNanos = System.nanoTime();
		running = true;
		maintainForceload(world);
		silenceDataPack(world);
		// M3-51：广播"从这一秒开始"给所有客户端 —— 静音模式下由客户端 nanoTime 调度出声（1ms 级）
		try {
			for (var player : world.getServer().getPlayerManager().getPlayerList()) {
				net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking.send(player,
					new net.nbmachina.mod.net.NbmachinaMachineSyncPayload(fromSec));
			}
		} catch (Exception e) {
			NbmachinaMod.LOGGER.warn("[nbmachina] 同步包发送失败（不影响机器）：{}", e.toString());
		}
		// M3-72：日志里同时印**整曲偏移**与**触发提前量**——两者不是一个东西，只印偏移会让用户以为 lead 没生效
		NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动开始：从 {}s 起，整曲偏移 {}ms，速率 {}，触发提前量 {} 刻={}ms（谱面 {} 颗音，第 {} 颗）",
			fromSec, leadMs, rate, leadTicks, leadTicks * 50, NOTES.size(), cursor);
		return null;
	}

	public static synchronized void stop(ServerWorld world) {
		if (!running) return;
		running = false;
		releaseForceload(world);
		NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动停止：已触发 {} 颗 / 走过 {} 刻 / 用时 {}s", firedCount, tickCount, String.format("%.1f", elapsedSec()));
	}

	/** 每服务器刻调用一次（ServerTickEvents.END_SERVER_TICK） */
	public static synchronized void tick(MinecraftServer server) {
		if (!running) return;
		tickCount++;
		ServerWorld world = server.getOverworld();
		if (tickCount % 10 == 0) maintainForceload(world);
		// ① 真实时间到了哪些音就触发哪些（方块事件下一 tick 开头才被处理，所以留 leadTicks 的提前量）
		final double now = songTimeSec();
		final double tickSec = server.getTickManager().getNanosPerTick() / 1e9;
		// 到点的视觉：点灯 + 出粒子（真实音高上色），下一刻熄灭
		for (var it = pendingVisual.iterator(); it.hasNext(); ) {
			PendingVisual v = it.next();
			if (v.dueSec() > now) continue;
			float pitch01 = (float) Math.max(0.0, Math.min(1.0, (v.midi() - 21) / 87.0));
			world.spawnParticles(ParticleTypes.NOTE, v.x() + 0.5, v.y() + 1.2, v.z() + 0.5,
				1, pitch01, 0.0, 0.0, 1.0);
			// M3-70：机器已经**没有红石灯那一层**了（用户："取消音符盒下面的红石灯"），
			// 所以这里只出粒子——旧代码往 y-1 塞红石灯，会在这台新机器下面凭空刷出一排灯。
			it.remove();
		}
		int firedThisTick = 0;
		while (cursor < NOTES.size()) {
			Note n = NOTES.get(cursor);
			// now 已经是"谱面时间"（含速率与偏移）。
			// M3-54：提前量从 1 刻改成 **2 刻**——音符盒的方块事件是**下一 tick 开头**才处理的，
			// 1 刻提前量会让载荷在目标时刻之后才到客户端（实测 p90 49ms 全落在"迟到"一侧）；
			// 提前 2 刻后载荷约在目标前 ~50ms 到达，客户端就能用 nanoTime 等到准确时刻再发声。
			if (n.timeSec() > now + leadTicks * tickSec) break;
			final BlockPos notePos = new BlockPos(n.x(), n.y() + 1, n.z());
			final BlockState noteState = world.getBlockState(notePos);
			if (noteState.isOf(Blocks.NOTE_BLOCK)) {
				// M3-71：**不放红石块**，直接把音符盒的同步方块事件排进队列 —— 与"被红石激活"完全同一条原版路径
				// （`NoteBlock.neighborUpdate` 内部就是这么写的），客户端那格永远保持空气，没有任何可见方块。
				world.addSyncedBlockEvent(notePos, Blocks.NOTE_BLOCK, 0, noteState.get(NoteBlock.NOTE));
			} else {
				// 音符盒本体不在（还没铺 / 被挖掉）→ 退回引擎直接派发（力度/时值/音高都来自谱面）
				NbmachinaNoteBlocks.playAt(world, notePos,
					new NbmachinaNoteBlocks.Mapped(n.instrument(), n.voice(), n.midi(), n.velocity(), n.durMs()));
			}
			// M3-72：前 8 颗把"实际提前了多少毫秒发出"打出来 —— 用户要能**当场验证触发提前量生效**
			// （它不影响听感，只影响载荷早到多少；打印的这个数应≈提前量×50ms）
			if (firedCount + 1 <= 8) {
				NbmachinaMod.LOGGER.info(String.format(
					"[nbmachina] 派发 #%d pos=%s 谱面 %.3fs / 现在 %.3fs → 提前 %.0fms（触发提前量 %d 刻）",
					firedCount + 1, notePos.toShortString(), n.timeSec(), now,
					(n.timeSec() - now) * 1000.0, leadTicks));
			}
			// 粒子：真实音高 → 0..1（钢琴 A0=21 .. C8=108）
			// 但**视觉要延到该音真正到点**才做（提前 3 刻只是为了让载荷先到客户端；
			// 灯/粒子提前亮会看得出发光在声音之前）→ 排进 pendingVisual，到点再放。
			final Note fn = n;
			pendingVisual.add(new PendingVisual(fn.x(), fn.y(), fn.z(), fn.midi(), fn.timeSec() - offsetMs / 1000.0));
			cursor++;
			firedCount++;
			firedThisTick++;
		}
		if (firedThisTick > 0 && firedCount % 200 < firedThisTick) {
			NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动：已触发 {} 颗（谱面时间 {}s，刻率 {}）",
				firedCount, String.format("%.2f", now), server.getTickManager().getTickRate());
		}
		if (cursor >= NOTES.size()) {
			// 最后一颗音刚排进方块事件队列 → 再跑一刻，等它被处理（否则撤强加载可能让那颗音丢失）
			if (endTicks++ == 0) return;
			NbmachinaMod.LOGGER.info("[nbmachina] 机器驱动：全曲结束（{} 颗 / {} 刻）", firedCount, tickCount);
			running = false;
			releaseForceload(world);
		}
	}

	/** 滚动强加载：当前音 .. 未来 {@link #FORCELOAD_AHEAD_SEC} 秒涉及的区块（z 取机器那条带的 6 个 chunk） */
	/**
	 * M3-43：由 mod 驱动时，**把数据包那套播放关掉**。
	 *
	 * <p>2026-09-19 真机实测：录像期间客户端收到 **4600 条**音符（谱面只有 3044 条）——
	 * 因为 `styx:redo` 结尾会自动起播，用户又跑了 `/nbm machine start`，两条链路同时在触发：
	 * 同一颗音被红石块触发两次 + 数据包再派发一次 → 声音重叠、总电平冲顶（录像里 262 个样本削到 0.995+），
	 * 听感就是"奇怪的杂音"。这里把 `#on`（数据包播放）、`#nb`（它的红石块触发）、`#snd`（它的派发）全置 0，
	 * 机器完全交给 mod 驱动；想回到数据包驱动就 `/nbm machine stop` + `/function styx:play/start`。
	 */
	private static void silenceDataPack(ServerWorld world) {
		try {
			var server = world.getServer();
			var src = server.getCommandSource().withSilent().withMaxLevel(4);
			var cm = server.getCommandManager();
			cm.parseAndExecute(src, "scoreboard objectives add styx.flag dummy");
			cm.parseAndExecute(src, "scoreboard players set #on styx.flag 0");
			cm.parseAndExecute(src, "scoreboard players set #nb styx.flag 0");
			cm.parseAndExecute(src, "scoreboard players set #snd styx.flag 0");
		} catch (Exception e) {
			NbmachinaMod.LOGGER.warn("[nbmachina] 关闭数据包播放失败（不影响 mod 驱动）：{}", e.toString());
		}
	}

	private static void maintainForceload(ServerWorld world) {
		if (NOTES.isEmpty()) return;
		int i = Math.min(cursor, NOTES.size() - 1);
		double until = NOTES.get(i).timeSec() + FORCELOAD_AHEAD_SEC;
		int x0 = NOTES.get(i).x(), x1 = x0;
		// M3-70：z 带**从谱面推**。旧代码把 z 写死成 −200..−110（机器在 z −172..−141 时的坐标），
		// 换到新的 z 55..82 之后强加载的是一整条**空带**，机器本体全程没被强加载 → 红石块放不下去 → 没声音。
		int z0 = NOTES.get(i).z(), z1 = z0;
		for (int k = i; k < NOTES.size() && NOTES.get(k).timeSec() <= until; k++) {
			x0 = Math.min(x0, NOTES.get(k).x());
			x1 = Math.max(x1, NOTES.get(k).x());
			z0 = Math.min(z0, NOTES.get(k).z());
			z1 = Math.max(z1, NOTES.get(k).z());
		}
		int cx0 = (x0 >> 4) - 2, cx1 = (x1 >> 4) + 2;
		int cz0 = (z0 >> 4) - 1, cz1 = (z1 >> 4) + 1;
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
