package net.nbmachina.mod.show;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

import com.google.gson.Gson;

import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.command.ServerCommandSource;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.server.world.ServerWorld;
import net.nbmachina.mod.NbmachinaMod;

/**
 * M5 · STYX HELIX 视效层（**方案 A**：挂在 mod 的"到点"时刻上，`/nbm machine start` 一条命令即出画面）。
 *
 * <p>与演奏共用同一根真实时间轴（nanoTime）；用服务端命令 `particlex ...` 把 ExParticle 的 payload 发出去
 * —— 不引编译期依赖（避开 LGPL 链接与 Yarn/Mojmap 交叉），命令字符串与 `tools/show-pack.mjs` 同源。
 *
 * <p>数据：`<游戏目录>/nbmachina/styxshow.json`（v2：逐字时间来自**官方 TTML 的 span** + 整体平移；
 * 含每行中文翻译；文字用 textMatrix **平铺在水面上**，配合"从音符盒上方扫到末尾"的运镜）。
 *
 * <p>⚠ 语法口径（2026-09-24 踩过）：`color4`/`speed3`/`range3` 是**空格分隔**；表达式内部元组仍是逗号。
 * `exec()` 一律**先 parse 再 execute**，语法错误不再被 silent source 吞掉。
 */
public final class StyxShow {
	private static final Gson GSON = new Gson();
	/**
	 * 文字朝向的候选矩阵（`/nbm machine textmatrix <序号>` 现场切）。
	 *
	 * <p>2026-09-24 实机对照（把 'E' 用三种矩阵摆在同一机位前拍照比对）确认的口径：
	 * image 粒子的图像坐标里 u 是读向、v 已经翻转成「上」，所以**相机朝 +x（东）时**
	 * 正确的映射是 <b>u → +z、v → +y</b>（= 1 号）。上一版默认的 (u→−z, v→−y)
	 * 等于整幅画面**同时左右镜像 + 上下颠倒**——这就是「歌词朝向始终不对」的真因。
	 */
	private static final String[] MATRICES = {
		"(0,0,0,0,,0,1,0,0,,1,0,0,0,,0,0,0,1)",     // 1 竖立·正对朝 +x 飞的机位（u→+z、上→+y）★默认
		"(0,0,0,0,,0,1,0,0,,-1,0,0,0,,0,0,0,1)",    // 2 同 1 但左右镜像（现场对照用）
		"(0,0,0,0,,0,-1,0,0,,1,0,0,0,,0,0,0,1)",    // 3 同 1 但上下颠倒（现场对照用）
		"(0,1,0,0,,0,0,0,0,,-1,0,0,0,,0,0,0,1)",    // 4 平铺（俯视/水面用，法线朝 +y）
		"(1,0,0,0,,0,1,0,0,,0,0,0,0,,0,0,0,1)",     // 5 正对朝 −z 看的机位
		"(-1,0,0,0,,0,1,0,0,,0,0,0,0,,0,0,0,1)",    // 6 正对朝 +z 看的机位
	};
	private static final String FLAT_MATRIX = MATRICES[3];
	/** 文字是否平铺（决定"屏幕下方"是 +x 还是 −y）：默认竖立 */
	private static int matrixIndex = 0;
	private static final double ZC = 2.5;                    // 机器音轨轴（河心）
	private static final double DECK_TOP = 111.0;            // 甲板顶面（machine_map 的 y=110 是甲板方块）
	/** 唱词基准（图像锚点 = **左下角**：图像沿 +u 右、沿 +v 上展开）。音符盒顶面 112.0 → 抬到 114.1 */
	private static final double LYRIC_Y = DECK_TOP + 3.1;
	private static final double PLAYHEAD_A = 8.3341, PLAYHEAD_B = -32.784;
	/** M5-4：河/螺旋暂缓（用户："其他地方先别做了，等后面一起设计"），只留音符盒 + 文字 */
	private static final boolean AMBIENT_ON = false;

	private record LyricChar(double t, String c, double z, double w, double dur) {
	}

	private record LyricLine(double t, double end, double scale, double w, String tr, List<LyricChar> chars) {
	}

	private static final class Doc {
		int version = 1;
		double shiftSec = 0;
		String textMatrix = FLAT_MATRIX;
		double dpb = 8.0;
		double[] accents = new double[0];
		List<LyricLine> lines = new ArrayList<>();
	}

	private static Doc doc = null;
	private static boolean active = false;
	private static int accCursor = 0;
	private static int lineCursor = 0;
	/** 开场"延迟生成"队列（视效层时间 → 命令）：用生成时刻 + age 控寿命，避免写动态 alpha 窗口。 */
	private record Pending(double at, String cmd) {}
	private static final List<Pending> pending = new ArrayList<>();
	private static int sent = 0;
	private static int failed = 0;
	/** 歌词整体提前/延后（秒，正数 = 更晚出现）：现场微调用 `/nbm machine lyricoff <秒>` */
	private static double lyricOffset = 0.0;

	private StyxShow() {
	}

	public static boolean active() {
		return active;
	}

	public static void setLyricOffset(double sec) {
		lyricOffset = sec;
	}

	public static void setMatrixIndex(int i) {
		matrixIndex = Math.max(0, Math.min(MATRICES.length - 1, i));
	}

	public static String matrixName() {
		return MATRICES[matrixIndex];
	}

	public static double lyricOffset() {
		return lyricOffset;
	}

	public static String status() {
		return String.format("视效 %s；已发 %d 条命令，失败 %d 条；歌词平移 %+.2fs（show.json 内置 %+.2fs）",
			active ? "**运行中**" : "停", sent, failed, lyricOffset, doc == null ? 0 : doc.shiftSec);
	}

	// ───────────────────────── 命令模板（唯一来源） ─────────────────────────

	private static String river() {
		return "particlex tick-parameter end_rod 2 111.12 2.5 0.15 0.86 0.80 0.30 0 0 0 0 2400 "
			+ "\"x,y,z=t,0.15*sin(t/4),sin(t/9)*1.2\" 0.0833 5 26";
	}

	/** 河面再加两条平行光带，让"河"从上方看是一整片而不是一条线 */
	private static String riverLane(double dz) {
		return "particlex tick-parameter end_rod 2 111.12 " + fmt(ZC + dz) + " 0.15 0.86 0.80 0.22 0 0 0 0 2400 "
			+ "\"x,y,z=t,0.10*sin(t/3.4),sin(t/7)*1.6\" 0.0833 4 30";
	}

	private static String helix(double phase) {
		return "particlex tick-polar-parameter end_rod 2 114.5 2.5 0.47 0.36 1.0 0.45 0 0 0 0 2400 "
			+ "\"s1=t*0.62+" + phase + "; s2=1.5708; dis=4.2\" 0.12 3 40";
	}

