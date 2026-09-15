package net.nbforge.mod.audio;

import java.io.IOException;
import java.io.Reader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.annotations.SerializedName;

import net.fabricmc.loader.api.FabricLoader;
import net.nbforge.mod.NbforgeMod;

/**
 * M3-16（P2）· 乐器库：`config/nbforge/instruments.json` →（乐器, midi, 力度）解析到采样文件。
 *
 * <p>JSON 由 `tools/export-mod-instruments.mjs` 从我们的 SFZ 索引生成（区域 = 录音根音 × 力度区间，
 * 与离线渲染同一套映射），所以**离线听到什么、游戏里就播什么**：同一批母版文件、同一套选层规则。
 *
 * <p>选层规则（与 tools/import-sfz.mjs + render-ensemble 一致）：
 * 先按 (midi 落在 [loKey,hiKey]) + (力度落在 [loVel,hiVel]) 精确命中；命中不了就退化成
 * "键位距离最近 + 力度距离最近"，绝不静音——静音会被误当成漏音。
 */
public final class NbforgeInstruments {
	private static final Gson GSON = new GsonBuilder().create();
	private static final Map<String, Instrument> BY_ID = new LinkedHashMap<>();
	private static String lastError = null;

	private NbforgeInstruments() {
	}

	/** 一个 SFZ region 的镜像 */
	public static final class Region {
		public String file;
		public int loKey;
		public int hiKey;
		public int root;
		public int loVel;
		public int hiVel;
		@SerializedName("gainDb")
		public float gainDb;
		@SerializedName("tuneCents")
		public float tuneCents;

		public double pitchRatio(int midi) {
			return Math.pow(2.0, (midi - root + tuneCents / 100.0) / 12.0);
		}
	}

	public static final class Instrument {
		public String id;
		public String name;
		public String license;
		public boolean isDefault;
		public List<Region> regions = new ArrayList<>();

		/** 精确命中 → 退化命中（键位最近、再力度最近）；永不返回 null（除非该乐器没有区域） */
		public Region pick(int midi, int velocity) {
			Region best = null;
			int bestScore = Integer.MAX_VALUE;
			for (Region r : regions) {
				int keyDist = midi < r.loKey ? r.loKey - midi : midi > r.hiKey ? midi - r.hiKey : 0;
				int velDist = velocity < r.loVel ? r.loVel - velocity : velocity > r.hiVel ? velocity - r.hiVel : 0;
				int score = keyDist * 1000 + velDist;   // 键位优先，其次力度
				if (score < bestScore) {
					bestScore = score;
					best = r;
				}
			}
			return best;
		}
	}

	private static final class Root {
		public List<Instrument> instruments = new ArrayList<>();
	}

	/** 配置文件位置：`<游戏目录>/config/nbforge/instruments.json` */
	public static Path configFile() {
		return FabricLoader.getInstance().getConfigDir().resolve("nbforge").resolve("instruments.json");
	}

	/** 候选路径：config 目录优先，其次游戏目录下的 `nbforge/instruments.json`（便于直接拷贝） */
	public static List<Path> candidates() {
		Path gameDir = FabricLoader.getInstance().getGameDir();
		return List.of(configFile(), gameDir.resolve("nbforge").resolve("instruments.json"));
	}

	/** 重新加载（懒加载入口；返回加载到的乐器数，失败返回 -1 并记录原因） */
	public static synchronized int reload() {
		BY_ID.clear();
		for (Path p : candidates()) {
			if (!Files.isRegularFile(p)) continue;
			try (Reader reader = Files.newBufferedReader(p, StandardCharsets.UTF_8)) {
				Root root = GSON.fromJson(reader, Root.class);
				if (root == null || root.instruments == null) continue;
				for (Instrument inst : root.instruments) {
					if (inst == null || inst.id == null) continue;
					BY_ID.put(inst.id, inst);
				}
				lastError = null;
				NbforgeMod.LOGGER.info("[nbforge] 乐器库已加载：{} 个乐器（{}）", BY_ID.size(), p);
				return BY_ID.size();
			} catch (IOException | RuntimeException e) {
				lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
				NbforgeMod.LOGGER.warn("[nbforge] 乐器库解析失败 {}：{}", p, lastError);
			}
		}
		lastError = "没有找到 instruments.json（试过 " + candidates() + "）";
		return -1;
	}

	public static synchronized Instrument get(String id) {
		if (BY_ID.isEmpty()) reload();
		return BY_ID.get(id);
	}

	public static synchronized Collection<Instrument> all() {
		if (BY_ID.isEmpty()) reload();
		return List.copyOf(BY_ID.values());
	}

	public static synchronized int size() {
		if (BY_ID.isEmpty()) reload();
		return BY_ID.size();
	}

	public static String lastError() {
		return lastError;
	}

	/** 力度 → 线性增益：1..127 映射到 -18dB..0dB（与离线 `velMidiToAmplitude` 同一把尺子） */
	public static float velocityGain(int velocity) {
		int v = Math.max(1, Math.min(127, velocity));
		double amp = Math.pow(10.0, ((v - 127) / 126.0) * 18.0 / 20.0);
		return (float) amp;
	}
}
