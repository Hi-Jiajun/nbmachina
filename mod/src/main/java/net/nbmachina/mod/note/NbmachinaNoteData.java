package net.nbmachina.mod.note;

import net.minecraft.block.Blocks;
import net.minecraft.block.entity.BlockEntityType;
import net.minecraft.registry.Registries;
import net.minecraft.registry.Registry;
import net.fabricmc.fabric.api.object.builder.v1.block.entity.FabricBlockEntityTypeBuilder;
import net.nbmachina.mod.NbmachinaMod;

/**
 * M3-98a · 把 {@link NoteDataBlockEntity} 注册到**原版音符盒**上。
 *
 * <p>原版 note_block 没有方块实体；Fabric 侧可以注册一个声明了 {@code Blocks.NOTE_BLOCK} 的
 * BlockEntityType —— 之后 `setBlockState` 放下的音符盒就会带 BE，`/clone`、结构方块、存档都会带上 NBT。
 */
public final class NbmachinaNoteData {

	public static final BlockEntityType<NoteDataBlockEntity> NOTE_DATA =
		Registry.register(Registries.BLOCK_ENTITY_TYPE, NbmachinaMod.id("note_data"),
			FabricBlockEntityTypeBuilder.create(NoteDataBlockEntity::new, Blocks.NOTE_BLOCK).build());

	private NbmachinaNoteData() {
	}

	/** 由主初始化器调用，触发类加载与注册。 */
	public static void register() {
		NbmachinaMod.LOGGER.info("[nbmachina] 音符数据方块实体已注册：{}（音符盒自带 NBT 可用）", NOTE_DATA);
	}
}