	// ── 开场三件套：封面 + 标题 + 副标题（2026-09-24 v3：**一图一四边形**）────────────
	//
	// 为什么不再用"一像素一颗粒子"的点阵：
	//   ① 分辨率被粒子数卡死（192² 已经是 3.7 万颗，MC 里再往上加不划算）；
	//   ② 单颗 `end_rod` 精灵是软的，要铺满只能叠到 6.6 倍间距 → 必然糊，且暗部像素
	//      几乎全透明（用户："封面图不全"、"清晰度能不能跟原图一致"）；
	//   ③ 改硬边方片（`minecraft:block` + size=间距）实测被引擎/光影的粒子位置抖动打散，
	//      画面变彩纸屑（2026-09-24 实测：dpb=2、size 恰好铺满时最明显）。
	// 所以：一张贴图 = 一颗 `minecraft:block` 粒子，quad 是 billboard（自动正对镜头），
	// 清晰度 = 贴图分辨率（资源包里的 2048² 封面）。贴图挂在**正常世界里不会出现**的方块上：
	//   · 封面   → minecraft:jigsaw                （贴图 block/jigsaw_top）
	//   · 标题   → minecraft:bamboo_fence_gate     （贴图 block/bamboo_fence_gate_particle）
	//   · 副标题 → minecraft:conduit               （贴图 block/conduit）
	//   ⚠ 必须选**模型里显式写了 particle 槽**的方块：structure_block 的 cube_all 没有 particle 槽，
	//     实测覆盖 block/structure_block_save 无效（粒子仍用原版贴图，2026-09-24 实机截图取证）。
	// ⚠ ExParticle 侧配套改动：TerrainParticleMixin —— 被 size 接管的 block 粒子画**整张** sprite
	//   （原版 TerrainParticle 只随机取 1/4×1/4 子块，那是给"方块碎裂"用的）。
	private static final String COVER_BLOCK = "minecraft:jigsaw";
	private static final String TITLE_BLOCK = "minecraft:bamboo_fence_gate";
	private static final String SUB_BLOCK = "minecraft:conduit";
	/** 点阵/碎块用的方块状态（硬边不透明白方块，ExParticle 会给它逐像素上色）。 */
	private static final String COVER_BLOCK_STATE = "minecraft:block{block_state:\"minecraft:white_concrete\"}";
	/**
	 * 封面见方尺寸（格）。
	 *
	 * <p>⚠ 2026-09-24 实测修正：`size` 的表达值是 1/8 格，但**渲染出来的四边形是 size/4 格**
	 * （1.21.10 的 {@code SingleQuadParticle} 把 {@code getQuadSize()} 当作**半边长**）。
	 * 实机取证：size=64 的板子在 13.5 格外量得 671px 宽，同帧里 6 格外 1×1 红石块量得 101px
	 * → 板子 ≈ 15 格（不是过去以为的 8 格）。点阵那侧是 {@code 像素/dpb} 格，**没有这个 2 倍**。
	 */
	private static final double PLATE_BLOCKS = 12.0;
	private static final double COVER_W = PLATE_BLOCKS;
	/** 封面 12 格 → size=48（四边形 ≈ size/4 格）。 */
	private static final double PLATE_SIZE = PLATE_BLOCKS * 4.0;
	/**
	 * 文案块 15 格（size=60）：贴图墨迹宽 89.6% → 可见文字 ≈13.4 格、曲名一行 ≈10.6 格，
	 * 16 格外约占屏宽四分之一，读得清又不压过封面。
	 */
	private static final double TEXT_BLOCKS = 15.0;
	private static final double TEXT_SIZE = TEXT_BLOCKS * 4.0;
	/**
	 * 接管时间表（2026-09-24 第三轮实测后定稿：**不再写动态 alpha 窗口**）：
	 *
	 * <pre>
	 * +0.45s  清晰板生成（alpha=1 恒定，age=45 刻 → 2.70s 自动消失）
	 * +2.50s  点阵生成（自己从 t=0 淡入 0.3s，然后逐像素吹散；age=34 刻 → 4.20s）
	 * 3.917s  第一颗音
	 * </pre>
	 *
	 * 两个坑（都是实机取证）：
	 * <ol>
	 *   <li>开光影时**半透明粒子会被渲染成抖动麻点**（alpha≈0.7 的封面整块变细密噪点，
	 *       alpha=1 的同一张图干净）→ 清晰板必须整段 alpha=1，淡入淡出交给点阵；</li>
	 *   <li>带 clamp 的**动态 alpha 窗口**在同一会话里时灵时不灵（同一串命令前一次能出、后一次全灭），
	 *       所以改成"**用 age 控制存活时间**、靠时间点切换"，命令里只留 `size=…; alpha=1` 和
	 *       旧版验证过的淡入+吹散表达式。</li>
	 * </ol>
	 */
	/**
	 * 开场三件套时间表（0.5.0；用户 2026-09-24 口径：**"两个封面都不需要动，只需要在一定时间里
	 * 从清晰封面过渡成点阵消散"**）。
	 *
	 * <pre>
	 * 0.00–0.45s  清晰板淡入（位置静止、尺寸不变）
	 * 0.45–2.30s  保持清晰（静止）
	 * 2.30–3.10s  **交叉过渡**：清晰板 alpha 1→0，同时点阵层 alpha 0→1（两块都不动）
	 * 3.15–3.90s  点阵层淡出"消散"（仍然不移动）
	 * 3.917s      第一颗音
	 * </pre>
	 *
	 * 标题/副标题整体后移 0.10s / 0.15s（避免三块一起动像"整体闪"）。
	 * 上一版的"炸开副本"（点向外飞）按用户要求**删除**——现在全程没有位移，只有交叉过渡与淡出。
	 */
	// ── 开场时间线（秒；0.7.0「世界固定」版）────────────────────────────────────────
	// ⚠ ExParticle 表达式里的 t 是**刻数**（命令末尾 step=1 → 每刻 +1），所以"秒"必须 ×20 才等于表达式里的时长。
	// 0.00/0.12  封面 + 文案块淡入 0.70s
	// 0.60-1.20  点阵分 12 条铺好（每条 768 颗，藏在封面后面 0.35 格，全程不透明）
	// 2.35→3.05  封面淡出 0.70s → 露出点阵（交叉过渡，不做半透明叠色）
	// 2.60→3.35  文案块随后淡出（让人多读一会儿）
	// 3.05→3.90  点阵从画面中心向外逐层淡出（消散）
	// 3.917      第一颗音
	private static final double[] OPEN_IN_AT = {0.00, 0.12};
	private static final double OPEN_PLATE_IN_SEC = 0.70;
	/** 封面与文案**同一时刻、同样时长**淡出（用户 2026-09-24：文字要跟封面同步、别那么生硬）。 */
	private static final double OPEN_COVER_OUT_AT = 2.30;
	private static final double OPEN_COVER_OUT_SEC = 0.80;
	private static final double OPEN_TEXT_OUT_AT = OPEN_COVER_OUT_AT;
	private static final double OPEN_TEXT_OUT_SEC = OPEN_COVER_OUT_SEC;
	/** 点阵分批生成：每 0.075s 铺一条（"逐行打点"的打印感），12 条铺完 0.60-1.43s。 */
	private static final double OPEN_DOT_SPAWN_AT = 0.60;
	private static final double OPEN_DOT_SPAWN_STEP = 0.075;
	private static final int OPEN_DOT_BANDS = 12;
	/** 点阵开始消散的时刻（所有条带同时开始，只是各自的 t 起点不同）与消散时长、每格半径的错开量。 */
	private static final double OPEN_DOT_DISSOLVE_AT = OPEN_COVER_OUT_AT + OPEN_COVER_OUT_SEC;   // 3.10s
	private static final double OPEN_DOT_FADE_SEC = 0.55;
	private static final double OPEN_DOT_STAGGER_SEC = 0.025;
	/** 点阵全部消失的时刻（< 第一颗音 3.917s）。 */
	private static final double OPEN_DOT_END_AT = 3.90;
	/**
	 * 点阵素材：128px ÷ dpb8 = **16 格**（与清晰板同尺寸，见 {@link #PLATE_SIZE} 的实测说明）＝ 16384 颗。
	 *
	 * <p>2026-09-24 实测（`ParticleStruct` 实例数）：128² 生成 16020 颗 ≈ 实心像素数，**没有丢粒子**；
	 * 用户看到的"只有一半 / 像个球"是**点太大糊成一团**（当时 1.5 格的点 = 12 个点距），
	 * 加上镜头飞过去把世界坐标里的点阵甩出画面。所以现在是"高密度小点 + 屏幕锁定"。
	 */
	private static final String COVER_GRID_IMAGE = "styx-dot-b";   // styx-dot-b00..b11.png
	/** dpb = 素材像素 ÷ 目标格数：96px ÷ 12 格 = 8（点阵那侧没有 2 倍系数，见 PLATE_BLOCKS）。 */
	private static final double COVER_DPB = 96.0 / PLATE_BLOCKS;
	/**
	 * 点尺寸（1/8 格；渲染出来的四边形 ≈ size/4 格，见 {@link #PLATE_SIZE}）：点距 = 12 格 / 96 = 0.125 格
	 * → size=0.5 时点正好相接。这里按像素亮度给尺寸（半调）：暗部 0.25（半格点距，看得见缝隙）、
	 * 亮部 0.70（略重叠）→ 亮的密、暗的疏，图像结构清楚。
	 */
	private static final String COVER_DOT_SIZE = "0.25+0.45*((cr+cg+cb)/3)";
	/**
	 * 开场卡片距离：**起播那一刻**在玩家前方 {@code OPEN_AHEAD} 格处钉一份，之后**永远不再动**
	 * （2026-09-24 用户口径："封面固定在某个位置"，既不跟镜头跑、也不随飞行漂移）。
	 *
	 * <p>为什么按起播机位钉：起播时玩家的位置/朝向就是他这次运镜的起点（实测 `/nbm machine start`
	 * 都在音轨起点、yaw −90），钉在"眼前 16 格"既保证构图居中，又不受他习惯飞多高影响。
	 * 钉完就固定在世界里 → 镜头推进时卡片自然放大，是"运镜推近"的观感。
	 */
	private static final double OPEN_AHEAD = 16.0;
	/**
	 * 是否把卡片**锚在屏幕上**（0.7.1 起默认 true；用户 2026-09-24 追评：
	 * "不太需要让他们移动，只需要自然显现和消失"）。
	 *
	 * <p>锚定 = 每刻把卡片搬到「当前眼位 + **起播方向**×16 格 + 起播右向×版面偏移」：
	 * 玩家飞行时卡片跟着平移 → **屏幕上位置和大小完全不变**，只有淡入/淡出；
	 * 方向用起播那一刻的常量（不是实时视角），所以转头时它会自然滑出画面，不会"甩着跟着转"。
	 */
	private static final boolean OPEN_SCREEN_ANCHOR = true;
	/** 卡片平面内偏移（格，沿 +z = 相机右）：封面在左、文案块在右，整组大致居中。 */
	private static final double OPEN_COVER_H = -6.5;
	private static final double OPEN_TEXT_H = 7.4;
	/**
	 * 点阵层相对封面的**右移量**（格）。用户 2026-09-24 口径："之前那种向右偏移逐行打点出来的点阵
	 * 还蛮有感觉的……只是把点阵的图层放在文字和封面之后"——即点阵故意偏到封面右侧，
	 * 但它必须**排在后层**：被封面和文字挡住的部分不显示，只在空白处铺开。
	 */
	private static final double OPEN_DOT_SHIFT_H = 6.5;
	/**
	 * 点阵比清晰板靠后多少格：交叉过渡靠"清晰板淡出露出点阵"，避免半透明叠色（开光影会变麻点）。
	 * ⚠ 镜头从 −x 方向飞来，所以"更远"= **更大** 的 x：点阵要放在 {@code ax + OPEN_DOT_BACK}。
	 */
	private static final double OPEN_DOT_BACK = 0.35;

