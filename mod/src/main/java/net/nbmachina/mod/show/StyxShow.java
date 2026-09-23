package net.nbmachina.mod.show;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.google.gson.Gson;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.world.ServerWorld;
import net.nbmachina.mod.NbmachinaMod;

/**
 * M5 · STYX HELIX 视效层（**方案 A**：挂在 mod 的"到点"时刻上，`/nbm machine start` 一条命令即出画面）。
 *
 * <p>和演奏链共用同一个真实时间轴：机器驱动什么时候把音符盒排进队列，这里就什么时候发粒子，
 * 所以视效与音乐是同一时刻，不靠第二条计时链（数据包那条已退役，见 docs/M5-show-design.md §7.0）。
 *
 * <p><b>怎么和 ExParticle 对接</b>：不走编译期依赖、也不碰它的内部类 —— 直接**用服务端命令**
 * `particlex ...` 把 payload 发出去（`NbmachinaMachine#silenceDataPack` 早就在用同一招跑 `scoreboard` 命令）。
 * 好处有三：① 不需要把 LGPL-3.0 的 ExParticle 编进 nbmachina（只要求它装着）；②
 * 跨 mod 的 Yarn/Mojmap 映射问题完全不存在（走命令字符串）；③ 命令就是数据包里那套**已经写好的**语法，
 * 一份口径两处复用（`tools/show-pack.mjs` 生成的就是同一条命令）。
 *
 * <p>数据：`<游戏目录>/nbmachina/styxshow.json`（由 `node nbmachina/tools/show-pack.mjs --json <它> --json-only` 生成）
 * —— 里面只有"重音时刻"和"逐字歌词"，逐音心跳的参数由谱面现场算。
 */
public final class StyxShow {
	private static final Gson GSON = new Gson();

	/** 逐字歌词的一个字 */
	private record LyricChar(double t, String c, double z, int age, double dur, double scale) {
	}

	private static final class Doc {
		double[] accents = new double[0];
		List<LyricChar> chars = new ArrayList<>();
	}

	private static Doc doc = null;
	private static boolean active = false;
	private static int accCursor = 0;
	private static int charCursor = 0;
	private static int sent = 0;
	private static int failed = 0;

	private StyxShow() {
	}

	public static boolean active() {
		return active;
	}

	public static String status() {
		return String.format("视效 %s；已发 %d 条命令，失败 %d 条（命令失败的前 8 条会打日志）",
			active ? "**运行中**" : "停", sent, failed);
	}

	private static void load(Path gameDir) {
		if (doc != null) return;
		Path p = gameDir.resolve("nbmachina").resolve("styxshow.json");
		try {
			if (!Files.isRegularFile(p)) {
				NbmachinaMod.LOGGER.warn("[styxshow] 找不到 {} —— 视效只有逐音心跳，没有重音环和歌词", p);
				doc = new Doc();
				return;
			}
			doc = GSON.fromJson(Files.readString(p, StandardCharsets.UTF_8), Doc.class);
			if (doc == null) doc = new Doc();
			if (doc.chars == null) doc.chars = new ArrayList<>();
			if (doc.accents == null) doc.accents = new double[0];
			NbmachinaMod.LOGGER.info("[styxshow] 视效数据已载入：重音 {} 个 / 歌词字 {} 个",
				doc.accents.length, doc.chars.size());
		} catch (Exception e) {
			NbmachinaMod.LOGGER.warn("[styxshow] 载入 styxshow.json 失败：{}", e.toString());
			doc = new Doc();
		}
	}

	/** 机器起播时调用（同一个 tick、同一根时间轴） */
	public static void start(ServerWorld world, double fromSec) {
		if (!FabricLoader.getInstance().isModLoaded("exparticle")) {
			NbmachinaMod.LOGGER.info("[styxshow] 没装 ExParticle → 视效层关闭（演奏不受影响）");
			return;
		}
		load(world.getServer().getRunDirectory());
		active = true;
		sent = 0;
		failed = 0;
		accCursor = firstAtOrAfter(doc.accents, fromSec);
		charCursor = 0;
		while (charCursor < doc.chars.size() && doc.chars.get(charCursor).t() < fromSec) charCursor++;

		// ① 河：一条恒速光流（前沿 = cpt×step = 0.4167 格/客户端刻 = 播放头速度）
		exec(world, "particlex tick-parameter end_rod 2 110.2 2.5 0.15,0.86,0.80,0.30 0,0,0 0 2400 "
			+ "\"x,y,z=t,0.15*sin(t/4),sin(t/9)*1.2\" 0.0833 5 26");
		// ② 螺旋：两条反向缠绕的光带
		for (double ph : new double[]{0.0, 3.1416}) {
			exec(world, "particlex tick-polar-parameter end_rod 2 117 2.5 0.47,0.36,1.0,0.45 0,0,0 0 2400 "
				+ "\"s1=t*0.62+" + ph + "; s2=1.5708; dis=5.5\" 0.12 3 40");
		}
		// ③ 开场标题（只在音乐起来之前发；从中间起播就不发了）
		if (fromSec < 3.5) {
			exec(world, "particlex text end_rod 14 116.5 2.5 \"STYX HELIX\" 5.0 "
				+ "\"(x,y,z)=(x,y,z,1)*rotate(0,PI/2,0)\" 8.0 0,0,0 120");
			exec(world, "particlex text end_rod 20 115.2 2.0 \"MYTH & ROID\" 3.0 "
				+ "\"(x,y,z)=(x,y,z,1)*rotate(0,PI/2,0)\" 8.0 0,0,0 110");
		}
		NbmachinaMod.LOGGER.info("[styxshow] 视效层启动：从 {}s 起（重音剩 {} / 歌词剩 {}）",
			fromSec, doc.accents.length - accCursor, doc.chars.size() - charCursor);
	}

