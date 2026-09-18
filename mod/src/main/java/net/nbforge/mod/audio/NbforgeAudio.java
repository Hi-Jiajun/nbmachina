package net.nbforge.mod.audio;

import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.IntBuffer;
import java.nio.file.Path;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.TimeUnit;

import org.lwjgl.openal.AL;
import org.lwjgl.openal.AL10;
import org.lwjgl.openal.ALC;
import org.lwjgl.openal.ALC10;
import org.lwjgl.openal.ALCCapabilities;
import org.lwjgl.openal.ALCapabilities;
import org.lwjgl.openal.EXTFloat32;

import net.nbforge.mod.NbforgeMod;

/**
 * M3-16（P2）· 无损音频引擎：**绕开原版 SoundManager**，自己开 OpenAL 设备播 WAV。
 *
 * <p>为什么必须绕开：原版客户端只实现了 {@code OggAudioStream}（javap 实证），
 * 资源包里的声音一定是 Ogg 有损；而 mod 直接读母版 WAV（48kHz/24bit）送进 OpenAL，
 * 才能做到无损 + 真力度层（每个力度层是一段独立采样）+ 将来的多声道。
 *
 * <p>线程模型：**自己的音频线程 + 自己的 OpenAL 设备/上下文**。原版的上下文只在
 * "Sound engine" 线程上 current，从渲染线程直接调 AL 是无效的；共用上下又会和原版抢线程。
 * 这里开第二个设备（OpenAL Soft 支持多设备），互相不打扰：主循环每 20ms 取一次任务队列，
 * 顺带回收播完的 source。所有 AL 调用都发生在这一条线程上。
 *
 * <p>接口是线程安全的：{@link #play} / {@link #setListener} 从游戏线程调用，入队即返回。
 */
public final class NbforgeAudio {
	/**
	 * 同时发声上限。钢琴密集段实测峰值 **124 路**（曲中段每 0.12s 一颗、采样截断 10s），
	 * 所以 128 会贴着天花板——超了就要偷最早那路（听感=提前掐掉一颗音）。抬到 192 留余量；
	 * OpenAL Soft 开几百路 source 没有问题，source 本身只是句柄。
	 */
	public static final int MAX_SOURCES = 192;
	/** 采样缓存**按字节**上限（不是按个数）：Salamander 单个采样最长 25.7s，float 立体声 ≈ 9.9MB */
	public static final long MAX_CACHE_BYTES = 512L * 1024 * 1024;
	/** 采样截断长度：钢琴 10s 之后只剩极轻的尾音，截断直接决定"能同时响多少音"与内存占用 */
	public static final double MAX_SECONDS = 10.0;

	/**
	 * 待执行任务队列。M3-29：换成**阻塞可唤醒**的队列 —— 旧实现是"非阻塞取一次，取不到就睡 15ms"，
	 * 于是客户端高精度调度发出的音最多会被拖 15ms 才真正播放。现在用 `poll(1ms)`：
	 * 有任务立刻返回、没任务最多睡 1ms，发声延迟降到亚毫秒级。
	 */
	private static final class Task {
		final Runnable runnable;
		final long enqueuedNanos = System.nanoTime();
		Task(Runnable runnable) { this.runnable = runnable; }
	}
	private static final java.util.concurrent.LinkedBlockingQueue<Task> TASKS =
		new java.util.concurrent.LinkedBlockingQueue<>();
	/** 最近一次"入队 → 执行"的延迟（ms），`/nbfc status` 里显示，用来验证高精度调度真的生效 */
	private static volatile double lastTaskLatencyMs = -1.0;
	private static final Map<String, Integer> BUFFERS = new LinkedHashMap<>(64, 0.75f, true);
	private static final Map<Integer, Long> BUFFER_BYTES = new HashMap<>();
	private static long cachedBytes = 0L;
	private static long DEVICE = 0L;
	private static long CONTEXT = 0L;
	/** 低音放音时长（ms）：贝斯线换音时把上一条低音快速放掉，模拟钢琴换踏板 / 贝斯手换音 */
	public static final long BASS_FADE_MS = 120L;
	/** 同键重击的放音时长（ms）：同一根弦被重新敲响，上一个声音被自然替换 */
	public static final long RESTRIKE_FADE_MS = 60L;

