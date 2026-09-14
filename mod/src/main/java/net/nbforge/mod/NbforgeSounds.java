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
	private static final String MOD_NAMESPACE = NbforgeMod.MOD_ID;

	private NbforgeSounds() {
	}

	public static SoundEvent resolve(String raw) {
		Identifier soundId = parse(raw);
		if (soundId == null) {
			return null;
		}
		return resolve(soundId);
	}

	/**
	 * 命令层入口（{@code /nbforge note <identifier>}）。
	 *
	 * <p>裸名会被 {@code IdentifierArgumentType} 解析成 {@code minecraft:<name>}——这不是用户的本意，
	 * 所以 {@code minecraft} 命名空间先在注册表里找，找不到再按本 mod 的命名空间试一次；
	 * 例如 {@code demo_bell} → {@code minecraft:demo_bell}（未注册）→ {@code nbforge:demo_bell}。
	 */
	public static SoundEvent resolve(Identifier soundId) {
		if (soundId == null) {
			return null;
		}
		SoundEvent registered = Registries.SOUND_EVENT.get(soundId);
		if (registered != null) {
			return registered; // 注册表命中：本 mod 的 demo_*、以及全部原版音效都走这里
		}
		if ("minecraft".equals(soundId.getNamespace())) {
			// 裸名（`/nbforge note demo_bell`）会被 IdentifierArgumentType 解析成 minecraft:demo_bell
			Identifier inMod = Identifier.of(MOD_NAMESPACE, soundId.getPath());
			SoundEvent modRegistered = Registries.SOUND_EVENT.get(inMod);
			return modRegistered != null ? modRegistered : SoundEvent.of(inMod);
		}
		// 其余命名空间（含 nbforge:strings_e4 这类资源包音色）：动态事件，客户端按 id 去 sounds.json 找采样
		return SoundEvent.of(soundId);
	}

	/** 字符串写法（自检/控制台脚本用）：支持 {@code demo_bell}、{@code nbforge:strings_e4}，两侧引号会被剥掉。 */
	public static Identifier parse(String raw) {
		if (raw == null) {
			return null;
		}
		String trimmed = raw.trim();
		if (trimmed.length() >= 2
			&& (trimmed.charAt(0) == '"' || trimmed.charAt(0) == '\'')
			&& trimmed.charAt(trimmed.length() - 1) == trimmed.charAt(0)) {
			trimmed = trimmed.substring(1, trimmed.length() - 1).trim(); // 兼容用户写引号的习惯
		}
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
