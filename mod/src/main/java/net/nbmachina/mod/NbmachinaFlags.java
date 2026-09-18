package net.nbmachina.mod;

import net.minecraft.scoreboard.ReadableScoreboardScore;
import net.minecraft.scoreboard.ScoreHolder;
import net.minecraft.scoreboard.Scoreboard;
import net.minecraft.scoreboard.ScoreboardObjective;
import net.minecraft.server.MinecraftServer;
import net.minecraft.world.World;

/**
 * 数据包 ↔ mod 的开关约定（只读）。
 *
 * <p>约定：目标名固定 {@code styx.flag}，键名写成 {@code #xxx} 的假玩家。
 * 目前只有一个：
 * <ul>
 *   <li>{@link #HIFI} = {@code #hifi}：1 = 用 nbmachina 自研音色（原版音符盒声音被替换成静音，
 *       由数据包 {@code styx:play/hifi/*} 按每音力度播 nbmachina:*）；0/缺省 = 原版音符盒声音。</li>
 * </ul>
 * 读写都在服务端（客户端世界 {@code getServer()==null} 时直接返回 0，不干预）。
 */
public final class NbmachinaFlags {
	public static final String OBJECTIVE = "styx.flag";
	public static final String HIFI = "#hifi";

	private NbmachinaFlags() {
	}

	public static int flag(World world, String name) {
		if (world == null) {
			return 0;
		}
		MinecraftServer server = world.getServer();
		if (server == null) {
			return 0;
		}
		Scoreboard scoreboard = server.getScoreboard();
		ScoreboardObjective objective = scoreboard.getNullableObjective(OBJECTIVE);
		if (objective == null) {
			return 0;
		}
		ReadableScoreboardScore score = scoreboard.getScore(ScoreHolder.fromName(name), objective);
		return score == null ? 0 : score.getScore();
	}

	/** 自研音色模式（数据包 {@code /function styx:play/monitor_hifi_on} 置 1）。 */
	public static boolean hifi(World world) {
		return flag(world, HIFI) == 1;
	}
}
