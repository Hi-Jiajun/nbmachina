package net.nbforge.mod;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandManager;
import net.fabricmc.fabric.api.client.command.v2.ClientCommandRegistrationCallback;
import net.fabricmc.fabric.api.client.command.v2.FabricClientCommandSource;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.network.ClientPlayerEntity;
import net.minecraft.sound.SoundCategory;
import net.minecraft.text.Text;
import net.minecraft.util.math.MathHelper;

import net.nbforge.mod.audio.NbforgeAudio;
import net.nbforge.mod.audio.NbforgeInstruments;
import net.nbforge.mod.audio.NbforgeWav;
import net.nbforge.mod.net.NbforgePlayPayload;
import net.nbforge.mod.score.NbforgeClientPlayer;

/**
 * M3-16（P2）· 客户端入口：无损音频引擎 + 乐器库 + 客户端命令。
 *
 * <p>客户端命令用 **{@code /nbfc}**（不是 {@code /nbforge}）：后者是服务端命令，
 * 客户端命令优先级更高、且不会发给服务器——同名会把原来的 {@code /nbforge info} 顶掉。
 *
 * <pre>
 * /nbfc status                     引擎状态（就绪/采样缓存/活跃声部/播放计数）
 * /nbfc reload                     重新读 config/nbforge/instruments.json
 * /nbfc instruments                列出已加载乐器（id / 区域数 / 许可）
 * /nbfc note &lt;乐器&gt; &lt;midi&gt; [力度]  本地试听一颗音（不吃资源包、不走原版音频栈）
 * /nbfc demo [乐器]                一键试听：C 大调琶音 × 三档力度（验证力度层与无损通路）
 * /nbfc selftest [乐器] [midi] [力度]  单音自检：打印采样文件/解码参数/AL 状态（远程诊断用）
 * /nbfc play [起始秒]              客户端高精度播放（自己读 nbforge/score.csv，不受服务器刻率限制）
 * /nbfc stop                       停止客户端播放
 * </pre>
 */
