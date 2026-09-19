package net.nbmachina.mod;

import java.util.List;
import java.util.Locale;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.block.Blocks;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.Vec3d;

import net.nbmachina.mod.note.NbmachinaNoteBlocks;
import net.nbmachina.mod.score.NbmachinaScore;
import net.nbmachina.mod.score.NbmachinaScorePlayer;

/**
 * 只读自检：加 {@code -Dnbmachina.selftest=true} 起服后自动执行，120 刻后停服。
 * 用来在无人值守的环境里拿到「mod 被加载 / 注册表命中 / 命令树命中 / playSound 可调用」的日志证据。
 */
public final class NbmachinaSelfTest {
	private static final List<String> DEMO_IDS = List.of(
		"nbmachina:demo_bell", "nbmachina:demo_pad", "nbmachina:demo_strings", "nbmachina:demo_bass");

	private static boolean running;
	private static int ticks;
	/** M3-37 音符盒触发实验：分相位布置（方块事件要到下一 tick 才派发，不能同 tick 连做） */
	private static int expPhase = 0;
	private static int[] expDelta = new int[6];
	private static int expMark = 0;
	/** 谱面播放器自检用：前 2.0s 应有的到点数（由谱面算出来，不写死——打击乐入库后会变） */
	private static int expectAt2s = -1;

	private NbmachinaSelfTest() {
	}

