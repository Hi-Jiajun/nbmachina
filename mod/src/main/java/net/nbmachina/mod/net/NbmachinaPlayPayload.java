package net.nbmachina.mod.net;

import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.codec.PacketCodecs;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.util.Identifier;

/**
 * M3-16（P2）· 服务端 → 客户端：播放一颗音。
 *
 * <p>这是 mod 音频引擎的"音符"协议：只带（乐器 id、声部、midi、力度、世界坐标），
 * 采样文件与变调全部在客户端按乐器库解析——因为客户端才有 OpenAL 与无损采样缓存。
 *
 * <p>力度用 1..127 的 MIDI 口径（与谱面 `velMidi` 一致），客户端按"力度层 + 增益"两层使用它。
 * <p>**声部**（harp/bass/…）决定客户端怎么处理"放音"（damping）：
 * `bass` 走**单声部**（新音进来就把上一条低音放掉，模拟钢琴换踏板/贝斯手换音），
 * 其余声部保留自然衰减，只在**同键重击**时放掉上一个（同一根弦被重新敲响）。
 *
 * <p>**durMs**（M3-22）：这颗音的**实际发声时长**（毫秒，0 = 没这信息）。它由
 * `tools/calibrate-from-reference.mjs` 从参考演奏里量出来 —— 键释放 + 踏板抬起
 * （踏板踩着时松键不制音）。有了它，钢琴就不必靠"低音单声部"这类补丁去糊，
 * 而是照抄演奏者的放音时刻。
 */
public record NbmachinaPlayPayload(String instrument, String voice, int midi, int velocity, int durMs,
								double x, double y, double z, double scoreTimeSec)
	implements CustomPayload {

	/** 立即播放（scoreTimeSec = 0）——给 /nbm 命令等即时路径用 */
	public NbmachinaPlayPayload(String instrument, String voice, int midi, int velocity, int durMs,
							double x, double y, double z) {
		this(instrument, voice, midi, velocity, durMs, x, y, z, 0.0);
	}

	public static final CustomPayload.Id<NbmachinaPlayPayload> ID =
		new CustomPayload.Id<>(Identifier.of("nbmachina", "play"));

	// M3-53：多了一个 `scoreTimeSec`（这颗音在谱面里的时间，0 = 立即播），tuple 不够用 → 手写编解码
	public static final PacketCodec<RegistryByteBuf, NbmachinaPlayPayload> CODEC = PacketCodec.of(
		(payload, buf) -> {
			PacketCodecs.STRING.encode(buf, payload.instrument());
			PacketCodecs.STRING.encode(buf, payload.voice());
			PacketCodecs.VAR_INT.encode(buf, payload.midi());
			PacketCodecs.VAR_INT.encode(buf, payload.velocity());
			PacketCodecs.VAR_INT.encode(buf, payload.durMs());
			PacketCodecs.DOUBLE.encode(buf, payload.x());
			PacketCodecs.DOUBLE.encode(buf, payload.y());
			PacketCodecs.DOUBLE.encode(buf, payload.z());
			PacketCodecs.DOUBLE.encode(buf, payload.scoreTimeSec());
		},
		buf -> new NbmachinaPlayPayload(
			PacketCodecs.STRING.decode(buf),
			PacketCodecs.STRING.decode(buf),
			PacketCodecs.VAR_INT.decode(buf),
			PacketCodecs.VAR_INT.decode(buf),
			PacketCodecs.VAR_INT.decode(buf),
			PacketCodecs.DOUBLE.decode(buf),
			PacketCodecs.DOUBLE.decode(buf),
			PacketCodecs.DOUBLE.decode(buf),
			PacketCodecs.DOUBLE.decode(buf)));

	@Override
	public CustomPayload.Id<? extends CustomPayload> getId() {
		return ID;
	}
}