	/**
	 * 板子通用模板：一颗 block 粒子 = 一整张贴图。
	 *
	 * <p>{@code age} 是寿命（刻）；{@code anim} 是 ExParticle 的表达式（逐刻求值），
	 * 里面用 {@code size=}（1/8 格）{@code alpha=}（0–1）{@code vx/vz=}（每刻位移）做动效。
	 * 贴图文件固定用 1×1 白点 `styx-1px.png`：粒子颜色 = 白色 × 贴图 = 贴图原色。
	 */
	private static String plate(String block, double cx, double cy, double cz, int age, String anim) {
		return "particlex image-matrix minecraft:block{block_state:\"" + block + "\"} "
			+ fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " styx-1px.png 1.0 \"E4\" 1 0 0 0 " + age + " \"" + anim + "\" 1.0";
	}

	/**
	 * 封面板（世界固定）：一颗 {@code minecraft:block} 粒子 = 整张专辑封面，只有 alpha 在动。
	 *
	 * <p>历史：0.6.0 曾经用 ExParticle 的镜头变量把它**锁在屏幕上**跟着镜头跑，
	 * 用户 2026-09-24 反馈"封面会随着我的人物移动而移动，我想让他固定在某个位置" → 0.7.0 改回
	 * **固定世界坐标**（锚点见 {@link #OPEN_AHEAD}）。（ExParticle 的 px/fx/rx 变量留在那边，随时可用。）
	 */
	private static String coverPlate(double cx, double cy, double cz, int age, boolean rising, double durSec) {
		return plateFade(COVER_BLOCK, cx, cy, cz, age, "alpha=" + alphaSeg(rising, durSec));
	}

	/** 带屏幕锚定表达式的封面板（{@code lock} 为空 = 纯世界固定）。 */
	private static String coverPlate(double cx, double cy, double cz, int age, boolean rising, double durSec, String lock) {
		return plateFade(COVER_BLOCK, cx, cy, cz, age,
			"alpha=" + alphaSeg(rising, durSec) + (lock.isEmpty() ? "" : "; " + lock));
	}

	/** 文案块板（世界固定）：曲名 / 作者 / 钢琴改编三行，贴图见 tools/render-plate-pack.mjs。 */
	private static String textPlate(double cx, double cy, double cz, int age, boolean rising, double durSec) {
		return textPlate(cx, cy, cz, age, rising, durSec, "");
	}

	/** 带屏幕锚定表达式的文案块板（{@code lock} 为空 = 纯世界固定）。 */
	private static String textPlate(double cx, double cy, double cz, int age, boolean rising, double durSec, String lock) {
		return plate(TITLE_BLOCK, cx, cy, cz, age,
			"size=" + fmt(TEXT_SIZE) + "; light=1.0; alpha=" + alphaSeg(rising, durSec)
				+ (lock.isEmpty() ? "" : "; " + lock));
	}

