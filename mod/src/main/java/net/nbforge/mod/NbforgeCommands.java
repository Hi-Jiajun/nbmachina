package net.nbforge.mod;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.FloatArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.command.argument.IdentifierArgumentType;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.sound.SoundCategory;
import net.minecraft.sound.SoundEvent;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.Vec3d;

import net.nbforge.mod.net.NbforgePlayPayload;
import net.nbforge.mod.score.NbforgeScore;
import net.nbforge.mod.score.NbforgeScorePlayer;

/**
 * 服务端命令入口（Fabric Command API v2）：
 * <pre>
 * /nbforge info
 * /nbforge note &lt;音色id&gt; [音量] [音高]
 * /nbforge sustain &lt;音色id&gt; &lt;音量&gt; &lt;音高&gt; &lt;总刻数&gt; &lt;间隔刻数&gt;
 * /nbforge stopall
 * /nbforge play &lt;乐器&gt; &lt;midi 0-127&gt; [力度 1-127]   ← P2：让客户端用**无损音频引擎**播（走 mod 自己的 OpenAL，不进原版音频栈）
 * /nbforge score load [路径] / play / stop / status      ← P2-2：**谱面直读**（服务端按谱面派发，客户端无损播）
 * </pre>
 * 控制台（无玩家）也能执行：位置取命令源的坐标，音源世界取命令源所在世界。
 *
 * <p>音色参数用 {@link IdentifierArgumentType}（与 vanilla {@code /playsound} 同一套参数类型）：
 * 可以裸写 {@code nbforge:demo_bell}。**不要**改回 {@code StringArgumentType.string()}——
 * 那是"带引号的字符串"，裸写冒号会直接语法报错（2026-09-14 玩家实测 + 副本服复现：
 * {@code Expected whitespace to end one argument, but found trailing data}）。
 * 裸名（{@code demo_bell}）会被解析成 {@code minecraft:demo_bell}，由
 * {@link NbforgeSounds#resolve(net.minecraft.util.Identifier)} 兜回 {@code nbforge} 命名空间。
 */