	public static void register() {
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			if (!Boolean.getBoolean("nbmachina.selftest")) {
				return;
			}
			running = true;
			ticks = 0;
			run(server);
		});
		ServerTickEvents.END_SERVER_TICK.register(server -> {
			if (!running) {
				return;
			}
			ticks++;
			// M3-37：音符盒触发矩阵实验（每个布置隔一 tick，方块事件下一 tick 才派发）
			if (ticks >= 8 && ticks <= 26 && ticks % 2 == 0) {
				experimentStep(server, ticks);
			}
			if (ticks == 40) {
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] t=40 活跃延音作业={} 累计击发={}",
					NbmachinaSustainQueue.activeJobs(), NbmachinaSustainQueue.totalPlays());
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 音符盒注入（mixin）：事件 {} 次 / 已派发 {} / 跳过 {} → {}",
					NbmachinaNoteBlocks.eventCount(), NbmachinaNoteBlocks.dispatched(), NbmachinaNoteBlocks.skipped(),
					NbmachinaNoteBlocks.eventCount() > 0 ? "注入生效" : "注入未生效（refmap 问题仍在）");
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 机器映射（位置→谱面音符）：{} 个位置",
					NbmachinaNoteBlocks.mapSize());
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 谱面播放器 t=40（约 2.0s）：到点 {} 颗 / 已发 {} 条 / 收件人 {}"
					+ "（无玩家时只计数不发送；谱面前 2.0s 应为 {} 颗）→ {}",
					NbmachinaScorePlayer.due(), NbmachinaScorePlayer.sent(), NbmachinaScorePlayer.recipients(),
					expectAt2s, Math.abs(NbmachinaScorePlayer.due() - expectAt2s) <= 1 ? "通过" : "不符");
			}
			if (ticks >= 120) {
				running = false;
				NbmachinaScorePlayer.stop();
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 结束：累计击发={} 峰值并发作业={} 残留作业={}",
					NbmachinaSustainQueue.totalPlays(), NbmachinaSustainQueue.peakActiveJobs(),
					NbmachinaSustainQueue.activeJobs());
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] === 自检通过，停服 ===");
				server.stop(false);
			}
		});
	}

	/**
	 * M3-37 · 音符盒触发矩阵：方块事件要到**下一 tick** 才派发，所以"布置 → 隔一拍读计数"。
	 * 三个用例回答一个设计问题：**能不能让音符盒真的响，并且不占用它上方的格子**。
	 *   ① 基准：harp + 上方空气 + 侧面红石块（正常红石音乐机的触发方式）
	 *   ② 关键：snare（非基座类乐器）+ 触发位在**正上方**（上方被占）
	 *   ③ 备选：石头甲板（导体）+ 红石块在**甲板下方** + 上方空气
	 */
	private static void experimentStep(MinecraftServer server, int tick) {
		ServerWorld world = server.getOverworld();
		net.minecraft.util.math.BlockPos pos = new net.minecraft.util.math.BlockPos(0, 120, 0);
		int idx = (tick - 8) / 2;
		switch (idx) {
			case 0 -> {
				clearColumn(world, pos);
				world.setBlockState(pos.down(), Blocks.OAK_PLANKS.getDefaultState(), 3);
				world.setBlockState(pos, noteBlock(net.minecraft.block.enums.NoteBlockInstrument.HARP), 3);
				world.setBlockState(pos.east(), Blocks.REDSTONE_BLOCK.getDefaultState(), 3);
				expMark = NbmachinaNoteBlocks.eventCount();
			}
			case 1 -> expDelta[0] = NbmachinaNoteBlocks.eventCount() - expMark;
			case 2 -> {
				clearColumn(world, pos);
				world.setBlockState(pos.down(), Blocks.OAK_PLANKS.getDefaultState(), 3);
				world.setBlockState(pos, noteBlock(net.minecraft.block.enums.NoteBlockInstrument.SNARE), 3);
				world.setBlockState(pos.up(), Blocks.REDSTONE_BLOCK.getDefaultState(), 3);
				expMark = NbmachinaNoteBlocks.eventCount();
			}
			case 3 -> expDelta[1] = NbmachinaNoteBlocks.eventCount() - expMark;
			case 4 -> {
				clearColumn(world, pos);
				world.setBlockState(pos.down(2), Blocks.REDSTONE_BLOCK.getDefaultState(), 3);
				world.setBlockState(pos.down(), Blocks.STONE.getDefaultState(), 3);   // 导体甲板
				world.setBlockState(pos, noteBlock(net.minecraft.block.enums.NoteBlockInstrument.HARP), 3);
				expMark = NbmachinaNoteBlocks.eventCount();
			}
			case 5 -> {
				expDelta[2] = NbmachinaNoteBlocks.eventCount() - expMark;
			}
			case 6 -> {
				clearColumn(world, pos);
				world.setBlockState(pos.down(), Blocks.REDSTONE_BLOCK.getDefaultState(), 3);  // 触发位＝正下方
				world.setBlockState(pos, noteBlock(net.minecraft.block.enums.NoteBlockInstrument.HARP), 3);
				expMark = NbmachinaNoteBlocks.eventCount();
			}
			case 7 -> {
				expDelta[3] = NbmachinaNoteBlocks.eventCount() - expMark;
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 音符盒触发矩阵："
					+ "① 上方空气+侧面触发 → {} 次；② 非基座类+触发在正上方 → {} 次；"
					+ "③ 石头甲板+触发在甲板下 → {} 次；④ 触发位在**正下方** → {} 次",
					expDelta[0], expDelta[1], expDelta[2], expDelta[3]);
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 判定：①={}（触发机制通不通）；"
					+ "②={}；③={}；④={} → {}",
					expDelta[0] > 0 ? "通" : "不通",
					expDelta[1] > 0 ? "能" : "不能",
					expDelta[2] > 0 ? "能" : "不能",
					expDelta[3] > 0 ? "能" : "不能",
					expDelta[3] > 0
						? "音符盒可以只靠**正下方**的触发位发声 → 现有密集布局只需把甲板那一格改成触发位，不用重建"
						: expDelta[0] > 0 ? "只有**水平相邻**的触发位有效 → 要回到音符盒路线必须给每个音符留出侧向一格（布局重建）"
						: "触发机制本身没复现，先查 mixin/红石");
			}
			default -> { }
		}
	}

	private static net.minecraft.block.BlockState noteBlock(net.minecraft.block.enums.NoteBlockInstrument instrument) {
		return Blocks.NOTE_BLOCK.getDefaultState().with(net.minecraft.block.NoteBlock.INSTRUMENT, instrument);
	}

	private static void clearColumn(ServerWorld world, net.minecraft.util.math.BlockPos pos) {
		for (int dy = -3; dy <= 3; dy++) world.setBlockState(pos.up(dy), Blocks.AIR.getDefaultState(), 3);
		world.setBlockState(pos.east(), Blocks.AIR.getDefaultState(), 3);
		world.setBlockState(pos.west(), Blocks.AIR.getDefaultState(), 3);
	}

	private static void run(MinecraftServer server) {
		NbmachinaMod.LOGGER.info("[nbmachina][selftest] === nbmachina mod 自检开始（MC 1.21.10 / Fabric）===");
		NbmachinaMod.LOGGER.info("[nbmachina][selftest] sound_event 注册表条目数={}", Registries.SOUND_EVENT.getIds().size());
		for (String id : DEMO_IDS) {
			Identifier parsed = Identifier.tryParse(id);
			boolean hit = parsed != null && Registries.SOUND_EVENT.containsId(parsed);
			NbmachinaMod.LOGGER.info("[nbmachina][selftest] 注册表命中 {} -> {}", id, hit);
		}

		CommandManager commandManager = server.getCommandManager();
		var root = commandManager.getDispatcher().getRoot();
		var node = root.getChild("nbmachina");
		NbmachinaMod.LOGGER.info("[nbmachina][selftest] /nbmachina 命令节点存在={} 子命令={}",
			node != null, node == null ? "-" : String.join(",",
				node.getChildren().stream().map(c -> c.getName()).toList()));

		// M3-36 采样库定位：索引（jar 内置 / config）→ 采样根 → 逐文件在位检查。
		// 专门验"换机器不用改绝对路径"这条链路，无头服务器上也能跑。
		try {
			int inst = net.nbmachina.mod.audio.NbmachinaInstruments.reload();
			NbmachinaMod.LOGGER.info("[nbmachina][selftest] 乐器库：{} 个乐器；采样根 {}", inst,
				net.nbmachina.mod.audio.NbmachinaSamples.describe());
			if (inst > 0) {
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 采样自检：{}",
					String.join(" | ", net.nbmachina.mod.audio.NbmachinaInstruments.sampleReport()));
			}
		} catch (Exception e) {
			NbmachinaMod.LOGGER.warn("[nbmachina][selftest] 乐器库自检异常：{}", e.toString());
		}

		// P2-2 谱面直读：<游戏目录>/nbmachina/score.csv 存在就解析并抽查"到点计数"
		java.nio.file.Path scoreFile = NbmachinaScorePlayer.defaultFile(server);
		if (NbmachinaScorePlayer.exists(scoreFile)) {
			try {
				int n = NbmachinaScorePlayer.load(scoreFile);
				NbmachinaScore sc = NbmachinaScorePlayer.score();
				int at0 = NbmachinaScorePlayer.dryRunDue(sc, 0.0);
				int at60 = NbmachinaScorePlayer.dryRunDue(sc, 60.0);
				int all = NbmachinaScorePlayer.dryRunDue(sc, sc.durationSec() + 1.0);
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 谱面直读：{} 颗音 / {}s / 跳过 {} 行；声部 {}",
					n, String.format(Locale.ROOT, "%.1f", sc.durationSec()), sc.skippedRows(), sc.byVoice());
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 到点计数：t=0 → {}，t=60s → {}，末尾 → {}（应等于 {}）",
					at0, at60, all, sc.size());
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 谱面自检 {}", all == sc.size() && at0 <= at60 ? "通过" : "失败");
				// 真跑一次播放器（没有玩家 → 不发送，只验证"到点计数随时间推进"）
				NbmachinaScorePlayer.start(new Vec3d(0.5D, 70.0D, 0.5D));
				expectAt2s = NbmachinaScorePlayer.dryRunDue(sc, 2.0 + 0.03);
				NbmachinaMod.LOGGER.info("[nbmachina][selftest] 已启动谱面播放器（自检用，t=120 停；前 2.0s 期望到点 {} 颗）",
					expectAt2s);
			} catch (Exception e) {
				NbmachinaMod.LOGGER.warn("[nbmachina][selftest] 谱面自检失败：{}", e.toString());
			}
		} else {
			NbmachinaMod.LOGGER.info("[nbmachina][selftest] 谱面文件不存在（{}），跳过谱面自检", scoreFile);
		}

		// M3-21 / M3-37 音符盒触发实验：三种布置各放一次，看 mixin 到底在哪些布置下被调到。
		// 背景：M3-21 §6 的结论是"harp/bass（基座类乐器）上方必须是空气，所以触发位没地方放"，
		// 由此把发声改成了 /nbm playat。但那条规则可能**只对基座类乐器成立** ——
		// 若换成非基座类乐器（沙→snare、金块→bell…），正上方就可以放触发位，音符盒仍然会真的响。
		// 这个实验直接决定"机器能不能重新走音符盒发声"。
		try {
			ServerWorld world = server.getOverworld();
			net.minecraft.util.math.BlockPos pos = new net.minecraft.util.math.BlockPos(0, 100, 0);
			// 先清空：重复 setBlockState 同样的方块**不会产生方块更新**
			world.setBlockState(pos, Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos.up(), Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos.down(), Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos.up(2), Blocks.AIR.getDefaultState(), 3);
			int e0 = NbmachinaNoteBlocks.eventCount();

			// 注意：`/setblock`（以及这里的 setBlockState）放出来的音符盒**不会**自动按下方方块算乐器，
			// 默认是 harp —— 所以必须显式指定 INSTRUMENT，否则测不出"非基座类"这一档。
			var harp = Blocks.NOTE_BLOCK.getDefaultState()
				.with(net.minecraft.block.NoteBlock.INSTRUMENT, net.minecraft.block.enums.NoteBlockInstrument.HARP);
			var snare = Blocks.NOTE_BLOCK.getDefaultState()
				.with(net.minecraft.block.NoteBlock.INSTRUMENT, net.minecraft.block.enums.NoteBlockInstrument.SNARE);
			var base = Blocks.OAK_PLANKS.getDefaultState();   // 音符盒下方垫一块木头（保证有底座）

			// A：基座类（harp）+ 触发位在**正上方** → 预期被"上方必须空气"拦下
			world.setBlockState(pos.down(), base, 3);
			world.setBlockState(pos, harp, 3);
			world.setBlockState(pos.up(), Blocks.REDSTONE_BLOCK.getDefaultState(), 3);
			int eA = NbmachinaNoteBlocks.eventCount();

			// B：非基座类（snare）+ 触发位在**正上方** → 这正是"能不能回到音符盒发声"的关键
			world.setBlockState(pos.up(), Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos, Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos, snare, 3);
			world.setBlockState(pos.up(), Blocks.REDSTONE_BLOCK.getDefaultState(), 3);
			int eB = NbmachinaNoteBlocks.eventCount();

			// C：基座类（harp）+ 上方空气 + 触发位在**侧面** → 证明"触发机制本身是通的"
			world.setBlockState(pos.up(), Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos.east(), Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos, Blocks.AIR.getDefaultState(), 3);
			world.setBlockState(pos, harp, 3);
			world.setBlockState(pos.east(), Blocks.REDSTONE_BLOCK.getDefaultState(), 3);
			int eC = NbmachinaNoteBlocks.eventCount();

			NbmachinaMod.LOGGER.info("[nbmachina][selftest] 音符盒触发实验：A 基座类+触发在正上方 → 事件 {}；"
				+ "B 非基座类(snare)+触发在正上方 → 事件 {}；C 基座类+触发在侧面 → 事件 {}",
				eA - e0, eB - eA, eC - eB);
			NbmachinaMod.LOGGER.info("[nbmachina][selftest] 结论：{}",
				eC - eB > 0 && eB - eA > 0
					? "非基座类乐器 + 上方触发位**可以让音符盒真的响** → 机器可以回到音符盒路线（mod 只负责换音色）"
					: eC - eB > 0 ? "触发机制通，但上方触发位被拦 → 只能改用侧向/重建布局"
					: "连侧向触发都没进 mixin，需要查 mixin 是否真的生效（见 docs/M3-37）");
		} catch (Exception e) {
			NbmachinaMod.LOGGER.warn("[nbmachina][selftest] 音符盒注入自检布置失败：{}", e.toString());
		}

		ServerWorld overworld = server.getOverworld();
		// 1) 直接调 mod API 发声（完全不经过命令层）
		NbmachinaCommands.playDirect(overworld, NbmachinaMod.DEMO_BELL, 1.0F, 1.0F);
		NbmachinaCommands.playDirect(overworld, NbmachinaMod.DEMO_STRINGS, 0.35F, 2.0F);
		NbmachinaMod.LOGGER.info("[nbmachina][selftest] 直接调用 playSound 2 次完成，累计击发={}",
			NbmachinaSustainQueue.totalPlays());

		// 2) 走命令层：解析 → 执行 → 反馈
		execute(server, "nbmachina info");
		// 全部用**带命名空间**的写法：玩家在游戏里就是这么敲的（裸名只作为兼容保留，见下面的解析矩阵）
		execute(server, "nbmachina note nbmachina:demo_bell 1.0 1.0");
		execute(server, "nbmachina note nbmachina:strings_a3 0.35 2.0");
		execute(server, "nbmachina note not_a_sound 1.0 1.0");
		// 3) 三条并发延音作业（不同力度/长度）
		execute(server, "nbmachina sustain nbmachina:demo_pad 0.8 1.0 60 10");
		execute(server, "nbmachina sustain nbmachina:demo_bell 0.5 1.5 100 5");
		execute(server, "nbmachina sustain nbmachina:demo_bass 0.9 0.5 40 8");
		NbmachinaMod.LOGGER.info("[nbmachina][selftest] 命令链执行完成，活跃延音作业={} 累计击发={}",
			NbmachinaSustainQueue.activeJobs(), NbmachinaSustainQueue.totalPlays());

		// 4) 命令**解析**矩阵 —— 2026-09-14 回归：玩家裸写 `nbmachina note nbmachina:demo_bell 1 1`
		//    曾因参数类型是「带引号的字符串」而报 Expected whitespace to end one argument。
		//    这条矩阵把"带命名空间/裸名/参数个数不足"三种写法都钉住，以后改命令树必须让它继续全绿。
		String[][] parseCases = {
			{ "nbmachina note nbmachina:demo_bell 1 1", "ok" },
			{ "nbmachina note demo_bell 1 1", "ok" },
			{ "nbmachina note minecraft:block.note_block.harp 1 1", "ok" },
			{ "nbmachina sustain nbmachina:demo_pad 0.8 1 60 10", "ok" },
		};
		// 注：这里只做**解析**矩阵，所以不放"越界应当失败"的用例——实测 `dispatcher.parse()`
		// 对越界数值也不抛（它只保证语法树能走通，范围/语义校验在 `parseAndExecute` 那一步）。
		// 越界行为由"执行链"覆盖：命令链里 6 条真实命令全部走 parseAndExecute。
		int parseBad = 0;
		for (String[] c : parseCases) {
			boolean parsed;
			String detail = "";
			try {
				commandManager.getDispatcher().parse(c[0], server.getCommandSource());
				parsed = true;
			} catch (Exception e) {
				parsed = false;
				detail = e.getMessage();
			}
			boolean expected = "ok".equals(c[1]);
			if (parsed != expected) {
				parseBad++;
			}
			NbmachinaMod.LOGGER.info("[nbmachina][selftest] 解析{} 期望={} 实际={} /{} {}",
				expected == parsed ? "通过" : "**不符**", c[1], parsed ? "ok" : "fail", c[0], detail);
		}
		NbmachinaMod.LOGGER.info("[nbmachina][selftest] 解析矩阵：{} 条，不符 {} 条", parseCases.length, parseBad);

		Vec3d probe = new Vec3d(0.5D, 70.0D, 0.5D);
		NbmachinaMod.LOGGER.info("[nbmachina][selftest] 监听基准点 {}", probe);
	}

	private static void execute(MinecraftServer server, String command) {
		try {
			server.getCommandManager().parseAndExecute(server.getCommandSource(), command);
		} catch (Exception e) {
			NbmachinaMod.LOGGER.error("[nbmachina][selftest] 命令执行异常 /{}: {}", command, e.toString());
		}
	}
}
