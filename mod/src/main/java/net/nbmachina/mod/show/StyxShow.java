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
	/**
	 * 开场"延迟生成"队列（视效层时间 → 命令）。
	 *
	 * <p>⚠ 命令是**到点才拼**的（{@link java.util.function.Supplier}），不是开场时算好：粒子被创建的那一刻
	 * 会落在命令给的世界坐标上，而锚定表达式要**下一刻**才把它搬到"眼位 + 起播方向×距离"处；
	 * 中间这一帧的渲染位置是"出生点 → 锚定目标"的插值。要是出生点还用**起播瞬间**的机位算，
	 * 飞行一段之后每颗新粒子都会先闪在几格甚至十几格之外再归位——点阵"打点时闪烁"、
	 * 封面板"最后左右抖动"都是这个（2026-09-24 定位）。所以出生点必须**按当前眼位现算**。
	 */
	private record Pending(double at, java.util.function.Supplier<String> cmd) {}
	private static final List<Pending> pending = new ArrayList<>();
	private static int sent = 0;
	private static int failed = 0;
	/** 视效层当前时刻（秒，见 tick()）；音符盒特效的延迟队列用它算"到点"。 */
	private static double showNow = 0.0;
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
	// ── 开场时间线（秒；0.7.4「点阵先打印 → 清板压上 → 一起缩没」版）──────────────────
	// ⚠ ExParticle 表达式里的 t 是**刻数**（命令末尾 step=1 → 每刻 +1），所以"秒"必须 ×20 才等于表达式里的时长。
	//
	// 0.00→0.70  封面 + 文案**同一时刻、同一类型**柔和淡入（用户 2026-09-24："柔和淡入淡出"）
	// 2.30→3.00  封面 + 文案**同一时刻**柔和淡出（同一条曲线的镜像）
	// 3.917      第一颗音
	//
	// ⚠ **开场不再有点阵层**（用户 2026-09-24："把整个点阵去掉"）。下面 dot* 模板只留给
	//   `/nbm machine showcheck` 做命令自检，开场流程里不再调用。
	//
	// ⚠ 淡入时长按"观感"对齐：开光影时 alpha<1 的板子**暗部会整块消失**（§16.1 实测），
	//   深色封面要 alpha≈1（≈0.9×时长）才算"成形"，白字文案 ≈0.7×时长 就看清了。
	//   要让两者**看起来**同时出现/同时消失，封面那条斜坡就得短一点（0.55 ≈ 0.78×0.70）。
	//
	// 为什么会有"两拨点阵"：单个表达式里**两个 clamp 相乘的复合式实测整颗粒子不渲染**
	// （2026-09-24 实机对照：单 clamp 正常、clamp*clamp 全灭），所以"长出来"和"缩回去"
	// 必须拆成两批粒子，各自只带一个 clamp。
	/** 封面 + 文案**同一时刻、同一时长**淡入。 */
	private static final double OPEN_PLATE_IN_AT = 0.00;
	/**
	 * 淡入时长：封面 0.35s、文案 0.70s。
	 *
	 * <p>为什么不一样：开光影时 alpha&lt;1 的板子**暗部会整块消失**（§16.1），深色封面要 alpha≈0.9 才算
	 * "成形"，白字文案 alpha≈0.25 就能读 → 若两者同长，封面看起来会比文案晚一大截（实测：文案 0.2s 可读、
	 * 封面 0.8s 才成形）。把封面那条斜坡缩到一半、并让曲线"起手快"（x(2-x)），两者才基本同时到位。
	 */
	private static final double OPEN_TEXT_IN_SEC = 0.70;
	private static final double OPEN_COVER_IN_SEC = 0.35;
	/**
	 * 封面与文案**同一时刻、同一时长**退场，曲线 = 入场那条线性斜坡的镜像
	 * （用户口径："消失动画用和出现动画一样类型的"）。
	 */
	private static final double OPEN_COVER_OUT_AT = 2.30;
	/** 退场两者都用 0.70s（用户口径"封面和文字同时消失"）：同时起、同时收干净。 */
	private static final double OPEN_COVER_OUT_SEC = 0.70;
	private static final double OPEN_TEXT_OUT_AT = OPEN_COVER_OUT_AT;
	private static final double OPEN_TEXT_OUT_SEC = OPEN_TEXT_IN_SEC;
	/**
	 * 拆块动画参数：4×4 块、对角顺序（左上先）、**0.04s/步**错开、每块 0.35s 长满或缩没。
	 * 错开量比"每块的时长"小得多 → 16 块在时间上互相重叠，读起来是"整幅图连着填满/退掉"，
	 * 而不是一块块孤零零地蹦。出现与消失共用同一组数字（用户口径：两者同类型、同速度）。
	 */
	private static final int PLATE_TILES = 4;
	private static final double OPEN_TILE_BLOCKS = PLATE_BLOCKS / PLATE_TILES;
	private static final double OPEN_TILE_STAGGER_SEC = 0.04;
	private static final double OPEN_TILE_GROW_SEC = 0.35;
	private static final double OPEN_TILE_SHRINK_SEC = 0.35;
	/** 消失用的 16 块比"消失起点"早 0.02s 出生（视觉上就是同一时刻交接，不会闪）。 */
	private static final double OPEN_TILE_OUT_AT = OPEN_COVER_OUT_AT - 0.02;
	/** 点阵淡入：12 条在 0.75→0.97s 生成，整片一起在 1.35s 亮满（不再有"打点"过程）。 */
	private static final double OPEN_DOT_SPAWN_AT = 0.75;
	private static final double OPEN_DOT_SPAWN_STEP = 0.020;
	private static final double OPEN_DOT_IN_SEC_EXPR = 0.60;
	/** 第一拨点阵的到期时刻（= 第二拨生成的时刻；两拨同图同位、alpha 都是 1，交接看不见缝）。 */
	private static final double OPEN_DOT_PRINT_END_AT = 3.02;
	/** 第二拨点阵（淡出）：封面/文案收完之后（3.00s）才开始，3.70s 收干净。 */
	private static final double OPEN_DOT_OUT_AT = 3.00;
	private static final double OPEN_DOT_OUT_SEC_EXPR = 0.70;
	private static final double OPEN_DOT_DISSOLVE_SPAWN_STEP = 0.020;
	private static final int OPEN_DOT_BANDS = 12;
	/** 点阵全部消失的时刻（< 第一颗音 3.917s）。 */
	private static final double OPEN_DOT_END_AT = 3.74;
	/** 起播机位（fire 时取不到玩家就用它）与起播朝向常量。 */
	private static double eye0X, eye0Y, eye0Z, dirFx, dirFz, dirRx, dirRz;
	/** 诊断开关（默认关）：`-Dstyx.nodots=true` 只放封面/文案，`-Dstyx.noplates=true` 只放点阵。 */
	private static final boolean DBG_NO_DOTS = Boolean.getBoolean("styx.nodots");
	private static final boolean DBG_NO_PLATES = Boolean.getBoolean("styx.noplates");
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
	 * → <b>size ≤ 0.5 才不会互相糊在一起</b>。
	 *
	 * <p>2026-09-24 修正：旧版是 0.25–0.70（亮部 0.7 → 四边形 0.175 格 &gt; 点距），亮部直接糊成
	 * 一整片——用户反馈"打点的时候好像连成一个图像了……出现闪动"，就是半调在高光处糊掉 + 大面积
	 * 突然连片造成的。现在压到 0.32–0.48（四边形 0.08–0.12 格，**恒小于点距 0.125**）：
	 * 任何亮度下都留得出缝，整片永远读得出"点阵"，不会变成实心图。
	 */
	private static final String COVER_DOT_SIZE = "(0.32+0.16*((cr+cg+cb)/3))";
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
	 *
	 * <p>2026-09-24 第二轮先按"抖动来自错位副本"的猜测改成 0；用户复看后明确
	 * <b>"点阵需要右偏才对，那才是我希望的效果"</b> → 恢复 6.5。
	 * 抖动真因见 {@link #Pending} 的说明（新粒子出生点用了旧机位），与偏移量无关。
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
		// 2026-09-24 用户口径："消失动画用出现动画一样类型的（柔和淡入 淡出）"：
		//   出现 alpha = x(2-x)，消失 alpha = 1-x²（x = clamp(t/时长,0,1)）—— 后者正是前者的**镜像**。
		// 形状：出现"起手快、收尾软"（深色封面能早点成形，不至于比白字晚太多），
		//       消失"先稳住、末端收干净"，比线性柔。两个式子都只有一个 clamp + 四则运算，
		//       不会踩到"两个 clamp 相乘整颗不渲染"的坑。
		String x = "(clamp(t/" + fmt(dur) + ",0,1))";
		return rising ? x + "*(2-" + x + ")" : "1-" + x + "*" + x;
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
	 * 点阵"整片长出来"（2026-09-24 用户口径："不用点阵打点了"）：不再逐点/逐带打印，
	 * 全片一起从 0 长到目标尺寸 —— 和封面/文案的拆块动画同一类型（几何缩放，不碰 alpha）。
	 *
	 * <p>{@code t0Sec} = 本批粒子相对"长出来起点"的出生偏移：12 条分批生成（避免一次 9216 颗卡帧），
	 * 补上这个偏移，12 条才会在同一时刻长满。依旧只用一个 clamp（两个 clamp 相乘会让整颗不渲染，实测）。
	 */
	private static String dotGrow(double t0Sec) {
		double rise = OPEN_DOT_IN_SEC_EXPR * 20.0;
		return "size=" + COVER_DOT_SIZE + "*clamp((t+" + fmt(t0Sec * 20.0) + ")/" + fmt(rise) + ",0,1); alpha=1";
	}

	/** 点阵"整片缩回去"：与长出来同类型（线性斜坡的镜像），时间点在封面/文案消失之后。 */
	private static String dotShrink(double t0Sec) {
		double fall = OPEN_DOT_OUT_SEC_EXPR * 20.0;
		return "size=" + COVER_DOT_SIZE + "*(1-clamp((t+" + fmt(t0Sec * 20.0) + ")/" + fmt(fall) + ",0,1)); alpha=1";
	}

	/**
	 * 点阵条带（世界固定 / 屏幕锚定）：全程**不透明**地躲在封面后面
	 * （交叉过渡靠"封面淡出把它露出来"，不做半透明叠色）。
	 *
	 * <p>⚠ 硬约束（2026-09-24 实测）：**必须用 {@code end_rod}**（{@code minecraft:block} + 面向镜头的
	 * 字面矩阵整段不出图）；点必须小（点距 0.125 格时 size≈0.5，1.5 格的"大点"会糊成一个球）。
	 *
	 * <p>⚠ 粒子总数上限实测约 16384：四条 96² 点阵同屏时只活下来 ~16100 颗，后面的整批被丢。
	 */
	private static String dotBand(String image, double dpb, double cx, double cy, double cz,
	                             String matrix, int age, String anim, String lock) {
		return "particlex image-matrix end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " " + image + " 1.0 \"" + matrix + "\" " + fmt(dpb) + " 0 0 0 " + age
			+ " \"" + anim + (lock.isEmpty() ? "" : "; " + lock) + "\" 1.0";
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
	 * **整块缩放板**（0.7.7 出场/退场统一用）：{@code size} 从 0 长到 {@code size}（出现）
	 * 或者从 {@code size} 缩到 0（消失），全程 {@code alpha=1}、位置不动。
	 *
	 * <p>为什么不用 alpha 淡入淡出：开光影时 alpha&lt;1 的板子**暗部会整块消失**（§16.1 实测）——
	 * 同一段 0.7s 里白字的文案 0.6s 就看清、深色封面要到 1.0s 才成形，用户反馈的
	 * "封面和文字出现动画时长/速度不一致"就是这个。几何缩放没有这个问题，而且封面/文案
	 * 可以走**完全同一条曲线**，出现与消失又是同一条曲线正反走（用户："消失动画用和出现动画一样类型的"）。
	 */
	private static String scalePlate(String block, double cx, double cy, double cz, int age,
	                                 double size, double durSec, boolean grow, String lock) {
		double dur = Math.max(1.0, durSec * 20.0);
		String ramp = grow ? "clamp(t/" + fmt(dur) + ",0,1)" : "1-clamp(t/" + fmt(dur) + ",0,1)";
		return plate(block, cx, cy, cz, age,
			"size=" + fmt(size) + "*" + ramp + "; light=1.0; alpha=1" + (lock.isEmpty() ? "" : "; " + lock));
	}

	/**
	 * **拆块板**（0.7.5 退场用）：一颗粒子只画贴图的一个矩形块。
	 *
	 * <p>取景窗走 ExParticle 的 {@code u0/u1/v0/v1}（归一化，默认 0,1,0,1 = 整张）——这是这次给
	 * ExParticle Fabric 侧新加的变量，落点是 {@code TerrainParticleMixin} 的 UV 覆写。
	 *
	 * <p>⚠ 为什么入场/退场都用它：开光影时 alpha&lt;1 的板子**暗部会整块消失**（§16.1 实测），
	 * 于是同一段 0.7s 淡入里，白字的文案 0.6s 就看清了、深色封面要到 1.0s 才成形——
	 * 用户 2026-09-24 反馈的"封面和文字出现动画时长/速度不一致"就是这个（逐帧量过：文案先亮）。
	 * 改成拆块后每块**全程 alpha=1**，只动 {@code size}：封面与文案用同一套栅格、同一段错开、同一时长，
	 * 出现与消失又是同一种动画的"长出来 / 缩回去" —— 类型一致、速度一致，且完全不受光影影响。
	 */
	private static String tilePlate(String block, double cx, double cy, double cz, int age, double size,
	                                double u0, double u1, double v0, double v1, double delaySec,
	                                double durSec, boolean grow, String lock) {
		double delay = Math.max(0.0, delaySec * 20.0);
		double dur = Math.max(1.0, durSec * 20.0);
		String ramp = grow
			? "clamp((t-" + fmt(delay) + ")/" + fmt(dur) + ",0,1)"
			: "1-clamp((t-" + fmt(delay) + ")/" + fmt(dur) + ",0,1)";
		String anim = "size=" + fmt(size) + "*" + ramp + "; light=1.0; alpha=1"
			+ "; u0=" + fmt(u0) + "; u1=" + fmt(u1) + "; v0=" + fmt(v0) + "; v1=" + fmt(v1)
			+ (lock.isEmpty() ? "" : "; " + lock);
		return plate(block, cx, cy, cz, age, anim);
	}

	/**
	 * 逐字等宽格（格）：show-pack 生成的 show.json 里每个字占 {@code ADV} 格（含字距），
	 * 48px 的字形图用 dpb = 48/ADV 摆上去，正好一格一个字形；整行超过 {@code LINE_MAX} 格时
	 * 按 {@code fit} 等比缩小（字形和排布一起缩），免得长句子飞出机器那条水带。
	 */
	private static final double ADV = 1.25, GLYPH_DPB = 48.0 / ADV, LINE_MAX = 26.0;
	/** 逐字点尺寸：四边形 ≈ 笔画宽（≈0.17 格）。实机对照：1.0 偏散、2.5 偏糊，1.4 最锐 */
	private static final double LYRIC_SIZE = 1.4;
	/**
	 * 涟漪环的预渲染素材（v5：**32px**，环带半径 11.2–13.8px）+ dpb：
	 * 出生态半径 = 12.5/20 = 0.625 格。24px 版只有 116 颗/圈，用户要"粒子增多一点" →
	 * 换成 32px（≈204 颗/圈），环线更连续。素材生成见 `_scratch-m3-80/render-show-pngs.mjs` 第 4 段。
	 */
	private static final double RING_DPB = 20.0;
	/**
	 * 彩虹的亮度口径：通道 = {@code RAIN_BIAS + RAIN_SCALE*(0.5+0.5*sin(...))}。
	 * 0.8.8 初版用 0.18/0.78（通道上界 0.96）→ 三通道和为 1.7，比旧的 HSV val 0.58 亮一大截，
	 * 实机被 Iris 泛光糊成一圈厚"甜甜圈"；收到 0.14/0.62（上界 0.76、和 ≈1.3）才恢复"细环"。
	 */
	private static final double RAIN_BIAS = 0.14, RAIN_SCALE = 0.62;
	/** 涟漪是否带上下起伏（`/nbm machine ripplebob on|off`，现场 A/B 用）。 */
	private static boolean rippleBob = true;

	// ───────────────────────── 音符盒特效参数（模块化：预设 = 一组参数）─────────────────────────
	/**
	 * 所有可调参数。`/nbm machine fx` 看当前值、`/nbm machine fx <key> <value>` 现改、
	 * `/nbm machine preset <name>` 一键切预设。
	 *
	 * <p>开关类参数用 0/1 表示（0=关、非 0=开）。默认值就是用户 2026-09-25 认可的那套效果。
	 */
	private static final java.util.Map<String, Double> FX = new java.util.LinkedHashMap<>();
	private static final java.util.Map<String, Double> FX_DEFAULTS = new java.util.LinkedHashMap<>();
	static {
		FX_DEFAULTS.put("color.wave", 9.0);      // 一个完整色环跨多少格（越小相邻方块差得越多）
		FX_DEFAULTS.put("color.drift", 0.16);    // 色带每秒往回流多少"环"
		FX_DEFAULTS.put("color.rate", 0.13);     // 单颗音自身变色的角速度（rad/刻）
		FX_DEFAULTS.put("color.jitter", 0.15);   // 每个方块自己的相位抖动（单位：环）→ 同时响的也不同色
		FX_DEFAULTS.put("ripple.waves", 0.0);    // 0 = 每颗音随机 1~3 条；1/2/3 = 固定条数
		FX_DEFAULTS.put("ripple.bob", 1.0);      // 涟漪是否带上下起伏
		FX_DEFAULTS.put("ripple.speed", 0.20);   // 径向扩散基准速度
		FX_DEFAULTS.put("ripple.scale", 1.0);    // 出生半径 / 尺寸整体缩放
		FX_DEFAULTS.put("ripple.alpha", 0.90);   // 涟漪透明度（ARGB 的 A）
		FX_DEFAULTS.put("ripple.gap", 0.16);     // 阵与阵的间隔（秒）
		FX_DEFAULTS.put("surface.alpha", 0.82);  // 面光透明度（"薄光"）
		FX_DEFAULTS.put("edge.spread", 0.024);   // 棱框每刻扩散系数
		FX_DEFAULTS.put("spark.count", 22.0);    // 金色火星数量
		FX_DEFAULTS.put("spark.size", 0.55);     // 金色火星大小
		FX_DEFAULTS.put("note.count", 1.0);      // 每块蹦几个音符精灵
		FX.putAll(FX_DEFAULTS);
	}

	/** 预设表：预设 = 对默认值的一组覆盖（没写到的键保持默认）。 */
	private static final java.util.Map<String, java.util.Map<String, Double>> PRESETS = new java.util.LinkedHashMap<>();
	static {
		// 当前被用户认可的那套（0.8.9）——名字取"冥河霓虹"
		PRESETS.put("styx-neon", java.util.Map.of());
		// 同一套参数、只把涟漪的上下起伏关掉（环边缘更干净）
		PRESETS.put("styx-flat", java.util.Map.of("ripple.bob", 0.0));
		// 每块只出一条涟漪（用户想试的"单条"）
		PRESETS.put("styx-solo", java.util.Map.of("ripple.waves", 1.0));
		// 三条涟漪 + 平环：最"水"的一档
		PRESETS.put("styx-choir", java.util.Map.of("ripple.waves", 3.0, "ripple.bob", 0.0));
	}
	private static String presetName = "styx-neon";

	private static double fx(String key) {
		Double v = FX.get(key);
		return v == null ? 0.0 : v;
	}

	private static void applyPreset(String name) {
		java.util.Map<String, Double> p = PRESETS.get(name);
		if (p == null) return;
		FX.putAll(FX_DEFAULTS);
		FX.putAll(p);
		presetName = name;
		rippleBob = fx("ripple.bob") > 0.5;   // 兼容旧命令
	}

	public static String presetName() {
		return presetName;
	}

	/** `/nbm machine fx`：把当前参数逐条列出来。 */
	public static String fxReport() {
		StringBuilder sb = new StringBuilder("音符盒特效参数（预设 " + presetName + "）：");
		for (var e : FX.entrySet()) {
			sb.append('\n').append(e.getKey()).append('=')
				.append(fmt(e.getValue()))
				.append(e.getValue().equals(FX_DEFAULTS.get(e.getKey())) ? "" : " *");
		}
		sb.append("\n（带 * = 与默认值不同；预设：" + String.join(" / ", PRESETS.keySet()) + "）");
		return sb.toString();
	}

	public static boolean setFx(String key, double value) {
		if (!FX.containsKey(key)) return false;
		FX.put(key, value);
		if ("ripple.bob".equals(key)) rippleBob = value > 0.5;
		return true;
	}

	public static String presetList() {
		return "预设：" + String.join(" / ", PRESETS.keySet()) + "（当前 " + presetName + "）";
	}

	public static boolean setPreset(String name) {
		if (!PRESETS.containsKey(name)) return false;
		applyPreset(name);
		return true;
	}
	/** 粒子固定色（用户 v4 口径："粒子颜色就纯金色或者白色即可"）。 */
	private static final String GOLD = "1.000,0.820,0.330", PLATINUM = "1.000,0.960,0.880";
	/**
	 * 平铺圆环矩阵：把 24×24 贴图的**中心**（±11.5px）对到命令点上。
	 *
	 * <p>⚠ 这是 0.7.9 "涟漪根本看不到" 的第二个根因（第一个是命令字符串少个空格、压根没解析成功）：
	 * `image-matrix` 每颗粒子的"中心"就是**命令点**，而 0.7.9 把命令点放在贴图左下角，
	 * 于是 `(dx,dy,dz)` 里全带着 +0.8/−0.8 格的角点偏置，`(vx,vy,vz)=(dx,dy,dz)*k`
	 * 等于把整圈**一边膨胀一边以 ~6 格/秒斜着推走**。现在命令点 = 环心，`dx/dz` 才是真正的半径方向。
	 *
	 * <p>⚠ 单位坑（2026-09-24 实测定论）：ExParticle 侧是 `pos = M · matDiv((col,row,0,1), dpb)`，
	 * `matDiv` 把**整个向量（含齐次项 w=1）**都除以 dpb，于是平移项也自动被除以 dpb：
	 * 想要 -0.7667 格的居中偏移，矩阵里就得写**像素值 -11.5**。
	 * 写成"格"（-0.7667）会让整圈偏 0.72 格 —— 俯视实机量到的就是这个偏移。
	 *
	 * <p>scale 只给"预览"用：不开机器时三阵只能同刻出生，用不同半径错开（机器跑的时候是每阵晚 0.15s）。
	 */
	private static String ringMatrix(double sx, double sz, double offX, double offZ) {
		double half = 15.5;   // 像素（会被 dpb 除掉）——见上面那条单位说明；32px 图的半图是 16px
		// 环心平移量 = offX*RING_DPB 像素（矩阵里写像素，除以 dpb 后才是"格"）
		return "(0," + fmt(sx) + ",0," + fmt(-half * sx + offX * RING_DPB) + ",,0,0,0,0,,"
			+ fmt(-sz) + ",0,0," + fmt(half * sz + offZ * RING_DPB) + ",,0,0,0,1)";
	}
	/**
	 * ① **12 条棱**（描边立方体）：从音符盒本体（1 格见方，半边长 0.5）起**等比例**往外扩
	 * （`(vx,vy,vz)=(dx,dy,dz)*0.035` → 每刻 3.5%，近似等比），线本身就是"描边"——
	 * size 0.6（四边形 ≈0.15 格）不粗不细。退场只缩 size、不碰 alpha：
	 * 开光影时半透明粒子会被 dither 成抖动麻点（2026-09-24 实测）。
	 *
	 * <p>step 必须能整除 1.0：0.05 → 采样点正好落在 ±0.5 上，12 条棱全中；
	 * 0.06 会让 ±0.5 只被部分命中（用户实测"只有 3 条棱"就是这个）。
	 *
	 * <p>锚点给**方块中心**（y+0.5）：棱框就是方块本体那 12 条棱。0.7.9 曾把锚点抬到
	 * y+1.5（顶面上方半格），整只框悬在方块上空一格 —— 用户要的是"体积从和音符盒一样大"。
	 */
	private static String flareEdges(double cx, double cy, double cz, double phase, double rate) {
		return "particlex custom-conditional end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=0.6; alpha=1; age=20; light=1.0\" 0.5 0.5 0.5 "
			+ "\"abs(abs(x)-0.5)<0.01&abs(abs(y)-0.5)<0.01|abs(abs(x)-0.5)<0.01&abs(abs(z)-0.5)<0.01"
			+ "|abs(abs(y)-0.5)<0.01&abs(abs(z)-0.5)<0.01\" 0.05 "
			// v4：扩散系数 0.035 → 0.024（用户："音符盒的立方体扩散范围稍微小一点"）
			+ "\"(vx,vy,vz)=(dx,dy,dz)*0.024; size=0.6*(1-t/20); "
			+ rainbowExpr(phase, rate, RAIN_BIAS, RAIN_SCALE) + "\" 1.0";
	}

	/**
	 * ② **盒体表面发光**（v3）：把不透明小点铺在方块的**五个面**上（±0.5 壳层，去掉底面），
	 * 每颗都是面向镜头的四边形 → 不管镜头多平，都能看到"盒体表面亮了一下再消退"。
	 *
	 * <p>踩过的三条路（别再回退）：
	 * <ol>
	 *   <li>单颗 size 9→25 的 end_rod 冒充柔光 → 是一大片硬边色块（精灵本身是六边形）；</li>
	 *   <li>`glow.png`（16² 径向 alpha 渐变）+ 逐像素 alpha → 开光影时半透明被 **dither** 成
	 *       一片抖动噪点方块（2026-09-24 逐帧取证，正是用户说的"柔光很拉跨"）；</li>
	 *   <li>0.7.9 的"顶面上方一圈平铺的点"：机位与海平面平行时，平的圆晕在画面里被压成一条线，
	 *       实机等于看不见（用户 2026-09-24 复看："其他效果都没看出来"）。</li>
	 * </ol>
	 * <p>采样口径：range 0.5 / step 0.125（二进制精确 → 9×9×9 = 729 点），条件取
	 * |x|=0.5 或 |z|=0.5 或 y=+0.5 的壳层 → 337 颗；size 0.75（四边形 ≈0.19 格）在 0.125 格间距上
	 * 互相压住 → 贴着盒面的一层细密辉光。
	 *
	 * <p>尺寸口径（2026-09-24 逐帧实测）：{@code size} 对应的四边形 ≈ <b>size/8 格</b>
	 * （不是 size/4），所以 0.25 格间距要铺满，size 得 ≥1.2。0.7.9 之后第一版用 size 0.75
	 * （0.094 格）在 0.125 间距上是一粒粒孤立的点，实机几乎看不见。
	 * {@code 0.064*dx³} 让每颗沿自己的面法线慢慢往外飘 0.08 格 → 表面像"亮起来往外渗"。
	 * 退场只缩 size、alpha 全程 1。
	 */
	private static String flareSurface(double cx, double cy, double cz, double phase, double rate) {
		return "particlex custom-conditional end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			// v5（用户："面光要更透、更像一层薄光"）：size 1.75 → 1.05（点缩到 0.13 格，
			// 在 0.125 格间距上刚好接触 → 能透出方块本身的贴图），并给 alpha 0.82 让它像"光膜"。
			+ " \"size=1.05; alpha=0.82; age=12; light=1.0; " + rainbowExpr(phase, rate, RAIN_BIAS, RAIN_SCALE)
			+ "\" 0.5 0.5 0.5 "
			+ "\"abs(abs(x)-0.5)<0.01|abs(abs(z)-0.5)<0.01|abs(y-0.5)<0.01\" 0.125 "
			+ "\"vx=0.040*dx*dx*dx; vy=0.040*dy*dy*dy; vz=0.040*dz*dz*dz; "
			+ "size=1.05*(1-t/12); alpha=0.82*(1-t/12); " + rainbowExpr(phase, rate, RAIN_BIAS, RAIN_SCALE) + "\" 1.0";
	}

	/**
	 * ③ **涟漪 / 水波**（v3）：`custom-parameter polar` 绕方块中心撒一圈点，沿半径向外推，
	 * 边推边上下起伏 —— 湖面被雨点砸中后一圈圈荡开的波纹。
	 *
	 * <p>踩过的坑（别再回退）：
	 * <ol>
	 *   <li>0.7.9 用 `image-matrix` + ring.png：锚点在**贴图左下角**，而 `(vx,vy,vz)=(dx,dy,dz)*k`
	 *       是按"相对锚点"推的 → 整圈一边膨胀一边以 ~6 格/秒斜着飞走，实机根本看不到环；</li>
	 *   <li>平铺的水波环在"与海平面平行"的机位下被压成一条线，就算不出错也看不清。</li>
	 * </ol>
	 * 现在：`dis` 是**相对方块中心**的半径，每颗都是面向镜头的四边形（size ≈0.2 格），
	 * 半径按 `0.17/(1+t/3.2)` 先快后慢往外荡；`vy=0.045*sin(t/2.4+ds1*3)` 给整圈叠一列行波，
	 * 镜头平飞时看到的就是"一圈圈往外荡、还带着上下起伏"的水纹。
	 *
	 * <p>0.8.1 起改回 `image-matrix` + ring.png（**连续细环**，116 颗/圈）：
	 * polar 版（105 颗/圈的点阵）实机是"一串珠子"——点与点之间有明显空隙，
	 * 而且 size 的四边形只有 size/8 格（0.95 → 0.12 格），间距 0.11 格时就断成虚线了。
	 * 环贴图是连着的，只在环带上取像素，观感就是"一条水波线"；
	 * 竖向下沉/起伏仍靠 `vy=0.045*sin(...)`（`ds1` = 该像素在环上的方位角）。
	 *
	 * <p>波形口径抄自参考项目 sonic-topography 的涟漪 shader（`CustomShaderMaterial.ts` 316-350 行）：
	 * `waveRadius = t * speed`、剖面是 `exp(-d²/width)` 的高斯环、幅度按 `exp(-waveRadius/fadeDist)`
	 * **指数衰减**。粒子做不了位移，就把"指数衰减"落在 size 上：`size = s0*exp(-1.8t/age)`
	 * （上一版用 `(1+0.9u)*pow(1-u,0.45)` → 前段一直很粗，实机是一坨）。
	 *
	 * @param scale 出生半径缩放（1.0 = 素材原尺寸 0.63 格；只有预览才用 !=1）
	 */
	private static String flareRipple(double cx, double top, double cz, double phase, double rate, Ripple r) {
		return "particlex image-matrix end_rod " + fmt(cx) + " " + fmt(top) + " " + fmt(cz)
			+ " ring.png 1.0 \"" + ringMatrix(r.sx(), r.sz(), r.offX(), r.offZ()) + "\" " + fmt(RING_DPB)
			+ " 0 0 0 " + r.age()
			// 扩散：`/(1+t/2.6)` → **一开始最快、随后迅速变慢**（用户 v5："粒子扩散速度从快到慢"）
			+ " \"(vx,vy,vz)=(dx,dy,dz)/ddis*" + fmt(r.speed()) + "/(1+t/2.6); "
			+ "vy=" + fmt(r.bobAmp()) + "*sin(t/" + fmt(r.bobPeriod()) + "+ds1*3+" + fmt(r.bobPhase()) + "); "
			+ "size=" + fmt(r.size()) + "*exp(-2.2*t/" + r.age() + "); alpha=" + fmt(r.alpha()) + "; "
			+ rainbowExpr(phase, rate, RAIN_BIAS, RAIN_SCALE) + "\" 1.0";
	}

	/**
	 * 一阵涟漪的参数（v4 起每颗音现摇一份；v5 加大随机幅度 → 用户复看 v4 后仍觉得"涟漪还是一样"）。
	 *
	 * <p>v5 起连"环的形状"都随机：{@code sx/sz} 让环变成**略椭圆的**（真实水波不会是正圆）、
	 * {@code offX/offZ} 让环心**不总在方块正中**、{@code alpha} 给一点 ARGB 透明、
	 * {@code bobAmp} 决定起伏幅度。→ 相邻两块看着就是两圈不一样的波纹。
	 *
	 * @param sx,sz     环在 x/z 方向的出生半径缩放（0.85–1.25，两轴独立 → 椭圆）
	 * @param offX,offZ 环心偏移（格）
	 * @param age       寿命（刻）
	 * @param size      出生 size（四边形 ≈ size/8 格）
	 * @param speed     径向扩散速度系数（先快后慢，见 {@code /(1+t/2.6)}）
	 * @param bobAmp    行波幅度（格/刻）
	 * @param bobPeriod 行波周期（刻）
	 * @param bobPhase  行波相位（弧度）
	 * @param alpha     透明度（0..1；光影下会 dither，所以只压到 0.8 上下）
	 */
	private record Ripple(double sx, double sz, double offX, double offZ, int age, double size,
	                      double speed, double bobAmp, double bobPeriod, double bobPhase, double alpha) {
	}

	/**
	 * ④ **落点迸溅**：雨点砸在水面上的那一小簇向上窜的水花（10 颗 / 0.65s）。
	 * 出生点压在水皮上（sigma_y=0.03），带重力自然回落。
	 */
	private static String flareSplash(double cx, double cy, double cz, String col) {
		return "particlex custom-normal end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=1.10; cr,cg,cb=" + col + "; alpha=1; age=13; light=1.0; "
			+ "vx=(random()-0.5)*0.12; vy=0.14+random()*0.20; vz=(random()-0.5)*0.12; "
			+ "gravity=0.035; friction=0.98\" 0.15 0.03 0.15 10 "
			+ "\"size=1.10*(1-t/13)\" 1.0";
	}

	/**
	 * ⑤ **金色火星**（v4）：四散炸开、更小更慢、"金光闪闪"。
	 *
	 * <p>用户 v4 口径："炸开的粒子效果应该四散开来，并且粒子还可以小一些，速度稍慢一点，
	 * 有点金光闪闪的那种感觉"。所以：
	 * <ul>
	 *   <li>方向：`vx/vz=±lat/2`、`vy=(random()-0.3)*up` → 上下左右都撒得出去（旧版 vy 恒正 = 只往上窜）；</li>
	 *   <li>尺寸：0.55（≈0.07 格，旧版 0.8）；寿命 18 刻；</li>
	 *   <li>速度：横向 ±0.17、纵向 −0.08~+0.18 格/刻（旧版纵向上限 0.62）；</li>
	 *   <li>颜色：{@link #GOLD}（主）＋ {@link #PLATINUM}（少量白闪），不再跟音高。</li>
	 * </ul>
	 * 退场仍是 size 收缩（alpha 全程 1，光影不会 dither 成噪点）。
	 */
	private static String flareSparks(double cx, double cy, double cz, String col,
	                                  int count, double size, double lateral, double up) {
		return "particlex custom-normal end_rod " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=" + fmt(size) + "; cr,cg,cb=" + col + "; alpha=1; age=18; light=1.0; "
			+ "vx=(random()-0.5)*" + fmt(lateral) + "; vy=(random()-0.3)*" + fmt(up)
			+ "; vz=(random()-0.5)*" + fmt(lateral) + "; gravity=0.04; friction=0.985\" "
			+ "0.11 0.06 0.11 " + count
			+ " \"size=" + fmt(size) + "*exp(-1.5*t/18)\" 1.0";
	}

	/**
	 * ⑥ **音符精灵**（用户 v4/v5："音符盒本身的音符粒子特效可以增强一下"、"每一个音符盒只蹦一个音符粒子就行，
	 * 音符粒子的[颜色]随那个音符盒特效颜色而定"）：
	 * 用 MC 自己的 `minecraft:note` 精灵，**每块只放 1 颗**、颜色 = 本块特效色（{@code colFace}），
	 * 比原版那颗更大更亮、飘得更久，向上带一点横向漂移。
	 *
	 * <p>原版那颗（红石触发时由 `NoteBlock` 自己 spawn）仍会照常出现 —— 它是按音高上色的，
	 * 和我们这颗霓虹色会叠在一起（用户看过 v4 的 4 颗版本后要求"只蹦一个"，所以这里收到 1 颗）。
	 */
	private static String flareNotes(double cx, double cy, double cz, double phase, double rate, int count) {
		return "particlex custom-normal minecraft:note " + fmt(cx) + " " + fmt(cy) + " " + fmt(cz)
			+ " \"size=2.4; alpha=1; age=28; light=1.0; " + rainbowExpr(phase, rate, RAIN_BIAS, RAIN_SCALE) + "; "
			+ "vx=(random()-0.5)*0.06; vy=0.085; vz=(random()-0.5)*0.06\" "
			+ "0.02 0.02 0.02 " + Math.max(0, count) + " \"size=2.4*exp(-1.0*t/28); "
			+ rainbowExpr(phase, rate * 1.3, RAIN_BIAS, RAIN_SCALE) + "\" 1.0";
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
		// 起播机位/朝向：方向常量（fx/fz/rx/rz）决定版面朝向，眼位只做"取不到玩家"时的兜底
		double yaw = Math.toRadians(p.getYaw());
		double fx = -Math.sin(yaw), fz = Math.cos(yaw);   // 水平前
		double rx = -fz, rz = fx;                         // 水平右
		eye0X = p.getX();
		eye0Y = p.getEyeY();
		eye0Z = p.getZ();
		dirFx = fx;
		dirFz = fz;
		dirRx = rx;
		dirRz = rz;
		double ax = p.getX() + fx * OPEN_AHEAD, az = p.getZ() + fz * OPEN_AHEAD;
		double ay = p.getEyeY() + 0.2;
		// 屏幕锚定（0.7.1）：把卡片每刻搬到「眼位 + 起播方向×距离 + 起播右向×版面偏移」→ 屏幕上不动
		String coverLock = OPEN_SCREEN_ANCHOR ? anchorTo(OPEN_AHEAD, OPEN_COVER_H, 0.2, fx, fz, rx, rz) : "";
		String textLock = OPEN_SCREEN_ANCHOR ? anchorTo(OPEN_AHEAD, OPEN_TEXT_H, 0.2, fx, fz, rx, rz) : "";
		/*
		 * 开场只有两件事：封面 + 文案。
		 *   出现 = 柔和淡入；消失 = **同一条缓动曲线的镜像**（用户 2026-09-24："消失动画用出现动画一样
		 *   类型的（柔和淡入 淡出）"、"把整个点阵去掉"）。
		 * 每颗板子一颗粒子：淡入那颗活到退场时刻，退场那颗是"只淡出"的新粒子（复合 clamp 实测整颗不渲染）。
		 */
		if (!DBG_NO_PLATES) {
			pending.add(new Pending(atSec + OPEN_PLATE_IN_AT, () -> {
				double[] q = anchorPoint(world, OPEN_AHEAD, OPEN_COVER_H, 0.2);
				return coverPlate(q[0], q[1], q[2], ticks(OPEN_COVER_OUT_AT - OPEN_PLATE_IN_AT),
					true, OPEN_COVER_IN_SEC, coverLock);
			}));
			pending.add(new Pending(atSec + OPEN_PLATE_IN_AT, () -> {
				double[] q = anchorPoint(world, OPEN_AHEAD, OPEN_TEXT_H, 0.2);
				return textPlate(q[0], q[1], q[2], ticks(OPEN_TEXT_OUT_AT - OPEN_PLATE_IN_AT),
					true, OPEN_TEXT_IN_SEC, textLock);
			}));
			pending.add(new Pending(atSec + OPEN_COVER_OUT_AT, () -> {
				double[] q = anchorPoint(world, OPEN_AHEAD, OPEN_COVER_H, 0.2);
				return coverPlate(q[0], q[1], q[2], ticks(OPEN_COVER_OUT_SEC) + 4,
					false, OPEN_COVER_OUT_SEC, coverLock);
			}));
			pending.add(new Pending(atSec + OPEN_TEXT_OUT_AT, () -> {
				double[] q = anchorPoint(world, OPEN_AHEAD, OPEN_TEXT_H, 0.2);
				return textPlate(q[0], q[1], q[2], ticks(OPEN_TEXT_OUT_SEC) + 4,
					false, OPEN_TEXT_OUT_SEC, textLock);
			}));
		}
		NbmachinaMod.LOGGER.info("[styxshow] 开场卡片（{}）：起播 yaw {} 锚点 ({}, {}, {})，{} 格前方、点阵右偏 {} 格；{} 条点阵、退出拆 {}×{} 块",
			OPEN_SCREEN_ANCHOR ? "屏幕锚定·出生点按当前眼位现算" : "世界固定",
			fmt(p.getYaw()), fmt(ax), fmt(ay), fmt(az), fmt(OPEN_AHEAD), fmt(OPEN_DOT_SHIFT_H),
			OPEN_DOT_BANDS, PLATE_TILES, PLATE_TILES);
	}

	/** 秒 → 刻（表达式里的 t 是刻数）。 */
	private static int ticks(double sec) {
		return Math.max(1, (int) Math.round(sec * 20.0));
	}

	/**
	 * 出一份"**当前**眼位 + 起播方向×dist + 起播右向×h、高度 = 当前眼高 + v"的世界坐标，
	 * 给粒子当**出生点**用（{@link Pending} 的说明：出生点必须现算，否则新粒子会先在旧机位闪一下）。
	 * 拿不到玩家（理论上不会）就退回起播机位。
	 */
	private static double[] anchorPoint(ServerWorld world, double dist, double h, double v) {
		double ex = eye0X, ey = eye0Y, ez = eye0Z;
		var players = world.getServer().getPlayerManager().getPlayerList();
		if (!players.isEmpty()) {
			ServerPlayerEntity p = players.get(0);
			ex = p.getX();
			ey = p.getEyeY();
			ez = p.getZ();
		}
		return new double[]{
			ex + dirFx * dist + dirRx * h,
			ey + v,
			ez + dirFz * dist + dirRz * h};
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
		showNow = now;
		if (!active || doc == null) return;
		if (!pending.isEmpty()) {
			for (int i = pending.size() - 1; i >= 0; i--) {
				Pending p = pending.get(i);
				if (p.at() <= now) {
					exec(world, p.cmd().get());
					pending.remove(i);
				}
			}
		}
		double nowLyric = now - lyricOffset;
		// 重音"大圆环"（旧 accentRing，青色 size 3.0 / 半径荡到 5 格）已按用户 2026-09-24 口径**删除**：
		// "还有一个圆环的视效也是不符合要求的，把他去掉"。styxshow.json 里的 accents 数据保留但不再出画。
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
		fireNote(world, x, y, z, midi, velocity, bass);
	}

	/** 调试预览：不管视效层在不在跑都放一次（`/nbm machine flare <midi>`，站在音符盒上执行）。 */
	public static void previewFlare(ServerWorld world, int x, int y, int z, int midi, int velocity, boolean bass) {
		fireNote(world, x, y, z, midi, velocity, bass);
	}

	private static void fireNote(ServerWorld world, int x, int y, int z, int midi, int velocity, boolean bass) {
		// ⚠ y 口径（2026-09-24 用户实机取证："视效跑到音符盒下面去了"）：
		//   机器 `machine_map.csv` / `PendingVisual` 里的 y=110 **不是音符盒**，音符盒在它**上一格**
		//   （in-world 验证：`execute if block 0 111 -6 minecraft:note_block` 命中，y=110 那格不命中）。
		//   所以这里按**方块状态** self-heal：先看 (x,y,z)，不是音符盒就取 y+1。
		//   预览命令 `/nbm machine flare <midi> [x y z]` 两种写法（map 的 y 或音符盒的 y）都能对。
		int by = y;
		if (!world.getBlockState(new net.minecraft.util.math.BlockPos(x, y, z))
				.isOf(net.minecraft.block.Blocks.NOTE_BLOCK)) {
			by = y + 1;
		}
		// v3.1 锚点：整组特效都长在**音符盒本体／顶面**上（不是水面、不是下一格）。
		double cx = x + 0.5, cz = z + 0.5;
		double mid = by + 0.5;     // 音符盒中心
		double top = by + 1.0;     // 音符盒顶面
		// v6 配色（用户 2026-09-25："在单一音符盒就能做到它每次播放的音符颜色渐变，然后整体随之渐变流转"）：
		// 不再预先把颜色算成 RGB，而是把**相位**交给 ExParticle 表达式 → 每颗粒子在自己的生命里持续渐变
		// （见 rainbowExpr）。相位来自「方块位置 − 视效时刻」（相邻块/不同时刻不同色），
		// 再给棱框/面光/涟漪各一个固定偏移 → 同一颗音内部也有层次。
		// v7：相位同时带 z + 每块哈希抖动（用户："同一时间戳响的音符盒色彩似乎一致" —— 和弦是同 x 不同 z）
		double jit = blockJitter(x, by, z);
		double phEdge = neonPhase(cx, cz, showNow, 0.000, jit);
		double phFace = neonPhase(cx, cz, showNow, 0.045, jit);
		double phRing = neonPhase(cx, cz, showNow, 0.105, jit);
		double rate = fx("color.rate") * (0.8 + Math.random() * 0.5);   // 每颗音的变色速度也随机
		final double rateF = rate;
		exec(world, flareEdges(cx, mid, cz, phEdge, rate));
		// 面光：v5 按用户"要更透、更像一层薄光"整层重做（见 flareSurface 注释）
		exec(world, flareSurface(cx, mid, cz, phFace, rate * 1.15));
		// 水波阵：贴着**音符盒顶面**荡开，每 0.16s 追一阵（0 / 0.16 / 0.32s）→ "像被流星砸中那样泛起波纹"。
		// 机器在跑时用延迟队列错开（见 pulse()）；单独 /nbm machine flare 预览时没有"到点"这一说、
		// 只能同刻出生，就换成"更大的出生半径"把阵与阵拉开（scale 1.0 / 1.45 / 1.9）。
		final double ringY = top + 0.02;
		// 每颗音**大随机**（用户 v5："涟漪随机性感觉不够…每一个音符盒的涟漪效果还是像一样的"）：
		// 两个轴分别缩放（→ 椭圆）、环心偏移、扩散速度、寿命、粒子大小、起伏幅度/周期/相位，
		// 连**阵数**都现摇 → 相邻两块看到的波纹形状、大小、节奏都不同。
		double sx0 = 0.85 + Math.random() * 0.40;
		double sz0 = 0.85 + Math.random() * 0.40;
		double offX = (Math.random() - 0.5) * 0.36;
		double offZ = (Math.random() - 0.5) * 0.36;
		double rk = fx("ripple.speed") * (0.80 + Math.random() * 0.40);   // 扩散基准 × 随机
		int age = 20 + (int) (Math.random() * 10);
		// v5：0.75–1.30（0.09–0.16 格）——32px 环的点距是 1/20=0.05 格，这个尺寸下点会互相压住，
		// 环线是连续的（0.55–1.05 时实机偏"串珠"）
		double rScale = fx("ripple.scale");
		double size0 = (0.75 + Math.random() * 0.55) * rScale;
		// 起伏可关（`ripple.bob` / `/nbm machine ripplebob off`）
		double bobAmp = fx("ripple.bob") > 0.5 ? 0.020 + Math.random() * 0.040 : 0.0;
		double bobT = 1.8 + Math.random() * 1.4;
		double bobP = Math.random() * 6.2832;
		double alpha0 = fx("ripple.alpha") * (0.90 + Math.random() * 0.10);
		// 涟漪条数：`ripple.waves` = 0 → 每颗音随机 1~3；= 1/2/3 → 固定（用户要的"单条"就写 1）
		int wavesCfg = (int) Math.round(fx("ripple.waves"));
		int waves = wavesCfg >= 1 ? Math.min(3, wavesCfg) : 1 + (int) (Math.random() * 3);
		if (wavesCfg == 0 && velocity >= 90 && waves < 3) waves = 3;
		double gap = Math.max(0.02, fx("ripple.gap"));
		final double gapF = gap;
		final double sxF = sx0 * rScale, szF = sz0 * rScale, offXF = offX, offZF = offZ, sizeF = size0;
		final double rkF = rk, bobAF = bobAmp, bobTF = bobT, bobPF = bobP, alphaF = alpha0;
		final int ageF = age, wavesF = waves;
		final boolean live = active;
		pulse(world, 0.00, () -> flareRipple(cx, ringY, cz, phRing, rateF * 0.90,
			new Ripple(sxF, szF, offXF, offZF, ageF, sizeF, rkF, bobAF, bobTF, bobPF, alphaF)));
		if (wavesF >= 2)
			pulse(world, gapF * 0.9 + Math.random() * 0.08, () -> flareRipple(cx, ringY, cz, phRing + 0.55, rateF * 0.90,
				new Ripple(live ? sxF * 1.12 : sxF * 1.45, live ? szF * 1.12 : szF * 1.45,
					-offXF * 0.6, -offZF * 0.6, ageF + 3, sizeF * 0.88, rkF * 0.90,
					bobAF * 1.2, bobTF * 1.12, bobPF + 1.1, alphaF * 0.95)));
		if (wavesF >= 3)
			pulse(world, gapF * 1.8 + Math.random() * 0.10, () -> flareRipple(cx, ringY, cz, phRing + 1.15, rateF * 0.90,
				new Ripple(live ? sxF * 1.26 : sxF * 1.90, live ? szF * 1.26 : szF * 1.90,
					offXF * 0.4, offZF * 0.4, ageF + 6, sizeF * 0.78, rkF * 0.82,
					bobAF * 1.4, bobTF * 1.25, bobPF + 2.2, alphaF * 0.90)));
		// 金/白粒子（用户口径：火星金色、白闪点缀）+ 铂金水花 + 音符精灵（一颗，跟本块特效同色）
		exec(world, flareSparks(cx, top + 0.06, cz, GOLD, (int) fx("spark.count"), fx("spark.size"), 0.34, 0.26));
		exec(world, flareSparks(cx, top + 0.06, cz, PLATINUM, 8, 0.42, 0.22, 0.20));
		exec(world, flareSplash(cx, top + 0.03, cz, PLATINUM));
		int noteCount = Math.max(0, (int) Math.round(fx("note.count")));
		if (noteCount > 0) exec(world, flareNotes(cx, top + 0.12, cz, phFace, rate, noteCount));
	}

	/**
	 * 音符盒特效里"要不要晚一点再放"的开关：
	 * 视效层在跑（= 机器在跑）→ 塞进 {@link #pending}，到点再拼命令；否则（预览）直接放。
	 *
	 * <p>延迟只用于涟漪的第二、三阵：同刻出生的话三圈会叠成一圈，
	 * 分 0.15s 出生才是"雨点一层接一层推出去"。
	 */
	private static void pulse(ServerWorld world, double delaySec, java.util.function.Supplier<String> cmd) {
		if (active && delaySec > 0) {
			pending.add(new Pending(showNow + delaySec, cmd));
		} else {
			exec(world, cmd.get());
		}
	}

	/**
	 * 霓虹**相位**（弧度）：`(x/波长x + z/波长z − 时刻×漂移 + 偏移 + 每块抖动)` × 2π。
	 *
	 * <p>⚠ 2026-09-25 用户口径："同一时间戳响的音符盒的色彩似乎是一致的" —— 机器里的和弦
	 * 正是 **同一个 x、不同 z**（实测 time=147.379 三颗：x=1196 / z=2,4,6）。
	 * 所以相位里必须**同时带上 z**，再叠一个按方块坐标哈希出来的抖动
	 * （{@link #blockJitter}）→ 同一刻响的和弦也是三个不同色，而且颜色仍沿着河连续渐变。
	 */
	private static double neonPhase(double x, double z, double now, double offset, double jitter) {
		return 6.2832 * (x / fx("color.wave") + z / (fx("color.wave") * 0.72)
			- now * fx("color.drift") + offset + jitter * fx("color.jitter"));
	}

	/**
	 * 每块自己的相位抖动（-1..1，确定性哈希）：同一 x 上的和弦、甚至同 x 同 z 的重复触发，
	 * 颜色都不会撞在一起。哈希用经典 32 位混合常数，纯整数运算、跨平台稳定。
	 */
	private static double blockJitter(int x, int y, int z) {
		int h = x * 73856093 ^ y * 19349663 ^ z * 83492791;
		h ^= (h >>> 13);
		h *= 0x5bd1e995;
		h ^= (h >>> 15);
		return (h & 0xFFFF) / 65535.0 * 2.0 - 1.0;
	}

	/**
	 * **一枚音自己的颜色渐变**（用户 2026-09-25："我希望在单一音符盒就能做到它每次播放的音符颜色渐变，
	 * 然后整体随之渐变流转"）。
	 *
	 * <p>做法：把颜色写进 ExParticle 的**逐刻表达式**，用三段相位差 2π/3 的正弦近似一条连续色环
	 * （廉价 ISP 彩虹，省掉 HSV 分支）：`c = bias + scale*(0.5+0.5*sin(base + 2πk/3 + t*rate))`。
	 * 其中 `t` 是**粒子自己的年龄（刻）** —— 所以同一颗音在它 0.6~1.5s 的生命里自己就在变色；
	 * `base` 由方块位置与视效时刻给出 → 相邻方块、不同时刻又各不相同，整体呈"彩虹在河上流"。
	 *
	 * <p>{@code bias}/{@code scale} 压住亮度：三通道相位差 120°，任一时刻必有两路偏暗 → 天然高饱和；
	 * 上界 0.96 不会整颗洗成白色（Iris 泛光会把纯白核心糊掉，2026-09-24 取证）。
	 */
	private static String rainbowExpr(double base, double rate, double bias, double scale) {
		return "cr=" + fmt(bias) + "+" + fmt(scale) + "*(0.5+0.5*sin(" + fmt(base) + "+t*" + fmt(rate) + "));"
			+ "cg=" + fmt(bias) + "+" + fmt(scale) + "*(0.5+0.5*sin(" + fmt(base + 2.0944) + "+t*" + fmt(rate) + "));"
			+ "cb=" + fmt(bias) + "+" + fmt(scale) + "*(0.5+0.5*sin(" + fmt(base + 4.1888) + "+t*" + fmt(rate) + "))";
	}

	public static boolean rippleBob() {
		return rippleBob;
	}

	public static void setRippleBob(boolean on) {
		rippleBob = on;
		FX.put("ripple.bob", on ? 1.0 : 0.0);   // 与 fx/preset 的同一份参数保持一致
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
		cmds.add(coverPlate(-10.0, 115.0, ZC, 40, true, OPEN_TEXT_IN_SEC));
		cmds.add(textPlate(-10.0, 119.9, ZC, 40, true, OPEN_TEXT_IN_SEC));
		cmds.add(dotBand(COVER_GRID_IMAGE + "00.png", COVER_DPB, -14.0, 111.0, ZC - 4.0,
			gridMatrix(0.0, 1.0, -(96.0 / 2), -(96.0 / 2)), 40, dotGrow(0.0), ""));
		cmds.add(dotBand(COVER_GRID_IMAGE + "00.png", COVER_DPB, -14.0, 111.0, ZC - 8.0,
			gridMatrix(0.0, 1.0, -(96.0 / 2), -(96.0 / 2)), 40, dotShrink(0.0), ""));
		cmds.add(flareEdges(0.5, 111.5, -5.5, 0.0, 0.12));
		cmds.add(flareSurface(0.5, 111.5, -5.5, 0.6, 0.14));
		cmds.add(flareRipple(0.5, 112.02, -5.5, 1.2, 0.11,
			new Ripple(1.00, 1.00, 0.0, 0.0, 21, 0.75, 0.18, 0.035, 2.2, 0.0, 0.90)));
		cmds.add(flareRipple(0.5, 112.02, -5.5, 1.8, 0.11,
			new Ripple(1.12, 1.25, -0.1, 0.1, 27, 0.60, 0.14, 0.05, 2.6, 1.1, 0.85)));
		cmds.add(flareSplash(0.5, 112.03, -5.5, PLATINUM));
		cmds.add(flareSparks(0.5, 112.06, -5.5, GOLD, 22, 0.55, 0.34, 0.26));
		cmds.add(flareNotes(0.5, 112.12, -5.5, 0.6, 0.14, 1));
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