	/**
	 * 单段 alpha：淡入 = {@code clamp(t/dur,0,1)}；淡出 = {@code 1-clamp(t/dur,0,1)}。
	 * 只用一个 clamp（两个 clamp 相乘的复合表达式实测会让整颗粒子不渲染）。
	 *
	 * <p>{@code durSec} 传**秒**，这里 ×20 换成刻——表达式里的 t 是刻数（见时间线注释）。
	 */
	private static String alphaSeg(boolean rising, double durSec) {
		double dur = durSec * 20.0;
		if (rising) return "clamp(t/" + fmt(dur) + ",0,1)";
		// 淡出加一点缓动（用户 2026-09-24："消失动画还比较生硬"）：quadraticLerp 让透明度
		// 先慢慢掉、后段收干净，比线性柔。仍是"单个 clamp + 一个函数调用"，
		// 和歌词里 lerp(clamp(...)) 同型（实测能渲染）；两个 clamp 相乘那类复合式才会整颗不渲染。
		return "quadraticLerp(clamp(t/" + fmt(dur) + ",0,1),1,0,0.30,0.85)";
	}

	/**
	 * 点阵矩阵：竖直平面、正对镜头，**平移列让 {@code pos} 变成"画面中心"**。
	 *
	 * <p>平移量写在矩阵第 4 列，而 {@code pos = M·(col,row,0,1) / dpb}，所以平移量要按
	 * "格 × dpb" 给。这样粒子表达式里的 {@code dx/dy/dz}（相对中心的初始偏移）才是以
	 * **画面中心**为原点，炸开时朝四周均匀散开；否则中心是图像左下角，整张图会朝右上角吹。
	 */
	private static String gridMatrix(double rx, double rz, double tyOff, double tzOff) {
		return "(" + fmt(rx) + ",0,0,0,,0,1,0," + fmt(tyOff) + ",," + fmt(rz) + ",0,0," + fmt(tzOff)
			+ ",,0,0,0,1)";
	}

	/**
	 * 点阵层（世界固定）：全程**不透明**地躲在封面后面（交叉过渡 = 封面淡出把它露出来，不做半透明叠色），
	 * 到 {@code holdSec} 之后从画面中心向外逐层淡出消散。
	 *
	 * <p>消散表达式：{@code alpha = 1-clamp((t-起始-半径×错开)/时长,0,1)} —— 依旧只有一个 clamp（见 alphaSeg）。
	 * {@code holdSec} 由调用方按"绝对消散时刻 − 本批生成时刻"算，这样 12 条分批生成的条带是**同时**开始消散的。
	 *
	 * <p>⚠ 硬约束（2026-09-24 实测）：**必须用 {@code end_rod}**（{@code minecraft:block} + 面向镜头的
	 * 字面矩阵整段不出图）；点必须小（点距 0.125 格时 size≈0.5，1.5 格的"大点"会糊成一个球）。
	 */
	private static String dotBand(String image, double dpb, String sizeExpr, double cx, double cy, double cz,
	                             String matrix, int age, double holdSec, double fadeSec, double staggerSec) {
		return dotBand(image, dpb, sizeExpr, cx, cy, cz, matrix, age, holdSec, fadeSec, staggerSec, "");
	}

	/** 带屏幕锚定表达式的点阵条带（{@code lock} 为空 = 纯世界固定）。 */
	private static String dotBand(String image, double dpb, String sizeExpr, double cx, double cy, double cz,
	                             String matrix, int age, double holdSec, double fadeSec, double staggerSec, String lock) {
		double hold = holdSec * 20.0, fade = fadeSec * 20.0, stagger = staggerSec * 20.0;
		String alpha = "1-clamp((t-" + fmt(hold) + "-ddis*" + fmt(stagger) + ")/" + fmt(fade) + ",0,1)";
		return "particlex image-matrix end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " " + image + " 1.0 \"" + matrix + "\" " + fmt(dpb) + " 0 0 0 " + age
			+ " \"size=" + sizeExpr + "; alpha=" + alpha + (lock.isEmpty() ? "" : "; " + lock) + "\" 1.0";
	}

	/**
	 * 清晰板：位置锁在屏幕上，只有一个 alpha 段。
	 *
	 * <p>⚠ **不要写"两个 clamp 相乘"的复合表达式**：2026-09-24 实测（同一会话对照）——
	 * 单 clamp 正常渲染，{@code clamp(...)*(1-clamp(...))} 会让**整颗粒子不渲染**（无声无息）。
	 * 所以淡入、淡出各自生成一颗粒子：前一颗只淡入、寿命正好到交叉点，后一颗只淡出。
	 */
	private static String plateFade(String block, double cx, double cy, double cz, int age, String anim) {
		return plate(block, cx, cy, cz, age, "size=" + fmt(PLATE_SIZE) + "; light=1.0; " + anim);
	}

	/**
	 * 逐字等宽格（格）：show-pack 生成的 show.json 里每个字占 {@code ADV} 格（含字距），
	 * 48px 的字形图用 dpb = 48/ADV 摆上去，正好一格一个字形；整行超过 {@code LINE_MAX} 格时
	 * 按 {@code fit} 等比缩小（字形和排布一起缩），免得长句子飞出机器那条水带。
	 */
	private static final double ADV = 1.25, GLYPH_DPB = 48.0 / ADV, LINE_MAX = 26.0;
	/** 柔光/涟漪的预渲染素材参数（16px / 24px，见 `_scratch-m3-80/render-show-pngs.mjs`） */
	private static final double GLOW_DPB = 8.0, GLOW_R = 16.0 / GLOW_DPB / 2;   // 直径 2 格
	private static final double RING_DPB = 15.0, RING_R = 24.0 / RING_DPB / 2;  // 直径 1.6 格
	/** 逐字点尺寸：四边形 ≈ 笔画宽（≈0.17 格）。实机对照：1.0 偏散、2.5 偏糊，1.4 最锐 */
	private static final double LYRIC_SIZE = 1.4;

	private static String flareEdges(double cx, double cy, double cz, String col) {
		return "particlex custom-conditional end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			// step 必须能整除 1.0：0.05 → 采样点正好落在 ±0.5 上，12 条棱全中；
			// 0.06 会让 ±0.5 只被部分命中（2026-09-24 用户实测"只有 3 条棱"就是这个）
			+ " \"size=0.55; cr,cg,cb=" + col + "; alpha=0.95; age=24; light=1.0\" 0.5 0.5 0.5 "
			+ "\"abs(abs(x)-0.5)<0.01&abs(abs(y)-0.5)<0.01|abs(abs(x)-0.5)<0.01&abs(abs(z)-0.5)<0.01"
			+ "|abs(abs(y)-0.5)<0.01&abs(abs(z)-0.5)<0.01\" 0.05 "
			// 扩散节奏跟"音符盒响"对齐：约 12 刻放到 1.4×，之后只淡出
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.03; alpha=0.95*(1-t/24)\" 1.0";
	}

