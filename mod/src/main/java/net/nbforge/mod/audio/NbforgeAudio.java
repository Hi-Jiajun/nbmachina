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
	/** 同时发声上限（钢琴密集段实测要几十路；超了会偷最早的那个 source） */
	public static final int MAX_SOURCES = 128;
	/** 采样缓存**按字节**上限（不是按个数）：Salamander 单个采样最长 25.7s，float 立体声 ≈ 9.9MB */
	public static final long MAX_CACHE_BYTES = 512L * 1024 * 1024;
	/** 采样截断长度：钢琴 10s 之后只剩极轻的尾音，截断直接决定"能同时响多少音"与内存占用 */
	public static final double MAX_SECONDS = 10.0;

	private static final ConcurrentLinkedQueue<Runnable> TASKS = new ConcurrentLinkedQueue<>();
	private static final Map<String, Integer> BUFFERS = new LinkedHashMap<>(64, 0.75f, true);
	private static final Map<Integer, Long> BUFFER_BYTES = new HashMap<>();
	private static long cachedBytes = 0L;
	private static final Map<Integer, Long> ACTIVE = new HashMap<>();   // source -> 开始时间(ms)
	private static final ArrayDeque<Integer> FREE = new ArrayDeque<>();

	private static Thread thread;
	private static volatile boolean ready = false;
	private static volatile String lastError = null;
	private static volatile String alInfo = "（未初始化）";
	private static volatile float masterGain = 0.85f;
	private static volatile int playedCount = 0;
	private static volatile int droppedCount = 0;
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

	private static void run() {
		long device = 0L;
		long context = 0L;
		try {
			device = ALC10.alcOpenDevice((ByteBuffer) null);
			if (device == 0L) {
				lastError = "alcOpenDevice 失败（没有可用的 OpenAL 设备）";
				NbforgeMod.LOGGER.warn("[nbforge] {}", lastError);
				return;
			}
			context = ALC10.alcCreateContext(device, (IntBuffer) null);
			if (context == 0L || !ALC10.alcMakeContextCurrent(context)) {
				lastError = "alcCreateContext/alcMakeContextCurrent 失败";
				NbforgeMod.LOGGER.warn("[nbforge] {}", lastError);
				return;
			}
			ALCCapabilities alcCaps = ALC.createCapabilities(device);
			ALCapabilities caps = AL.createCapabilities(alcCaps);
			boolean floatOk = caps.AL_EXT_FLOAT32;
			FLOAT_OK = floatOk;
			alInfo = AL10.alGetString(AL10.AL_VENDOR) + " / " + AL10.alGetString(AL10.AL_RENDERER)
				+ " / " + AL10.alGetString(AL10.AL_VERSION) + " / float32=" + floatOk;
			ready = true;
			NbforgeMod.LOGGER.info("[nbforge] 音频引擎就绪：OpenAL 自有设备；float32 支持={}；上限 {} 声部 / 采样缓存 {}MB / 采样截断 {}s",
				floatOk, MAX_SOURCES, MAX_CACHE_BYTES / 1048576, (int) MAX_SECONDS);

			IntBuffer state = ByteBuffer.allocateDirect(4).order(ByteOrder.nativeOrder()).asIntBuffer();
			while (!Thread.currentThread().isInterrupted()) {
				Runnable task = TASKS.poll();
				if (task == null) {
					try {
						Thread.sleep(15L);
					} catch (InterruptedException e) {
						Thread.currentThread().interrupt();
						break;
					}
				} else {
					try {
						task.run();
					} catch (Throwable t) {
						lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
						NbforgeMod.LOGGER.warn("[nbforge] 音频任务异常：{}", lastError);
					}
				}
				recycle(state, floatOk);
			}
		} catch (Throwable t) {
			lastError = t.getClass().getSimpleName() + ": " + t.getMessage();
			NbforgeMod.LOGGER.warn("[nbforge] 音频引擎启动失败", t);
		} finally {
			ready = false;
			if (context != 0L) ALC10.alcDestroyContext(context);
			if (device != 0L) ALC10.alcCloseDevice(device);
		}
	}

	/** 回收播放结束的 source（必须在本线程调用） */
	private static void recycle(IntBuffer state, boolean floatOk) {
		if (ACTIVE.isEmpty()) return;
		Long now = System.currentTimeMillis();
		for (Iterator<Map.Entry<Integer, Long>> it = ACTIVE.entrySet().iterator(); it.hasNext(); ) {
			Map.Entry<Integer, Long> e = it.next();
			state.clear();
			AL10.alGetSourcei(e.getKey(), AL10.AL_SOURCE_STATE, state);
			boolean stopped = state.get(0) != AL10.AL_PLAYING;
			boolean tooLong = now - e.getValue() > 60_000L;   // 兜底：超过 60s 的一律回收
			if (stopped || tooLong) {
				AL10.alSourceStop(e.getKey());
				AL10.alSourcei(e.getKey(), AL10.AL_BUFFER, 0);
				FREE.push(e.getKey());
				it.remove();
			}
		}
	}

	/**
	 * 播一颗音（线程安全）。采样文件按"乐器 + midi + 力度"解析，解析不到就不播（并计数）。
	 *
	 * @param instrument 乐器 id（instruments.json 里的 id）
	 * @param midi       0..127
	 * @param velocity   1..127（决定力度层与增益）
	 * @param x,y,z      世界坐标（世界的音源位置；听者位置由 {@link #setListener} 同步）
	 */
	public static void play(String instrument, int midi, int velocity, double x, double y, double z) {
		if (!ready) {
			droppedCount++;
			return;
		}
		NbforgeInstruments.Instrument inst = NbforgeInstruments.get(instrument);
		if (inst == null) {
			droppedCount++;
			lastError = "没有这个乐器：" + instrument;
			return;
		}
		NbforgeInstruments.Region region = inst.pick(midi, velocity);
		if (region == null || region.file == null) {
			droppedCount++;
			lastError = "乐器 " + instrument + " 里没有可用区域";
			return;
		}
		float gain = NbforgeInstruments.velocityGain(velocity) * (float) Math.pow(10.0, region.gainDb / 20.0);
		float pitch = (float) region.pitchRatio(midi);
		TASKS.offer(() -> playNow(region.file, gain, pitch, x, y, z));
	}

	private static void playNow(String file, float gain, float pitch, double x, double y, double z) {
		int buffer = bufferFor(file);
		if (buffer == 0) return;
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
		ACTIVE.put(source, System.currentTimeMillis());
		playedCount++;
		if (ACTIVE.size() > peakActive) peakActive = ACTIVE.size();
	}

	private static int stealOldest() {
		int oldest = 0;
		long best = Long.MAX_VALUE;
		for (Map.Entry<Integer, Long> e : ACTIVE.entrySet()) {
			if (e.getValue() < best) {
				best = e.getValue();
				oldest = e.getKey();
			}
		}
		if (oldest == 0) return 0;
		AL10.alSourceStop(oldest);
		ACTIVE.remove(oldest);
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
		TASKS.offer(() -> {
			AL10.alListener3f(AL10.AL_POSITION, (float) x, (float) y, (float) z);
			AL10.alListenerfv(AL10.AL_ORIENTATION, new float[] {forwardX, forwardY, forwardZ, upX, upY, upZ});
		});
	}
}