	/**
	 * 制音器放音时长（ms，M3-22）：谱面给了实际发声时长时用它。
	 * 低音弦又粗又重、制音器压下去要更久；高音弦轻，收得干脆——与离线渲染同一套口径。
	 */
	public static long damperMs(int midi) {
		return midi >= 60 ? 140L : midi >= 45 ? 200L : 300L;
	}

	/** 一路正在发声的音：谁（乐器 + 键位 + 声部）、增益、起始时间与放音状态 */
	private static final class Voice {
		final int source;
		final String instrument;
		final String voice;
		final int midi;
		final float gain;
		final long startMs = System.currentTimeMillis();
		final long fadeMs;
		/** 谱面给的**实际发声时长**（ms，0 = 没这信息，靠采样自然衰减）——M3-22 */
		final long durMs;
		long releaseStartMs = -1L;

		Voice(int source, String instrument, String voice, int midi, float gain, long fadeMs, long durMs) {
			this.source = source;
			this.instrument = instrument;
			this.voice = voice;
			this.midi = midi;
			this.gain = gain;
			this.fadeMs = fadeMs;
			this.durMs = durMs;
		}

		boolean isReleasing() {
			return releaseStartMs >= 0L;
		}

		/** 放音包络：1 → 0 */
		float fadeFactor(long nowMs) {
			if (releaseStartMs < 0L) return 1f;
			if (fadeMs <= 0L) return 0f;
			return Math.max(0f, 1f - (nowMs - releaseStartMs) / (float) fadeMs);
		}

		/** 到点了该放音吗（谱面给了时值才用；这就是"手指松开/踏板抬起"那一刻） */
		boolean dueToRelease(long nowMs) {
			return durMs > 0L && releaseStartMs < 0L && nowMs - startMs >= durMs;
		}
	}

	private static final Map<Integer, Voice> ACTIVE = new LinkedHashMap<>();   // source -> Voice
	private static final ArrayDeque<Integer> FREE = new ArrayDeque<>();

	private static Thread thread;
	private static volatile boolean ready = false;
	private static volatile boolean broken = false;
	private static volatile String lastError = null;
	private static volatile String alInfo = "（未初始化）";
	private static volatile float masterGain = 0.85f;
	private static volatile int playedCount = 0;
	private static volatile int droppedCount = 0;
	private static volatile int receivedCount = 0;
	private static volatile int restartCount = 0;
	private static volatile int stolenCount = 0;
	private static volatile int foldedCount = 0;
	/** 被"放音"规则提前放掉的声部数（低音单音线 + 同键重击）——M3-19 的低音"糊"就是靠它解决 */
	private static volatile int dampedCount = 0;
	/** 因为**谱面时值到点**而放音的声部数（M3-22：手指松开 / 踏板抬起） */
	private static volatile int releasedByScore = 0;
	/** 收到过时值的音符数（用于确认 machine_map.csv 里的 dur_ms 真的生效了） */
	private static volatile int withDuration = 0;
	private static volatile int peakActive = 0;

	private NbforgeAudio() {
	}

	public static boolean ready() {
		return ready;
	}

	public static String lastError() {
		return lastError;
	}

	/** OpenAL 设备字符串 + float32 能力（`/nbfc status` 里回显，便于远程诊断） */
	public static String alInfo() {
		return alInfo;
	}

	public static int playedCount() {
		return playedCount;
	}

	public static int droppedCount() {
		return droppedCount;
	}

	/** 客户端一共收到多少条 `nbforge:play`（与"已播/丢弃"配合判断链路断在哪一段） */
	public static int receivedCount() {
		return receivedCount;
	}

