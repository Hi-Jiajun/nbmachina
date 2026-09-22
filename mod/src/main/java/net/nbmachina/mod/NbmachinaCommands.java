package net.nbmachina.mod;

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

import net.nbmachina.mod.net.NbmachinaPlayPayload;
import net.nbmachina.mod.score.NbmachinaScore;
import net.nbmachina.mod.score.NbmachinaScorePlayer;

/**
 * 服务端命令入口（Fabric Command API v2）：
 * <pre>
 * /nbmachina info
 * /nbmachina note &lt;音色id&gt; [音量] [音高]
 * /nbmachina sustain &lt;音色id&gt; &lt;音量&gt; &lt;音高&gt; &lt;总刻数&gt; &lt;间隔刻数&gt;
 * /nbmachina stopall
 * /nbmachina play &lt;乐器&gt; &lt;midi 0-127&gt; [力度 1-127]   ← P2：让客户端用**无损音频引擎**播（走 mod 自己的 OpenAL，不进原版音频栈）
 * /nbmachina score load [路径] / play / stop / status      ← P2-2：**谱面直读**（服务端按谱面派发，客户端无损播）
 * </pre>
 * 控制台（无玩家）也能执行：位置取命令源的坐标，音源世界取命令源所在世界。
 *
 * <p>音色参数用 {@link IdentifierArgumentType}（与 vanilla {@code /playsound} 同一套参数类型）：
 * 可以裸写 {@code nbmachina:demo_bell}。**不要**改回 {@code StringArgumentType.string()}——
 * 那是"带引号的字符串"，裸写冒号会直接语法报错（2026-09-14 玩家实测 + 副本服复现：
 * {@code Expected whitespace to end one argument, but found trailing data}）。
 * 裸名（{@code demo_bell}）会被解析成 {@code minecraft:demo_bell}，由
 * {@link NbmachinaSounds#resolve(net.minecraft.util.Identifier)} 兜回 {@code nbmachina} 命名空间。
 */
public final class NbmachinaCommands {
	private NbmachinaCommands() {
	}

	public static void register() {
		CommandRegistrationCallback.EVENT.register(
			(dispatcher, registryAccess, environment) -> register(dispatcher));
	}

