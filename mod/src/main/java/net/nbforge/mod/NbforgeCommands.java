package net.nbforge.mod;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.FloatArgumentType;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.context.CommandContext;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.minecraft.command.argument.IdentifierArgumentType;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.sound.SoundCategory;
import net.minecraft.sound.SoundEvent;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.Vec3d;

/**
 * 服务端命令入口（Fabric Command API v2）：
 * <pre>
 * /nbforge info
 * /nbforge note &lt;音色id&gt; [音量] [音高]
 * /nbforge sustain &lt;音色id&gt; &lt;音量&gt; &lt;音高&gt; &lt;总刻数&gt; &lt;间隔刻数&gt;
 * /nbforge stopall
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
				.executes(NbforgeCommands::stopAll)));
	}

	private static int info(CommandContext<ServerCommandSource> ctx) {
		ServerCommandSource source = ctx.getSource();
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbforge] 后端 A 骨架在线；活跃延音作业=%d 累计击发=%d 峰值并发=%d",
			NbforgeSustainQueue.activeJobs(),
			NbforgeSustainQueue.totalPlays(),
			NbforgeSustainQueue.peakActiveJobs())), false);
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
}