	/** OpenAL 上下文重建次数（资源重载/设备抖动后自愈用；正常应为 0） */
	public static int restartCount() {
		return restartCount;
	}

	/** 因为并发上限被抢走的声部数（>0 说明"有音被提前掐掉"，需要抬上限或缩短采样） */
	public static int stolenCount() {
		return stolenCount;
	}

	/** 因为超出乐器音域而被**整八度**折回来的音符数（低音提琴/竖琴这类窄音域乐器会有） */
	public static int foldedCount() {
		return foldedCount;
	}

	public static int dampedCount() {
		return dampedCount;
	}

	/** 按谱面时值放音的次数（M3-22） */
	public static int releasedByScore() {
		return releasedByScore;
	}

	/** 带时值播放的音符数（0 说明 machine_map.csv 还没有 dur_ms 列） */
	public static int withDurationCount() {
		return withDuration;
	}

	public static int activeCount() {
		return ACTIVE.size();
	}

	public static int bufferCount() {
		return BUFFERS.size();
	}

	public static long cachedBytes() {
		return cachedBytes;
	}

	public static int peakActive() {
		return peakActive;
	}

	public static void setMasterGain(float gain) {
		masterGain = Math.max(0.0f, Math.min(2.0f, gain));
	}

	public static float masterGain() {
		return masterGain;
	}

	public static void start() {
		if (thread != null) return;
		thread = new Thread(NbforgeAudio::run, "nbforge-audio");
		thread.setDaemon(true);
		thread.start();
	}

	/**
	 * 音频线程主循环。
	 *
	 * <p>**可自愈**：Minecraft 在资源重载/切设备时会重启它自己的声音引擎，实测日志里出现过
	 * `[Sound engine/ERROR] Allocate new source: Invalid name parameter`（OpenAL 对象名失效）。
	 * 我们虽然用自己的设备/上下文，但底层一旦抖动，旧 buffer/source 也会一起失效——
	 * 所以这里只要检测到 AL 错误，就把自己整套（设备/上下文/缓存/声部）拆掉重建，
	 * 而不是从此静音（2026-09-15 09:42 用户实测"关资源包后听不到"就是这个场景）。
	 */
	private static void run() {
		IntBuffer state = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
		while (!Thread.currentThread().isInterrupted()) {
			if (!ready) {
				if (!initContext()) {
					try {
						Thread.sleep(1000L);
					} catch (InterruptedException e) {
						Thread.currentThread().interrupt();
					}
					continue;
				}
			}
			Task task;
			try {
				task = TASKS.poll(1L, java.util.concurrent.TimeUnit.MILLISECONDS);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				break;
			}
			// 一次把已到的都跑掉（密集段落不排队），但每轮限量，避免饿死 recycle/错误检测
			for (int drained = 0; task != null && drained < 64; drained++) {
				lastTaskLatencyMs = (System.nanoTime() - task.enqueuedNanos) / 1e6;
				try {
					task.runnable.run();
				} catch (Throwable t) {
					lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
					broken = true;
					NbforgeMod.LOGGER.warn("[nbforge] 音频任务异常（将重建上下文）：{}", lastError);
				}
				task = TASKS.poll();
			}
			int err = AL10.alGetError();
			if (err != AL10.AL_NO_ERROR) {
				broken = true;
				lastError = "OpenAL 错误 0x" + Integer.toHexString(err);
			}
			if (broken) {
				teardown(lastError);
				continue;
			}
			recycle(state);
		}
		teardown(null);
	}