	/**
	 * 柔光 = **正对机位的圆形光晕**（素材 glow.png = 预渲染径向渐变，16px ÷ dpb8 = 2 格）。
	 *
	 * <p>旧版用一颗 size 9→25 的 end_rod 冒充柔光，实测是「一大片实心色块」（2026-09-24 视频取证），
	 * 因为单颗 end_rod 的精灵本身就是个硬边六边形。真正柔和的圆晕只能靠**逐像素带 alpha 的图**：
	 * 每颗粒子吃 PNG 的像素 alpha（0.55 峰值）叠出连续衰减；颜色仍按音高给（cr,cg,cb 覆盖）。
	 */
	private static String flareGlow(double cx, double cy, double cz, String col) {
		// 锚点 = 图像左下角 → 想让圆心落在音符盒中心，锚点要往左下各退 1 格
		return "particlex image-matrix end_rod " + fmt(cx - GLOW_R) + " " + fmt(cy - GLOW_R) + " " + fmt(cz - GLOW_R)
			+ " glow.png 1.0 \"" + MATRICES[0] + "\" " + fmt(GLOW_DPB) + " 0 0 0 15 "
			// ⚠ alpha 一律写**绝对值**：写 `alpha=alpha*k` 会被逐刻自乘（第一刻乘到 0 就永远 0，
			//   粒子还在、画面全空——2026-09-24 实测 15k 颗粒子在内存里但屏幕上一个都没有）。
			//   径向衰减由每颗粒子自己的初始偏移 (dx,dy,dz) 现算，PNG 只负责"哪些像素存在"。
			+ "\"size=1.0; cr,cg,cb=" + col + "; alpha=0.55*clamp(t/2,0,1)*(1-t/15)"
			+ "*exp(-(dx*dx+dy*dy+dz*dz)/0.6)\" 1.0";
	}

	/** 余辉：弹过的音留一小块低透明色斑（2.5s），让"颜色沿着河往下传"看起来是流动的 */
	private static String flareTrail(double cx, double top, double cz, String col) {
		return "particlex custom-normal end_rod " + fmt(cx) + " " + fmt(top) + " " + fmt(cz)
			+ " \"size=6; cr,cg,cb=" + col + "; alpha=0.10; age=50; light=1.0\" 0.05 0.01 0.05 3 "
			+ "\"alpha=0.10*(1-t/49)\" 1.0";
	}

	/**
	 * 涟漪 = **音符盒顶面铺开的圆环**（素材 ring.png = 预渲染高斯环，24px ÷ dpb15 = 1.6 格）。
	 *
	 * <p>旧版用 `custom-parameter polar` 撒一圈点再往外推，视频里是梳齿状断弧（不连贯）；
	 * 换成逐像素带 alpha 的环图后，`(vx,vy,vz)=(dx,dy,dz)*k` 是**等比放大**（半径按 (1+k)^t 指数长），
	 * 环始终连续，1.3s 内从 0.8 格推到 ~2.3 格并淡出。
	 */
	private static String flareRipple(double cx, double top, double cz, String col) {
		// 平铺矩阵 (0,1,0,0,,0,0,0,0,,-1,0,0,0,,0,0,0,1)：v→+x、u→−z ⇒ 锚点要 (+x, +z) 各退 R
		return "particlex image-matrix end_rod " + fmt(cx - RING_R) + " " + fmt(top) + " " + fmt(cz + RING_R)
			+ " ring.png 1.0 \"" + FLAT_MATRIX + "\" " + fmt(RING_DPB) + " 0 0 0 26 "
			// 环带的柔和度同样现算：r 用粒子自己的初始偏移长度，峰在 0.65 格、σ≈0.12 格
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.055; size=0.7; cr,cg,cb=" + col
			+ "; alpha=0.9*(1-t/26)*exp(-pow(sqrt(dx*dx+dy*dy+dz*dz)-0.65,2)/0.03)\" 1.0";
	}

	private static String flareSparks(double cx, double cy, double cz) {
		return "particlex custom-normal end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=2.2; cr,cg,cb=0.92,0.96,1.0; alpha=0.95; age=26; light=1.0; vx=(random()-0.5)*0.16; "
			+ "vy=random()*0.22; vz=(random()-0.5)*0.16; gravity=0.06; friction=0.96\" 0.15 0.15 0.15 14";
	}

	private static String accentRing(double t) {
		return "particlex custom-parameter polar end_rod " + fmt(PLAYHEAD_A * t + PLAYHEAD_B + 0.5) + " "
			+ fmt(DECK_TOP + 0.18) + " " + fmt(ZC) + " 0 6.2832 "
			+ "\"s1=t; s2=0; dis=0.6; size=3.0; cr,cg,cb=0.15,0.86,0.80; alpha=0.5; age=32; light=1.0\" 0.08 "
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.42/(1+t/6); alpha=0.5*(1-t/31)\" 1.0";
	}

	/**
	 * 逐字：用**预渲染字形 PNG**（Noto Sans SC / OFL，见 _scratch-m3-80/render-lyric-pngs.mjs）
	 * + image-matrix 摆放 —— 比 text 的系统字体点阵锐得多；颜色/透明度由逐刻表达式给（唱到哪亮到哪 + 弹一下）。
	 */
	private static String lyricChar(LyricLine line, LyricChar c, int index) {
		int d = Math.max(1, (int) Math.round(c.dur() * 20));
		double x = PLAYHEAD_A * c.t() + PLAYHEAD_B + 5.0;
		// 读向是 +z（= 相机右）：逐字的左边界取 show.json 的累计 z，整行按总宽 line.w() 居中。
		// （上一版是 `index * CELL` 定步长 + 只画音节块首字母 → 屏幕上 "O p s d l m d" 那种乱码）
		double fit = Math.min(1.0, LINE_MAX / Math.max(1.0, line.w()));
		double z = ZC + (c.z() - line.w() / 2) * fit;
		String file = "ly" + String.format("%04x", c.c().codePointAt(0)) + ".png";
		return "particlex image-matrix end_rod " + fmt(x) + " " + fmt(LYRIC_Y) + " " + fmt(z) + " " + file
			+ " 1.0 \"" + MATRICES[matrixIndex] + "\" " + fmt(GLYPH_DPB / fit) + " 0 0 0 "
			+ Math.max(1, (int) Math.round((line.end() - c.t() + 0.8) * 20))
			// ① 骑流：vx = 播放头速度，整行像船一样跟着河走（**不加 vy 浮动**：用户要"码平、别错位"）
			+ " \"vx=" + fmt(PLAYHEAD_A / 20.0) + "; size=" + fmt(LYRIC_SIZE) + "; "
			// ② 唱到哪亮到哪：未唱 = 冥河青的暗调，唱过 = 苍白色
			+ "cr,cg,cb=lerp(clamp(t/" + d + ",0,1),0.20,0.93),lerp(clamp(t/" + d + ",0,1),0.28,0.98),"
			+ "lerp(clamp(t/" + d + ",0,1),0.32,1.0); alpha=0.34+0.66*clamp(t/" + d + ",0,1)\" 1.0";
	}

