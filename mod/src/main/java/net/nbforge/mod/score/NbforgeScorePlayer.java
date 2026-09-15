package net.nbforge.mod.score;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.util.math.Vec3d;

import net.nbforge.mod.NbforgeMod;
import net.nbforge.mod.net.NbforgePlayPayload;

/**
 * M3-17（P2-2）· 谱面播放器：服务端按时间把谱面里的音符派发给玩家客户端（`nbforge:play`），
 * 客户端用**无损引擎**播（不经过资源包、不经过原版音频栈）。
 *
 * <p>调度按**墙上时间**而不是 tick 编号：开始播放时记一个 nanosecond 起点，
 * 每个服务端 tick 把"已经到点"的音全部发出（带 30ms 预看，补偿 50ms 的 tick 粒度）。
 * 这样无论玩家有没有敲 `/tick rate 100`，节奏都对得上（tick rate 只是精度更高）。
 *
 * <p>位置：开始播放时把**执行命令的玩家坐标**记成锚点，之后所有音都在锚点发声
 * ——玩家走动时声场不会跟着跑（否则每个音都贴着耳朵响）。
 */
public final class NbforgeScorePlayer {
	/** 预看窗口：一个服务端 tick 是 50ms，往前多看 30ms，避免音符卡在半拍后 */
	private static final double LOOKAHEAD_SEC = 0.03;

	private static NbforgeScore score;
	private static boolean playing;
	private static long startNanos;
	private static int cursor;
	private static int due;
	private static int sent;
	private static int recipients;
	private static Vec3d anchor = Vec3d.ZERO;

	private NbforgeScorePlayer() {
	}

	public static void register() {
		ServerTickEvents.END_SERVER_TICK.register(NbforgeScorePlayer::tick);
	}

	/** 默认谱面位置：`<游戏目录>/nbforge/score.csv`（由 tools/export-mod-score.mjs --deploy 写出来） */
	public static Path defaultFile(MinecraftServer server) {
		return server.getRunDirectory().resolve("nbforge").resolve("score.csv");
	}

	public static int load(Path file) throws IOException {
		score = NbforgeScore.load(file);
		stop();
		NbforgeMod.LOGGER.info("[nbforge] 谱面已加载：{} 颗音 / 总时长 {}s（跳过 {} 行）← {}",
			score.size(), String.format("%.1f", score.durationSec()), score.skippedRows(), file);
		return score.size();
	}

	public static NbforgeScore score() {
		return score;
	}

	public static boolean playing() {
		return playing;
	}

	public static int due() {
		return due;
	}

	public static int sent() {
		return sent;
	}

	public static int recipients() {
		return recipients;
	}

	public static int cursor() {
		return cursor;
	}

	public static double elapsedSec() {
		return playing ? (System.nanoTime() - startNanos) / 1e9 : 0.0;
	}

	public static Vec3d anchor() {
		return anchor;
	}

	public static void start(Vec3d at) {
		if (score == null || score.size() == 0) return;
		anchor = at;
		cursor = 0;
		due = 0;
		sent = 0;
		recipients = 0;
		startNanos = System.nanoTime();
		playing = true;
	}

	public static void stop() {
		playing = false;
	}

	/** 每个服务端 tick：把到点的音发出去；放完了自动停 */
	private static void tick(MinecraftServer server) {
		if (!playing || score == null) return;
		double elapsed = elapsedSec();
		List<NbforgeScore.Note> notes = score.notes();
		List<ServerPlayerEntity> players = server.getPlayerManager().getPlayerList();
		while (cursor < notes.size() && notes.get(cursor).timeSec() <= elapsed + LOOKAHEAD_SEC) {
			NbforgeScore.Note n = notes.get(cursor++);
			due++;
			for (ServerPlayerEntity player : players) {
				ServerPlayNetworking.send(player, new NbforgePlayPayload(
					n.instrument(), n.voice(), n.midi(), n.velocity(), anchor.x, anchor.y, anchor.z));
				sent++;
			}
			recipients = players.size();
		}
		if (cursor >= notes.size() && elapsed > score.durationSec() + 2.0) {
			playing = false;
			NbforgeMod.LOGGER.info("[nbforge] 谱面播放结束：到点 {} 颗，发送 {} 条，收件人 {} 名",
				due, sent, recipients);
		}
	}

	/** 自检用：不启播放器，直接把谱面进度推到一个时间点，看看"到点计数"对不对 */
	public static int dryRunDue(NbforgeScore target, double upToSec) {
		int n = 0;
		for (NbforgeScore.Note note : target.notes()) {
			if (note.timeSec() <= upToSec) n++;
			else break;
		}
		return n;
	}

	public static boolean exists(Path file) {
		return Files.isRegularFile(file);
	}
}
