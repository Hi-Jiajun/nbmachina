// M3-37 · 触发位映射（单一来源）：给每个音符算一个**水平相邻**的空位，用来"放红石块 → 音符盒响"。
//
// 为什么必须水平相邻：2026-09-19 的无头实验（docs/M3-37-noteblock-trigger-matrix.md）证明
// 1.21.10 里只有**水平相邻**的红石块能触发音符盒 —— 正上方、正下方、隔着导体甲板下方都不行。
// 而现在的密集单排布局里，音符盒左右是别的音符盒，所以要在音符盒那一层找"没被机器占用"的格子。
//
// 占用格定义（与 src/emit/note-blocks.mjs 摆的方块一一对应）：
//   灯 (x, y-1, z) / 甲板 (x, y, z) / 音符盒 (x, y+1, z) / 旧触发位 (x, y+2, z)
// 候选触发位只在**音符盒那一层**（y+1）里选，按 zPlus → zMinus → xPlus → xMinus 的固定顺序；
// 同一个格子只允许一个音符用（否则两音的"放置/清除"会互相打架）。

/**
 * @param {Array<{step:number, pitch:number}>} notes 机器谱面（step = 格位，pitch = 音符盒 row 0..24）
 * @param {(step:number, pitch:number) => {x:number,y:number,z:number}} pos makePos(profile)
 * @returns {{cells: Array<{x:number,y:number,z:number,dir:string}|null>, occupied: Set<string>, missing: number}}
 */
export function buildTriggerMap(notes, pos) {
  return buildTriggerMapFromPoints(notes.map((n) => pos(n.step, n.pitch)));
}

/**
 * 同上，但直接用**已经算好的甲板坐标**（`{x,y,z}` = 甲板那一格）。
 * `src/emit/note-blocks.mjs` 摆方块时手上就是坐标，用这个入口避免再算一次。
 */
export function buildTriggerMapFromPoints(points) {
  // M3-68（用户 2026-09-22）：**触发位改成音符盒正下方**（= 原来甲板那一格 (x,y,z)）。
  // 用户实测：红石块放音符盒下方可以正常激活，而且这样做天然"只点亮自己"——
  // 相邻音符盒都在 (x±1,y+1,z) 或 (x,y+1,z±1)，与 (x,y,z) 只成对角关系，不会互相点亮。
  const noteCells = new Set(points.map((p) => `${p.x},${p.y + 1},${p.z}`));
  const occupied = new Set();
  for (const p of points) {
    for (const dy of [-1, 0, 1, 2]) occupied.add(`${p.x},${p.y + dy},${p.z}`);
  }
  const used = new Map();
  const cells = points.map((p, i) => {
    const key = `${p.x},${p.y},${p.z}`;
    used.set(key, i);
    return { x: p.x, y: p.y, z: p.z, dir: 'below', strict: true };
  });
  return { cells, occupied, missing: 0, strictCount: cells.length, looseCount: 0 };
}

/** 旧的"水平相邻"触发位算法（保留备用：万一哪天又要换回去） */
export function buildTriggerMapHorizontal(points) {
  const noteCells = new Set(points.map((p) => `${p.x},${p.y + 1},${p.z}`));
  const occupied = new Set();
  for (const p of points) {
    for (const dy of [-1, 0, 1, 2]) occupied.add(`${p.x},${p.y + dy},${p.z}`);
  }
  const used = new Map();
  const cells = points.map((p, i) => {
    const y = p.y + 1;
    const self = `${p.x},${y},${p.z}`;
    const candidates = [
      ['zPlus', p.x, y, p.z + 1],
      ['zMinus', p.x, y, p.z - 1],
      ['xPlus', p.x + 1, y, p.z],
      ['xMinus', p.x - 1, y, p.z],
    ];
    // 严格优先：触发位**只能挨着目标这一个音符盒**。
    // 否则红石块会顺手点亮旁边的音符盒（实测 3044 个位里有 309 个会"多点亮"）→ 多出来的音。
    let loose = null;
    for (const [dir, x, cy, z] of candidates) {
      const key = `${x},${cy},${z}`;
      if (occupied.has(key) || used.has(key)) continue;
      const cell = { x, y: cy, z, dir };
      if (!loose) loose = cell;
      let others = 0;
      for (const [dx, dy, dz] of [[0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0]]) {
        const k = `${x + dx},${cy + dy},${z + dz}`;
        if (k !== self && noteCells.has(k)) others++;
      }
      if (others === 0) {
        used.set(key, i);
        return { ...cell, strict: true };
      }
    }
    if (loose) {
      used.set(`${loose.x},${loose.y},${loose.z}`, i);
      return { ...loose, strict: false };
    }
    return null;
  });
  return {
    cells,
    occupied,
    missing: cells.filter((c) => !c).length,
    strictCount: cells.filter((c) => c?.strict).length,
    looseCount: cells.filter((c) => c && !c.strict).length,
  };
}

/** 触发位所在格 → 该格在"机器占用表"里是否真的空着（自检用） */
export function cellKey(cell) {
  return `${cell.x},${cell.y},${cell.z}`;
}