	private static boolean initContext() {
		long device = 0L;
		long context = 0L;
		try {
			device = ALC10.alcOpenDevice((ByteBuffer) null);
			if (device == 0L) {
				lastError = "alcOpenDevice 失败（没有可用的 OpenAL 设备）";
				return false;
			}
			context = ALC10.alcCreateContext(device, (IntBuffer) null);
			if (context == 0L || !ALC10.alcMakeContextCurrent(context)) {
				lastError = "alcCreateContext/alcMakeContextCurrent 失败";
				if (context != 0L) ALC10.alcDestroyContext(context);
				ALC10.alcCloseDevice(device);
				return false;
			}
			ALCCapabilities alcCaps = ALC.createCapabilities(device);
			ALCapabilities caps = AL.createCapabilities(alcCaps);
			FLOAT_OK = caps.AL_EXT_FLOAT32;
			alInfo = AL10.alGetString(AL10.AL_VENDOR) + " / " + AL10.alGetString(AL10.AL_RENDERER)
				+ " / " + AL10.alGetString(AL10.AL_VERSION) + " / float32=" + FLOAT_OK;
			DEVICE = device;
			CONTEXT = context;
			broken = false;
			ready = true;
			NbforgeMod.LOGGER.info("[nbforge] 音频引擎就绪：OpenAL 自有设备；float32 支持={}；上限 {} 声部 / 采样缓存 {}MB / 采样截断 {}s",
				FLOAT_OK, MAX_SOURCES, MAX_CACHE_BYTES / 1048576, (int) MAX_SECONDS);
			return true;
		} catch (Throwable t) {
			lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
			NbforgeMod.LOGGER.warn("[nbforge] 音频引擎初始化失败", t);
			return false;
		}
	}

	/** 拆掉设备/上下文与全部缓存（重建前调用；why=null 表示正常退出） */
	private static void teardown(String why) {
		ready = false;
		try {
			for (int source : ACTIVE.keySet()) AL10.alDeleteSources(source);
			ACTIVE.clear();
			while (!FREE.isEmpty()) AL10.alDeleteSources(FREE.pop());
			for (int buffer : BUFFERS.values()) AL10.alDeleteBuffers(buffer);
			BUFFERS.clear();
			BUFFER_BYTES.clear();
			cachedBytes = 0L;
		} catch (Throwable ignored) {
			// 上下文已经不可用时删除对象会抛错，忽略即可
		}
		if (CONTEXT != 0L) ALC10.alcMakeContextCurrent(0L);
		if (CONTEXT != 0L) ALC10.alcDestroyContext(CONTEXT);
		if (DEVICE != 0L) ALC10.alcCloseDevice(DEVICE);
		CONTEXT = 0L;
		DEVICE = 0L;
		if (why != null) {
			restartCount++;
			NbforgeMod.LOGGER.warn("[nbforge] 重建音频上下文（第 {} 次）：{} —— 旧缓存已清空，下一颗音会重新解码",
				restartCount, why);
		}
	}

	/** 回收播放结束的 source（必须在本线程调用） */
	private static void recycle(IntBuffer state) {
		if (ACTIVE.isEmpty()) return;
		long now = System.currentTimeMillis();
		for (Iterator<Map.Entry<Integer, Voice>> it = ACTIVE.entrySet().iterator(); it.hasNext(); ) {
			Map.Entry<Integer, Voice> e = it.next();
			Voice v = e.getValue();
			// M3-22：谱面时值到点 → 进入放音（制音器落下）
			if (v.dueToRelease(now)) {
				v.releaseStartMs = now;
				releasedByScore++;
			}
			if (v.isReleasing()) {
				float f = v.fadeFactor(now);
				AL10.alSourcef(v.source, AL10.AL_GAIN, Math.max(0f, v.gain * masterGain * f));
				if (f <= 0f) {
					AL10.alSourceStop(v.source);
					AL10.alSourcei(v.source, AL10.AL_BUFFER, 0);
					FREE.push(v.source);
					it.remove();
					continue;
				}
			}
			state.clear();
			AL10.alGetSourcei(v.source, AL10.AL_SOURCE_STATE, state);
			boolean stopped = state.get(0) != AL10.AL_PLAYING;
			boolean tooLong = now - v.startMs > 60_000L;   // 兜底：超过 60s 的一律回收
			if (stopped || tooLong) {
				AL10.alSourceStop(v.source);
				AL10.alSourcei(v.source, AL10.AL_BUFFER, 0);
				FREE.push(v.source);
				it.remove();
			}
		}
	}