	public static void stop(ServerWorld world) {
		if (!active) return;
		active = false;
		exec(world, "particlex clear-particle");
		NbmachinaMod.LOGGER.info("[styxshow] 视效层停止");
	}

	/** 每服务器刻：重音冲击环 + 逐字歌词（都是"到点才发"，和音符同一条真实时间轴） */
	public static void tick(ServerWorld world, double now) {
		if (!active || doc == null) return;
		while (accCursor < doc.accents.length && doc.accents[accCursor] <= now) {
			double x = 8.3341 * doc.accents[accCursor] - 32.784 + 0.5;
			exec(world, "particlex custom-polar-parameter end_rod " + fmt(x) + " 110.05 2.5 0 6.2832 "
				+ "\"s1=t; s2=0; dis=0.6; size=4; cr,cg,cb=0.15,0.86,0.80; alpha=0.5; age=32; light=1.0\" 0.08 "
				+ "\"(vx,vy,vz)=(dx,dy,dz)*0.42/(1+t/6); alpha=0.5*(1-t/31)\" 1.0");
			accCursor++;
		}
		while (charCursor < doc.chars.size() && doc.chars.get(charCursor).t() <= now) {
			LyricChar c = doc.chars.get(charCursor++);
			int d = Math.max(1, (int) Math.round(c.dur() * 20));
			double x = 8.3341 * c.t() - 32.784 + 6.0;
			exec(world, "particlex text end_rod " + fmt(x) + " 118.5 " + fmt(c.z()) + " \"" + escape(c.c())
				+ "\" " + fmt(c.scale()) + " \"(x,y,z)=(x,y,z,1)*rotate(0,PI/2,0)\" 8.0 0,0,0 " + c.age()
				+ " \"vx=0.4167; cr,cg,cb=lerp(clamp(t/" + d + ",0,1),0.30,1.0),lerp(clamp(t/" + d
				+ ",0,1),0.45,0.96),lerp(clamp(t/" + d + ",0,1),0.50,1.0); alpha=0.5+0.5*clamp(t/" + d + ",0,1)\" 1.0");
		}
	}

	/**
	 * 逐音心跳：描边方块（12 棱 · 从音符盒大小等比例放大）+ 表面涟漪 + 火花（力度大的音）。
	 * 由 {@code NbmachinaMachine} 在"这颗音真正到点"时调用（同一根时间轴）。
	 */
	public static void noteFlare(ServerWorld world, int x, int y, int z, int midi, int velocity, boolean bass) {
		if (!active) return;
		double cx = x + 0.5, cy = y + 1.5, cz = z + 0.5;
		String col = bass ? "0.47,0.36,1.00" : (midi > 78 ? "0.90,0.95,1.00" : "0.55,0.90,0.92");
		exec(world, "particlex custom-conditional end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=6; cr,cg,cb=" + col + "; alpha=0.92; age=28; light=1.0\" 0.5,0.5,0.5 "
			+ "\"abs(x)==0.5&abs(y)==0.5|abs(x)==0.5&abs(z)==0.5|abs(y)==0.5&abs(z)==0.5\" 0.25 "
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.11/(1+t/9); alpha=0.92*(1-t/27)\" 1.0");
		exec(world, "particlex custom-polar-parameter end_rod " + fmt(cx) + " " + fmt(cy - 0.5) + " " + fmt(cz)
			+ " 0 6.2832 \"s1=t; s2=0; dis=0.5; size=5; cr,cg,cb=0.15,0.86,0.80; alpha=0.9; age=30; light=1.0\" 0.1 "
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.12/(1+t/10); alpha=0.9*(1-t/29)\" 1.0");
		if (velocity >= 90) {
			exec(world, "particlex custom-normal end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
				+ " \"size=2.5; cr,cg,cb=0.92,0.96,1.0; alpha=0.95; age=26; light=1.0; vx=(random()-0.5)*0.16; "
				+ "vy=random()*0.22; vz=(random()-0.5)*0.16; gravity=0.06; friction=0.96\" 0.15,0.15,0.15 14");
		}
	}

	// ── 工具 ──
	private static void exec(ServerWorld world, String cmd) {
		try {
			MinecraftServer server = world.getServer();
			var src = server.getCommandSource().withSilent().withMaxLevel(4);
			server.getCommandManager().parseAndExecute(src, cmd);
			sent++;
		} catch (Throwable e) {
			failed++;
			// 前 8 条失败打到日志（含原命令）：命令写错时能直接照抄去查，不必开 debug 模式
			if (failed <= 8) NbmachinaMod.LOGGER.warn("[styxshow] 命令失败（第 {} 次）：{} ← {}", failed, e.toString(), cmd);
		}
	}

	private static int firstAtOrAfter(double[] arr, double t) {
		int i = 0;
		while (i < arr.length && arr[i] < t) i++;
		return i;
	}

	private static String fmt(double v) {
		String s = String.format("%.3f", v);
		while (s.contains(".") && (s.endsWith("0") || s.endsWith("."))) s = s.substring(0, s.length() - 1);
		return s.isEmpty() ? "0" : s;
	}

	private static String escape(String s) {
		return s.replace("\\", "\\\\").replace("\"", "\\\"");
	}
}
