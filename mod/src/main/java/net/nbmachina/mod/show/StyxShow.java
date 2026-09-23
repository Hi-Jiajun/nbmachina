package net.nbmachina.mod.show;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.google.gson.Gson;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.world.ServerWorld;
import net.nbmachina.mod.NbmachinaMod;

/**
 * M5 · STYX HELIX 视效层（**方案 A**：挂在 mod 的"到点"时刻上，`/nbm machine start` 一条命令即出画面）。
 *
 * <p>与演奏共用同一根真实时间轴（nanoTime）；用服务端命令 `particlex ...` 把 ExParticle 的 payload 发出去
 * —— 不引编译期依赖（避开 LGPL 链接与 Yarn/Mojmap 交叉），命令字符串与 `tools/show-pack.mjs` 同源。
 *
 * <p>数据：`<游戏目录>/nbmachina/styxshow.json`（v2：逐字时间来自**官方 TTML 的 span** + 整体平移；
 * 含每行中文翻译；文字用 textMatrix **平铺在水面上**，配合"从音符盒上方扫到末尾"的运镜）。
 *
 * <p>⚠ 语法口径（2026-09-24 踩过）：`color4`/`speed3`/`range3` 是**空格分隔**；表达式内部元组仍是逗号。
 * `exec()` 一律**先 parse 再 execute**，语法错误不再被 silent source 吞掉。
 */
public final class StyxShow {
	private static final Gson GSON = new Gson();
	/** 平铺在水面上：读向 = +x、字上 = −z（预演里已按同一朝向验证过） */
	private static final String FLAT_MATRIX = "(0,1,0,0,,0,0,0,0,,-1,0,0,0,,0,0,0,1)";
	private static final double ZC = 2.5;                    // 机器音轨轴（河心）
	private static final double DECK_TOP = 111.0;            // 甲板顶面（machine_map 的 y=110 是甲板方块）
	private static final double LYRIC_Y = DECK_TOP + 1.25;   // 标签/歌词的平铺高度（音符盒顶层在 112.0）
	private static final double PLAYHEAD_A = 8.3341, PLAYHEAD_B = -32.784;

	private record LyricChar(double t, String c, double z, double w, double dur) {
	}

	private record LyricLine(double t, double end, double scale, double w, String tr, List<LyricChar> chars) {
	}

	private static final class Doc {
		int version = 1;
		double shiftSec = 0;
		String textMatrix = FLAT_MATRIX;
		double dpb = 8.0;
		double[] accents = new double[0];
		List<LyricLine> lines = new ArrayList<>();
	}

	private static Doc doc = null;
	private static boolean active = false;
	private static int accCursor = 0;
	private static int lineCursor = 0;
	private static int sent = 0;
	private static int failed = 0;
	/** 歌词整体提前/延后（秒，正数 = 更晚出现）：现场微调用 `/nbm machine lyricoff <秒>` */
	private static double lyricOffset = 0.0;

	private StyxShow() {
	}

	public static boolean active() {
		return active;
	}

	public static void setLyricOffset(double sec) {
		lyricOffset = sec;
	}

	public static double lyricOffset() {
		return lyricOffset;
	}

	public static String status() {
		return String.format("视效 %s；已发 %d 条命令，失败 %d 条；歌词平移 %+.2fs（show.json 内置 %+.2fs）",
			active ? "**运行中**" : "停", sent, failed, lyricOffset, doc == null ? 0 : doc.shiftSec);
	}

	// ───────────────────────── 命令模板（唯一来源） ─────────────────────────

	private static String river() {
		return "particlex tick-parameter end_rod 2 111.12 2.5 0.15 0.86 0.80 0.30 0 0 0 0 2400 "
			+ "\"x,y,z=t,0.15*sin(t/4),sin(t/9)*1.2\" 0.0833 5 26";
	}

	/** 河面再加两条平行光带，让"河"从上方看是一整片而不是一条线 */
	private static String riverLane(double dz) {
		return "particlex tick-parameter end_rod 2 111.12 " + fmt(ZC + dz) + " 0.15 0.86 0.80 0.22 0 0 0 0 2400 "
			+ "\"x,y,z=t,0.10*sin(t/3.4),sin(t/7)*1.6\" 0.0833 4 30";
	}

