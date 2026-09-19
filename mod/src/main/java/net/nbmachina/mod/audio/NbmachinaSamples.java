package net.nbmachina.mod.audio;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;

import com.google.gson.Gson;

import net.fabricmc.loader.api.FabricLoader;
import net.nbmachina.mod.NbmachinaMod;

/**
 * M3-36 · 采样库定位：把乐器索引里的**相对路径**解析成实际文件。
 *
 * <p>为什么需要它：M3-16 起 `instruments.json` 里写的是本机绝对路径
 * （`C:/Users/hiliang/Documents/minecraft/_toolchain/...`），于是
 * <b>jar 换台机器（或发给别人）就完全用不了</b>——这是分发出的最后一个硬缺口。
 * 现在索引一律用相对路径（`piano/salamander48_hp/A0v1.wav`），采样根按下面的顺序找：
 *
 * <ol>
 *   <li>JVM 参数 {@code -Dnbmachina.samples=<目录>}；</li>
 *   <li>环境变量 {@code NBMACHINA_SAMPLES}；</li>
 *   <li>{@code config/nbmachina/samples.json} 里的 {@code {"root": "..."}}（一键安装脚本写这个）；</li>
 *   <li>游戏目录下的常见位置：{@code <gameDir>/nbmachina-samples}、
 *       {@code <gameDir>/config/nbmachina/samples}、{@code <gameDir>/../nbmachina-samples}。</li>
 * </ol>
 *
 * <p>索引里若是绝对路径（老版本导出、或用户手工改过），只要文件真的存在就原样使用——向后兼容。
 */
public final class NbmachinaSamples {
	/** 环境变量名（与一键安装脚本共用） */
	public static final String ENV = "NBMACHINA_SAMPLES";
	/** 采样根下的约定目录名 */
	public static final String DEFAULT_DIR_NAME = "nbmachina-samples";

	private static final Gson GSON = new Gson();
	private static boolean resolved = false;
	private static Path root;
	private static String source = "未找到";

	private NbmachinaSamples() {
	}

	/** 采样根目录（找不到真实目录时返回首选位置，供错误提示用） */
	public static synchronized Path root() {
		if (!resolved) {
			resolved = true;
			pick();
		}
		return root;
	}

	/** 根目录是怎么来的（给命令输出用） */
	public static synchronized String source() {
		root();
		return source;
	}

	/** 让下次 root() 重新探测（`/nbmc reload` 会调） */
	public static synchronized void invalidate() {
		resolved = false;
	}

	private static void pick() {
		// 1) JVM 参数
		String prop = System.getProperty("nbmachina.samples");
		if (prop != null && !prop.isBlank()) {
			Path p = Path.of(prop);
			if (Files.isDirectory(p)) {
				set(p, "-Dnbmachina.samples");
				return;
			}
		}
		// 2) 环境变量
		String env = System.getenv(ENV);
		if (env != null && !env.isBlank()) {
			Path p = Path.of(env);
			if (Files.isDirectory(p)) {
				set(p, ENV + " 环境变量");
				return;
			}
		}
		// 3) config/nbmachina/samples.json
		Path cfg = FabricLoader.getInstance().getConfigDir().resolve("nbmachina").resolve("samples.json");
		if (Files.isRegularFile(cfg)) {
			try (var reader = Files.newBufferedReader(cfg, StandardCharsets.UTF_8)) {
				Map<?, ?> m = GSON.fromJson(reader, Map.class);
				Object v = m == null ? null : m.get("root");
				if (v != null && !String.valueOf(v).isBlank()) {
					Path p = Path.of(String.valueOf(v));
					if (Files.isDirectory(p)) {
						set(p, "config/nbmachina/samples.json");
						return;
					}
					NbmachinaMod.LOGGER.warn("[nbmachina] samples.json 里的 root 不存在：{}", p);
				}
			} catch (IOException | RuntimeException e) {
				NbmachinaMod.LOGGER.warn("[nbmachina] samples.json 读取失败：{}", e.toString());
			}
		}
		// 4) 常见位置
		List<Path> cand = candidates();
		for (Path c : cand) {
			if (Files.isDirectory(c)) {
				set(c, "默认位置");
				return;
			}
		}
		root = cand.get(0);
		source = "未找到（默认取首选位置）";
		NbmachinaMod.LOGGER.warn("[nbmachina] 没找到采样根目录，试过：{}", cand);
	}

	private static void set(Path p, String why) {
		root = p.toAbsolutePath().normalize();
		source = why;
	}

	/** 默认候选目录（按优先级） */
	public static List<Path> candidates() {
		List<Path> out = new ArrayList<>();
		Path game = FabricLoader.getInstance().getGameDir().toAbsolutePath().normalize();
		LinkedHashSet<Path> set = new LinkedHashSet<>();
		set.add(game.resolve(DEFAULT_DIR_NAME));
		set.add(FabricLoader.getInstance().getConfigDir().resolve("nbmachina").resolve("samples"));
		Path parent = game.getParent();
		if (parent != null) set.add(parent.resolve(DEFAULT_DIR_NAME));
		out.addAll(set);
		return out;
	}

	/**
	 * 索引里的路径 → 实际文件。
	 * 绝对路径（老索引）原样返回；相对路径拼到采样根上。
	 */
	public static Path resolve(String file) {
		if (file == null || file.isBlank()) return null;
		Path p = Path.of(file.replace('/', File.separatorChar).replace('\\', File.separatorChar));
		if (p.isAbsolute()) return p;
		Path r = root();
		return r == null ? p : r.resolve(p);
	}

	/** 一句话状态（日志/命令用） */
	public static String describe() {
		return root() + "（来源：" + source() + "）";
	}
}
