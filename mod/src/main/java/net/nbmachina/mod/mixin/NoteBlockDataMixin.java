package net.nbmachina.mod.mixin;

import net.minecraft.block.BlockState;
import net.minecraft.block.NoteBlock;
import net.minecraft.block.entity.BlockEntity;
import net.minecraft.block.BlockEntityProvider;
import net.minecraft.util.math.BlockPos;
import net.nbmachina.mod.note.NoteDataBlockEntity;
import org.spongepowered.asm.mixin.Mixin;

/**
 * M3-98a 补丁 · 让**原版音符盒**变成"会带方块实体"的方块。
 *
 * <p>踩坑记录（用户实测报错"目标方块不是方块实体"）：只注册 {@code BlockEntityType} 是**不够的**——
 * 原版 {@code NoteBlock} 没有实现 {@link BlockEntityProvider}，所以 {@code setBlockState} 放下音符盒时
 * 根本不会去建 BE，`/data get block` 自然说"不是方块实体"。
 * 这里把 NoteBlock 实现成 BlockEntityProvider（`BlockState#hasBlockEntity()` 就是按这个接口判断的），
 * 之后每次放下音符盒都会自动挂上 {@link NoteDataBlockEntity}。
 */
@Mixin(NoteBlock.class)
public abstract class NoteBlockDataMixin implements BlockEntityProvider {

	@Override
	public BlockEntity createBlockEntity(BlockPos pos, BlockState state) {
		return new NoteDataBlockEntity(pos, state);
	}
}
