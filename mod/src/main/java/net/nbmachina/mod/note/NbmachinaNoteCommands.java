package net.nbmachina.mod.note;

import com.mojang.brigadier.CommandDispatcher;
import com.mojang.brigadier.arguments.IntegerArgumentType;
import com.mojang.brigadier.tree.CommandNode;
import net.minecraft.command.argument.BlockPosArgumentType;
import net.minecraft.command.argument.IdentifierArgumentType;
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
				IdentifierArgumentType.getIdentifier(ctx, "instrument").toString(),
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
		CommandNode<ServerCommandSource> instrument = CommandManager.argument("instrument", IdentifierArgumentType.identifier())
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
		data.set(instrument, null, midi, velocity, durMs, -1);
		source.sendFeedback(() -> Text.literal("[nbmachina] 已写入 " + pos.toShortString()
			+ " → " + instrument + " midi=" + midi + " vel=" + velocity + " dur=" + durMs + "ms"), true);
		return 1;
	}
}
