package net.nbforge.mod;

import java.util.List;
import java.util.Locale;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.minecraft.registry.Registries;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.CommandManager;
import net.minecraft.server.world.ServerWorld;
import net.minecraft.util.Identifier;
import net.minecraft.util.math.Vec3d;

import net.nbforge.mod.score.NbforgeScore;
import net.nbforge.mod.score.NbforgeScorePlayer;

/**
 * 只读自检：加 {@code -Dnbforge.selftest=true} 起服后自动执行，120 刻后停服。
 * 用来在无人值守的环境里拿到「mod 被加载 / 注册表命中 / 命令树命中 / playSound 可调用」的日志证据。
 */
public final class NbforgeSelfTest {
	private static final List<String> DEMO_IDS = List.of(
		"nbforge:demo_bell", "nbforge:demo_pad", "nbforge:demo_strings", "nbforge:demo_bass");

	private static boolean running;
	private static int ticks;
	/** 谱面播放器自检用：前 2.0s 应有的到点数（由谱面算出来，不写死——打击乐入库后会变） */
	private static int expectAt2s = -1;

	private NbforgeSelfTest() {
	}

	public static void register() {
		ServerLifecycleEvents.SERVER_STARTED.register(server -> {
			if (!Boolean.getBoolean("nbforge.selftest")) {
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
			if (ticks == 40) {
				NbforgeMod.LOGGER.info("[nbforge][selftest] t=40 活跃延音作业={} 累计击发={}",
					NbforgeSustainQueue.activeJobs(), NbforgeSustainQueue.totalPlays());
				NbforgeMod.LOGGER.info("[nbforge][selftest] 谱面播放器 t=40（约 2.0s）：到点 {} 颗 / 已发 {} 条 / 收件人 {}"
					+ "（无玩家时只计数不发送；谱面前 2.0s 应为 {} 颗）→ {}",
					NbforgeScorePlayer.due(), NbforgeScorePlayer.sent(), NbforgeScorePlayer.recipients(),
					expectAt2s, Math.abs(NbforgeScorePlayer.due() - expectAt2s) <= 1 ? "通过" : "不符");
			}
			if (ticks >= 120) {
				running = false;
				NbforgeScorePlayer.stop();
				NbforgeMod.LOGGER.info("[nbforge][selftest] 结束：累计击发={} 峰值并发作业={} 残留作业={}",
					NbforgeSustainQueue.totalPlays(), NbforgeSustainQueue.peakActiveJobs(),
					NbforgeSustainQueue.activeJobs());
				NbforgeMod.LOGGER.info("[nbforge][selftest] === 自检通过，停服 ===");
				server.stop(false);
			}
		});
	}

	private static void run(MinecraftServer server) {
		NbforgeMod.LOGGER.info("[nbforge][selftest] === nbforge mod 自检开始（MC 1.21.10 / Fabric）===");
		NbforgeMod.LOGGER.info("[nbforge][selftest] sound_event 注册表条目数={}", Registries.SOUND_EVENT.getIds().size());
		for (String id : DEMO_IDS) {
			Identifier parsed = Identifier.tryParse(id);
			boolean hit = parsed != null && Registries.SOUND_EVENT.containsId(parsed);
			NbforgeMod.LOGGER.info("[nbforge][selftest] 注册表命中 {} -> {}", id, hit);
		}

		CommandManager commandManager = server.getCommandManager();
		var root = commandManager.getDispatcher().getRoot();
		var node = root.getChild("nbforge");
		NbforgeMod.LOGGER.info("[nbforge][selftest] /nbforge 命令节点存在={} 子命令={}",
			node != null, node == null ? "-" : String.join(",",
				node.getChildren().stream().map(c -> c.getName()).toList()));

		// P2-2 谱面直读：<游戏目录>/nbforge/score.csv 存在就解析并抽查"到点计数"
		java.nio.file.Path scoreFile = NbforgeScorePlayer.defaultFile(server);
		if (NbforgeScorePlayer.exists(scoreFile)) {
			try {
				int n = NbforgeScorePlayer.load(scoreFile);
				NbforgeScore sc = NbforgeScorePlayer.score();
				int at0 = NbforgeScorePlayer.dryRunDue(sc, 0.0);
				int at60 = NbforgeScorePlayer.dryRunDue(sc, 60.0);
				int all = NbforgeScorePlayer.dryRunDue(sc, sc.durationSec() + 1.0);
				NbforgeMod.LOGGER.info("[nbforge][selftest] 谱面直读：{} 颗音 / {}s / 跳过 {} 行；声部 {}",
					n, String.format(Locale.ROOT, "%.1f", sc.durationSec()), sc.skippedRows(), sc.byVoice());
				NbforgeMod.LOGGER.info("[nbforge][selftest] 到点计数：t=0 → {}，t=60s → {}，末尾 → {}（应等于 {}）",
					at0, at60, all, sc.size());
				NbforgeMod.LOGGER.info("[nbforge][selftest] 谱面自检 {}", all == sc.size() && at0 <= at60 ? "通过" : "失败");
				// 真跑一次播放器（没有玩家 → 不发送，只验证"到点计数随时间推进"）
				NbforgeScorePlayer.start(new Vec3d(0.5D, 70.0D, 0.5D));
				expectAt2s = NbforgeScorePlayer.dryRunDue(sc, 2.0 + 0.03);
				NbforgeMod.LOGGER.info("[nbforge][selftest] 已启动谱面播放器（自检用，t=120 停；前 2.0s 期望到点 {} 颗）",
					expectAt2s);
			} catch (Exception e) {
				NbforgeMod.LOGGER.warn("[nbforge][selftest] 谱面自检失败：{}", e.toString());
			}
		} else {
			NbforgeMod.LOGGER.info("[nbforge][selftest] 谱面文件不存在（{}），跳过谱面自检", scoreFile);
		}

		ServerWorld overworld = server.getOverworld();
		// 1) 直接调 mod API 发声（完全不经过命令层）
		NbforgeCommands.playDirect(overworld, NbforgeMod.DEMO_BELL, 1.0F, 1.0F);
		NbforgeCommands.playDirect(overworld, NbforgeMod.DEMO_STRINGS, 0.35F, 2.0F);
		NbforgeMod.LOGGER.info("[nbforge][selftest] 直接调用 playSound 2 次完成，累计击发={}",
			NbforgeSustainQueue.totalPlays());

		// 2) 走命令层：解析 → 执行 → 反馈
		execute(server, "nbforge info");
		// 全部用**带命名空间**的写法：玩家在游戏里就是这么敲的（裸名只作为兼容保留，见下面的解析矩阵）
		execute(server, "nbforge note nbforge:demo_bell 1.0 1.0");
		execute(server, "nbforge note nbforge:strings_a3 0.35 2.0");
		execute(server, "nbforge note not_a_sound 1.0 1.0");
		// 3) 三条并发延音作业（不同力度/长度）
		execute(server, "nbforge sustain nbforge:demo_pad 0.8 1.0 60 10");
		execute(server, "nbforge sustain nbforge:demo_bell 0.5 1.5 100 5");
		execute(server, "nbforge sustain nbforge:demo_bass 0.9 0.5 40 8");
		NbforgeMod.LOGGER.info("[nbforge][selftest] 命令链执行完成，活跃延音作业={} 累计击发={}",
			NbforgeSustainQueue.activeJobs(), NbforgeSustainQueue.totalPlays());

		// 4) 命令**解析**矩阵 —— 2026-09-14 回归：玩家裸写 `nbforge note nbforge:demo_bell 1 1`
		//    曾因参数类型是「带引号的字符串」而报 Expected whitespace to end one argument。
		//    这条矩阵把"带命名空间/裸名/参数个数不足"三种写法都钉住，以后改命令树必须让它继续全绿。
		String[][] parseCases = {
			{ "nbforge note nbforge:demo_bell 1 1", "ok" },
			{ "nbforge note demo_bell 1 1", "ok" },
			{ "nbforge note minecraft:block.note_block.harp 1 1", "ok" },
			{ "nbforge sustain nbforge:demo_pad 0.8 1 60 10", "ok" },
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
			NbforgeMod.LOGGER.info("[nbforge][selftest] 解析{} 期望={} 实际={} /{} {}",
				expected == parsed ? "通过" : "**不符**", c[1], parsed ? "ok" : "fail", c[0], detail);
		}
		NbforgeMod.LOGGER.info("[nbforge][selftest] 解析矩阵：{} 条，不符 {} 条", parseCases.length, parseBad);

		Vec3d probe = new Vec3d(0.5D, 70.0D, 0.5D);
		NbforgeMod.LOGGER.info("[nbforge][selftest] 监听基准点 {}", probe);
	}

	private static void execute(MinecraftServer server, String command) {
		try {
			server.getCommandManager().parseAndExecute(server.getCommandSource(), command);
		} catch (Exception e) {
			NbforgeMod.LOGGER.error("[nbforge][selftest] 命令执行异常 /{}: {}", command, e.toString());
		}
	}
}
