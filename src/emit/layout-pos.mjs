// 谱面坐标规则（单一来源）：播放器放触发方块、生成器摆音符盒，必须用同一个函数，
// 否则"播放器按新谱面算的坐标"和"世界里摆着的音符盒"会错位——音符盒不会响。
//
// 单排：step → 段号 seg=floor(step/48)、段内偏移 lx=step%48；段的 x0/y 从 single_row_profile.json 读。
// 每个音符占 4 格（竖直）：y-1 红石灯 / y 甲板（乐器方块）/ y+1 音符盒 / y+2 触发位（瞬放红石块）。
export function makePos(profile) {
  return (step, pitch) => {
    const seg = Math.floor(step / 48), lx = step % 48;
    const r = profile[Math.min(seg, profile.length - 1)];
    return { x: r.x0 + lx, y: r.y, z: -172 + pitch + 3 };
  };
}

/** 该声部甲板用什么方块（决定音符盒音色，1.21.10 实测：sand→harp、oak_planks→bass、stone→basedrum、glass→hat） */
export const DECK_BLOCK = {
  harp: 'minecraft:sand',
  bass: 'minecraft:oak_planks',
  basedrum: 'minecraft:stone',
  hat: 'minecraft:glass',
};

export const noteBlockOf = (voice, note) => `minecraft:note_block[instrument=${DECK_BLOCK[voice] ? voice : 'harp'},note=${note},powered=false]`;
