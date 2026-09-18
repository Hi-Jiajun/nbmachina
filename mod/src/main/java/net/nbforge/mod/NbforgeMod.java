package net.nbforge.mod;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.sound.SoundEvent;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.nbforge.mod.net.NbforgePlayPayload;
import net.nbforge.mod.score.NbforgeScorePlayer;

/**
 * nbforge 后端 A 的最小骨架。
 *
 * <p>与「资源包 + /playsound」方案的区别：
 * <ul>
 *   <li>音色绑定：音色事件由 mod 注册进 {@code minecraft:sound_event} 注册表，可按 id 直接引用；</li>
 *   <li>独立力度：{@code World#playSound(..., volume, pitch)} 的 volume/pitch 由调用方逐音指定；</li>
 *   <li>独立延音：{@link NbforgeSustainQueue} 用 tick 级重触发 + 包络衰减，超出单次播放长度。</li>
 * </ul>
 */
public class NbforgeMod implements ModInitializer {
	public static final String MOD_ID = "nbforge";
	public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

	/** 四个示例音色事件；sounds.json 里指向的资源包音频位于 assets/nbforge/sounds/{bell,pad,strings,bass}。 */
	public static final SoundEvent DEMO_BELL = registerSound("demo_bell");
	public static final SoundEvent DEMO_PAD = registerSound("demo_pad");
	public static final SoundEvent DEMO_STRINGS = registerSound("demo_strings");
	public static final SoundEvent DEMO_BASS = registerSound("demo_bass");

	public static Identifier id(String path) {
		return Identifier.of(MOD_ID, path);
	}

	// ------------------------------------------------------------------ 声部 → 乐器
	/** 旋律声部用的乐器（默认 Salamander 48k/24bit 母版） */
	public static volatile String MELODY_INSTRUMENT = "salamander48";
	/** 低声声部用的乐器（全钢琴预设下与旋律同琴；小编制预设可换成 vsco_contrabass_pizz） */
	public static volatile String BASS_INSTRUMENT = "salamander48";
	/** 打击乐声部用的乐器（全钢琴预设下为 null = 跳过；小编制预设可换成 vsco_perc） */
	public static volatile String PERC_INSTRUMENT = null;

	/**
	 * 声部名（harp/bass/basedrum/hat…）→ 乐器库 id；null 表示"这个声部现在不发声"。
	 * 机器（音符盒）触发时用它决定播哪个乐器——与 `score.csv` 的映射保持同一套预设。
	 */
	public static String instrumentForVoice(String voice) {
		return switch (String.valueOf(voice).toLowerCase()) {
			case "harp", "bell", "inner", "melody" -> MELODY_INSTRUMENT;
			case "bass" -> BASS_INSTRUMENT;
			case "basedrum", "hat", "snare", "perc" -> PERC_INSTRUMENT;
			default -> MELODY_INSTRUMENT;
		};
	}

	private static SoundEvent registerSound(String path) {
		Identifier soundId = id(path);
		return Registry.register(Registries.SOUND_EVENT, soundId, SoundEvent.of(soundId));
	}

	@Override
	public void onInitialize() {
		LOGGER.info("[nbforge] onInitialize：已注册自定义音色事件 demo_bell/demo_pad/demo_strings/demo_bass");
		// P2：音符协议（服务端 → 客户端）。必须在两边都注册，否则客户端拒收。
		PayloadTypeRegistry.playS2C().register(NbforgePlayPayload.ID, NbforgePlayPayload.CODEC);
		LOGGER.info("[nbforge] 已注册 S2C 音符协议 nbforge:play");
		NbforgeCommands.register();
		NbforgeSustainQueue.register();
		NbforgeScorePlayer.register();
		NbforgeSelfTest.register();
		// 机器映射（位置 → 谱面音符）：起服时读一次，红石触发时就能查到"这颗音该多大力"。
		// M3-23：`/reload`（数据包重载）与 `/nbforge reloadmap` 也会重读 —— 换谱面时不用重启游戏。
		ServerLifecycleEvents.SERVER_STARTED.register(NbforgeMod::reloadMachineMap);
		ServerLifecycleEvents.END_DATA_PACK_RELOAD.register(
			(server, resourceManager, success) -> reloadMachineMap(server));
	}

	/** 重新读入 `nbforge/machine_map.csv`（服务端启动、`/reload`、`/nbforge reloadmap` 都走这里） */
	public static void reloadMachineMap(net.minecraft.server.MinecraftServer server) {
		java.nio.file.Path map = server.getRunDirectory().resolve("nbforge").resolve("machine_map.csv");
		try {
			int n = net.nbforge.mod.note.NbforgeNoteBlocks.loadMap(map);
			LOGGER.info("[nbforge] 机器映射已加载：{} 个音符盒位置 ← {}", n, map);
		} catch (java.io.IOException e) {
			LOGGER.warn("[nbforge] 机器映射未加载（{}）：{} —— 音符盒仍会发声，但力度用默认值",
				map, e.getMessage());
		}
	}
}
