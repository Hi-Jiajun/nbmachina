package net.nbmachina.mod.machine;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.block.Blocks;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.text.Text;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;
import net.nbmachina.mod.note.NoteDataBlockEntity;

/**
 * M3-98b 第一步 · **扫机器包围盒里的音符盒方块实体**（机器自描述）：
 * 不读 CSV，直接从世界把"这颗音是什么"读出来。这一版只作为**诊断能力**（`/nbmscan`），
 * 先把"扫得对不对"验清楚，再谈把运行时切过来。
 *
 * <p>判据：扫到的音符格数应与谱面一致（水世界 = 3044），其中"有数据"的应占绝大多数；
 * 出现"音符盒但没数据"说明那个方块是旧 jar 放下的（需要 wipe + redo 重新铺一次）。
 */
public final class NbmachinaNoteScan {

	public record Scanned(BlockPos pos, String instrument, String voice, int midi, int velocity, int durMs, double timeSec) {
	}

	private NbmachinaNoteScan() {
	}

	/** 扫描 [from, to] 闭区间内的音符盒；返回 (音符盒格数, 有数据的格数, 无数据的格数, 采样若干条)。 */
	public static void run(ServerCommandSource source, BlockPos from, BlockPos to) {
		World world = source.getWorld();
		int noteBlocks = 0;
		int withData = 0;
		int withoutData = 0;
		List<String> samples = new ArrayList<>();
		List<Scanned> scanned = new ArrayList<>();

		BlockPos.Mutable pos = new BlockPos.Mutable();
		for (int x = from.getX(); x <= to.getX(); x++) {
			for (int z = from.getZ(); z <= to.getZ(); z++) {
				for (int y = from.getY(); y <= to.getY(); y++) {
					pos.set(x, y, z);
					if (!world.getBlockState(pos).isOf(Blocks.NOTE_BLOCK)) {
						continue;
					}
					noteBlocks++;
					BlockEntity be = world.getBlockEntity(pos);
					if (be instanceof NoteDataBlockEntity data && data.hasData()) {
						withData++;
						Scanned s = new Scanned(pos.toImmutable(), data.instrument(), data.voice(),
							data.midi(), data.velocity(), data.durMs(), data.timeSec());
						scanned.add(s);
						if (samples.size() < 5) {
							samples.add(s.pos().toShortString() + " " + s.instrument() + "/" + s.voice()
								+ " midi=" + s.midi() + " vel=" + s.velocity() + " dur=" + s.durMs() + " t=" + s.timeSec());
						}
					} else {
						withoutData++;
					}
				}
			}
		}

		final int nb = noteBlocks, wd = withData, nd = withoutData;
		source.sendFeedback(() -> Text.literal(String.format(
			"[nbmachina] 扫描 %s .. %s → 音符盒 %d 格：有数据 %d / **没数据 %d**",
			from.toShortString(), to.toShortString(), nb, wd, nd)), false);
		if (nd > 0) {
			source.sendFeedback(() -> Text.literal(
				"[nbmachina] 有 " + nd + " 格没数据：它们是旧 jar 放下的音符盒 → 用 /function styx:wipe_notes + styx:redo 重铺一次即可"),
				false);
		}
		for (String s : samples) {
			source.sendFeedback(() -> Text.literal("[nbmachina]   " + s), false);
		}
	}
}
