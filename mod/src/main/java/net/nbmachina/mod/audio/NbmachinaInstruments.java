package net.nbmachina.mod.audio;

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
import net.nbmachina.mod.NbmachinaMod;

/**
 * M3-16（P2）· 乐器库：`config/nbmachina/instruments.json` →（乐器, midi, 力度）解析到采样文件。
 *
 * <p>JSON 由 `tools/export-mod-instruments.mjs` 从我们的 SFZ 索引生成（区域 = 录音根音 × 力度区间，
 * 与离线渲染同一套映射），所以**离线听到什么、游戏里就播什么**：同一批母版文件、同一套选层规则。
 *
 * <p>选层规则（与 tools/import-sfz.mjs + render-ensemble 一致）：
 * 先按 (midi 落在 [loKey,hiKey]) + (力度落在 [loVel,hiVel]) 精确命中；命中不了就退化成
 * "键位距离最近 + 力度距离最近"，绝不静音——静音会被误当成漏音。
 */
public final class NbmachinaInstruments {
	private static final Gson GSON = new GsonBuilder().create();
	private static final Map<String, Instrument> BY_ID = new LinkedHashMap<>();
	private static String lastError = null;

	/* ------------------------------------------------------------------ M3-30 运行时音色切换
	 * 谱面里每颗音自带"用哪个乐器"（`machine_map.csv` 的 instrument 列），但**不用改数据**也能换琴：
	 * 这里维护一张 声部 → 乐器 的覆盖表（客户端本地），解析顺序 = 声部覆盖 → `*` 全局覆盖 → 谱面原值。
	 * 落盘在 `config/nbmachina/voices.json`，重启仍在；换到的乐器**必须已在本机乐器库里**，否则忽略覆盖
	 * （宁可照谱面播，也不要静音）。
	 */
	private static final Map<String, String> VOICE_OVERRIDE = new java.util.concurrent.ConcurrentHashMap<>();
	private static final String ANY_VOICE = "*";

	/** 用覆盖表解析"这颗音到底用哪件乐器" */
	public static String resolve(String instrument, String voice) {
		String v = voice == null ? "" : voice.trim().toLowerCase();
		String o = VOICE_OVERRIDE.get(v);
		if (o == null) o = VOICE_OVERRIDE.get(ANY_VOICE);
		if (o == null) return instrument;
		return BY_ID.containsKey(o) ? o : instrument;
	}

	/** 当前映射快照（声部 → 乐器 id） */
	public static Map<String, String> overrides() {
		return new LinkedHashMap<>(VOICE_OVERRIDE);
	}

	public static void setOverride(String voice, String id) {
		VOICE_OVERRIDE.put(voice == null || voice.isBlank() ? ANY_VOICE : voice.trim().toLowerCase(), id);
		saveVoices();
	}

	public static void clearOverride(String voice) {
		VOICE_OVERRIDE.remove(voice == null || voice.isBlank() ? ANY_VOICE : voice.trim().toLowerCase());
		saveVoices();
	}

	public static void clearAllOverrides() {
		VOICE_OVERRIDE.clear();
		saveVoices();
	}

	private static Path voicesFile() {
		return FabricLoader.getInstance().getGameDir().resolve("config").resolve("nbmachina").resolve("voices.json");
	}

	/** 读覆盖表（客户端启动、`/nbmc reload`、`/nbmc instrument` 都会走） */
	public static void loadVoices() {
		Path f = voicesFile();
		VOICE_OVERRIDE.clear();
		if (!Files.exists(f)) return;
		try (Reader r = Files.newBufferedReader(f, StandardCharsets.UTF_8)) {
			Map<?, ?> m = GSON.fromJson(r, Map.class);
			if (m == null) return;
			for (Map.Entry<?, ?> e : m.entrySet()) {
				String k = String.valueOf(e.getKey()).trim().toLowerCase();
				String val = String.valueOf(e.getValue()).trim();
				if (!k.isEmpty() && !val.isEmpty()) VOICE_OVERRIDE.put(k, val);
			}
			NbmachinaMod.LOGGER.info("[nbmachina] 音色覆盖表已载入：{}", VOICE_OVERRIDE);
		} catch (Exception e) {
			lastError = "voices.json 读取失败：" + e.getMessage();
			NbmachinaMod.LOGGER.warn("[nbmachina] {}", lastError);
		}
	}

	private static void saveVoices() {
		Path f = voicesFile();
		try {
			Files.createDirectories(f.getParent());
			Files.writeString(f, new GsonBuilder().setPrettyPrinting().create().toJson(overrides()), StandardCharsets.UTF_8);
		} catch (IOException e) {
			lastError = "voices.json 写入失败：" + e.getMessage();
			NbmachinaMod.LOGGER.warn("[nbmachina] {}", lastError);
		}
	}

	private NbmachinaInstruments() {
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
		/** M3-31：sta（断奏）采样 —— 短音优先用它 */
		public boolean staccato;

		public double pitchRatio(int midi) {
			return Math.pow(2.0, (midi - root + tuneCents / 100.0) / 12.0);
		}
	}