public final class NbforgeCommands {
	private NbforgeCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register(
			(dispatcher, registryAccess, environment) -> register(dispatcher));
	}

	private static void register(CommandDispatcher<ServerCommandSource> dispatcher) {
		dispatcher.register(CommandManager.literal("nbforge")
			.then(CommandManager.literal("info")
				.executes(NbforgeCommands::info))
			// M3-23：换谱面（machine_map.csv）时不用重启游戏
			.then(CommandManager.literal("reloadmap")
				.executes(NbforgeCommands::reloadMap))
			.then(CommandManager.literal("note")
				.then(CommandManager.argument("sound", IdentifierArgumentType.identifier())
					.executes(ctx -> note(ctx, 1.0F, 1.0F))
					.then(CommandManager.argument("volume", FloatArgumentType.floatArg(0.0F, 8.0F))
						.executes(ctx -> note(ctx, FloatArgumentType.getFloat(ctx, "volume"), 1.0F))
						.then(CommandManager.argument("pitch", FloatArgumentType.floatArg(0.25F, 4.0F))
							.executes(ctx -> note(ctx,
								FloatArgumentType.getFloat(ctx, "volume"),
								FloatArgumentType.getFloat(ctx, "pitch")))))))
			.then(CommandManager.literal("sustain")
				.then(CommandManager.argument("sound", IdentifierArgumentType.identifier())
					.then(CommandManager.argument("volume", FloatArgumentType.floatArg(0.0F, 8.0F))
						.then(CommandManager.argument("pitch", FloatArgumentType.floatArg(0.25F, 4.0F))
							.then(CommandManager.argument("ticks", IntegerArgumentType.integer(1, 1200))
								.then(CommandManager.argument("interval", IntegerArgumentType.integer(1, 40))
									.executes(NbforgeCommands::sustain)))))))
			.then(CommandManager.literal("stopall")
				.executes(NbforgeCommands::stopAll))
			.then(CommandManager.literal("play")
				.then(CommandManager.argument("instrument", StringArgumentType.word())
					.then(CommandManager.argument("midi", IntegerArgumentType.integer(0, 127))
						.executes(ctx -> play(ctx, 100))
						.then(CommandManager.argument("velocity", IntegerArgumentType.integer(1, 127))
							.executes(ctx -> play(ctx, IntegerArgumentType.getInteger(ctx, "velocity")))))))
			// M3-21c：自研演奏器入口——数据包逐音调用它，mod 按"位置 → 谱面音符"表发声
			.then(CommandManager.literal("playat")
				.then(CommandManager.argument("x", IntegerArgumentType.integer(-30000000, 30000000))
					.then(CommandManager.argument("y", IntegerArgumentType.integer(-1024, 2048))
						.then(CommandManager.argument("z", IntegerArgumentType.integer(-30000000, 30000000))
							.executes(NbforgeCommands::playAt)))))
			// 监听模式：声音锚在玩家身上（整条机器都能听到）；默认按物理位置发声
			.then(CommandManager.literal("listen")
				.then(CommandManager.literal("on").executes(ctx -> keepListening(ctx, true)))
				.then(CommandManager.literal("off").executes(ctx -> keepListening(ctx, false))))
			.then(CommandManager.literal("score")
				.then(CommandManager.literal("load")
					.executes(ctx -> scoreLoad(ctx, null))
					.then(CommandManager.argument("file", StringArgumentType.greedyString())
						.executes(ctx -> scoreLoad(ctx, StringArgumentType.getString(ctx, "file")))))
				.then(CommandManager.literal("play").executes(NbforgeCommands::scorePlay))
				.then(CommandManager.literal("stop").executes(NbforgeCommands::scoreStop))
				.then(CommandManager.literal("status").executes(NbforgeCommands::scoreStatus))));
	}

	private static int info(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbforge] 后端 A 在线\n"
				+ "  自研演奏器：已派发 %d 次（音符盒本体事件 %d / 跳过 %d）；机器映射 %d 个位置\n"
				+ "  旧路径（/nbforge note|sustain）：活跃作业 %d 累计击发 %d 峰值并发 %d"
				+ "（走自研演奏器时这里一直是 0，是正常的——声音走 nbforge:play 到客户端无损引擎）\n"
				+ "  声部→乐器：旋律=%s 低音=%s 打击乐=%s",
			net.nbforge.mod.note.NbforgeNoteBlocks.dispatched(),
			net.nbforge.mod.note.NbforgeNoteBlocks.eventCount(),
			net.nbforge.mod.note.NbforgeNoteBlocks.skipped(),
			net.nbforge.mod.note.NbforgeNoteBlocks.mapSize(),
			NbforgeSustainQueue.activeJobs(),
			NbforgeSustainQueue.totalPlays(),
			NbforgeSustainQueue.peakActiveJobs(),
			NbforgeMod.MELODY_INSTRUMENT, NbforgeMod.BASS_INSTRUMENT,
			String.valueOf(NbforgeMod.PERC_INSTRUMENT))), false);
		return 1;
	}

	/** M3-23：重读 `nbforge/machine_map.csv`（换谱面时不用重启游戏；`/reload` 也会顺手重读） */
	private static int reloadMap(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		NbforgeMod.reloadMachineMap(source.getServer());
		source.sendFeedback(() -> Text.literal("[nbforge] 机器映射已重读：当前 "
			+ net.nbforge.mod.note.NbforgeNoteBlocks.mapSize() + " 个位置"), false);
		return 1;
	}

	private static int note(CommandContext<ServerCommandSource> ctx, float volume, float pitch) {
		ServerCommandSource source = ctx.getSource();
		Identifier raw = IdentifierArgumentType.getIdentifier(ctx, "sound");
		SoundEvent sound = NbforgeSounds.resolve(raw);
		if (sound == null) {
			source.sendError(Text.literal("[nbforge] 无法解析音色 id：" + raw));
			return 0;
		}
		ServerWorld world = source.getWorld();
		Vec3d pos = source.getPosition();
		if (!NbforgeSustainQueue.playAt(world, pos, sound, volume, pitch)) {
			source.sendError(Text.literal("[nbforge] 播放失败（世界未加载）：" + raw));
			return 0;
		}
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbforge] note %s vol=%.2f pitch=%.2f @ %.1f/%.1f/%.1f",
			sound.id(), volume, pitch, pos.x, pos.y, pos.z)), false);
		return 1;
	}

	private static int sustain(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		Identifier raw = IdentifierArgumentType.getIdentifier(ctx, "sound");
		SoundEvent sound = NbforgeSounds.resolve(raw);
		if (sound == null) {
			source.sendError(Text.literal("[nbforge] 无法解析音色 id：" + raw));
			return 0;
		}
		float volume = FloatArgumentType.getFloat(ctx, "volume");
		float pitch = FloatArgumentType.getFloat(ctx, "pitch");
		int ticks = IntegerArgumentType.getInteger(ctx, "ticks");
		int interval = IntegerArgumentType.getInteger(ctx, "interval");
		NbforgeSustainQueue.enqueue(source.getWorld(), source.getPosition(), sound, volume, pitch, ticks, interval);
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbforge] sustain %s vol=%.2f pitch=%.2f 共 %d 刻 / 每 %d 刻重触发（包络 1.0→0.4）",
			sound.id(), volume, pitch, ticks, interval)), false);
		return 1;
	}

	private static int stopAll(CommandContext<ServerCommandSource> ctx) {
		int dropped = NbforgeSustainQueue.stopAll();
		ctx.getSource().sendFeedback(() -> Text.literal("[nbforge] 已停止 " + dropped + " 条延音作业"), false);
		return dropped;
	}

	/** 供自检直接调用（绕过命令层），证明 mod 侧 API 通路可用。 */
	static void playDirect(ServerWorld world, SoundEvent sound, float volume, float pitch) {
		NbforgeSustainQueue.playAt(world, new Vec3d(0.5D, 70.0D, 0.5D), sound, volume, pitch);
	}

	static SoundCategory defaultCategory() {
		return SoundCategory.RECORDS;
	}

	/**
	 * P2 · 让**执行命令的玩家客户端**用无损音频引擎播一颗音。
	 *
	 * <p>服务端只发（乐器 / midi / 力度 / 坐标），采样文件与变调由客户端按自己的
	 * `config/nbforge/instruments.json` 解析——所以服务端（包括专用服务器）不需要任何采样。
	 */
	private static int play(CommandContext<ServerCommandSource> ctx, int velocity) {
		ServerCommandSource source = ctx.getSource();
		ServerPlayerEntity player = source.getPlayer();
		if (player == null) {
			source.sendError(Text.literal("[nbforge] play 需要玩家执行（控制台没有客户端可发）"));
			return 0;
		}
		String instrument = StringArgumentType.getString(ctx, "instrument");
		int midi = IntegerArgumentType.getInteger(ctx, "midi");
		NbforgePlayPayload payload = new NbforgePlayPayload(
			instrument, "manual", midi, velocity, 0, player.getX(), player.getY(), player.getZ());
		ServerPlayNetworking.send(player, payload);
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbforge] play %s midi=%d vel=%d → 客户端无损引擎（nbforge:play）", instrument, midi, velocity)), false);
		return 1;
	}

	/** `/nbforge score load [路径]`：默认读 `<游戏目录>/nbforge/score.csv` */
	/**
	 * M3-21c · 自研演奏器入口：`/nbforge playat <x> <y> <z>`。
	 *
	 * <p>数据包在播放函数里逐音调用它；mod 按 `machine_map.csv`（位置 → 谱面音符）
	 * 取乐器/声部/midi/力度，发给附近玩家的无损引擎——声音与机器同 tick，不会漂移。
	 * 由函数调用时（没有玩家实体）不刷聊天栏，只写日志。
	 */
	private static int playAt(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		int x = IntegerArgumentType.getInteger(ctx, "x");
		int y = IntegerArgumentType.getInteger(ctx, "y");
		int z = IntegerArgumentType.getInteger(ctx, "z");
		net.minecraft.util.math.BlockPos pos = new net.minecraft.util.math.BlockPos(x, y, z);
		net.nbforge.mod.note.NbforgeNoteBlocks.Mapped mapped = net.nbforge.mod.note.NbforgeNoteBlocks.mappedAt(pos);
		if (mapped == null) {
			source.sendError(Text.literal("[nbforge] playat " + x + " " + y + " " + z
				+ " 不在机器映射里（先跑 node tools/export-mod-machine-map.mjs --deploy）"));
			return 0;
		}
		int sent = net.nbforge.mod.note.NbforgeNoteBlocks.playAt(source.getWorld(), pos, mapped);
		if (source.getEntity() instanceof ServerPlayerEntity) {
			source.sendFeedback(() -> Text.literal(String.format(
				"[nbforge] playat %d %d %d → %s midi=%d vel=%d（%s，发给 %d 人）",
				x, y, z, mapped.instrument(), mapped.midi(), mapped.velocity(), mapped.voice(), sent)), false);
		}
		return 1;
	}

	/** `/nbforge listen on|off`：监听模式（声音锚在玩家身上，整条机器都听得到） */
	private static int keepListening(CommandContext<ServerCommandSource> ctx, boolean on) {
		net.nbforge.mod.note.NbforgeNoteBlocks.setListenMode(on);
		ctx.getSource().sendFeedback(() -> Text.literal(on
			? "[nbforge] 监听模式：开（声音锚在你身上，站在哪儿都能听到整条机器；代价是没有方位感）"
			: "[nbforge] 监听模式：关（按方块物理位置发声，需要站在音轨附近）"), false);
		return 1;
	}

	private static int scoreLoad(CommandContext<ServerCommandSource> ctx, String fileArg) {
		ServerCommandSource source = ctx.getSource();
		java.nio.file.Path file = fileArg == null || fileArg.isBlank()
			? NbforgeScorePlayer.defaultFile(source.getServer())
			: java.nio.file.Path.of(fileArg.trim());
		try {
			int n = NbforgeScorePlayer.load(file);
			NbforgeScore sc = NbforgeScorePlayer.score();
			source.sendFeedback(() -> Text.literal(String.format(
				"[nbforge] 谱面已加载：%d 颗音 / %.1fs（跳过 %d 行）\n  声部：%s\n  来源：%s",
				n, sc.durationSec(), sc.skippedRows(), sc.byVoice(), file)), false);
			return n;
		} catch (Exception e) {
			source.sendError(Text.literal("[nbforge] 谱面加载失败：" + e.getClass().getSimpleName() + ": " + e.getMessage()
				+ "\n  先跑 `node tools/export-mod-score.mjs --deploy` 生成 " + file));
			return 0;
		}
	}

	/** `/nbforge score play`：锚点取执行者坐标；没有玩家时退回命令源坐标（控制台也能跑） */
	private static int scorePlay(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		if (NbforgeScorePlayer.score() == null) {
			source.sendError(Text.literal("[nbforge] 还没加载谱面：先 /nbforge score load"));
			return 0;
		}
		NbforgeScorePlayer.start(source.getPosition());
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbforge] 谱面播放开始：%d 颗音 / %.1fs，锚点 %.1f/%.1f/%.1f（客户端无损引擎播）",
			NbforgeScorePlayer.score().size(), NbforgeScorePlayer.score().durationSec(),
			source.getPosition().x, source.getPosition().y, source.getPosition().z)), false);
		return 1;
	}

	private static int scoreStop(CommandContext<ServerCommandSource> ctx) {
		NbforgeScorePlayer.stop();
		ctx.getSource().sendFeedback(() -> Text.literal(String.format(
			"[nbforge] 谱面播放已停止（到点 %d 颗 / 发送 %d 条）",
			NbforgeScorePlayer.due(), NbforgeScorePlayer.sent())), false);
		return 1;
	}

	private static int scoreStatus(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		NbforgeScore sc = NbforgeScorePlayer.score();
		if (sc == null) {
			source.sendFeedback(() -> Text.literal(String.format(
				"[nbforge] 谱面未加载；默认路径 %s（存在=%s）",
				NbforgeScorePlayer.defaultFile(source.getServer()),
				NbforgeScorePlayer.exists(NbforgeScorePlayer.defaultFile(source.getServer())))), false);
			return 0;
		}
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbforge] 谱面：%d 颗 / %.1fs，进度 %d 颗（%.1f%%），到点 %d / 发送 %d，收件人 %d，播放中=%s",
			sc.size(), sc.durationSec(), NbforgeScorePlayer.cursor(),
			sc.size() == 0 ? 0.0 : 100.0 * NbforgeScorePlayer.cursor() / sc.size(),
			NbforgeScorePlayer.due(), NbforgeScorePlayer.sent(), NbforgeScorePlayer.recipients(),
			NbforgeScorePlayer.playing())), false);
		return 1;
	}
}
