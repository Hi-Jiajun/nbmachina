package net.nbforge.mod;

import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.minecraft.sound.SoundEvent;
import net.minecraft.util.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import net.nbforge.mod.net.NbforgePlayPayload;

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
		NbforgeSelfTest.register();
	}
}
