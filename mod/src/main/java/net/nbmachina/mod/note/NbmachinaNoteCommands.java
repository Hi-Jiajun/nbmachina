package net.nbmachina.mod.note;

import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;

/**
 * M3-98a · `/nbm notes get|set`：直接读写音符盒的方块实体数据（机器自描述）。
 *
 * <p>有了它就不必手打 `/data get block …`，也方便现场微调某一颗音（音色/音高/力度/时值）。
 */
public final class NbmachinaNoteCommands {

	private NbmachinaNoteCommands() {
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
