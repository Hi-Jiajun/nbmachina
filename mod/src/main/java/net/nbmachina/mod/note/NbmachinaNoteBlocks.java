package net.nbmachina.mod.note;

import java.util.Map;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import net.minecraft.block.BlockState;
import net.minecraft.block.NoteBlock;
import net.minecraft.block.enums.NoteBlockInstrument;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

import net.nbmachina.mod.NbmachinaMod;
import net.nbmachina.mod.net.NbmachinaPlayPayload;

/**
 * M3-21 · 机器与引擎合一：**音符盒被红石触发的那一刻，声音由我们的无损引擎发出**。
 *
 * <p>入口是 {@code NoteBlockMixin}（注入 {@code NoteBlock.onSyncedBlockEvent}）。
 * 这一层做三件事：
 * <ol>
 *   <li>统计/日志（先证明注入真的生效，再看要不要接管）；</li>
 *   <li>把方块状态（乐器 + note）翻译成我们的（乐器 id + midi + 力度）；</li>
 *   <li>给附近玩家发 {@code nbmachina:play}，并**让原版音符盒声音不发声**
 *       ——粒子仍由方块本体生成（我们只掐声音）。</li>
 * </ol>
 */
public final class NbmachinaNoteBlocks {
	/** 接管开关（命令可切）；默认开 */
	private static volatile boolean enabled = true;
	private static final AtomicInteger eventCount = new AtomicInteger();
	private static final AtomicInteger dispatched = new AtomicInteger();
	private static final AtomicInteger skipped = new AtomicInteger();
	/** 位置 → 该处方块的"力度"（如果谱面提供过）——先留空，后续由谱面导出填充 */
	private static final Map<Long, Integer> VELOCITY_BY_POS = new ConcurrentHashMap<>();

	/**
	 * 谱面音符：位置 → 用哪个乐器 / 哪个声部 / 多高 / 多重 / 响多久
	 * （由 tools/export-mod-machine-map.mjs 生成；`durMs` 来自 M3-22 的参考演奏校准）
	 */
	public record Mapped(String instrument, String voice, int midi, int velocity, int durMs) {
	}

	private static final Map<Long, Mapped> BY_POS = new ConcurrentHashMap<>();
	/**
	 * 监听模式：声音锚在玩家自己身上（整条机器都能听到），而不是方块位置。
	 *
	 * <p>M3-23 默认改成 **on**：机器横跨 480..2880 格，按物理位置只有 64 格内的音发得出去——
	 * 2026-09-18 用户实测就是被这一点坑了（起服后默认 off，听起来只剩零星碎片）。
	 * 拍视频要"方位感"时可以手动 `/nbmachina listen off`。
	 */
	private static volatile boolean listenMode = true;

	private NbmachinaNoteBlocks() {
	}

	public static boolean enabled() {
		return enabled;
	}

	public static void setEnabled(boolean value) {
		enabled = value;
	}

	public static int eventCount() {
		return eventCount.get();
	}

	public static int dispatched() {
		return dispatched.get();
	}

	public static int skipped() {
		return skipped.get();
	}

	public static int mapSize() {
		return BY_POS.size();
	}

	public static boolean listenMode() {
		return listenMode;
	}

	public static void setListenMode(boolean value) {
		listenMode = value;
	}

	/** 按位置查谱面音符（数据包 `/nbmachina playat` 与 mixin 共用） */
	public static Mapped mappedAt(BlockPos pos) {
		return BY_POS.get(pos.asLong());
	}

	/** 把"这个位置该发的那颗音"发给附近玩家；返回发送人数 */
	public static int playAt(ServerWorld world, BlockPos pos, Mapped mapped) {
		double x = pos.getX() + 0.5, y = pos.getY() + 0.5, z = pos.getZ() + 0.5;
		int sent = 0;
		for (ServerPlayerEntity player : world.getServer().getPlayerManager().getPlayerList()) {
			if (player.getEntityWorld() != world) continue;
			// 物理位置模式：只发给听得到的玩家（64 格内）
			if (!listenMode && player.squaredDistanceTo(x, y, z) > 64 * 64) continue;
			double px = listenMode ? player.getX() : x;
			double py = listenMode ? player.getY() : y;
			double pz = listenMode ? player.getZ() : z;
			net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking.send(player,
				new NbmachinaPlayPayload(mapped.instrument(), mapped.voice(), mapped.midi(), mapped.velocity(),
					mapped.durMs(), px, py, pz));
			sent++;
		}
		dispatched.incrementAndGet();
		if (dispatched.get() <= 5 || dispatched.get() % 200 == 0) {
			NbmachinaMod.LOGGER.info("[nbmachina] playat {} → {} midi={} vel={}（第 {} 次，发给 {} 人）",
				pos.toShortString(), mapped.instrument(), mapped.midi(), mapped.velocity(), dispatched.get(), sent);
		}
		return sent;
	}

