package net.nbmachina.mod.net;

import net.minecraft.network.RegistryByteBuf;
import net.minecraft.network.codec.PacketCodec;
import net.minecraft.network.codec.PacketCodecs;
import net.minecraft.network.packet.CustomPayload;
import net.minecraft.util.Identifier;

/**
 * M3-51 · 服务端 → 客户端：**"机器从第 X 秒开始跑了，你也从这个时间起播"**。
 *
 * <p>用途：把节奏从"服务器刻（20 tps → 50ms 量化）"提到"客户端 nanoTime（实测抖动 0.18ms）"。
 * 流程：`/nbm machine silent on`（音符盒闭嘴，机器照常亮灯/出粒子）→ `/nbm machine start`
 * → 服务端发这个包 → 每台客户端用它自己的时钟从同一时间点开始播放，误差只有网络单程延迟（本地 ~1ms）。
 */
public record NbmachinaMachineSyncPayload(double fromSec) implements CustomPayload {
	public static final CustomPayload.Id<NbmachinaMachineSyncPayload> ID =
		new CustomPayload.Id<>(Identifier.of("nbmachina", "machine_sync"));
	public static final PacketCodec<RegistryByteBuf, NbmachinaMachineSyncPayload> CODEC = PacketCodec.tuple(
		PacketCodecs.DOUBLE, NbmachinaMachineSyncPayload::fromSec,
		NbmachinaMachineSyncPayload::new);

	@Override
	public Id<? extends CustomPayload> getId() {
		return ID;
	}
}
