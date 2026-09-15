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
 * </pre>
 */
public final class NbforgeClient implements ClientModInitializer {
	@Override
	public void onInitializeClient() {
		int loaded = NbforgeInstruments.reload();
		NbforgeAudio.start();
		NbforgeMod.LOGGER.info("[nbforge] 客户端入口：乐器 {} 个（{}）", loaded, NbforgeInstruments.lastError());

		ClientPlayNetworking.registerGlobalReceiver(NbforgePlayPayload.ID, (payload, context) ->
			NbforgeAudio.play(payload.instrument(), payload.midi(), payload.velocity(), payload.x(), payload.y(), payload.z()));

		ClientTickEvents.END_CLIENT_TICK.register(NbforgeClient::tick);
		ClientCommandRegistrationCallback.EVENT.register((dispatcher, access) -> dispatcher.register(
			ClientCommandManager.literal("nbfc")
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
									IntegerArgumentType.getInteger(ctx, "velocity")))))))));
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

	private static int status(FabricClientCommandSource src) {
		src.sendFeedback(Text.literal(String.format(
			"[nbforge] 引擎就绪=%s 乐器=%d 采样缓存=%d 个/%.0fMB 活跃声部=%d 峰值=%d 已播=%d 丢弃=%d 主增益=%.2f\n"
				+ "  OpenAL：%s%s",
			NbforgeAudio.ready(), NbforgeInstruments.size(), NbforgeAudio.bufferCount(),
			NbforgeAudio.cachedBytes() / 1048576.0, NbforgeAudio.activeCount(), NbforgeAudio.peakActive(),
			NbforgeAudio.playedCount(), NbforgeAudio.droppedCount(), NbforgeAudio.masterGain(),
			NbforgeAudio.alInfo(),
			NbforgeAudio.lastError() == null ? "" : "；最后错误：" + NbforgeAudio.lastError())));
		return 1;
	}

	private static int reload(FabricClientCommandSource src) {
		int n = NbforgeInstruments.reload();
		src.sendFeedback(Text.literal(n >= 0
			? "[nbforge] 乐器库已重新加载：" + n + " 个"
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
		NbforgeAudio.play(instrument, midi, velocity, player.getX(), player.getY(), player.getZ());
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
						NbforgeAudio.play(instrument, midi, v, player.getX(), player.getY(), player.getZ());
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
		NbforgeAudio.play(instrument, midi, velocity, player.getX(), player.getY(), player.getZ());
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