	/**
	 * 放音规则（M3-19）：
	 * <ul>
	 *   <li><b>同声部单音线</b>（目前是 `bass`）：新音进来 → 把同声部仍在响的音全部放掉
	 *       （实测贝斯 1054 颗在 E2 以下、956 颗间隔 &lt; 0.5s，10 秒尾巴叠起来必糊）；</li>
	 *   <li><b>同键重击</b>：同一（乐器 + 键位）再响 → 上一个放掉（同一根弦被重新敲响，物理上就是替换）。</li>
	 * </ul>
	 */
	private static void dampConflicts(String instrument, String voice, int midi, boolean hasScoreDuration) {
		long now = System.currentTimeMillis();
		// 谱面给了时值就**不再**按"低音单声部"硬掐：那颗音该响多久由演奏者决定
		// （踏板踩着的时候低音本来就会一直响，这正是要的效果）。
		boolean monophonic = !hasScoreDuration && "bass".equalsIgnoreCase(voice);
		for (Voice v : ACTIVE.values()) {
			if (v.isReleasing()) continue;
			// 同一时刻的和弦（同一 tick 派发下来的几颗音）不能互相放掉：
			// 只在"上一个音至少已经响了 60ms"时才放，否则一个三音和弦会被自己掐成单音。
			if (now - v.startMs < 60L) continue;
			boolean sameKey = v.instrument.equals(instrument) && v.midi == midi;
			boolean sameVoiceLine = monophonic && v.voice.equalsIgnoreCase(voice);
			if (!sameKey && !sameVoiceLine) continue;
			v.releaseStartMs = now;
			dampedCount++;
		}
	}

	/**
	 * 播一颗音（线程安全）。采样文件按"乐器 + midi + 力度"解析，解析不到就不播（并计数）。
	 *
	 * @param instrument 乐器 id（instruments.json 里的 id）
	 * @param voice      声部（harp/bass/…；`bass` 走单音线放音，其余保留自然衰减）
	 * @param midi       0..127
	 * @param velocity   1..127（决定力度层与增益）
	 * @param x,y,z      世界坐标（世界的音源位置；听者位置由 {@link #setListener} 同步）
	 */
	public static void play(String instrument, String voice, int midi, int velocity, int durMs,
							double x, double y, double z) {
		receivedCount++;
		if (receivedCount % 25 == 0) {
			NbforgeMod.LOGGER.info("[nbforge] 已收到 {} 条音符（引擎就绪={} 已播={} 丢弃={} 重建={}）",
				receivedCount, ready, playedCount, droppedCount, restartCount);
		}
		if (!ready) {
			droppedCount++;
			return;
		}
		// M3-30：运行时音色切换——声部覆盖表优先于谱面里写的乐器（换琴不用改数据）
		final String instId = NbforgeInstruments.resolve(instrument, voice);
		NbforgeInstruments.Instrument inst = NbforgeInstruments.get(instId);
		if (inst == null) {
			droppedCount++;
			lastError = "没有这个乐器：" + instId;
			return;
		}
		// 有音高的乐器：先把超出音域的键整八度折回来（与离线渲染同一口径）；
		// 打击乐（pitched=false）按 GM 键位原样用。
		int playMidi = inst.isPitched() ? inst.foldKey(midi) : midi;
		if (playMidi != midi) foldedCount++;
		// M3-31：短音（durMs ≤ 300ms）优先用 sta 断奏采样；没有 sta 区域时自动退回
		NbforgeInstruments.Region region = inst.pick(playMidi, velocity, durMs);
		if (region == null || region.file == null) {
			droppedCount++;
			lastError = "乐器 " + instrument + " 里没有可用区域";
			return;
		}
		float gain = NbforgeInstruments.velocityGain(velocity) * (float) Math.pow(10.0, region.gainDb / 20.0);
		float pitch = (float) region.pitchRatio(playMidi);
		TASKS.offer(new Task(() -> playNow(region.file, gain, pitch, x, y, z, instId, voice, playMidi, durMs)));
	}