	/**
	 * 译文：唱词**下方**（图像锚点是左下角，所以基准要再降一个行高）、小一号、暗一点。
	 *
	 * <p>⚠ **不用 ExParticle 的 `text` 族**：它的「文本 → 图像」是自管 GL 离屏光栅化 + `glReadPixels`，
	 * 开着 Iris 光影包时会直接打崩 NVIDIA 驱动（2026-09-24 实测：0.2.0 起播到 22.4s、第一句译文落地
	 * 的瞬间 EXCEPTION_ACCESS_VIOLATION，hs_err 的 Java 栈 = TextUtil.requestImage →
	 * GlTextRasterizer.rasterize → glReadPixels → nvoglv64.dll）。译文与逐字一样改成**预渲染 PNG**
	 * （`trNNN.png`，见 `_scratch-m3-80/render-show-pngs.mjs`），走 image-matrix 就没有这条 GL 路径。
	 */
	private static String lyricTranslation(LyricLine line, int lineIndex) {
		if (line.tr() == null || line.tr().isBlank()) return null;
		double x = PLAYHEAD_A * line.t() + PLAYHEAD_B + 6.6;
		// 译文字号固定 24px、dpb 24 ⇒ 每字正好 1 格宽，宽度 = 字数，按此居中
		int n = line.tr().length();
		double z = ZC - n / 2.0;
		return "particlex image-matrix end_rod " + fmt(x) + " " + fmt(LYRIC_Y - 2.35) + " " + fmt(z)
			+ " tr" + String.format("%03d", lineIndex) + ".png 1.0 \"" + MATRICES[matrixIndex] + "\" 24 0 0 0 "
			+ Math.max(1, (int) Math.round((line.end() - line.t() + 0.8) * 20))
			+ " \"vx=" + fmt(PLAYHEAD_A / 20.0) + "; size=0.7; alpha=0.62*clamp(t/4,0,1)\" 1.0";
	}

	/** 朝向探针：同一张图用 6 个矩阵各来一份（**不用 text 族**，见 lyricTranslation 的警告） */
	private static List<String> probeCmds() {
		String[] mats = {
			"(-1,0,0,0,,0,1,0,0,,0,0,0,0,,0,0,0,1)",   // 朝 −z 看
			"(0,0,0,0,,0,1,0,0,,1,0,0,0,,0,0,0,1)",    // ★ 朝 +x 看（默认）
			"(1,0,0,0,,0,1,0,0,,0,0,0,0,,0,0,0,1)",    // 朝 +z 看
			"(0,0,0,0,,0,1,0,0,,-1,0,0,0,,0,0,0,1)",   // 左右镜像
			"(0,0,0,0,,0,-1,0,0,,1,0,0,0,,0,0,0,1)",   // 上下颠倒
			FLAT_MATRIX,                               // 平铺
		};
		List<String> out = new ArrayList<>();
		for (int i = 0; i < mats.length; i++) {
			out.add("particlex image-matrix end_rod ~ ~" + (3 + i * 2) + " ~ title.png 1.0 \"" + mats[i]
				+ "\" 48 0 0 0 600");
		}
		return out;
	}

	// ───────────────────────── 生命周期 ─────────────────────────

	private static void load(Path gameDir) {
		if (doc != null) return;
		Path p = gameDir.resolve("nbmachina").resolve("styxshow.json");
		try {
			if (!Files.isRegularFile(p)) {
				NbmachinaMod.LOGGER.warn("[styxshow] 找不到 {} —— 只有逐音心跳，没有重音环与歌词", p);
				doc = new Doc();
				return;
			}
			doc = GSON.fromJson(Files.readString(p, StandardCharsets.UTF_8), Doc.class);
			if (doc == null) doc = new Doc();
			if (doc.lines == null) doc.lines = new ArrayList<>();
			if (doc.accents == null) doc.accents = new double[0];
			if (doc.textMatrix == null || doc.textMatrix.isBlank()) doc.textMatrix = FLAT_MATRIX;
			if (doc.dpb <= 0) doc.dpb = 8.0;
			int nChars = 0;
			for (LyricLine l : doc.lines) nChars += l.chars() == null ? 0 : l.chars().size();
			NbmachinaMod.LOGGER.info("[styxshow] 视效数据 v{} 已载入：重音 {} / 歌词 {} 行 {} 字（平移 {}s）",
				doc.version, doc.accents.length, doc.lines.size(), nChars, doc.shiftSec);
		} catch (Exception e) {
			NbmachinaMod.LOGGER.warn("[styxshow] 载入 styxshow.json 失败：{}", e.toString());
			doc = new Doc();
		}
	}

	private static double dpb() {
		return doc != null && doc.dpb > 0 ? doc.dpb : 8.0;
	}

	public static void start(ServerWorld world, double fromSec) {
		if (!FabricLoader.getInstance().isModLoaded("exparticle")) {
			NbmachinaMod.LOGGER.info("[styxshow] 没装 ExParticle → 视效层关闭（演奏不受影响）");
			return;
		}
		load(world.getServer().getRunDirectory());
		active = true;
		sent = 0;
		failed = 0;
		pending.clear();
		accCursor = firstAtOrAfter(doc.accents, fromSec);
		lineCursor = 0;
		while (lineCursor < doc.lines.size() && doc.lines.get(lineCursor).t() + lyricOffset < fromSec) lineCursor++;

		exec(world, river());
		if (AMBIENT_ON) {
			exec(world, riverLane(-8.0));
			exec(world, riverLane(8.0));
			exec(world, helix(0.0));
			exec(world, helix(3.1416));
		}
		if (fromSec < 3.5) opening(world, fromSec);
		// ⚠ SLF4J 不认 `{:+}` 这种格式（会原样打印并报 placeholder 数量不符）→ 偏移自己格式化
		NbmachinaMod.LOGGER.info("[styxshow] 视效层启动：从 {}s 起（重音剩 {} / 歌词剩 {} 行，整体平移 {}s）",
			fromSec, doc.accents.length - accCursor, doc.lines.size() - lineCursor, fmt(lyricOffset));
	}