	private static String helix(double phase) {
		return "particlex tick-polar-parameter end_rod 2 114.5 2.5 0.47 0.36 1.0 0.45 0 0 0 0 2400 "
			+ "\"s1=t*0.62+" + phase + "; s2=1.5708; dis=4.2\" 0.12 3 40";
	}

	private static String title() {
		return "particlex text end_rod 8 " + fmt(LYRIC_Y + 2.0) + " " + fmt(ZC) + " \"STYX HELIX\" 4.0 \""
			+ FLAT_MATRIX + "\" 6.0 0 0 0 150";
	}

	private static String subtitle() {
		return "particlex text end_rod 12 " + fmt(LYRIC_Y + 2.0) + " " + fmt(ZC) + " \"MYTH & ROID\" 2.6 \""
			+ FLAT_MATRIX + "\" 6.0 0 0 0 140";
	}

	/** 开场：专辑封面平铺（素材 = `<游戏目录>/particleImages/styx-cover-64.png`，64×64） */
	private static String cover() {
		return "particlex image-matrix end_rod -10 " + fmt(LYRIC_Y + 3.5) + " " + fmt(ZC)
			+ " styx-cover-64.png 1.0 \"" + FLAT_MATRIX + "\" 8.0 0 0 0 80";
	}

	private static String flareEdges(double cx, double cy, double cz, String col) {
		return "particlex custom-conditional end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=3.2; cr,cg,cb=" + col + "; alpha=0.92; age=28; light=1.0\" 0.5 0.5 0.5 "
			+ "\"abs(abs(x)-0.5)<0.01&abs(abs(y)-0.5)<0.01|abs(abs(x)-0.5)<0.01&abs(abs(z)-0.5)<0.01"
			+ "|abs(abs(y)-0.5)<0.01&abs(abs(z)-0.5)<0.01\" 0.25 "
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.11/(1+t/9); alpha=0.92*(1-t/27)\" 1.0";
	}

	private static String flareRipple(double cx, double cz) {
		return "particlex custom-polar-parameter end_rod " + fmt(cx) + " " + fmt(DECK_TOP + 0.15) + " " + fmt(cz)
			+ " 0 6.2832 \"s1=t; s2=0; dis=0.5; size=2.6; cr,cg,cb=0.15,0.86,0.80; alpha=0.9; age=30; light=1.0\" 0.1 "
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.12/(1+t/10); alpha=0.9*(1-t/29)\" 1.0";
	}

	private static String flareSparks(double cx, double cy, double cz) {
		return "particlex custom-normal end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=2.2; cr,cg,cb=0.92,0.96,1.0; alpha=0.95; age=26; light=1.0; vx=(random()-0.5)*0.16; "
			+ "vy=random()*0.22; vz=(random()-0.5)*0.16; gravity=0.06; friction=0.96\" 0.15 0.15 0.15 14";
	}

	private static String accentRing(double t) {
		return "particlex custom-polar-parameter end_rod " + fmt(PLAYHEAD_A * t + PLAYHEAD_B + 0.5) + " "
			+ fmt(DECK_TOP + 0.18) + " " + fmt(ZC) + " 0 6.2832 "
			+ "\"s1=t; s2=0; dis=0.6; size=3.0; cr,cg,cb=0.15,0.86,0.80; alpha=0.5; age=32; light=1.0\" 0.08 "
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.42/(1+t/6); alpha=0.5*(1-t/31)\" 1.0";
	}

	/** 逐字：平铺、骑流（vx = 播放头速度）、唱到哪亮到哪 + 弹性鼓一下 */
	private static String lyricChar(LyricLine line, LyricChar c) {
		int d = Math.max(1, (int) Math.round(c.dur() * 20));
		double x = PLAYHEAD_A * c.t() + PLAYHEAD_B + 5.0;
		double z = ZC + line.w() / 2 - c.z();
		return "particlex text end_rod " + fmt(x) + " " + fmt(LYRIC_Y) + " " + fmt(z) + " \"" + escape(c.c())
			+ "\" " + fmt(line.scale()) + " \"" + FLAT_MATRIX + "\" " + fmt(dpb()) + " 0 0 0 "
			+ Math.max(1, (int) Math.round((line.end() - c.t() + 0.8) * 20))
			+ " \"vx=" + fmt(PLAYHEAD_A / 20.0) + "; size=1+0.9*exp(-t/5); "
			+ "cr,cg,cb=lerp(clamp(t/" + d + ",0,1),0.32,1.0),lerp(clamp(t/" + d + ",0,1),0.46,0.98),"
			+ "lerp(clamp(t/" + d + ",0,1),0.52,1.0); alpha=0.42+0.58*clamp(t/" + d + ",0,1)\" 1.0";
	}

