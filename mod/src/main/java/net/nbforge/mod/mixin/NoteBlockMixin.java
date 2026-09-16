package net.nbforge.mod.mixin;

import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import net.minecraft.block.BlockState;
import net.minecraft.block.NoteBlock;
import net.minecraft.util.math.BlockPos;
import net.minecraft.world.World;

import net.nbforge.mod.note.NbforgeNoteBlocks;

/**
 * M3-21 · 机器与引擎合一：音符盒被红石触发时，用我们的无损引擎发声。
 *
 * <p>注入点选 `NoteBlock.onSyncedBlockEvent` 的**方法头**，理由（javap 实证）：
 * `playNote` 内部是 if/else —— **客户端只生成粒子、服务端才播声音**（`World.addParticleClient`
 * 在客户端分支，`World.playSound` 在服务端分支）。所以服务端在方法头接管，只掐掉"原版声音"，
 * 粒子照旧由客户端生成，一点不损失。
 *
 * <p>（`@Redirect` 那条路走不通：没有 refmap 时 target 描述符不会被 remap，
 * Mixin 扫到 0 个目标 → `InjectionError`。方法名注入则不受影响——这是实测结论。）
 */
@Mixin(NoteBlock.class)
public abstract class NoteBlockMixin {
	@Inject(method = "onSyncedBlockEvent", at = @At("HEAD"), cancellable = true)
	private void nbforge$onSyncedBlockEvent(BlockState state, World world, BlockPos pos, int type, int data,
											CallbackInfoReturnable<Boolean> cir) {
		if (NbforgeNoteBlocks.onNoteBlockEvent(world, pos, state)) {
			// 已经在客户端用无损引擎发声：跳过原版 playNote（服务端这一支只有 playSound）
			cir.setReturnValue(true);
		}
	}
}
