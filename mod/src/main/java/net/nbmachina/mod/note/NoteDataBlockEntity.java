package net.nbmachina.mod.note;

import net.minecraft.block.BlockState;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.nbt.NbtCompound;
import net.minecraft.network.listener.ClientPlayPacketListener;
import net.minecraft.network.packet.Packet;
import net.minecraft.network.packet.s2c.play.BlockEntityUpdateS2CPacket;
import net.minecraft.registry.RegistryWrapper;
import net.minecraft.storage.ReadView;
import net.minecraft.storage.WriteView;
import net.minecraft.util.math.BlockPos;
import org.jetbrains.annotations.Nullable;

/**
 * M3-98a · 挂在原版音符盒上的方块实体：**让机器自带音符数据**。
 *
 * <p>动机（见 docs/M3-98-block-carried-notes.md）：运行时依赖 machine_map.csv / score.csv 时，
 * "世界里的方块"与"表里的数据"是两个真值，换代/换原点/换存档必然错位。把数据写进方块后，
 * `/clone`、结构文件、存档迁移都会把它带着走，机器就是唯一真值。
 *
 * <p>字段刻意最小化：{@code instrument / voice / midi / velocity / dur_ms}（{@code time_sec} 可选，写进去便于自描述）。
 * 时序本身由几何编码（step = 段号*48 + 段内 x，time = step * STEP_SECONDS），不需要存在这里。
 */
public class NoteDataBlockEntity extends BlockEntity {

	/** M3-98a：字段名**平铺**存储（1.21.10 的 ReadView/WriteView 没有现成的嵌套 NBT 写入 API，
	 *  平铺反而更好读：`/data get block … nbm_midi`）。数据包里的 `data merge block` 用同一套键名。 */
	public static final String K_INSTRUMENT = "nbm_instrument";
	public static final String K_VOICE = "nbm_voice";
	public static final String K_MIDI = "nbm_midi";
	public static final String K_VELOCITY = "nbm_velocity";
	public static final String K_DUR_MS = "nbm_dur_ms";
	public static final String K_TIME_SEC = "nbm_time_sec";

	@Nullable private String instrument;
	@Nullable private String voice;
	private int midi = -1;
	private int velocity = -1;
	private int durMs = -1;
	private double timeSec = -1;

	public NoteDataBlockEntity(BlockPos pos, BlockState state) {
		super(NbmachinaNoteData.NOTE_DATA, pos, state);
	}

	public void set(String instrument, String voice, int midi, int velocity, int durMs, double timeSec) {
		this.instrument = instrument;
		this.voice = voice;
		this.midi = midi;
		this.velocity = velocity;
		this.durMs = durMs;
		this.timeSec = timeSec;
		this.markDirty();
		if (this.world != null) {
			this.world.updateListeners(this.pos, this.getCachedState(), this.getCachedState(), 3);
		}
	}

	public boolean hasData() {
		return this.instrument != null && this.midi >= 0;
	}

	@Nullable public String instrument() { return this.instrument; }
	@Nullable public String voice() { return this.voice; }
	public int midi() { return this.midi; }
	public int velocity() { return this.velocity; }
	public int durMs() { return this.durMs; }
	public double timeSec() { return this.timeSec; }

	@Override
	protected void writeData(WriteView view) {
		super.writeData(view);
		if (this.instrument != null) view.putString(K_INSTRUMENT, this.instrument);
		if (this.voice != null) view.putString(K_VOICE, this.voice);
		view.putInt(K_MIDI, this.midi);
		view.putInt(K_VELOCITY, this.velocity);
		view.putInt(K_DUR_MS, this.durMs);
		if (this.timeSec >= 0) view.putDouble(K_TIME_SEC, this.timeSec);
	}

	@Override
	protected void readData(ReadView view) {
		super.readData(view);
		this.instrument = view.getString(K_INSTRUMENT, null);
		this.voice = view.getString(K_VOICE, null);
		this.midi = view.getInt(K_MIDI, -1);
		this.velocity = view.getInt(K_VELOCITY, -1);
		this.durMs = view.getInt(K_DUR_MS, -1);
		this.timeSec = view.getDouble(K_TIME_SEC, -1);
	}

	/** 让客户端在区块首次下发时就能拿到这些数据（机器是静态的，不需要每 tick 同步）。 */
	@Override
	public NbtCompound toInitialChunkDataNbt(RegistryWrapper.WrapperLookup registries) {
		return this.createNbt(registries);
	}

	@Nullable
	@Override
	public Packet<ClientPlayPacketListener> toUpdatePacket() {
		return BlockEntityUpdateS2CPacket.create(this);
	}
}