public final class NbforgeClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		int loaded = NbforgeInstruments.reload();
		NbforgeInstruments.loadVoices();   // M3-30：音色覆盖表（config/nbforge/voices.json）
		NbforgeAudio.start();
		NbforgeMod.LOGGER.info("[nbforge] 客户端入口：乐器 {} 个（{}）", loaded, NbforgeInstruments.lastError());

		ClientPlayNetworking.registerGlobalReceiver(NbforgePlayPayload.ID, (payload, context) ->
			NbforgeAudio.play(payload.instrument(), payload.voice(), payload.midi(), payload.velocity(), payload.durMs(),
				payload.x(), payload.y(), payload.z()));

		ClientTickEvents.END_CLIENT_TICK.register(NbforgeClient::tick);
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, access) -> dispatcher.register(
			ClientCommandManager.literal("nbfc")
				// 只打 `/nbfc` 不带子命令时，Brigadier 默认报"错误的命令参数，位于第5个字符：nbfc"
				// （2026-09-18 用户就撞上这个）——这里给它一个人话用法说明，顺便自证有哪些子命令。
				.executes(ctx -> {
					usage(ctx.getSource());
					return 1;
				})
				.then(ClientCommandManager.literal("status").executes(ctx -> status(ctx.getSource())))
				.then(ClientCommandManager.literal("reload").executes(ctx -> reload(ctx.getSource())))
				.then(ClientCommandManager.literal("instruments").executes(ctx -> list(ctx.getSource())))
				.then(ClientCommandManager.literal("selftest")
					.executes(ctx -> selftest(ctx.getSource(), defaultInstrument(), 60, 100))
					.then(ClientCommandManager.argument("instrument", StringArgumentType.word())
						.executes(ctx -> selftest(ctx.getSource(), StringArgumentType.getString(ctx, "instrument"), 60, 100))
						.then(ClientCommandManager.argument("midi", IntegerArgumentType.integer(0, 127))
							.executes(ctx -> selftest(ctx.getSource(), StringArgumentType.getString(ctx, "instrument"),
								IntegerArgumentType.getInteger(ctx, "midi"), 100))
							.then(ClientCommandManager.argument("velocity", IntegerArgumentType.integer(1, 127))
								.executes(ctx -> selftest(ctx.getSource(), StringArgumentType.getString(ctx, "instrument"),
									IntegerArgumentType.getInteger(ctx, "midi"),
									IntegerArgumentType.getInteger(ctx, "velocity")))))))
				.then(ClientCommandManager.literal("demo")
					.executes(ctx -> demo(ctx.getSource(), defaultInstrument()))
					.then(ClientCommandManager.argument("instrument", StringArgumentType.word())
						.executes(ctx -> demo(ctx.getSource(), StringArgumentType.getString(ctx, "instrument")))))
				.then(ClientCommandManager.literal("note")
					.then(ClientCommandManager.argument("instrument", StringArgumentType.word())
						.then(ClientCommandManager.argument("midi", IntegerArgumentType.integer(0, 127))
							.executes(ctx -> note(ctx.getSource(),
								StringArgumentType.getString(ctx, "instrument"),
								IntegerArgumentType.getInteger(ctx, "midi"),
								100))
							.then(ClientCommandManager.argument("velocity", IntegerArgumentType.integer(1, 127))
								.executes(ctx -> note(ctx.getSource(),
									StringArgumentType.getString(ctx, "instrument"),
									IntegerArgumentType.getInteger(ctx, "midi"),
									IntegerArgumentType.getInteger(ctx, "velocity")))))))
				// M3-29：客户端高精度播放（自己读 nbforge/score.csv，不受服务器刻率限制）
				.then(ClientCommandManager.literal("play")
					.executes(ctx -> play(ctx.getSource(), 0.0))
					.then(ClientCommandManager.argument("fromSec",
							com.mojang.brigadier.arguments.DoubleArgumentType.doubleArg(0.0))
						.executes(ctx -> play(ctx.getSource(),
							com.mojang.brigadier.arguments.DoubleArgumentType.getDouble(ctx, "fromSec")))))
				.then(ClientCommandManager.literal("stop")
					.executes(ctx -> {
						NbforgeClientPlayer.stop();
						ctx.getSource().sendFeedback(Text.literal("[nbforge] 客户端播放已停止"));
						return 1;
					}))
				// M3-31：sta（断奏）采样阈值（默认 0 = 关闭；用户 2026-09-18 判定开启后"缺音"）
				.then(ClientCommandManager.literal("sta")
					.executes(ctx -> {
						ctx.getSource().sendFeedback(Text.literal("[nbforge] sta 阈值 = "
							+ NbforgeInstruments.staccatoMs() + "ms（0 = 关闭，走 leg 连奏采样）"));
						return 1;
					})
					.then(ClientCommandManager.argument("ms", IntegerArgumentType.integer(0, 1000))
						.executes(ctx -> {
							int ms = IntegerArgumentType.getInteger(ctx, "ms");
							NbforgeInstruments.setStaccatoMs(ms);
							ctx.getSource().sendFeedback(Text.literal(ms == 0
								? "[nbforge] sta 已关闭：全部用 leg 连奏采样（默认）"
								: "[nbforge] sta 已开启：dur_ms ≤ " + ms + "ms 的音用断奏采样（实测容易听成缺音，谨慎）"));
							return 1;
						})))
				// M3-30：运行时音色切换（不用改 machine_map.csv / score.csv）
				.then(ClientCommandManager.literal("instrument")
					.executes(ctx -> instrumentList(ctx.getSource()))
					.then(ClientCommandManager.literal("list")
						.executes(ctx -> instrumentList(ctx.getSource())))
					// 子命令一律用字面量（set / clear）：字面量与自由词同层会被 Brigadier 判为歧义
					.then(ClientCommandManager.literal("set")
						.then(ClientCommandManager.argument("voice", StringArgumentType.word())
							.then(ClientCommandManager.argument("id", StringArgumentType.word())
								.executes(ctx -> instrumentSet(ctx.getSource(),
									StringArgumentType.getString(ctx, "voice"),
									StringArgumentType.getString(ctx, "id"))))))
					.then(ClientCommandManager.literal("clear")
						.executes(ctx -> {
							NbforgeInstruments.clearAllOverrides();
							ctx.getSource().sendFeedback(Text.literal("[nbforge] 音色映射已清空：全部按谱面原值播"));
							return 1;
						})
						.then(ClientCommandManager.argument("voice", StringArgumentType.word())
							.executes(ctx -> {
								String v = StringArgumentType.getString(ctx, "voice");
								NbforgeInstruments.clearOverride(v);
								ctx.getSource().sendFeedback(Text.literal("[nbforge] 声部 " + v + " 已恢复谱面原值"));
								return 1;
							}))))));
	}

	/** 每刻：把相机位置/朝向同步给音频线程，并把原版主音量接过来 */
	private static void tick(MinecraftClient client) {
		ClientPlayerEntity player = client.player;
		if (player == null) return;
		double yaw = Math.toRadians(player.getYaw());
		double pitch = Math.toRadians(player.getPitch());
		float fx = (float) (-Math.sin(yaw) * Math.cos(pitch));
		float fy = (float) (-Math.sin(pitch));
		float fz = (float) (Math.cos(yaw) * Math.cos(pitch));
		NbforgeAudio.setListener(player.getX(), player.getEyeY(), player.getZ(), fx, fy, fz, 0f, 1f, 0f);
		float master = client.options.getSoundVolume(SoundCategory.MASTER);
		NbforgeAudio.setMasterGain(master * 0.85f);
	}

	/** `/nbfc` 不带子命令时的用法说明（顺便自证子命令清单） */
	private static void usage(FabricClientCommandSource src) {
		src.sendFeedback(Text.literal(
			"[nbforge] 客户端命令：\n"
				+ "  /nbfc status                 引擎状态（含客户端播放的抖动/队列延迟）\n"
				+ "  /nbfc play [起始秒]          客户端高精度播放 nbforge/score.csv（不受服务器刻率限制）\n"
				+ "  /nbfc stop                   停止客户端播放\n"
				+ "  /nbfc instruments            列出乐器库\n"
				+ "  /nbfc note <乐器> <midi> [力度]  本地试听一颗音\n"
				+ "  /nbfc demo [乐器]            一键试听琶音\n"
				+ "  /nbfc selftest [乐器] [midi] [力度]  单音自检\n"
				+ "  /nbfc instrument [声部] [乐器]  运行时换琴（不带参数看当前映射与可选乐器）\n"
				+ "  /nbfc instrument set <声部|all> <乐器>   运行时换琴（all = 全部声部）\n"
				+ "  /nbfc instrument clear [声部]   恢复谱面原值\n"
				+ "  /nbfc reload                 重读 config/nbforge/instruments.json"));
	}

	/** M3-30：列出当前音色映射 + 可选乐器 */
	private static int instrumentList(FabricClientCommandSource src) {
		StringBuilder sb = new StringBuilder("[nbforge] 音色映射（声部 → 乐器，`*` = 全部声部）：\n");
		var ov = NbforgeInstruments.overrides();
		if (ov.isEmpty()) sb.append("  （未设置：全部按谱面里的乐器播）\n");
		else for (var e : ov.entrySet()) sb.append("  ").append(e.getKey()).append(" → ").append(e.getValue()).append('\n');
		sb.append("  可选乐器：");
		src.sendFeedback(Text.literal(sb.toString()));
		return list(src);
	}

	/**
	 * `/nbfc instrument set <声部> <乐器>`；声部写 `all`（或 `*`）= 全部声部一起换。
	 */
	private static int instrumentSet(FabricClientCommandSource src, String voiceArg, String id) {
		String v = voiceArg == null ? "all" : voiceArg.trim().toLowerCase();
		boolean anyVoice = v.equals("all") || v.equals("*") || v.equals("全部");
		String voice = anyVoice ? "*" : v;
		if (NbforgeInstruments.get(id) == null) {
			src.sendError(Text.literal("[nbforge] 没有这个乐器：" + id + "（/nbfc instrument 看清单）"));
			return 0;
		}
		NbforgeInstruments.setOverride(voice, id);
		src.sendFeedback(Text.literal(String.format("[nbforge] 音色已切换：%s → %s（立即生效，已写入 config/nbforge/voices.json）",
			anyVoice ? "全部声部" : voice, id)));
		return 1;
	}

	private static int status(FabricClientCommandSource src) {
		src.sendFeedback(Text.literal(String.format(
			"[nbforge] 引擎就绪=%s 乐器=%d 采样缓存=%d 个/%.0fMB 活跃声部=%d 峰值=%d 已播=%d 丢弃=%d 主增益=%.2f\n"
				+ "  收到 %d 条 nbforge:play（带时值 %d 条）；上下文重建 %d 次；被抢声部 %d；八度折叠 %d\n"
				+ "  放音：按谱面时值 %d 次 / 旧规则（低音单声部+同键重击）%d 次\n"
				+ "  客户端高精度播放：%s 谱面 %d 颗 / 已调度 %d / 发声 %d / 跳过 %d / 抖动 均 %.2fms 最大 %.2fms；音频队列延迟 %.2fms\n"
				+ "  音色映射（声部→乐器，`*`=全部）：%s\n"
				+ "  OpenAL：%s\n"
				+ "  资源包：%s%s",
			NbforgeAudio.ready(), NbforgeInstruments.size(), NbforgeAudio.bufferCount(),
			NbforgeAudio.cachedBytes() / 1048576.0, NbforgeAudio.activeCount(), NbforgeAudio.peakActive(),
			NbforgeAudio.playedCount(), NbforgeAudio.droppedCount(), NbforgeAudio.masterGain(),
			NbforgeAudio.receivedCount(), NbforgeAudio.withDurationCount(),
			NbforgeAudio.restartCount(), NbforgeAudio.stolenCount(),
			NbforgeAudio.foldedCount(),
			NbforgeAudio.releasedByScore(), NbforgeAudio.dampedCount(),
			NbforgeClientPlayer.isPlaying() ? String.format("进行中 %.1fs；", NbforgeClientPlayer.elapsed()) : "空闲；",
			NbforgeClientPlayer.noteCount(), NbforgeClientPlayer.scheduledCount(),
			NbforgeClientPlayer.playedCount(), NbforgeClientPlayer.skippedCount(),
			NbforgeClientPlayer.meanJitterMs(), NbforgeClientPlayer.maxJitterMs(),
			NbforgeAudio.lastTaskLatencyMs(),
			NbforgeInstruments.overrides().isEmpty() ? "（未设置，按谱面原值）" : NbforgeInstruments.overrides().toString(),
			NbforgeAudio.alInfo(),
			packHint(),
			NbforgeAudio.lastError() == null ? "" : "；最后错误：" + NbforgeAudio.lastError())));
		return 1;
	}

	/**
	 * M3-29：客户端高精度播放。自己读游戏目录的 `nbforge/score.csv`（与服务端部署的是同一份），
	 * 用 nanoTime 逐颗发声——分辨率不受服务器刻率（20 tps=50ms / 100 tps=10ms）限制。
	 */
	private static int play(FabricClientCommandSource src, double fromSec) {
		java.nio.file.Path file = net.fabricmc.loader.api.FabricLoader.getInstance().getGameDir()
			.resolve("nbforge").resolve("score.csv");
		try {
			int n = NbforgeClientPlayer.load(file);
			if (!NbforgeAudio.ready()) {
				src.sendError(Text.literal("[nbforge] 音频引擎还没就绪（/nbfc status 看详情）"));
				return 0;
			}
			if (!NbforgeClientPlayer.start(fromSec)) {
				src.sendError(Text.literal("[nbforge] 没有可用谱面：" + file));
				return 0;
			}
			src.sendFeedback(Text.literal(String.format(
				"[nbforge] 客户端高精度播放：%d 颗音，从 %.1fs 开始（不受服务器刻率限制）", n, fromSec)));
			return 1;
		} catch (java.io.IOException e) {
			src.sendError(Text.literal("[nbforge] 谱面读取失败：" + e.getMessage()));
			return 0;
		}
	}

	/**
	 * 资源包是否启用（`nbforge_resources.zip`）。
	 *
	 * <p>为什么值得单独报：**老链路**（数据包/`/playsound` 播 `nbforge:*`）完全依赖这个包——
	 * 实测 2026-09-15 09:22 有一次资源重载没带上它，客户端立刻刷了 54 条
	 * `Unable to play unknown soundEvent: nbforge:*`（机器那段时间是哑的）。
	 * 新链路（`nbforge:play` → 我们的 OpenAL 引擎）不吃资源包，所以这条只影响老链路。
	 */
	private static String packHint() {
		try {
			boolean enabled = MinecraftClient.getInstance().getResourcePackManager().getEnabledIds().stream()
				.anyMatch(id -> id.contains("nbforge_resources"));
			return enabled
				? "nbforge_resources.zip 已启用（老链路可用）"
				: "**未启用** —— 老链路（数据包 /playsound）会静音；无损引擎不受影响";
		} catch (Throwable t) {
			return "状态未知（" + t.getClass().getSimpleName() + "）";
		}
	}

	private static int reload(FabricClientCommandSource src) {
		int n = NbforgeInstruments.reload();
		NbforgeInstruments.loadVoices();
		src.sendFeedback(Text.literal(n >= 0
			? "[nbforge] 乐器库已重新加载：" + n + " 个；音色映射 " + NbforgeInstruments.overrides()
			: "[nbforge] 加载失败：" + NbforgeInstruments.lastError()));
		return n >= 0 ? 1 : 0;
	}

	private static int list(FabricClientCommandSource src) {
		var all = NbforgeInstruments.all();
		if (all.isEmpty()) {
			src.sendError(Text.literal("[nbforge] 没有乐器：" + NbforgeInstruments.lastError()));
			return 0;
		}
		StringBuilder sb = new StringBuilder("[nbforge] 已加载 " + all.size() + " 个乐器：");
		for (var inst : all) {
			sb.append("\n  ").append(inst.id).append("（").append(inst.regions.size()).append(" 区域")
				.append(inst.license == null ? "" : "， " + inst.license).append("）");
		}
		src.sendFeedback(Text.literal(sb.toString()));
		return all.size();
	}

	private static int note(FabricClientCommandSource src, String instrument, int midi, int velocity) {
		if (NbforgeInstruments.get(instrument) == null) {
			src.sendError(Text.literal("[nbforge] 没有这个乐器：" + instrument + "（先 /nbfc instruments 看列表）"));
			return 0;
		}
		ClientPlayerEntity player = src.getPlayer();
		NbforgeAudio.play(instrument, "manual", midi, velocity, 0, player.getX(), player.getY(), player.getZ());
		src.sendFeedback(Text.literal(String.format(
			"[nbforge] 本地试听 %s midi=%d vel=%d（增益 %.3f）", instrument, midi, velocity,
			NbforgeInstruments.velocityGain(velocity))));
		return 1;
	}

	private static String defaultInstrument() {
		for (var inst : NbforgeInstruments.all()) {
			if (inst.isDefault) return inst.id;
		}
		var all = NbforgeInstruments.all();
		return all.isEmpty() ? "salamander48" : all.iterator().next().id;
	}

	/** 一键试听：C4–G4–C5–E5–G5，三档力度各来一遍（听力度层差别 & 引擎是否通了） */
	private static int demo(FabricClientCommandSource src, String instrument) {
		if (NbforgeInstruments.get(instrument) == null) {
			src.sendError(Text.literal("[nbforge] 没有这个乐器：" + instrument + "（先 /nbfc instruments）"));
			return 0;
		}
		ClientPlayerEntity player = src.getPlayer();
		int[] notes = {60, 67, 72, 76, 79};
		int[] vels = {30, 70, 110};
		NbforgeMod.LOGGER.info("[nbforge] demo {} @ {}/{}/{}", instrument, player.getX(), player.getY(), player.getZ());
		// 0.35s 一颗，依次 低/中/高 力度——与离线渲染同一套（力度→采样层 + 增益）映射
		new Thread(() -> {
			try {
				for (int v : vels) {
					for (int midi : notes) {
						NbforgeAudio.play(instrument, "manual", midi, v, 0, player.getX(), player.getY(), player.getZ());
						Thread.sleep(350L);
					}
				}
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
		}, "nbforge-demo").start();
		src.sendFeedback(Text.literal("[nbforge] 试听 " + instrument + "：C4 G4 C5 E5 G5 × 力度 30/70/110"));
		return 1;
	}

	/**
	 * 单音自检（远程诊断用）：把"用哪个采样文件、解码参数、上传后的 AL 状态"全打出来。
	 * 出问题时把这几行发回即可定位（不用翻客户端日志）。
	 */
	private static int selftest(FabricClientCommandSource src, String instrument, int midi, int velocity) {
		var inst = NbforgeInstruments.get(instrument);
		if (inst == null) {
			src.sendError(Text.literal("[nbforge] 没有这个乐器：" + instrument));
			return 0;
		}
		var region = inst.pick(midi, velocity);
		if (region == null) {
			src.sendError(Text.literal("[nbforge] " + instrument + " 里没有可用区域"));
			return 0;
		}
		String file = region.file;
		boolean exists = file != null && java.nio.file.Files.isRegularFile(java.nio.file.Path.of(file));
		String decode;
		try {
			var pcm = NbforgeWav.read(java.nio.file.Path.of(file));
			decode = String.format("%dch / %dHz / %.2fs / %d 帧", pcm.channels(), pcm.sampleRate(), pcm.seconds(), pcm.frames());
		} catch (Exception e) {
			decode = "解码失败：" + e.getClass().getSimpleName() + ": " + e.getMessage();
		}
		src.sendFeedback(Text.literal(String.format(
			"[nbforge] selftest %s midi=%d vel=%d\n  采样=%s（存在=%s）\n  区域：loKey..hiKey=%d..%d root=%d 力度 %d..%d 增益%+.1fdB\n  解码：%s\n  引擎就绪=%s 主增益=%.2f",
			instrument, midi, velocity, file, exists,
			region.loKey, region.hiKey, region.root, region.loVel, region.hiVel, region.gainDb,
			decode, NbforgeAudio.ready(), NbforgeAudio.masterGain())));

		ClientPlayerEntity player = src.getPlayer();
		NbforgeAudio.play(instrument, "manual", midi, velocity, 0, player.getX(), player.getY(), player.getZ());
		MinecraftClient client = MinecraftClient.getInstance();
		new Thread(() -> {
			try {
				Thread.sleep(1200L);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			client.execute(() -> src.sendFeedback(Text.literal(String.format(
				"[nbforge] selftest 1.2s 后：采样缓存=%d 个（%.0fMB）活跃声部=%d 已播=%d 丢弃=%d%s",
				NbforgeAudio.bufferCount(), NbforgeAudio.cachedBytes() / 1048576.0, NbforgeAudio.activeCount(),
				NbforgeAudio.playedCount(), NbforgeAudio.droppedCount(),
				NbforgeAudio.lastError() == null ? "" : "；最后错误：" + NbforgeAudio.lastError()))));
		}, "nbforge-selftest").start();
		return 1;
	}
}
