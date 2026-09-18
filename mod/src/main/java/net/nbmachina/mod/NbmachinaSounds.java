package net.nbmachina.mod;

import net.minecraft.registry.Registries;
import net.minecraft.sound.SoundEvent;
import net.minecraft.util.Identifier;

/**
 * 音色 id 解析：注册表优先，资源包 id 兜底。
 *
 * <p>资源包里已有的 148 个音色（assets/nbmachina/sounds.json，键名如 strings_e4）没有注册
 * 进 sound_event 注册表，但 {@code SoundEvent.of(id)} 仍可播（客户端按 id 去 sounds.json 找采样），
 * 所以这里查不到注册表条目时回退成动态事件，保证「已有音色表」零改造可用。
 */
public final class NbmachinaSounds {
	private static final String MOD_NAMESPACE = NbmachinaMod.MOD_ID;

	/**
	 * 静音事件（资源包里的 0.05s 静音采样）。
	 *
	 * <p>**目前没有调用方**：原本给 mixin 版"替换掉原版音符盒声音"用，但那版卡在 refmap
	 * （Loom 没生成 → 注入不生效，见 docs/M3-4-report.md §5）；现在的做法是数据包在 `#hifi=1`
	 * 时干脆不触发音符盒。保留它是为了 mixin 路线修好后能直接接上（届时可恢复音符粒子由方块本身生成）。
	 */
	public static final Identifier SILENT_ID = Identifier.of(MOD_NAMESPACE, "silent");

	private NbmachinaSounds() {
	}

	public static SoundEvent resolve(String raw) {
		Identifier soundId = parse(raw);
		if (soundId == null) {
			return null;
		}
		return resolve(soundId);
	}

	/**
	 * 命令层入口（{@code /nbmachina note <identifier>}）。
	 *
	 * <p>裸名会被 {@code IdentifierArgumentType} 解析成 {@code minecraft:<name>}——这不是用户的本意，
	 * 所以 {@code minecraft} 命名空间先在注册表里找，找不到再按本 mod 的命名空间试一次；
	 * 例如 {@code demo_bell} → {@code minecraft:demo_bell}（未注册）→ {@code nbmachina:demo_bell}。
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
			// 裸名（`/nbmachina note demo_bell`）会被 IdentifierArgumentType 解析成 minecraft:demo_bell
			Identifier inMod = Identifier.of(MOD_NAMESPACE, soundId.getPath());
			SoundEvent modRegistered = Registries.SOUND_EVENT.get(inMod);
			return modRegistered != null ? modRegistered : SoundEvent.of(inMod);
		}
		// 其余命名空间（含 nbmachina:strings_e4 这类资源包音色）：动态事件，客户端按 id 去 sounds.json 找采样
		return SoundEvent.of(soundId);
	}

	/** 字符串写法（自检/控制台脚本用）：支持 {@code demo_bell}、{@code nbmachina:strings_e4}，两侧引号会被剥掉。 */
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
				: Identifier.of(NbmachinaMod.MOD_ID, trimmed);
		} catch (RuntimeException e) {
			return null;
		}
	}
}