	/**
	 * 开场：把「专辑封面 + 文案块（曲名 / 作者 / 钢琴改编）」摆成一组**固定在世界里**的竖直卡片，
	 * 位置 = 音轨起点前方 {@link #OPEN_AHEAD} 格、河心、玩家起播时的眼高（见 {@link #OPEN_AHEAD}）。
	 *
	 * <p>版面（2026-09-24 用户口径）：封面在左、三行文案在右侧空白处；
	 * 封面 12 格见方；文案块贴图 1024²，实际墨迹宽 79.3%（≈9.5 格），与封面同高居中。
	 *
	 * <p>历史：0.6.0 曾把它锁在屏幕上"跟着镜头"（用户："封面会随着我的人物移动而移动，我想让他固定在某个位置"）
	 * → 0.7.0 起改回世界固定；镜头一路飞过去会自然放大，正好当"运镜推进"用。
	 */
	private static void opening(ServerWorld world, double atSec) {
		var players = world.getServer().getPlayerManager().getPlayerList();
		if (players.isEmpty()) {
			NbmachinaMod.LOGGER.info("[styxshow] 没有玩家 → 跳过开场三件套");
			return;
		}
		ServerPlayerEntity p = players.get(0);
		// 起播机位 → 前方 OPEN_AHEAD 格钉一份（只在此刻算一次；之后卡片固定在世界上）
		double yaw = Math.toRadians(p.getYaw());
		double fx = -Math.sin(yaw), fz = Math.cos(yaw);   // 水平前
		double rx = -fz, rz = fx;                         // 水平右
		double ax = p.getX() + fx * OPEN_AHEAD, az = p.getZ() + fz * OPEN_AHEAD;
		double ay = p.getEyeY() + 0.2;
		// 卡片平面内偏移沿"右"方向：封面在左、文案块在右
		double coverX = ax + rx * OPEN_COVER_H, coverZ = az + rz * OPEN_COVER_H;
		double textX = ax + rx * OPEN_TEXT_H, textZ = az + rz * OPEN_TEXT_H;
		// 点阵矩阵：素材 96px，中心平移 -48 px → /8 = -6 格；平面基向量 = 起播时的相机右向
		String coverM = gridMatrix(rx, rz, -(96.0 / 2), -(96.0 / 2));
		// 屏幕锚定（0.7.1）：把卡片每刻搬到「眼位 + 起播方向×距离 + 起播右向×版面偏移」→ 屏幕上不动
		String coverLock = OPEN_SCREEN_ANCHOR ? anchorTo(OPEN_AHEAD, OPEN_COVER_H, 0.2, fx, fz, rx, rz) : "";
		String textLock = OPEN_SCREEN_ANCHOR ? anchorTo(OPEN_AHEAD, OPEN_TEXT_H, 0.2, fx, fz, rx, rz) : "";
		String dotLock = OPEN_SCREEN_ANCHOR
			? anchorCloud(OPEN_AHEAD + OPEN_DOT_BACK, OPEN_COVER_H + OPEN_DOT_SHIFT_H, 0.2, fx, fz, rx, rz) : "";
		// ① 两片清晰板：淡入一颗 + 到交叉点换成只淡出的新一颗（复合 clamp 实测整颗不渲染，见 plateFade）
		pending.add(new Pending(atSec + OPEN_IN_AT[0], coverPlate(coverX, ay, coverZ, ticks(OPEN_COVER_OUT_AT - OPEN_IN_AT[0]),
			true, OPEN_PLATE_IN_SEC, coverLock)));
		pending.add(new Pending(atSec + OPEN_COVER_OUT_AT, coverPlate(coverX, ay, coverZ, ticks(0.6),
			false, OPEN_COVER_OUT_SEC, coverLock)));
		pending.add(new Pending(atSec + OPEN_IN_AT[1], textPlate(textX, ay, textZ, ticks(OPEN_TEXT_OUT_AT - OPEN_IN_AT[1]),
			true, OPEN_PLATE_IN_SEC, textLock)));
		pending.add(new Pending(atSec + OPEN_TEXT_OUT_AT, textPlate(textX, ay, textZ, ticks(0.6),
			false, OPEN_TEXT_OUT_SEC, textLock)));
		// ② 点阵：12 条分批铺（每条 768 颗），藏在封面后面 0.35 格；3.05s 起同时从中心向外消散
		for (int i = 0; i < OPEN_DOT_BANDS; i++) {
			double spawnAt = OPEN_DOT_SPAWN_AT + i * OPEN_DOT_SPAWN_STEP;
			double holdSec = OPEN_DOT_DISSOLVE_AT - spawnAt;
			int age = ticks(OPEN_DOT_END_AT - spawnAt) + 6;
			String img = COVER_GRID_IMAGE + String.format("%02d", i) + ".png";
			// 发射位置 = 封面中心沿右向再偏 OPEN_DOT_SHIFT_H、沿前方再退 OPEN_DOT_BACK（只能被挡住，不能挡人）
			pending.add(new Pending(atSec + spawnAt, dotBand(img, COVER_DPB, COVER_DOT_SIZE,
				coverX + fx * OPEN_DOT_BACK + rx * OPEN_DOT_SHIFT_H, ay,
				coverZ + fz * OPEN_DOT_BACK + rz * OPEN_DOT_SHIFT_H, coverM, age, holdSec,
				OPEN_DOT_FADE_SEC, OPEN_DOT_STAGGER_SEC, dotLock)));
		}
		NbmachinaMod.LOGGER.info("[styxshow] 开场卡片（{}）：机位 yaw {} → 锚点 ({}, {}, {})，封面 ({}, {}, {}) 文案 ({}, {}, {})，{} 格前方，{} 条点阵",
			OPEN_SCREEN_ANCHOR ? "屏幕锚定、只显现/消失" : "世界固定",
			fmt(p.getYaw()), fmt(ax), fmt(ay), fmt(az), fmt(coverX), fmt(ay), fmt(coverZ),
			fmt(textX), fmt(ay), fmt(textZ), fmt(OPEN_AHEAD), OPEN_DOT_BANDS);
	}

	/** 秒 → 刻（表达式里的 t 是刻数）。 */
	private static int ticks(double sec) {
		return Math.max(1, (int) Math.round(sec * 20.0));
	}

	/**
	 * 屏幕锚定表达式（0.7.1）：每刻把粒子搬到「当前眼位 + 起播方向×dist + 起播右向×h + 上×v」。
	 *
	 * <p>方向/右向是**起播那一刻**的常量（不是实时视角）→ 飞行时卡片跟着平移、屏幕上位置与大小不变，
	 * 只有淡入淡出；转头时它会自然滑出画面而不是"甩着跟你转"。用 ExParticle 的只读镜头变量
	 * {@code px/py/pz}（玩家眼位，每刻刷新）。
	 */
	private static String anchorTo(double dist, double h, double v, double fx, double fz, double rx, double rz) {
		return "vx=(px+" + fmt(fx * dist + rx * h) + ")-(cx+x);"
			+ "vy=(py+" + fmt(v) + ")-(cy+y);"
			+ "vz=(pz+" + fmt(fz * dist + rz * h) + ")-(cz+z)";
	}

	/**
	 * 点阵层的屏幕锚定：每颗点再叠加它在画面平面内的偏移（引擎逐粒子给的 {@code dx/dy/dz}）——
	 * 水平方向按起播右向投影，竖直直接用 {@code dy}。
	 */
	private static String anchorCloud(double dist, double hBase, double v, double fx, double fz, double rx, double rz) {
		// hBase = 点阵整体在版面里的水平位置（要和封面板的 OPEN_COVER_H 一致，
		// 否则点阵会整体偏到右边、盖住文案——2026-09-24 用户截图取证）
		String h = "(" + fmt(rx) + "*dx+" + fmt(rz) + "*dz)";
		return "vx=(px+" + fmt(fx * dist + rx * hBase) + "+" + fmt(rx) + "*" + h + ")-(cx+x);"
			+ "vy=(py+" + fmt(v) + "+dy)-(cy+y);"
			+ "vz=(pz+" + fmt(fz * dist + rz * hBase) + "+" + fmt(rz) + "*" + h + ")-(cz+z)";
	}

	public static void stop(ServerWorld world) {
		if (!active) return;
		active = false;
		exec(world, "particlex clear-particle");
		NbmachinaMod.LOGGER.info("[styxshow] 视效层停止");
	}