	private static void playNow(String file, float gain, float pitch, double x, double y, double z,
								String instrument, String voice, int midi, int durMs) {
		int buffer = bufferFor(file);
		if (buffer == 0) return;
		dampConflicts(instrument, voice, midi, durMs > 0);
		int source;
		if (!FREE.isEmpty()) {
			source = FREE.pop();
		} else if (ACTIVE.size() < MAX_SOURCES) {
			source = AL10.alGenSources();
			if (source == 0) {
				droppedCount++;
				return;
			}
		} else {
			source = stealOldest();
			if (source == 0) {
				droppedCount++;
				return;
			}
		}
		AL10.alSourcei(source, AL10.AL_BUFFER, buffer);
		AL10.alSourcef(source, AL10.AL_GAIN, Math.max(0f, Math.min(4f, gain * masterGain)));
		AL10.alSourcef(source, AL10.AL_PITCH, Math.max(0.25f, Math.min(4f, pitch)));
		AL10.alSource3f(source, AL10.AL_POSITION, (float) x, (float) y, (float) z);
		AL10.alSourcef(source, AL10.AL_ROLLOFF_FACTOR, 0.0f);      // 不做距离衰减：琴声该整片都听得到
		AL10.alSourcei(source, AL10.AL_LOOPING, AL10.AL_FALSE);
		AL10.alSourcePlay(source);
		int err = AL10.alGetError();
		if (err != AL10.AL_NO_ERROR) {
			// 上下文失配（例如 MC 重启声音引擎之后）：标记坏掉，主循环会重建设备/上下文并重试
			broken = true;
			lastError = "alSourcePlay 错误 0x" + Integer.toHexString(err);
			FREE.push(source);
			return;
		}
		ACTIVE.put(source, new Voice(source, instrument, voice, midi,
			Math.max(0f, Math.min(4f, gain * masterGain)),
			// 有谱面时值 → 用制音器放音时长（低音弦重、放音慢）；没有 → 沿用旧的两条规则
			durMs > 0 ? damperMs(midi) : ("bass".equalsIgnoreCase(voice) ? BASS_FADE_MS : RESTRIKE_FADE_MS),
			durMs));
		if (durMs > 0) withDuration++;
		playedCount++;
		if (ACTIVE.size() > peakActive) peakActive = ACTIVE.size();
	}

	private static int stealOldest() {
		int oldest = 0;
		long best = Long.MAX_VALUE;
		for (Map.Entry<Integer, Voice> e : ACTIVE.entrySet()) {
			if (e.getValue().isReleasing()) continue;   // 已经在放音路上的优先回收，不需要"偷"
			if (e.getValue().startMs < best) {
				best = e.getValue().startMs;
				oldest = e.getKey();
			}
		}
		if (oldest == 0) return 0;
		AL10.alSourceStop(oldest);
		ACTIVE.remove(oldest);
		stolenCount++;
		return oldest;
	}

