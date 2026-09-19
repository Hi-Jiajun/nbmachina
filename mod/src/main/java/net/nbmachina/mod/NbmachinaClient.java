package net.nbmachina.mod;

import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

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

import net.nbmachina.mod.audio.NbmachinaAudio;
import net.nbmachina.mod.audio.NbmachinaInstruments;
import net.nbmachina.mod.audio.NbmachinaSamples;
import net.nbmachina.mod.audio.NbmachinaWav;
import net.nbmachina.mod.net.NbmachinaPlayPayload;
import net.nbmachina.mod.score.NbmachinaClientPlayer;

/**
 * M3-16（P2）· 客户端入口：无损音频引擎 + 乐器库 + 客户端命令。
 *
 * <p>客户端命令用 **{@code /nbmc}**（不是 {@code /nbmachina}）：后者是服务端命令，
 * 客户端命令优先级更高、且不会发给服务器——同名会把原来的 {@code /nbmachina info} 顶掉。
 *
 * <pre>
 * /nbmc status                     引擎状态（就绪/采样缓存/活跃声部/播放计数）
 * /nbmc reload                     重新读 config/nbmachina/instruments.json
 * /nbmc instruments                列出已加载乐器（id / 区域数 / 许可）
 * /nbmc note &lt;乐器&gt; &lt;midi&gt; [力度]  本地试听一颗音（不吃资源包、不走原版音频栈）
 * /nbmc demo [乐器]                一键试听：C 大调琶音 × 三档力度（验证力度层与无损通路）
 * /nbmc selftest [乐器] [midi] [力度]  单音自检：打印采样文件/解码参数/AL 状态（远程诊断用）
 * /nbmc play [起始秒]              客户端高精度播放（自己读 nbmachina/score.csv，不受服务器刻率限制）
 * /nbmc stop                       停止客户端播放
 * </pre>
 */