	private static void register(CommandDispatcher<ServerCommandSource> dispatcher) {
		dispatcher.register(CommandManager.literal("nbm")
			.then(CommandManager.literal("info")
				.executes(NbmachinaCommands::info))
			// M3-23：换谱面（machine_map.csv）时不用重启游戏
			.then(CommandManager.literal("reloadmap")
				.executes(NbmachinaCommands::reloadMap))
			// M3-39：由 mod 驱动机器（真实时间调度：不受服务器刻率影响、粒子按真实音高）
			.then(CommandManager.literal("machine")
				.executes(ctx -> machineStatus(ctx.getSource()))
				.then(CommandManager.literal("status").executes(ctx -> machineStatus(ctx.getSource())))
				.then(CommandManager.literal("start")
					.executes(ctx -> machineStart(ctx.getSource(), 0.0F, 0.0F))
					.then(CommandManager.argument("fromSec", FloatArgumentType.floatArg(0.0F, 1000.0F))
						.executes(ctx -> machineStart(ctx.getSource(),
							FloatArgumentType.getFloat(ctx, "fromSec"), 0.0F))
						.then(CommandManager.argument("offsetMs", FloatArgumentType.floatArg(-500.0F, 500.0F))
							.executes(ctx -> machineStart(ctx.getSource(),
								FloatArgumentType.getFloat(ctx, "fromSec"),
								FloatArgumentType.getFloat(ctx, "offsetMs"), 1.0F))
							.then(CommandManager.argument("rate", FloatArgumentType.floatArg(0.99F, 1.01F))
								.executes(ctx -> machineStart(ctx.getSource(),
									FloatArgumentType.getFloat(ctx, "fromSec"),
									FloatArgumentType.getFloat(ctx, "offsetMs"),
									FloatArgumentType.getFloat(ctx, "rate")))))))
				.then(CommandManager.literal("stop").executes(ctx -> machineStop(ctx.getSource())))
				.then(CommandManager.literal("silent")
					.executes(ctx -> machineSilent(ctx.getSource(), null))
					.then(CommandManager.literal("on").executes(ctx -> machineSilent(ctx.getSource(), true)))
					.then(CommandManager.literal("off").executes(ctx -> machineSilent(ctx.getSource(), false))))
				// M3-62：触发提前量（刻）——现场 A/B 用：0 = 不提前（声音会晚一整格），3 = 默认
				.then(CommandManager.literal("lead")
					.executes(ctx -> machineLead(ctx.getSource(), null))
					.then(CommandManager.argument("ticks", IntegerArgumentType.integer(0, 20))
						.executes(ctx -> machineLead(ctx.getSource(), IntegerArgumentType.getInteger(ctx, "ticks"))))))
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
									.executes(NbmachinaCommands::sustain)))))))
			.then(CommandManager.literal("stopall")
				.executes(NbmachinaCommands::stopAll))
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
							.executes(NbmachinaCommands::playAt)))))
			// 监听模式：声音锚在玩家身上（整条机器都能听到）；默认按物理位置发声
			.then(CommandManager.literal("listen")
				.then(CommandManager.literal("on").executes(ctx -> keepListening(ctx, true)))
				.then(CommandManager.literal("off").executes(ctx -> keepListening(ctx, false))))
			.then(CommandManager.literal("score")
				.then(CommandManager.literal("load")
					.executes(ctx -> scoreLoad(ctx, null))
					.then(CommandManager.argument("file", StringArgumentType.greedyString())
						.executes(ctx -> scoreLoad(ctx, StringArgumentType.getString(ctx, "file")))))
				.then(CommandManager.literal("play").executes(NbmachinaCommands::scorePlay))
				.then(CommandManager.literal("stop").executes(NbmachinaCommands::scoreStop))
				.then(CommandManager.literal("status").executes(NbmachinaCommands::scoreStatus))));
	}

	private static int info(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 后端 A 在线\n"
				+ "  自研演奏器：已派发 %d 次（音符盒本体事件 %d / 映射命中 %d / 未命中 %d / 跳过 %d）；机器映射 %d 个位置\n"
				+ "  发声开关：音符盒触发 #nb=%d / 数据包直派 #snd=%d / 播放中 #on=%d"
				+ "（`/function styx:play/sound_off` = 音符盒触发，`sound_on` = 数据包直派）\n"
				+ "  旧路径（/nbmachina note|sustain）：活跃作业 %d 累计击发 %d 峰值并发 %d"
				+ "（走自研演奏器时这里一直是 0，是正常的——声音走 nbmachina:play 到客户端无损引擎）\n"
				+ "  声部→乐器：旋律=%s 低音=%s 打击乐=%s",
			net.nbmachina.mod.note.NbmachinaNoteBlocks.dispatched(),
			net.nbmachina.mod.note.NbmachinaNoteBlocks.eventCount(),
			net.nbmachina.mod.note.NbmachinaNoteBlocks.mappedHit(),
			net.nbmachina.mod.note.NbmachinaNoteBlocks.mappedMiss(),
			net.nbmachina.mod.note.NbmachinaNoteBlocks.skipped(),
			net.nbmachina.mod.note.NbmachinaNoteBlocks.mapSize(),
			NbmachinaFlags.flag(ctx.getSource().getWorld(), "#nb"),
			NbmachinaFlags.flag(ctx.getSource().getWorld(), "#snd"),
			NbmachinaFlags.flag(ctx.getSource().getWorld(), "#on"),
			NbmachinaSustainQueue.activeJobs(),
			NbmachinaSustainQueue.totalPlays(),
			NbmachinaSustainQueue.peakActiveJobs(),
			NbmachinaMod.MELODY_INSTRUMENT, NbmachinaMod.BASS_INSTRUMENT,
			String.valueOf(NbmachinaMod.PERC_INSTRUMENT))), false);
		return 1;
	}

	/** M3-23：重读 `nbmachina/machine_map.csv`（换谱面时不用重启游戏；`/reload` 也会顺手重读） */
	private static int reloadMap(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		NbmachinaMod.reloadMachineMap(source.getServer());
		source.sendFeedback(() -> Text.literal("[nbmachina] 机器映射已重读：当前 "
			+ net.nbmachina.mod.note.NbmachinaNoteBlocks.mapSize() + " 个位置"), false);
		return 1;
	}

	/**
	 * M3-39 · `/nbm machine start [起始秒]`：由 **mod 自己**驱动机器。
	 *
	 * <p>与数据包驱动的区别：这里按 {@link System#nanoTime()} 的**真实时间**触发，
	 * 所以世界刻率不是 20 tps 时也不会整曲变速（数据包按"刻"计数，100 tps 下会快 5 倍）；
	 * 粒子也按谱面的**真实音高**上色（原版音符盒只有 25 档）。
	 */
	private static int machineStart(ServerCommandSource source, float fromSec, float offsetMs) {
		return machineStart(source, fromSec, offsetMs, 1.0F);
	}

	private static int machineStart(ServerCommandSource source, float fromSec, float offsetMs, float rate) {
		ServerWorld world = source.getWorld();
		String err = net.nbmachina.mod.machine.NbmachinaMachine.start(world, fromSec, offsetMs, rate);
		if (err != null) {
			source.sendError(Text.literal("[nbmachina] " + err));
			return 0;
		}
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 机器驱动：开始（从 %.1fs 起，全局偏移 %+.0fms，速率 %.5f，共 %d 颗音；真实时间调度，刻率只影响精度不影响速度）",
			fromSec, offsetMs, rate, net.nbmachina.mod.machine.NbmachinaMachine.size())), true);
		return 1;
	}

	/**
	 * `/nbm machine silent on|off`（M3-51）：音符盒静音（灯/粒子/触发照常），
	 * 声音改由客户端 `/nbmc play` 的 nanoTime 调度出 —— 把节奏从"服务器刻（50ms）"提到 1ms 级。
	 */
	private static int machineSilent(ServerCommandSource source, Boolean on) {
		boolean value = on != null ? on : !net.nbmachina.mod.note.NbmachinaNoteBlocks.silent();
		net.nbmachina.mod.note.NbmachinaNoteBlocks.setSilent(value);
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 音符盒静音：%s%s", value ? "开" : "关",
			value ? "（机器照常亮灯出粒子，声音请用客户端 /nbmc play —— 1ms 级调度）" : "（回到音符盒发声）")), true);
		return 1;
	}

	private static int machineStop(ServerCommandSource source) {
		net.nbmachina.mod.machine.NbmachinaMachine.stop(source.getWorld());
		source.sendFeedback(() -> Text.literal("[nbmachina] 机器驱动：已停止"), true);
		return 1;
	}

	/** M3-62：`/nbm machine lead [0..6]` —— 查看/设置红石块触发提前量（刻），用于现场 A/B */
	private static int machineLead(ServerCommandSource source, Integer ticks) {
		if (ticks != null) net.nbmachina.mod.machine.NbmachinaMachine.setLeadTicks(ticks);
		int cur = net.nbmachina.mod.machine.NbmachinaMachine.leadTicks();
		// M3-71：说清楚这个值到底管什么 —— 用户实测"改了 0/8 听不出区别"，因为**声音时刻由客户端按谱面时间对齐**
		// （nanoTime 调度），提前量只决定"载荷提前多久发出去"（旧版还会让红石块提前出现，现在红石块已经不放）。
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 触发提前量 = %d 刻（%.0fms）%s。它只决定载荷提前多久发给客户端（越大越抗卡顿），"
				+ "声音时刻由客户端按谱面时间对齐 —— 所以调这个值听感就是不会有变化；调太小（0~1 刻）反而会晚一整格",
			cur, cur * 50.0, ticks == null ? "" : "（已生效，下一次触发即用新值）")), true);
		return 1;
	}

	private static int machineStatus(ServerCommandSource source) {
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 机器驱动：%s；谱面 %d 颗 / 已触发 %d 颗 / 走过 %d 刻%s",
			net.nbmachina.mod.machine.NbmachinaMachine.running() ? "运行中" : "空闲",
			net.nbmachina.mod.machine.NbmachinaMachine.size(),
			net.nbmachina.mod.machine.NbmachinaMachine.fired(),
			net.nbmachina.mod.machine.NbmachinaMachine.ticks(),
			net.nbmachina.mod.machine.NbmachinaMachine.running()
				? String.format("（谱面时间 %.1fs）", net.nbmachina.mod.machine.NbmachinaMachine.elapsedSec()) : "")), false);
		return 1;
	}

	private static int note(CommandContext<ServerCommandSource> ctx, float volume, float pitch) {
		ServerCommandSource source = ctx.getSource();
		Identifier raw = IdentifierArgumentType.getIdentifier(ctx, "sound");
		SoundEvent sound = NbmachinaSounds.resolve(raw);
		if (sound == null) {
			source.sendError(Text.literal("[nbmachina] 无法解析音色 id：" + raw));
			return 0;
		}
		ServerWorld world = source.getWorld();
		Vec3d pos = source.getPosition();
		if (!NbmachinaSustainQueue.playAt(world, pos, sound, volume, pitch)) {
			source.sendError(Text.literal("[nbmachina] 播放失败（世界未加载）：" + raw));
			return 0;
		}
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] note %s vol=%.2f pitch=%.2f @ %.1f/%.1f/%.1f",
			sound.id(), volume, pitch, pos.x, pos.y, pos.z)), false);
		return 1;
	}

	private static int sustain(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		Identifier raw = IdentifierArgumentType.getIdentifier(ctx, "sound");
		SoundEvent sound = NbmachinaSounds.resolve(raw);
		if (sound == null) {
			source.sendError(Text.literal("[nbmachina] 无法解析音色 id：" + raw));
			return 0;
		}
		float volume = FloatArgumentType.getFloat(ctx, "volume");
		float pitch = FloatArgumentType.getFloat(ctx, "pitch");
		int ticks = IntegerArgumentType.getInteger(ctx, "ticks");
		int interval = IntegerArgumentType.getInteger(ctx, "interval");
		NbmachinaSustainQueue.enqueue(source.getWorld(), source.getPosition(), sound, volume, pitch, ticks, interval);
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] sustain %s vol=%.2f pitch=%.2f 共 %d 刻 / 每 %d 刻重触发（包络 1.0→0.4）",
			sound.id(), volume, pitch, ticks, interval)), false);
		return 1;
	}

	private static int stopAll(CommandContext<ServerCommandSource> ctx) {
		int dropped = NbmachinaSustainQueue.stopAll();
		ctx.getSource().sendFeedback(() -> Text.literal("[nbmachina] 已停止 " + dropped + " 条延音作业"), false);
		return dropped;
	}

	/** 供自检直接调用（绕过命令层），证明 mod 侧 API 通路可用。 */
	static void playDirect(ServerWorld world, SoundEvent sound, float volume, float pitch) {
		NbmachinaSustainQueue.playAt(world, new Vec3d(0.5D, 70.0D, 0.5D), sound, volume, pitch);
	}

	static SoundCategory defaultCategory() {
		return SoundCategory.RECORDS;
	}

	/**
	 * P2 · 让**执行命令的玩家客户端**用无损音频引擎播一颗音。
	 *
	 * <p>服务端只发（乐器 / midi / 力度 / 坐标），采样文件与变调由客户端按自己的
	 * `config/nbmachina/instruments.json` 解析——所以服务端（包括专用服务器）不需要任何采样。
	 */
	private static int play(CommandContext<ServerCommandSource> ctx, int velocity) {
		ServerCommandSource source = ctx.getSource();
		ServerPlayerEntity player = source.getPlayer();
		if (player == null) {
			source.sendError(Text.literal("[nbmachina] play 需要玩家执行（控制台没有客户端可发）"));
			return 0;
		}
		String instrument = StringArgumentType.getString(ctx, "instrument");
		int midi = IntegerArgumentType.getInteger(ctx, "midi");
		NbmachinaPlayPayload payload = new NbmachinaPlayPayload(
			instrument, "manual", midi, velocity, 0, player.getX(), player.getY(), player.getZ());
		ServerPlayNetworking.send(player, payload);
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] play %s midi=%d vel=%d → 客户端无损引擎（nbmachina:play）", instrument, midi, velocity)), false);
		return 1;
	}

	/** `/nbmachina score load [路径]`：默认读 `<游戏目录>/nbmachina/score.csv` */
	/**
	 * M3-21c · 自研演奏器入口：`/nbmachina playat <x> <y> <z>`。
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
		net.nbmachina.mod.note.NbmachinaNoteBlocks.Mapped mapped = net.nbmachina.mod.note.NbmachinaNoteBlocks.mappedAt(pos);
		if (mapped == null) {
			source.sendError(Text.literal("[nbmachina] playat " + x + " " + y + " " + z
				+ " 不在机器映射里（先跑 node tools/export-mod-machine-map.mjs --deploy）"));
			return 0;
		}
		int sent = net.nbmachina.mod.note.NbmachinaNoteBlocks.playAt(source.getWorld(), pos, mapped);
		if (source.getEntity() instanceof ServerPlayerEntity) {
			source.sendFeedback(() -> Text.literal(String.format(
				"[nbmachina] playat %d %d %d → %s midi=%d vel=%d（%s，发给 %d 人）",
				x, y, z, mapped.instrument(), mapped.midi(), mapped.velocity(), mapped.voice(), sent)), false);
		}
		return 1;
	}

	/** `/nbmachina listen on|off`：监听模式（声音锚在玩家身上，整条机器都听得到） */
	private static int keepListening(CommandContext<ServerCommandSource> ctx, boolean on) {
		net.nbmachina.mod.note.NbmachinaNoteBlocks.setListenMode(on);
		ctx.getSource().sendFeedback(() -> Text.literal(on
			? "[nbmachina] 监听模式：开（声音锚在你身上，站在哪儿都能听到整条机器；代价是没有方位感）"
			: "[nbmachina] 监听模式：关（按方块物理位置发声，需要站在音轨附近）"), false);
		return 1;
	}

	private static int scoreLoad(CommandContext<ServerCommandSource> ctx, String fileArg) {
		ServerCommandSource source = ctx.getSource();
		java.nio.file.Path file = fileArg == null || fileArg.isBlank()
			? NbmachinaScorePlayer.defaultFile(source.getServer())
			: java.nio.file.Path.of(fileArg.trim());
		try {
			int n = NbmachinaScorePlayer.load(file);
			NbmachinaScore sc = NbmachinaScorePlayer.score();
			source.sendFeedback(() -> Text.literal(String.format(
				"[nbmachina] 谱面已加载：%d 颗音 / %.1fs（跳过 %d 行）\n  声部：%s\n  来源：%s",
				n, sc.durationSec(), sc.skippedRows(), sc.byVoice(), file)), false);
			return n;
		} catch (Exception e) {
			source.sendError(Text.literal("[nbmachina] 谱面加载失败：" + e.getClass().getSimpleName() + ": " + e.getMessage()
				+ "\n  先跑 `node tools/export-mod-score.mjs --deploy` 生成 " + file));
			return 0;
		}
	}

	/** `/nbmachina score play`：锚点取执行者坐标；没有玩家时退回命令源坐标（控制台也能跑） */
	private static int scorePlay(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		if (NbmachinaScorePlayer.score() == null) {
			source.sendError(Text.literal("[nbmachina] 还没加载谱面：先 /nbmachina score load"));
			return 0;
		}
		NbmachinaScorePlayer.start(source.getPosition());
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 谱面播放开始：%d 颗音 / %.1fs，锚点 %.1f/%.1f/%.1f（客户端无损引擎播）",
			NbmachinaScorePlayer.score().size(), NbmachinaScorePlayer.score().durationSec(),
			source.getPosition().x, source.getPosition().y, source.getPosition().z)), false);
		return 1;
	}

	private static int scoreStop(CommandContext<ServerCommandSource> ctx) {
		NbmachinaScorePlayer.stop();
		ctx.getSource().sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 谱面播放已停止（到点 %d 颗 / 发送 %d 条）",
			NbmachinaScorePlayer.due(), NbmachinaScorePlayer.sent())), false);
		return 1;
	}

	private static int scoreStatus(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		NbmachinaScore sc = NbmachinaScorePlayer.score();
		if (sc == null) {
			source.sendFeedback(() -> Text.literal(String.format(
				"[nbmachina] 谱面未加载；默认路径 %s（存在=%s）",
				NbmachinaScorePlayer.defaultFile(source.getServer()),
				NbmachinaScorePlayer.exists(NbmachinaScorePlayer.defaultFile(source.getServer())))), false);
			return 0;
		}
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 谱面：%d 颗 / %.1fs，进度 %d 颗（%.1f%%），到点 %d / 发送 %d，收件人 %d，播放中=%s",
			sc.size(), sc.durationSec(), NbmachinaScorePlayer.cursor(),
			sc.size() == 0 ? 0.0 : 100.0 * NbmachinaScorePlayer.cursor() / sc.size(),
			NbmachinaScorePlayer.due(), NbmachinaScorePlayer.sent(), NbmachinaScorePlayer.recipients(),
			NbmachinaScorePlayer.playing())), false);
		return 1;
	}
}