	/** 译文：屏幕下方（= +x 方向）、小一号、暗一点 */
	private static String lyricTranslation(LyricLine line) {
		if (line.tr() == null || line.tr().isBlank()) return null;
		double x = PLAYHEAD_A * line.t() + PLAYHEAD_B + 7.4;
		return "particlex text end_rod " + fmt(x) + " " + fmt(LYRIC_Y) + " " + fmt(ZC)
			+ " \"" + escape(line.tr()) + "\" " + fmt(line.scale() * 0.52) + " \"" + FLAT_MATRIX + "\" " + fmt(dpb())
			+ " 0 0 0 " + Math.max(1, (int) Math.round((line.end() - line.t() + 0.8) * 20))
			+ " \"vx=" + fmt(PLAYHEAD_A / 20.0) + "; alpha=0.62\" 1.0";
	}

	/** 朝向探针：同一句话用 6 个矩阵各来一份，用户指哪个是正的我就定哪个 */
	private static List<String> probeCmds() {
		String[] mats = {
			"E4",
			FLAT_MATRIX,
			"(0,-1,0,0,,0,0,0,0,,1,0,0,0,,0,0,0,1)",
			"(1,0,0,0,,0,0,1,0,,0,-1,0,0,,0,0,0,1)",
			"(-1,0,0,0,,0,0,-1,0,,0,1,0,0,,0,0,0,1)",
			"(0,1,0,0,,0,0,0,0,,1,0,0,0,,0,0,0,1)",
		};
		List<String> out = new ArrayList<>();
		for (int i = 0; i < mats.length; i++) {
			out.add("particlex text end_rod ~ ~" + (3 + i * 2) + " ~ \"" + (i + 1) + " ABC " + (i + 1) + "\" 3.0 \""
				+ mats[i] + "\" 8.0 0 0 0 600");
		}
		return out;
	}

	// ───────────────────────── 生命周期 ─────────────────────────

	private static void load(Path gameDir) {
		if (doc != null) return;
		Path p = gameDir.resolve("nbmachina").resolve("styxshow.json");
		try {
			if (!Files.isRegularFile(p)) {
				NbmachinaMod.LOGGER.warn("[styxshow] 找不到 {} —— 只有逐音心跳，没有重音环与歌词", p);
				doc = new Doc();
				return;
			}
			doc = GSON.fromJson(Files.readString(p, StandardCharsets.UTF_8), Doc.class);
			if (doc == null) doc = new Doc();
			if (doc.lines == null) doc.lines = new ArrayList<>();
			if (doc.accents == null) doc.accents = new double[0];
			if (doc.textMatrix == null || doc.textMatrix.isBlank()) doc.textMatrix = FLAT_MATRIX;
			if (doc.dpb <= 0) doc.dpb = 8.0;
			int nChars = 0;
			for (LyricLine l : doc.lines) nChars += l.chars() == null ? 0 : l.chars().size();
			NbmachinaMod.LOGGER.info("[styxshow] 视效数据 v{} 已载入：重音 {} / 歌词 {} 行 {} 字（平移 {}s）",
				doc.version, doc.accents.length, doc.lines.size(), nChars, doc.shiftSec);
		} catch (Exception e) {
			NbmachinaMod.LOGGER.warn("[styxshow] 载入 styxshow.json 失败：{}", e.toString());
			doc = new Doc();
		}
	}

	private static double dpb() {
		return doc != null && doc.dpb > 0 ? doc.dpb : 8.0;
	}

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
		lineCursor = 0;
		while (lineCursor < doc.lines.size() && doc.lines.get(lineCursor).t() + lyricOffset < fromSec) lineCursor++;