public final class NbmachinaClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		int loaded = NbmachinaInstruments.reload();
		NbmachinaInstruments.loadVoices();   // M3-30：音色覆盖表（config/nbmachina/voices.json）
		NbmachinaAudio.start();
		NbmachinaMod.LOGGER.info("[nbmachina] 客户端入口：乐器 {} 个（{}）", loaded, NbmachinaInstruments.lastError());

		// M3-51：服务端说"机器从第 X 秒开始跑了" → 客户端用**自己的时钟**从同一时间点起播（1ms 级）
		ClientPlayNetworking.registerGlobalReceiver(
			net.nbmachina.mod.net.NbmachinaMachineSyncPayload.ID, (payload, context) ->
				context.client().execute(() -> {
					boolean ok = NbmachinaClientPlayer.start(payload.fromSec());
					NbmachinaMod.LOGGER.info("[nbmachina] 机器同步包：从 {}s 起播客户端精确音轨 → {}", payload.fromSec(), ok);
					if (context.player() != null) {
						context.player().sendMessage(Text.literal(ok
							? "[nbmachina] 客户端精确音轨已同步起播（1ms 级调度）"
							: "[nbmachina] 客户端精确音轨起播失败（没有谱面？/nbmc status 看详情）"), false);
					}
				}));
		ClientPlayNetworking.registerGlobalReceiver(NbmachinaPlayPayload.ID, (payload, context) ->
			NbmachinaAudio.play(payload.instrument(), payload.voice(), payload.midi(), payload.velocity(), payload.durMs(),
				payload.x(), payload.y(), payload.z()));

		ClientTickEvents.END_CLIENT_TICK.register(NbmachinaClient::tick);
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, access) -> dispatcher.register(
			ClientCommandManager.literal("nbmc")
				// 只打 `/nbmc` 不带子命令时，Brigadier 默认报"错误的命令参数，位于第5个字符：nbmc"
				// （2026-09-18 用户就撞上这个）——这里给它一个人话用法说明，顺便自证有哪些子命令。
				.executes(ctx -> {
					usage(ctx.getSource());
					return 1;
				})
				.then(ClientCommandManager.literal("status").executes(ctx -> status(ctx.getSource())))
				.then(ClientCommandManager.literal("reload").executes(ctx -> reload(ctx.getSource())))
				.then(ClientCommandManager.literal("samples").executes(ctx -> samples(ctx.getSource())))
				.then(ClientCommandManager.literal("instruments")
					.executes(ctx -> list(ctx.getSource(), null))
					.then(ClientCommandManager.argument("filter", StringArgumentType.word())
						.executes(ctx -> list(ctx.getSource(), StringArgumentType.getString(ctx, "filter")))))
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
				// M3-29：客户端高精度播放（自己读 nbmachina/score.csv，不受服务器刻率限制）
				.then(ClientCommandManager.literal("play")
					.executes(ctx -> play(ctx.getSource(), 0.0))
					.then(ClientCommandManager.argument("fromSec",
							com.mojang.brigadier.arguments.DoubleArgumentType.doubleArg(0.0))
						.executes(ctx -> play(ctx.getSource(),
							com.mojang.brigadier.arguments.DoubleArgumentType.getDouble(ctx, "fromSec")))))
				.then(ClientCommandManager.literal("stop")
					.executes(ctx -> {
						NbmachinaClientPlayer.stop();
						ctx.getSource().sendFeedback(Text.literal("[nbmachina] 客户端播放已停止"));
						return 1;
					}))
				// M3-31：sta（断奏）采样阈值（默认 0 = 关闭；用户 2026-09-18 判定开启后"缺音"）
				.then(ClientCommandManager.literal("sta")
					.executes(ctx -> {
						ctx.getSource().sendFeedback(Text.literal("[nbmachina] sta 阈值 = "
							+ NbmachinaInstruments.staccatoMs() + "ms（0 = 关闭，走 leg 连奏采样）"));
						return 1;
					})
					.then(ClientCommandManager.argument("ms", IntegerArgumentType.integer(0, 1000))
						.executes(ctx -> {
							int ms = IntegerArgumentType.getInteger(ctx, "ms");
							NbmachinaInstruments.setStaccatoMs(ms);
							ctx.getSource().sendFeedback(Text.literal(ms == 0
								? "[nbmachina] sta 已关闭：全部用 leg 连奏采样（默认）"
								: "[nbmachina] sta 已开启：dur_ms ≤ " + ms + "ms 的音用断奏采样（实测容易听成缺音，谨慎）"));
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
							NbmachinaInstruments.clearAllOverrides();
							ctx.getSource().sendFeedback(Text.literal("[nbmachina] 音色映射已清空：全部按谱面原值播"));
							return 1;
						})
						.then(ClientCommandManager.argument("voice", StringArgumentType.word())
							.executes(ctx -> {
								String v = StringArgumentType.getString(ctx, "voice");
								NbmachinaInstruments.clearOverride(v);
								ctx.getSource().sendFeedback(Text.literal("[nbmachina] 声部 " + v + " 已恢复谱面原值"));
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
		NbmachinaAudio.setListener(player.getX(), player.getEyeY(), player.getZ(), fx, fy, fz, 0f, 1f, 0f);
		float master = client.options.getSoundVolume(SoundCategory.MASTER);
		NbmachinaAudio.setMasterGain(master * 0.85f);
	}

	/** `/nbmc` 不带子命令时的用法说明（顺便自证子命令清单） */
	private static void usage(FabricClientCommandSource src) {
		src.sendFeedback(Text.literal(
			"[nbmachina] 客户端命令：\n"
				+ "  /nbmc status                 引擎状态（含客户端播放的抖动/队列延迟）\n"
				+ "  /nbmc play [起始秒]          客户端高精度播放 nbmachina/score.csv（不受服务器刻率限制）\n"
				+ "  /nbmc stop                   停止客户端播放\n"
				+ "  /nbmc instruments            列出乐器库\n"
				+ "  /nbmc note <乐器> <midi> [力度]  本地试听一颗音\n"
				+ "  /nbmc demo [乐器]            一键试听琶音\n"
				+ "  /nbmc selftest [乐器] [midi] [力度]  单音自检\n"
				+ "  /nbmc instrument [声部] [乐器]  运行时换琴（不带参数看当前映射与可选乐器）\n"
				+ "  /nbmc instrument set <声部|all> <乐器>   运行时换琴（all = 全部声部）\n"
				+ "  /nbmc instrument clear [声部]   恢复谱面原值\n"
				+ "  /nbmc samples                采样库自检（采样根 / 每个乐器缺多少文件）\n"
				+ "  /nbmc reload                 重读 config/nbmachina/instruments.json"));
	}

	/**
	 * M3-36 · `/nbmc samples`：采样库自检。
	 *
	 * <p>换机器、换目录、或别人第一次装完之后跑这条，一眼看出"索引里的采样到底在不在"。
	 * 缺文件的处置写在 {@code docs/INSTALL.md}（一键脚本 {@code tools/install-samples.mjs}）。
	 */
	private static int samples(FabricClientCommandSource src) {
		StringBuilder sb = new StringBuilder("[nbmachina] 采样库：" + NbmachinaSamples.describe() + "\n");
		boolean missing = false;
		for (String line : NbmachinaInstruments.sampleReport()) {
			sb.append("  ").append(line).append('\n');
			if (line.contains("✘")) missing = true;
		}
		src.sendFeedback(Text.literal(sb.toString().trim()));
		if (missing) {
			src.sendFeedback(Text.literal("[nbmachina] 有采样缺失 → 跑 `node tools/install-samples.mjs`（见 docs/INSTALL.md），"
				+ "或把采样库整个放到：" + NbmachinaSamples.candidates().get(0)));
		}
		return missing ? 0 : 1;
	}

	/** M3-30：列出当前音色映射 + 可选乐器 */
	private static int instrumentList(FabricClientCommandSource src) {
		StringBuilder sb = new StringBuilder("[nbmachina] 音色映射（声部 → 乐器，`*` = 全部声部）：\n");
		var ov = NbmachinaInstruments.overrides();
		if (ov.isEmpty()) sb.append("  （未设置：全部按谱面里的乐器播）\n");
		else for (var e : ov.entrySet()) sb.append("  ").append(e.getKey()).append(" → ").append(e.getValue()).append('\n');
		sb.append("  可选乐器：");
		src.sendFeedback(Text.literal(sb.toString()));
		return list(src, null);
	}

	/**
	 * `/nbmc instrument set <声部> <乐器>`；声部写 `all`（或 `*`）= 全部声部一起换。
	 */
	private static int instrumentSet(FabricClientCommandSource src, String voiceArg, String id) {
		String v = voiceArg == null ? "all" : voiceArg.trim().toLowerCase();
		boolean anyVoice = v.equals("all") || v.equals("*") || v.equals("全部");
		String voice = anyVoice ? "*" : v;
		if (NbmachinaInstruments.get(id) == null) {
			src.sendError(Text.literal("[nbmachina] 没有这个乐器：" + id + "（/nbmc instrument 看清单）"));
			return 0;
		}
		NbmachinaInstruments.setOverride(voice, id);
		src.sendFeedback(Text.literal(String.format("[nbmachina] 音色已切换：%s → %s（立即生效，已写入 config/nbmachina/voices.json）",
			anyVoice ? "全部声部" : voice, id)));
		return 1;
	}

	private static int status(FabricClientCommandSource src) {
		src.sendFeedback(Text.literal(String.format(
			"[nbmachina] 引擎就绪=%s 乐器=%d 采样缓存=%d 个/%.0fMB 活跃声部=%d 峰值=%d 已播=%d 丢弃=%d 主增益=%.2f\n"
				+ "  收到 %d 条 nbmachina:play（带时值 %d 条）；上下文重建 %d 次；被抢声部 %d；八度折叠 %d\n"
				+ "  放音：按谱面时值 %d 次 / 旧规则（低音单声部+同键重击）%d 次\n"
				+ "  客户端高精度播放：%s 谱面 %d 颗 / 已调度 %d / 发声 %d / 跳过 %d / 抖动 均 %.2fms 最大 %.2fms；音频队列延迟 %.2fms\n"
				+ "  音色映射（声部→乐器，`*`=全部）：%s\n"
				+ "  OpenAL：%s\n"
				+ "  资源包：%s%s",
			NbmachinaAudio.ready(), NbmachinaInstruments.size(), NbmachinaAudio.bufferCount(),
			NbmachinaAudio.cachedBytes() / 1048576.0, NbmachinaAudio.activeCount(), NbmachinaAudio.peakActive(),
			NbmachinaAudio.playedCount(), NbmachinaAudio.droppedCount(), NbmachinaAudio.masterGain(),
			NbmachinaAudio.receivedCount(), NbmachinaAudio.withDurationCount(),
			NbmachinaAudio.restartCount(), NbmachinaAudio.stolenCount(),
			NbmachinaAudio.foldedCount(),
			NbmachinaAudio.releasedByScore(), NbmachinaAudio.dampedCount(),
			NbmachinaClientPlayer.isPlaying() ? String.format("进行中 %.1fs；", NbmachinaClientPlayer.elapsed()) : "空闲；",
			NbmachinaClientPlayer.noteCount(), NbmachinaClientPlayer.scheduledCount(),
			NbmachinaClientPlayer.playedCount(), NbmachinaClientPlayer.skippedCount(),
			NbmachinaClientPlayer.meanJitterMs(), NbmachinaClientPlayer.maxJitterMs(),
			NbmachinaAudio.lastTaskLatencyMs(),
			NbmachinaInstruments.overrides().isEmpty() ? "（未设置，按谱面原值）" : NbmachinaInstruments.overrides().toString(),
			NbmachinaAudio.alInfo(),
			packHint(),
			NbmachinaAudio.lastError() == null ? "" : "；最后错误：" + NbmachinaAudio.lastError())));
		return 1;
	}

	/**
	 * M3-29：客户端高精度播放。自己读游戏目录的 `nbmachina/score.csv`（与服务端部署的是同一份），
	 * 用 nanoTime 逐颗发声——分辨率不受服务器刻率（20 tps=50ms / 100 tps=10ms）限制。
	 */
	private static int play(FabricClientCommandSource src, double fromSec) {
		java.nio.file.Path file = net.fabricmc.loader.api.FabricLoader.getInstance().getGameDir()
			.resolve("nbmachina").resolve("score.csv");
		try {
			int n = NbmachinaClientPlayer.load(file);
			if (!NbmachinaAudio.ready()) {
				src.sendError(Text.literal("[nbmachina] 音频引擎还没就绪（/nbmc status 看详情）"));
				return 0;
			}
			if (!NbmachinaClientPlayer.start(fromSec)) {
				src.sendError(Text.literal("[nbmachina] 没有可用谱面：" + file));
				return 0;
			}
			src.sendFeedback(Text.literal(String.format(
				"[nbmachina] 客户端高精度播放：%d 颗音，从 %.1fs 开始（不受服务器刻率限制）", n, fromSec)));
			return 1;
		} catch (java.io.IOException e) {
			src.sendError(Text.literal("[nbmachina] 谱面读取失败：" + e.getMessage()));
			return 0;
		}
	}

	/**
	 * 资源包是否启用（`nbmachina_resources.zip`）。
	 *
	 * <p>为什么值得单独报：**老链路**（数据包/`/playsound` 播 `nbmachina:*`）完全依赖这个包——
	 * 实测 2026-09-15 09:22 有一次资源重载没带上它，客户端立刻刷了 54 条
	 * `Unable to play unknown soundEvent: nbmachina:*`（机器那段时间是哑的）。
	 * 新链路（`nbmachina:play` → 我们的 OpenAL 引擎）不吃资源包，所以这条只影响老链路。
	 */
	private static String packHint() {
		try {
			boolean enabled = MinecraftClient.getInstance().getResourcePackManager().getEnabledIds().stream()
				.anyMatch(id -> id.contains("nbmachina_resources"));
			return enabled
				? "nbmachina_resources.zip 已启用（老链路可用）"
				: "**未启用** —— 老链路（数据包 /playsound）会静音；无损引擎不受影响";
		} catch (Throwable t) {
			return "状态未知（" + t.getClass().getSimpleName() + "）";
		}
	}

	private static int reload(FabricClientCommandSource src) {
		int n = NbmachinaInstruments.reload();
		NbmachinaInstruments.loadVoices();
		src.sendFeedback(Text.literal(n >= 0
			? "[nbmachina] 乐器库已重新加载：" + n + " 个；音色映射 " + NbmachinaInstruments.overrides()
			: "[nbmachina] 加载失败：" + NbmachinaInstruments.lastError()));
		return n >= 0 ? 1 : 0;
	}

	/**
	 * M3-33：乐器库列表。70 件之后一条消息塞不下，所以默认只报**分组统计**，
	 * 想看具体 id 用 `/nbmc instruments <关键字>`（匹配 id，最多列 25 条）。
	 */
	private static int list(FabricClientCommandSource src, String filter) {
		var all = NbmachinaInstruments.all();
		if (all.isEmpty()) {
			src.sendError(Text.literal("[nbmachina] 没有乐器：" + NbmachinaInstruments.lastError()));
			return 0;
		}
		if (filter == null || filter.isBlank()) {
			Map<String, Integer> byGroup = new java.util.LinkedHashMap<>();
			for (var inst : all) byGroup.merge(groupOf(inst.id), 1, Integer::sum);
			StringBuilder head = new StringBuilder("[nbmachina] 已加载 " + all.size() + " 件乐器（VSCO 2 CE 全集已入库 / CC0）：");
			for (var e : byGroup.entrySet()) head.append("\n  ").append(e.getKey()).append(" ").append(e.getValue()).append(" 件");
			head.append("\n  用 /nbmc instruments <关键字> 看具体 id（例：violin / trumpet / organ / timpani）");
			src.sendFeedback(Text.literal(head.toString()));
			return all.size();
		}
		String key = filter.toLowerCase();
		List<String> hits = new ArrayList<>();
		for (var inst : all) if (inst.id.contains(key)) hits.add(inst.id + "（" + inst.regions.size() + "）");
		if (hits.isEmpty()) {
			src.sendError(Text.literal("[nbmachina] 没有匹配「" + filter + "」的乐器"));
			return 0;
		}
		StringBuilder sb = new StringBuilder("[nbmachina] 已加载 " + all.size() + " 个乐器：");
		for (String h : hits.subList(0, Math.min(25, hits.size()))) sb.append("\n  ").append(h);
		if (hits.size() > 25) sb.append("\n  …还有 ").append(hits.size() - 25).append(" 件");
		src.sendFeedback(Text.literal(sb.toString()));
		return hits.size();
	}

	/** 从 id 猜乐器组（只用于列表显示） */
	private static String groupOf(String id) {
		if (id.startsWith("vsco_violin") || id.startsWith("vsco_viola") || id.startsWith("vsco_cello")
			|| id.startsWith("vsco_contrabass") || id.startsWith("vsco_sviolin")) return "Strings";
		if (id.contains("trumpet") || id.contains("fhorn") || id.contains("trombone") || id.contains("tuba")) return "Brass";
		if (id.contains("flute") || id.contains("oboe") || id.contains("clarinet") || id.contains("bassoon")
			|| id.contains("piccolo")) return "Woodwinds";
		if (id.contains("organ") || id.contains("piano") || id.contains("upright")) return "Keys";
		if (id.contains("timpani") || id.contains("glocken") || id.contains("marimba") || id.contains("xylophone")
			|| id.contains("tubular") || id.contains("perc")) return "Percussion";
		return "其他";
	}

	private static int note(FabricClientCommandSource src, String instrument, int midi, int velocity) {
		if (NbmachinaInstruments.get(instrument) == null) {
			src.sendError(Text.literal("[nbmachina] 没有这个乐器：" + instrument + "（先 /nbmc instruments 看列表）"));
			return 0;
		}
		ClientPlayerEntity player = src.getPlayer();
		NbmachinaAudio.play(instrument, "manual", midi, velocity, 0, player.getX(), player.getY(), player.getZ());
		src.sendFeedback(Text.literal(String.format(
			"[nbmachina] 本地试听 %s midi=%d vel=%d（增益 %.3f）", instrument, midi, velocity,
			NbmachinaInstruments.velocityGain(velocity))));
		return 1;
	}

	private static String defaultInstrument() {
		for (var inst : NbmachinaInstruments.all()) {
			if (inst.isDefault) return inst.id;
		}
		var all = NbmachinaInstruments.all();
		return all.isEmpty() ? "salamander48" : all.iterator().next().id;
	}

	/** 一键试听：C4–G4–C5–E5–G5，三档力度各来一遍（听力度层差别 & 引擎是否通了） */
	private static int demo(FabricClientCommandSource src, String instrument) {
		if (NbmachinaInstruments.get(instrument) == null) {
			src.sendError(Text.literal("[nbmachina] 没有这个乐器：" + instrument + "（先 /nbmc instruments）"));
			return 0;
		}
		ClientPlayerEntity player = src.getPlayer();
		int[] notes = {60, 67, 72, 76, 79};
		int[] vels = {30, 70, 110};
		NbmachinaMod.LOGGER.info("[nbmachina] demo {} @ {}/{}/{}", instrument, player.getX(), player.getY(), player.getZ());
		// 0.35s 一颗，依次 低/中/高 力度——与离线渲染同一套（力度→采样层 + 增益）映射
		new Thread(() -> {
			try {
				for (int v : vels) {
					for (int midi : notes) {
						NbmachinaAudio.play(instrument, "manual", midi, v, 0, player.getX(), player.getY(), player.getZ());
						Thread.sleep(350L);
					}
				}
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
			}
		}, "nbmachina-demo").start();
		src.sendFeedback(Text.literal("[nbmachina] 试听 " + instrument + "：C4 G4 C5 E5 G5 × 力度 30/70/110"));
		return 1;
	}

	/**
	 * 单音自检（远程诊断用）：把"用哪个采样文件、解码参数、上传后的 AL 状态"全打出来。
	 * 出问题时把这几行发回即可定位（不用翻客户端日志）。
	 */
	private static int selftest(FabricClientCommandSource src, String instrument, int midi, int velocity) {
		var inst = NbmachinaInstruments.get(instrument);
		if (inst == null) {
			src.sendError(Text.literal("[nbmachina] 没有这个乐器：" + instrument));
			return 0;
		}
		var region = inst.pick(midi, velocity);
		if (region == null) {
			src.sendError(Text.literal("[nbmachina] " + instrument + " 里没有可用区域"));
			return 0;
		}
		String file = region.file;
		// M3-38b：索引里是**相对采样根**的路径，必须先按 NbmachinaSamples 解析成实际文件，
		// 否则这里会误报"存在=false / 解码失败"（声音其实正常，只是自检看错了文件）。
		java.nio.file.Path resolved = NbmachinaSamples.resolve(file);
		String shown = resolved == null ? String.valueOf(file) : resolved.toString();
		boolean exists = resolved != null && java.nio.file.Files.isRegularFile(resolved);
		String decode;
		try {
			var pcm = NbmachinaWav.read(resolved);
			decode = String.format("%dch / %dHz / %.2fs / %d 帧", pcm.channels(), pcm.sampleRate(), pcm.seconds(), pcm.frames());
		} catch (Exception e) {
			decode = "解码失败：" + e.getClass().getSimpleName() + ": " + e.getMessage();
		}
		src.sendFeedback(Text.literal(String.format(
			"[nbmachina] selftest %s midi=%d vel=%d\n  采样=%s（存在=%s）\n  区域：loKey..hiKey=%d..%d root=%d 力度 %d..%d 增益%+.1fdB\n  解码：%s\n  引擎就绪=%s 主增益=%.2f",
			instrument, midi, velocity, shown, exists,
			region.loKey, region.hiKey, region.root, region.loVel, region.hiVel, region.gainDb,
			decode, NbmachinaAudio.ready(), NbmachinaAudio.masterGain())));

		ClientPlayerEntity player = src.getPlayer();
		NbmachinaAudio.play(instrument, "manual", midi, velocity, 0, player.getX(), player.getY(), player.getZ());
		MinecraftClient client = MinecraftClient.getInstance();
		new Thread(() -> {
			try {
				Thread.sleep(1200L);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
			client.execute(() -> src.sendFeedback(Text.literal(String.format(
				"[nbmachina] selftest 1.2s 后：采样缓存=%d 个（%.0fMB）活跃声部=%d 已播=%d 丢弃=%d%s",
				NbmachinaAudio.bufferCount(), NbmachinaAudio.cachedBytes() / 1048576.0, NbmachinaAudio.activeCount(),
				NbmachinaAudio.playedCount(), NbmachinaAudio.droppedCount(),
				NbmachinaAudio.lastError() == null ? "" : "；最后错误：" + NbmachinaAudio.lastError()))));
		}, "nbmachina-selftest").start();
		return 1;
	}
}