	/** 取（或解码并缓存）某个采样文件的 AL buffer；失败返回 0 */
	private static int bufferFor(String file) {
		Integer cached = BUFFERS.get(file);
		if (cached != null) return cached;
		try {
			NbforgeWav.Pcm pcm = NbforgeWav.read(Path.of(file));
			float[] samples = truncate(pcm.samples(), pcm.channels(), pcm.sampleRate());
			int format;
			ByteBuffer data;
			// 优先 float32（无损）；不支持时退 16bit（只在这一步有损）
			boolean floatOk = FLOAT_OK;
			if (pcm.channels() == 1) {
				format = floatOk ? EXTFloat32.AL_FORMAT_MONO_FLOAT32 : AL10.AL_FORMAT_MONO16;
			} else {
				format = floatOk ? EXTFloat32.AL_FORMAT_STEREO_FLOAT32 : AL10.AL_FORMAT_STEREO16;
			}
			if (floatOk) {
				data = ByteBuffer.allocateDirect(samples.length * 4).order(ByteOrder.nativeOrder());
				for (float s : samples) data.putFloat(s);
			} else {
				data = ByteBuffer.allocateDirect(samples.length * 2).order(ByteOrder.nativeOrder());
				for (float s : samples) {
					int v = Math.round(Math.max(-1f, Math.min(1f, s)) * 32767f);
					data.putShort((short) v);
				}
			}
			data.flip();
			int buffer = AL10.alGenBuffers();
			if (buffer == 0) return 0;
			AL10.alBufferData(buffer, format, data, pcm.sampleRate());
			int err = AL10.alGetError();
			if (err != AL10.AL_NO_ERROR) {
				lastError = "alBufferData 错误码 " + err + "（" + file + "）";
				AL10.alDeleteBuffers(buffer);
				return 0;
			}
			BUFFERS.put(file, buffer);
			BUFFER_BYTES.put(buffer, (long) data.capacity());
			cachedBytes += data.capacity();
			trimBuffers();
			return buffer;
		} catch (IOException | RuntimeException e) {
			lastError = "解码失败 " + file + "：" + e.getMessage();
			NbforgeMod.LOGGER.warn("[nbforge] {}", lastError);
			return 0;
		}
	}

	/** float32 能力（run() 里探测一次） */
	private static volatile boolean FLOAT_OK = false;

	/** 截到 {@link #MAX_SECONDS} 秒，并在尾部做 0.5s 淡出（避免截断爆音）。包内可见：供离线自检直接调。 */
	static float[] truncate(float[] pcm, int channels, int sampleRate) {
		int maxFrames = (int) Math.round(MAX_SECONDS * sampleRate);
		int frames = channels > 0 ? pcm.length / channels : 0;
		if (frames <= maxFrames) return pcm;
		int keep = maxFrames * channels;
		float[] out = new float[keep];
		System.arraycopy(pcm, 0, out, 0, keep);
		int fadeFrames = Math.min(maxFrames, Math.round(0.5f * sampleRate));
		int fadeStart = (maxFrames - fadeFrames) * channels;
		for (int i = fadeStart; i < keep; i++) {
			float gain = (keep - i) / (float) (keep - fadeStart);
			out[i] *= gain;
		}
		return out;
	}

	private static void trimBuffers() {
		while (cachedBytes > MAX_CACHE_BYTES && !BUFFERS.isEmpty()) {
			Iterator<Map.Entry<String, Integer>> it = BUFFERS.entrySet().iterator();
			if (!it.hasNext()) break;
			Map.Entry<String, Integer> eldest = it.next();
			it.remove();
			AL10.alDeleteBuffers(eldest.getValue());
			Long bytes = BUFFER_BYTES.remove(eldest.getValue());
			if (bytes != null) cachedBytes -= bytes;
		}
	}

	/** 听者位置/朝向（游戏线程调用；相机在哪，声场就在哪） */
	public static void setListener(double x, double y, double z,
								   float forwardX, float forwardY, float forwardZ,
								   float upX, float upY, float upZ) {
		if (!ready) return;
		TASKS.offer(new Task(() -> {
			AL10.alListener3f(AL10.AL_POSITION, (float) x, (float) y, (float) z);
			AL10.alListenerfv(AL10.AL_ORIENTATION, new float[] {forwardX, forwardY, forwardZ, upX, upY, upZ});
		}));
	}

	/** 最近一次"入队 → 执行"延迟（ms）；-1 = 还没跑过任务 */
	public static double lastTaskLatencyMs() {
		return lastTaskLatencyMs;
	}

	/** 当前排队中的任务数（>0 且持续增长说明音频线程跟不上） */
	public static int queuedTasks() {
		return TASKS.size();
	}
}
