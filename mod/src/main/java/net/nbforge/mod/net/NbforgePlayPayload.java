package net.nbforge.mod.net;

import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.codec.PacketCodecs;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.util.Identifier;

/**
 * M3-16（P2）· 服务端 → 客户端：播放一颗音。
 *
 * <p>这是 mod 音频引擎的"音符"协议：只带（乐器 id、midi、力度、世界坐标），
 * 采样文件与变调全部在客户端按乐器库解析——因为客户端才有 OpenAL 与无损采样缓存。
 *
 * <p>力度用 1..127 的 MIDI 口径（与谱面 `velMidi` 一致），客户端按"力度层 + 增益"两层使用它。
 */
public record NbforgePlayPayload(String instrument, int midi, int velocity, double x, double y, double z)
	implements CustomPayload {

	public static final CustomPayload.Id<NbforgePlayPayload> ID =
		new CustomPayload.Id<>(Identifier.of("nbforge", "play"));

	public static final PacketCodec<RegistryByteBuf, NbforgePlayPayload> CODEC = PacketCodec.tuple(
		PacketCodecs.STRING, NbforgePlayPayload::instrument,
		PacketCodecs.VAR_INT, NbforgePlayPayload::midi,
		PacketCodecs.VAR_INT, NbforgePlayPayload::velocity,
		PacketCodecs.DOUBLE, NbforgePlayPayload::x,
		PacketCodecs.DOUBLE, NbforgePlayPayload::y,
		PacketCodecs.DOUBLE, NbforgePlayPayload::z,
		NbforgePlayPayload::new);

	@Override
	public CustomPayload.Id<? extends CustomPayload> getId() {
		return ID;
	}
}
