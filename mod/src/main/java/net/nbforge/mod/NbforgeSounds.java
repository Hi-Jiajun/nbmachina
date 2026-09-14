package net.nbforge.mod;

import net.minecraft.registry.Registries;
import net.minecraft.sound.SoundEvent;
import net.minecraft.util.Identifier;

/**
 * 音色 id 解析：注册表优先，资源包 id 兜底。
 *
 * <p>资源包里已有的 148 个音色（assets/nbforge/sounds.json，键名如 strings_e4）没有注册
 * 进 sound_event 注册表，但 {@code SoundEvent.of(id)} 仍可播（客户端按 id 去 sounds.json 找采样），
 * 所以这里查不到注册表条目时回退成动态事件，保证「已有音色表」零改造可用。
 */
public final class NbforgeSounds {
	private NbforgeSounds() {
	}

	public static SoundEvent resolve(String raw) {
		Identifier soundId = parse(raw);
		if (soundId == null) {
			return null;
		}
		SoundEvent registered = Registries.SOUND_EVENT.get(soundId);
		return registered != null ? registered : SoundEvent.of(soundId);
	}

	/** 支持 {@code demo_bell}（补 nbforge 命名空间）与 {@code nbforge:strings_e4} 两种写法。 */
	public static Identifier parse(String raw) {
		if (raw == null) {
			return null;
		}
		String trimmed = raw.trim();
		if (trimmed.isEmpty()) {
			return null;
		}
		try {
			return trimmed.indexOf(':') >= 0
				? Identifier.tryParse(trimmed)
				: Identifier.of(NbforgeMod.MOD_ID, trimmed);
		} catch (RuntimeException e) {
			return null;
		}
	}
}