	public static void tick(ServerWorld world, double now) {
		if (!active || doc == null) return;
		if (!pending.isEmpty()) {
			for (int i = pending.size() - 1; i >= 0; i--) {
				Pending p = pending.get(i);
				if (p.at() <= now) {
					exec(world, p.cmd());
					pending.remove(i);
				}
			}
		}
		double nowLyric = now - lyricOffset;
		while (accCursor < doc.accents.length && doc.accents[accCursor] <= now) {
			exec(world, accentRing(doc.accents[accCursor]));
			accCursor++;
		}
		while (lineCursor < doc.lines.size() && doc.lines.get(lineCursor).t() <= nowLyric) {
			LyricLine line = doc.lines.get(lineCursor++);
			if (line.chars() != null) {
				List<LyricChar> cs = line.chars();
				for (int i = 0; i < cs.size(); i++) {
					LyricChar c = cs.get(i);
					if (c.c() == null || c.c().isBlank()) continue;   // 空格只占格、不画字形
					exec(world, lyricChar(line, c, i));
				}
			}
			String tr = lyricTranslation(line, lineCursor - 1);
			if (tr != null) exec(world, tr);
		}
	}

	public static void noteFlare(ServerWorld world, int x, int y, int z, int midi, int velocity, boolean bass) {
		if (!active) return;
		// 一切以**方块自己的 y** 为准（机器 map 里音符盒就在 y=110，顶面 111.0）：
		// 旧版涟漪写死在 DECK_TOP+1.03=112.03 —— 比顶面高一格，水面一涨就整条沉进去，
		// 用户 2026-09-24 反馈"涟漪没做到每个音符盒上 / 特效跑到方块下方一格"就是这个。
		double cx = x + 0.5, cz = z + 0.5;
		double cy = y + 0.5;          // 方块中心（描边框贴着方块本体）
		double top = y + 1.0;         // 方块顶面
		String col = hueColor(midi, bass);
		exec(world, flareEdges(cx, cy, cz, col));
		exec(world, flareGlow(cx, top + 0.45, cz, col));   // 柔光：顶面上方 0.45 格（镜头在方块上方平飞）
		exec(world, flareRipple(cx, top, cz, col));        // 涟漪：正好铺在顶面
		exec(world, flareTrail(cx, top + 0.02, cz, col));
		if (velocity >= 90) exec(world, flareSparks(cx, top + 0.5, cz));
	}

	/**
	 * 音高 → 颜色：12 音级色环（C=红 → B=紫），八度越高越亮；低音声部整体偏紫。
	 * 这样"每个音高有它独立的颜色、颜色顺着音高变化"（用户 2026-09-24 要求）。
	 */
	private static String hueColor(int midi, boolean bass) {
		double pc = ((midi % 12) + 12) % 12;
		double hue = pc / 12.0 + (bass ? 0.58 : 0.0);
		hue -= Math.floor(hue);
		double sat = bass ? 0.85 : 0.62, val = 0.75 + 0.25 * Math.min(1.0, (midi - 40) / 60.0);
		double c = val * sat, x = c * (1 - Math.abs((hue * 6) % 2 - 1)), m = val - c;
		double r, g, b;
		int k = (int) (hue * 6);
		switch (k) {
			case 0 -> { r = c; g = x; b = 0; }
			case 1 -> { r = x; g = c; b = 0; }
			case 2 -> { r = 0; g = c; b = x; }
			case 3 -> { r = 0; g = x; b = c; }
			case 4 -> { r = x; g = 0; b = c; }
			default -> { r = c; g = 0; b = x; }
		}
		return fmt(r + m) + "," + fmt(g + m) + "," + fmt(b + m);
	}

	/** 朝向探针（`/nbm machine textprobe`） */
	public static void textProbe(ServerWorld world) {
		if (!FabricLoader.getInstance().isModLoaded("exparticle")) return;
		load(world.getServer().getRunDirectory());
		for (String c : probeCmds()) exec(world, c);
	}

	/** 命令自检：每类模板各拿一条真去 Brigadier 解析（`/nbm machine showcheck`） */
	public static String selfCheck(ServerCommandSource src) {
		List<String> cmds = new ArrayList<>();
		cmds.add(river());
		cmds.add(riverLane(-8.0));
		cmds.add(helix(0.0));
		String demoMatrix = MATRICES[0];
		cmds.add(coverPlate(-10.0, 115.0, ZC, 40, true, OPEN_PLATE_IN_SEC));
		cmds.add(textPlate(-10.0, 119.9, ZC, 40, true, OPEN_PLATE_IN_SEC));
		cmds.add(dotBand(COVER_GRID_IMAGE + "00.png", COVER_DPB, COVER_DOT_SIZE, -14.0, 111.0, ZC - 4.0,
			gridMatrix(0.0, 1.0, -(96.0 / 2), -(96.0 / 2)), 40, 1.0, OPEN_DOT_FADE_SEC, OPEN_DOT_STAGGER_SEC));
		cmds.add(flareEdges(0.5, 110.5, -5.5, "0.90,0.95,1.00"));
		cmds.add(flareRipple(0.5, 111.0, -5.5, "0.90,0.95,1.00"));
		cmds.add(flareSparks(0.5, 111.5, -5.5));
		cmds.add(accentRing(3.917));
		LyricLine demo = new LyricLine(22.407, 24.457, 3.0, 10.0, "请不要让我就此死亡",
			List.of(new LyricChar(22.407, "O", 0, 1.4, 0.23), new LyricChar(22.64, "k", 1.4, 1.4, 0.24)));
		cmds.add(lyricChar(demo, demo.chars().get(0), 0));
		cmds.add(lyricTranslation(demo, 0));
		cmds.addAll(probeCmds());
		int ok = 0;
		String firstErr = null;
		for (String c : cmds) {
			try {
				var p = src.getServer().getCommandManager().getDispatcher().parse(c, src.withMaxLevel(4));
				// ⚠ parse() 对"多余尾巴"不报错（Brigadier 的特性）：必须再查 reader 有没有剩余输入，
				//    否则像 custom-polar-parameter 这种**不存在的字面量**会被判成"通过"（2026-09-24 真踩过）。
				if (p.getReader().canRead()) throw new IllegalArgumentException("未解析完：" + p.getReader().getRemaining());
				ok++;
			} catch (Throwable e) {
				if (firstErr == null) firstErr = e.toString() + "  ←  " + c;
			}
		}
		if (firstErr == null) return String.format("命令自检：%d/%d 条全部通过 ✓", ok, cmds.size());
		return String.format("命令自检：%d/%d 条通过；第一条失败：%s", ok, cmds.size(), firstErr);
	}

	// ── 工具 ──
	private static void exec(ServerWorld world, String cmd) {
		try {
			MinecraftServer server = world.getServer();
			ServerCommandSource src = server.getCommandSource().withSilent().withMaxLevel(4);
			var parsed = server.getCommandManager().getDispatcher().parse(cmd, src);
			server.getCommandManager().getDispatcher().execute(parsed);
			sent++;
		} catch (Throwable e) {
			failed++;
			if (failed <= 8) NbmachinaMod.LOGGER.warn("[styxshow] 命令失败（第 {} 次）：{} ← {}", failed, e.toString(), cmd);
		}
	}

	private static int firstAtOrAfter(double[] arr, double t) {
		int i = 0;
		while (i < arr.length && arr[i] < t) i++;
		return i;
	}

	private static String fmt(double v) {
		String s = String.format("%.3f", v);
		while (s.contains(".") && (s.endsWith("0") || s.endsWith("."))) s = s.substring(0, s.length() - 1);
		return s.isEmpty() ? "0" : s;
	}

	private static String escape(String s) {
		return s.replace("\\", "\\\\").replace("\"", "\\\"");
	}
}
