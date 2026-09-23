package net.nbmachina.mod.note;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.tree.CommandNode;
import net.minecraft.command.argument.BlockPosArgumentType;
import com.mojang.brigadier.arguments.StringArgumentType;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;

/**
 * M3-98a · `/nbmnotes get|set`：读写音符盒方块实体里的音符数据（机器自描述）。
 *
 * <p>故意**不**挂进 `/nbm` 那棵巨型命令树：独立注册一条根命令，并用中间变量拼装
 * （上一版直接往树里塞嵌套、括号数错了一次，故改写成一眼能数括号的形式）。
 */
public final class NbmachinaNoteCommands {

	private NbmachinaNoteCommands() {
	}

	public static void register(CommandDispatcher<ServerCommandSource> dispatcher) {
		// /nbmnotes get <pos>
		CommandNode<ServerCommandSource> get = CommandManager.literal("get")
			.then(CommandManager.argument("pos", BlockPosArgumentType.blockPos())
				.executes(ctx -> get(ctx.getSource(), BlockPosArgumentType.getBlockPos(ctx, "pos"))))
			.build();

		// /nbmnotes set <pos> <instrument> <midi> <velocity> <durMs>
		CommandNode<ServerCommandSource> durMs = CommandManager.argument("durMs", IntegerArgumentType.integer(0, 60000))
			.executes(ctx -> set(ctx.getSource(),
				BlockPosArgumentType.getBlockPos(ctx, "pos"),
				// M3-98a 自测修正：这里**不能**用 IdentifierArgumentType —— 它会把 `salamander48`
				// 规范化成 `minecraft:salamander48`，破坏 NbmachinaInstruments 的查找。用无空格的 word，
				// 若用户真写了带命名空间的形式，下面 strip 掉前缀。
				stripNamespace(StringArgumentType.getString(ctx, "instrument")),
				IntegerArgumentType.getInteger(ctx, "midi"),
				IntegerArgumentType.getInteger(ctx, "velocity"),
				IntegerArgumentType.getInteger(ctx, "durMs")))
			.build();
		CommandNode<ServerCommandSource> velocity = CommandManager.argument("velocity", IntegerArgumentType.integer(1, 127))
			.then(durMs)
			.build();
		CommandNode<ServerCommandSource> midi = CommandManager.argument("midi", IntegerArgumentType.integer(0, 127))
			.then(velocity)
			.build();
		CommandNode<ServerCommandSource> instrument = CommandManager.argument("instrument", StringArgumentType.word())
			.then(midi)
			.build();
		CommandNode<ServerCommandSource> set = CommandManager.literal("set")
			.then(CommandManager.argument("pos", BlockPosArgumentType.blockPos()).then(instrument))
			.build();

		CommandNode<ServerCommandSource> root = CommandManager.literal("nbmnotes")
			.then(get)
			.then(set)
			.build();
		dispatcher.getRoot().addChild(root);
	}

	public static int get(ServerCommandSource source, BlockPos pos) {
		if (!(source.getWorld().getBlockEntity(pos) instanceof NoteDataBlockEntity data) || !data.hasData()) {
			source.sendError(Text.literal("[nbmachina] " + pos.toShortString() + " 上没有音符数据（不是音符盒，或还没写入）"));
			return 0;
		}
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] %s → instrument=%s voice=%s midi=%d velocity=%d dur_ms=%d time=%.3fs",
			pos.toShortString(), data.instrument(), data.voice(), data.midi(), data.velocity(), data.durMs(), data.timeSec())), false);
		return 1;
	}

	public static int set(ServerCommandSource source, BlockPos pos, String instrument, int midi, int velocity, int durMs) {
		if (!(source.getWorld().getBlockEntity(pos) instanceof NoteDataBlockEntity data)) {
			source.sendError(Text.literal("[nbmachina] " + pos.toShortString() + " 不是「带音符数据的音符盒」——先放音符盒（mod 会给它挂上方块实体）再写"));
			return 0;
		}
		// 保留原有 voice（没有就默认 harp）——voice 是声部层（harp/bass/…），不该被这条命令清掉
		String voice = data.voice() != null ? data.voice() : "harp";
		data.set(instrument, voice, midi, velocity, durMs, data.timeSec());
		source.sendFeedback(() -> Text.literal("[nbmachina] 已写入 " + pos.toShortString()
			+ " → " + instrument + " voice=" + voice + " midi=" + midi + " vel=" + velocity + " dur=" + durMs + "ms"), true);
		return 1;
	}

	/** `minecraft:salamander48` → `salamander48`；没有前缀就原样返回。 */
	private static String stripNamespace(String id) {
		int colon = id.indexOf(':');
		return colon >= 0 ? id.substring(colon + 1) : id;
	}
}