	public static final class Instrument {
		public String id;
		public String name;
		public String license;
		public boolean isDefault;
		/** 是否有音高：钢琴/竖琴/低音提琴 = true；打击乐 = false（JSON 里可省，省了按 true 处理） */
		public Boolean pitched;
		public List<Region> regions = new ArrayList<>();

		public boolean isPitched() {
			return pitched == null || pitched;
		}

		public int minKey() {
			int m = 127;
			for (Region r : regions) m = Math.min(m, r.loKey);
			return m;
		}

		public int maxKey() {
			int m = 0;
			for (Region r : regions) m = Math.max(m, r.hiKey);
			return m;
		}

		/**
		 * 把超出乐器音域的键**整八度**折回来（不改和声，只换八度）——
		 * 与离线渲染 `render-ensemble` 的 `foldIntoRange` 同一口径。
		 * 例：低音提琴只到 C1(24)，谱面里的 A0(21) 会被折到 A1(33)，而不是硬降 3 个半音。
		 */
		public int foldKey(int midi) {
			int lo = minKey();
			int hi = maxKey();
			if (regions.isEmpty() || lo > hi) return midi;
			int m = midi;
			while (m < lo) m += 12;
			while (m > hi) m -= 12;
			return m;
		}

		/** 精确命中 → 退化命中（键位最近、再力度最近）；永不返回 null（除非该乐器没有区域） */
		public Region pick(int midi, int velocity) {
			return pick(midi, velocity, 0);
		}

		/**
		 * M3-31：多一个"短音优先用 sta（断奏）采样"的规则。
		 *
		 * <p>为什么：OLPC 合集里同一颗音同时录了 leg（连奏）与 sta（断奏）两套。谱面带 `dur_ms`
		 * （实际发声时长），短于 {@link #STACCATO_MS} 的音用 sta 采样更干净——leg 采样被制音器包络
		 * 硬切出来的音头会发闷。没有 sta 区域（如 Salamander）或 durMs=0（没有时值信息）时自动退回原逻辑。
		 */
		public Region pick(int midi, int velocity, int durMs) {
			// 有 sta 区域时**互斥**选池：短音只用 sta、长音只用 leg。
			// 不互斥的话，sta 区域（loKey==hiKey）会在"键位距离"上打平、再靠力度距离把长音也抢走。
			boolean hasSta = false;
			for (Region r : regions) {
				if (r.staccato) { hasSta = true; break; }
			}
			if (hasSta) {
				int mode = (staccatoMs > 0 && durMs > 0 && durMs <= staccatoMs) ? MODE_STA : MODE_LEG;
				Region r = pickFrom(regions, midi, velocity, mode);
				if (r != null) return r;
			}
			return pickFrom(regions, midi, velocity, MODE_ANY);
		}

		private static Region pickFrom(List<Region> pool, int midi, int velocity, int mode) {
			Region best = null;
			int bestScore = Integer.MAX_VALUE;
			for (Region r : pool) {
				if (mode == MODE_STA && !r.staccato) continue;
				if (mode == MODE_LEG && r.staccato) continue;
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

	/**
	 * sta（断奏）采样的启用阈值（ms）：**默认 0 = 关闭**。
	 *
	 * <p>2026-09-18 用户试听判定"改了之后似乎缺音了"，量化复核确认：OLPC 的 sta 采样衰减极快
	 * （前 200ms 掉 20~30dB），而谱面里 142–245ms 的"短音"在参考演奏里是**带踏板延续**的
	 * （原曲那几处包络 400ms 内只掉约 10dB）→ 换 sta 后这些音明显变轻，听感就是缺音。
	 * 默认走 leg；想实验可用 `/nbmc sta &lt;ms&gt;`（例如 120）只让"极短"的音用 sta。
	 */
	private static volatile int staccatoMs = 0;

	public static int staccatoMs() {
		return staccatoMs;
	}

	public static void setStaccatoMs(int ms) {
		staccatoMs = Math.max(0, Math.min(1000, ms));
	}
	/** 选池模式：任意 / 只用 sta / 只用 leg */
	private static final int MODE_ANY = 0, MODE_STA = 1, MODE_LEG = 2;

	private static final class Root {
		public List<Instrument> instruments = new ArrayList<>();
	}

	/** 配置文件位置：`<游戏目录>/config/nbmachina/instruments.json` */
	public static Path configFile() {
		return FabricLoader.getInstance().getConfigDir().resolve("nbmachina").resolve("instruments.json");
	}

	/** 候选路径：config 目录优先，其次游戏目录下的 `nbmachina/instruments.json`（便于直接拷贝） */
	public static List<Path> candidates() {
		Path gameDir = FabricLoader.getInstance().getGameDir();
		return List.of(configFile(), gameDir.resolve("nbmachina").resolve("instruments.json"));
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
				NbmachinaMod.LOGGER.info("[nbmachina] 乐器库已加载：{} 个乐器（{}）", BY_ID.size(), p);
				return BY_ID.size();
			} catch (IOException | RuntimeException e) {
				lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
				NbmachinaMod.LOGGER.warn("[nbmachina] 乐器库解析失败 {}：{}", p, lastError);
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