	/**
	 * 读入 `机器位置 → 谱面音符` 映射（`<游戏目录>/nbmachina/machine_map.csv`）。
	 * 表头：`x,y,z,instrument,voice,midi,velocity[,dur_ms]`（第 8 列 M3-22 新增，缺了也能跑）。
	 */
	public static int loadMap(Path file) throws IOException {
		List<String> lines = Files.readAllLines(file, StandardCharsets.UTF_8);
		if (lines.isEmpty()) throw new IOException("空文件：" + file);
		BY_POS.clear();
		for (int i = 1; i < lines.size(); i++) {
			String line = lines.get(i).trim();
			if (line.isEmpty()) continue;
			String[] c = line.split(",");
			if (c.length < 7) continue;
			try {
				int x = Integer.parseInt(c[0].trim());
				int y = Integer.parseInt(c[1].trim());
				int z = Integer.parseInt(c[2].trim());
				int durMs = 0;
				if (c.length >= 8) {
					String d = c[7].trim();
					if (!d.isEmpty()) durMs = Math.round(Float.parseFloat(d));
				}
				BY_POS.put(BlockPos.asLong(x, y, z),
					new Mapped(c[3].trim(), c[4].trim(), Integer.parseInt(c[5].trim()),
						Integer.parseInt(c[6].trim()), Math.max(0, durMs)));
			} catch (RuntimeException ignored) {
				// 坏行跳过
			}
		}
		return BY_POS.size();
	}

	/** 注入点调用：返回 true 表示"我们自己发声了，原版声音不要放" */
	public static boolean onNoteBlockEvent(World world, BlockPos pos, BlockState state) {
		eventCount.incrementAndGet();
		if (!enabled || !(world instanceof ServerWorld serverWorld)) {
			return false;
		}
		NoteBlockInstrument instrument = state.get(NoteBlock.INSTRUMENT);
		int note = state.get(NoteBlock.NOTE);
		// ① 优先用"机器位置 → 谱面音符"映射：这样力度就是谱面里的真实力度
		Mapped mapped = BY_POS.get(pos.asLong());
		// M3-37：`machine_map.csv` 记的是**甲板**那一格（makePos 的 y），而方块事件给的是**音符盒**那一格，
		// 所以位置命中不了时再往下看一格。补上这一条，音符盒路线才能拿到逐音的力度/时值/乐器，
		// 否则会退回"由方块状态推算 + 力度写死 100"。
		if (mapped == null) {
			mapped = BY_POS.get(new net.minecraft.util.math.BlockPos(pos.getX(), pos.getY() - 1, pos.getZ()).asLong());
		}
		String voice = mapped != null ? mapped.voice() : voiceOf(instrument);
		String target = mapped != null ? mapped.instrument() : (voice == null ? null : NbmachinaMod.instrumentForVoice(voice));
		if (voice == null || target == null) {
			skipped.incrementAndGet();
			return false;   // 不认识的乐器 / 该声部当前没有映射：交回原版
		}
		if (target == null) {
			skipped.incrementAndGet();
			return false;   // 该声部当前没有映射（例如全钢琴预设下的打击乐）
		}
		// ② 力度与音高：映射命中就用谱面里的；没命中才退回"由方块状态推算"
		int velocity = mapped != null ? mapped.velocity() : VELOCITY_BY_POS.getOrDefault(pos.asLong(), 100);
		int midi = mapped != null ? mapped.midi() : midiOf(instrument, note);
		MinecraftServer server = serverWorld.getServer();
		double x = pos.getX() + 0.5, y = pos.getY() + 0.5, z = pos.getZ() + 0.5;
		int sent = 0;
		for (ServerPlayerEntity player : server.getPlayerManager().getPlayerList()) {
			if (player.getEntityWorld() != serverWorld) continue;
			if (player.squaredDistanceTo(x, y, z) > 48 * 48) continue;   // 只发给听得到的玩家
			net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking.send(player,
				new NbmachinaPlayPayload(target, voice, midi, velocity,
					mapped != null ? mapped.durMs() : 0, x, y, z));
			sent++;
		}
		dispatched.incrementAndGet();
		if (eventCount.get() <= 8 || eventCount.get() % 50 == 0) {
			NbmachinaMod.LOGGER.info("[nbmachina] 音符盒触发 #{} pos={} 乐器={} note={} → {} midi={} vel={} 发给 {} 人",
				eventCount.get(), pos.toShortString(), instrument, note, target, midi, velocity, sent);
		}
		return true;
	}

	/** 音符盒乐器 → 我们的声部名（与谱面 voice 同一套：harp/bass/basedrum/hat） */
	private static String voiceOf(NoteBlockInstrument instrument) {
		return switch (instrument) {
			case HARP -> "harp";
			case BASS -> "bass";
			case BASEDRUM -> "basedrum";
			case SNARE -> "basedrum";
			case HAT -> "hat";
			default -> null;
		};
	}

	/**
	 * 音符盒（乐器 + note 0..24）→ MIDI。
	 *
	 * <p>与数据包同一套折叠规则：harp/bell 家族 = row + 42（音符盒最低行使到 midi 42 起），
	 * bass 家族 = row + 30（低两个八度，见 `src/emit/playsound-hifi.mjs` 的 `midiFromRow`）。
	 */
	private static int midiOf(NoteBlockInstrument instrument, int note) {
		return switch (instrument) {
			case BASS, DIDGERIDOO -> 30 + note;
			default -> 42 + note;
		};
	}
}