		exec(world, river());
		exec(world, riverLane(-8.0));
		exec(world, riverLane(8.0));
		exec(world, helix(0.0));
		exec(world, helix(3.1416));
		if (fromSec < 3.5) {
			exec(world, cover());
			exec(world, title());
			exec(world, subtitle());
		}
		NbmachinaMod.LOGGER.info("[styxshow] 视效层启动：从 {}s 起（重音剩 {} / 歌词剩 {} 行，整体平移 {:+.2f}s）",
			fromSec, doc.accents.length - accCursor, doc.lines.size() - lineCursor, lyricOffset);
	}

	public static void stop(ServerWorld world) {
		if (!active) return;
		active = false;
		exec(world, "particlex clear-particle");
		NbmachinaMod.LOGGER.info("[styxshow] 视效层停止");
	}

	public static void tick(ServerWorld world, double now) {
		if (!active || doc == null) return;
		double nowLyric = now - lyricOffset;
		while (accCursor < doc.accents.length && doc.accents[accCursor] <= now) {
			exec(world, accentRing(doc.accents[accCursor]));
			accCursor++;
		}
		while (lineCursor < doc.lines.size() && doc.lines.get(lineCursor).t() <= nowLyric) {
			LyricLine line = doc.lines.get(lineCursor++);
			if (line.chars() != null) for (LyricChar c : line.chars()) exec(world, lyricChar(line, c));
			String tr = lyricTranslation(line);
			if (tr != null) exec(world, tr);
		}
	}

	public static void noteFlare(ServerWorld world, int x, int y, int z, int midi, int velocity, boolean bass) {
		if (!active) return;
		double cx = x + 0.5, cy = y + 1.5, cz = z + 0.5;
		String col = bass ? "0.47,0.36,1.00" : (midi > 78 ? "0.90,0.95,1.00" : "0.55,0.90,0.92");
		exec(world, flareEdges(cx, cy, cz, col));
		exec(world, flareRipple(cx, cz));
		if (velocity >= 90) exec(world, flareSparks(cx, cy, cz));
	}

	/** 朝向探针（`/nbm machine textprobe`） */
	public static void textProbe(ServerWorld world) {
		if (!FabricLoader.getInstance().isModLoaded("exparticle")) return;
		load(world.getServer().getRunDirectory());
		for (String c : probeCmds()) exec(world, c);
	}

	/** 命令自检：每类模板各拿一条真去 Brigadier 解析（`/nbm machine showcheck`） */
	public static String selfCheck(ServerCommandSource src) {
		List<String> cmds = new ArrayList<>();
		cmds.add(river());
		cmds.add(riverLane(-8.0));
		cmds.add(helix(0.0));
		cmds.add(cover());
		cmds.add(title());
		cmds.add(subtitle());
		cmds.add(flareEdges(0.5, 111.5, -5.5, "0.90,0.95,1.00"));
		cmds.add(flareRipple(0.5, -5.5));
		cmds.add(flareSparks(0.5, 111.5, -5.5));
		cmds.add(accentRing(3.917));
		LyricLine demo = new LyricLine(22.407, 24.457, 3.0, 10.0, "请不要让我就此死亡",
			List.of(new LyricChar(22.407, "O", 0, 1.4, 0.23), new LyricChar(22.64, "k", 1.4, 1.4, 0.24)));
		cmds.add(lyricChar(demo, demo.chars().get(0)));
		cmds.add(lyricTranslation(demo));
		cmds.addAll(probeCmds());
		int ok = 0;
		String firstErr = null;
		for (String c : cmds) {
			try {
				src.getServer().getCommandManager().getDispatcher().parse(c, src.withMaxLevel(4));
				ok++;
			} catch (Throwable e) {
				if (firstErr == null) firstErr = e.toString() + "  ←  " + c;
			}
		}
		if (firstErr == null) return String.format("命令自检：%d/%d 条全部通过 ✓", ok, cmds.size());
		return String.format("命令自检：%d/%d 条通过；第一条失败：%s", ok, cmds.size(), firstErr);
	}

	// ── 工具 ──
	private static void exec(ServerWorld world, String cmd) {
		try {
			MinecraftServer server = world.getServer();
			ServerCommandSource src = server.getCommandSource().withSilent().withMaxLevel(4);
			var parsed = server.getCommandManager().getDispatcher().parse(cmd, src);
			server.getCommandManager().getDispatcher().execute(parsed);
			sent++;
		} catch (Throwable e) {
			failed++;
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
