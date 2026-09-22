package net.nbmachina.mod.audio;

import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.ZoneId;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * M3-76 · **游戏内无损录音**：把机器实际播放的每一路声音，按引擎用的同一套参数
 * （采样文件 / 增益 / 音高比 / 制音器包络）做确定性混音，边混边以 **48kHz / 24bit / 立体声 WAV** 落盘，
 * 同时写一份 `.json` 锚点文件（给 ReplayMod / Flashback 对齐用）。
 *
 * <p>为什么不是"录声卡"：我们的引擎（{@link NbmachinaAudio}）走**自己的 OpenAL 设备**，
 * 系统层回环录制会经过设备重采样/限幅，而且引入设备输出延迟。这里改为**按播放事实重建混音**：
 * 引擎每起一路声部就把它交给录音器（含增益/音高/时值），放音（制音器落下）时再补一次包络 ——
 * 得到的音频就是"这一场到底弹了什么"，且**可复现**（同样的输入 → 同样的字节）。
 *
 * <p>对齐（用户要求"不用考虑复杂的时间戳对齐"）：录音**从回放录制开始那一刻**起算
 * （ReplayMod / Flashback 开始录制时会在聊天栏发一条可判别的消息，客户端 hook 到就自动开录），
 * 于是 **WAV 的 t=0 == 回放时间轴的 t=0**；ReplayMod 渲染出来的画面配这条音轨 **offset = 0**，
 * Flashback 里把音频 keyframe 放在 0 秒即可。
 *
 * <p>本类**刻意不依赖 Minecraft/Fabric**（只用 java.* + {@link NbmachinaWav}），
 * 这样可以在游戏外直接编译 + 跑自检（见 `docs/VIDEO-PIPELINE.md` §8）。
 */
public final class NbmachinaRecorder {
	/** 输出格式固定 48k/24bit/立体声：与采样同源，也是 B 站 hi-res 要求的规格 */
	public static final int SR = 48000;
	public static final int CH = 2;
	public static final int BITS = 24;
	/** 与引擎一致：单个采样播放长度上限（超过就没声音了，混音也要按这个截断） */
	private static final double MAX_SECONDS = 10.0;
	/** 混音窗口：只把"已经确定不会被改写的部分"落盘，窗口必须 ≥ 最长 durMs + 冲突放音余量 */
	private static final double MARGIN_SECONDS = 4.0;
	/** 最长录音时长（防止忘记停：90 分钟 ≈ 1.5GB WAV） */
	private static final double MAX_RECORD_SECONDS = 90 * 60;

	/** 日志出口（mod 侧接到 Fabric logger；自检时默认打到 stdout） */
	public static volatile Consumer<String> LOG = System.out::println;

	private static final Object LOCK = new Object();
	private static final List<Voice> VOICES = new ArrayList<>();
	private static final List<Object[]> QUEUE = new ArrayList<>();   // 待登记/待放音的事件

	private static boolean recording = false;
	private static Path wavPath, jsonPath;
	private static RandomAccessFile out;
	private static long startNanos, startEpochMs, startTick;
	private static long writtenFrames;      // 已落盘帧数
	private static long flushedFrames;      // 已定稿（混音完毕）帧数
	private static long peakClamped;
	private static double peakAbs;
	private static int startedVoices;
	private static String tag = "";
	private static Thread worker;
	private static long lastReplayStartEpochMs = -1L;

	private NbmachinaRecorder() {
	}

	/** 一路正在（或曾经）发声的声部，参数都来自引擎那次 alSourcePlay */
	private static final class Voice {
		final int id;
		final float[] pcm;          // 交错立体声/单声道原始样本
		final int srcCh;
		final int srcRate;
		final float gain;
		final float pitch;
		final long startFrame;      // 相对录音起点的输出帧号
		final long maxEndFrame;     // 采样截断（MAX_SECONDS）后的结束帧
		long releaseFrame;          // -1 = 还没放音（自然衰减）
		long fadeFrames;

		Voice(int id, float[] pcm, int srcCh, int srcRate, float gain, float pitch, long startFrame, long maxEndFrame) {
			this.id = id;
			this.pcm = pcm;
			this.srcCh = srcCh;
			this.srcRate = srcRate;
			this.gain = gain;
			this.pitch = pitch;
			this.startFrame = startFrame;
			this.maxEndFrame = maxEndFrame;
			this.releaseFrame = -1L;
			this.fadeFrames = 0L;
		}
	}

	public static boolean recording() {
		return recording;
	}

	public static Path wavPath() {
		return wavPath;
	}

	/** 回放录制开始时刻（epoch ms）；用于把音轨与回放轴对齐 */
	public static long replayStartEpochMs() {
		return lastReplayStartEpochMs;
	}

	public static String status() {
		synchronized (LOCK) {
			if (!recording) {
				return "未录音" + (wavPath != null ? "（上一次：" + wavPath.getFileName() + "）" : "");
			}
			double sec = elapsedSeconds();
			return String.format("录音中 %.1fs / 声部 %d 路 / 峰值 %.3f / 削顶 %d 帧 → %s",
				sec, VOICES.size(), peakAbs, peakClamped, wavPath.getFileName());
		}
	}

	/** 当前录音长度（秒） */
	private static double elapsedSeconds() {
		return recording ? (System.nanoTime() - startNanos) / 1e9 : 0.0;
	}

	/**
	 * 开始录音。文件写到 `dir/<时间戳>[-tag].wav`。
	 *
	 * @param tick 当前游戏刻（写进 json，便于和回放轴核账）
	 */
	public static synchronized String start(Path dir, String tagIn, long tick) {
		if (recording) return "已经在录音：" + wavPath.getFileName();
		try {
			Files.createDirectories(dir);
			tag = tagIn == null ? "" : tagIn.replaceAll("[^A-Za-z0-9._-]", "");
			String stamp = DateTimeFormatter.ofPattern("yyyyMMdd-HHmmss").withZone(ZoneId.systemDefault())
				.format(Instant.now());
			String base = "nbm-" + stamp + (tag.isEmpty() ? "" : "-" + tag);
			wavPath = dir.resolve(base + ".wav");
			jsonPath = dir.resolve(base + ".json");
			out = new RandomAccessFile(wavPath.toFile(), "rw");
			out.setLength(0);
			out.write(wavHeader(0));
			synchronized (LOCK) {
				VOICES.clear();
				QUEUE.clear();
				writtenFrames = 0;
				flushedFrames = 0;
				peakClamped = 0;
				peakAbs = 0;
				startedVoices = 0;
			}
			startNanos = System.nanoTime();
			startEpochMs = System.currentTimeMillis();
			startTick = tick;
			recording = true;
			worker = new Thread(NbmachinaRecorder::loop, "nbmachina-recorder");
			worker.setDaemon(true);
			worker.start();
			LOG.accept("[nbmachina] 无损录音开始：48kHz/24bit 立体声 → " + wavPath);
			return null;
		} catch (IOException e) {
			recording = false;
			return "录音启动失败：" + e;
		}
	}

	/** 停止录音：把剩下的帧混完、补齐 WAV 头、写 json。返回一句话结果 */
	public static synchronized String stop() {
		if (!recording) return "没有在录音";
		recording = false;
		try {
			if (worker != null) worker.join(5000);
		} catch (InterruptedException ignored) {
			Thread.currentThread().interrupt();
		}
		return finalizeAndClose();
	}

	/** 收尾：混完剩余帧、回填 WAV 头、写 json（stop() 与"超时自动停"共用一个出口） */
	private static synchronized String finalizeAndClose() {
		try {
			drainQueue();      // 最后 100ms 里引擎才交过来的声部也要算进去
			flushTo(elapsedFramesNow());
		} catch (IOException e) {
			LOG.accept("[nbmachina] 收尾混音失败：" + e);
		}
		try {
			long frames = writtenFrames;
			out.seek(0);
			out.write(wavHeader(frames));
			out.close();
			out = null;
			writeSidecar(frames);
			LOG.accept(String.format("[nbmachina] 无损录音结束：%.2fs / 峰值 %.3f / 削顶 %d → %s",
				frames / (double) SR, peakAbs, peakClamped, wavPath));
			return String.format("已保存 %s（%.2fs，峰值 %.3f%s）", wavPath.getFileName(), frames / (double) SR,
				peakAbs, peakClamped > 0 ? "，有 " + peakClamped + " 帧削顶" : "");
		} catch (IOException e) {
			return "写文件失败：" + e;
		}
	}

	/**
	 * 引擎每起一路声部就调一次（音频线程）。
	 *
	 * @param id    声部句柄（= OpenAL source id，放音时要按它回填）
	 * @param wav   采样文件
	 * @param gain  引擎实际用的增益（已含 masterGain）
	 * @param pitch 音高比（AL_PITCH）
	 * @param durMs 谱面时值（0 = 没有，靠冲突/自然衰减）
	 * @param midi  播放键位（决定制音器时长）
	 */
	public static void onVoiceStart(int id, Path wav, float gain, float pitch, int durMs, int midi) {
		if (!recording || wav == null) return;
		// ⚠ 时间戳必须**在这里取**（引擎起播的那一刻），不能等录音线程轮询到才取 —— 不然最多会晚 100ms，
		// 混出来的音就和画面错开（自检实测过：延迟取时间戳会让每一路音都漂 0~100ms）。
		synchronized (LOCK) {
			QUEUE.add(new Object[]{ 0, id, wav, gain, pitch, durMs, midi, System.nanoTime() });
		}
	}

	/** 引擎进入放音（制音器落下 / 同键重击 / 低音单音线抢音）时调一次 */
	public static void onVoiceRelease(int id, long fadeMs) {
		if (!recording) return;
		synchronized (LOCK) {
			QUEUE.add(new Object[]{ 1, id, fadeMs, System.nanoTime() });
		}
	}

	/** 聊天栏消息里若是"回放开始录制"，自动开录并记住时刻（ReplayMod / Flashback 都认） */
	public static void onChatKey(String translatableKey, String plainText, long tick, Path dir) {
		if (translatableKey == null) return;
		String key = translatableKey.toLowerCase();
		boolean replayStart = key.equals("replaymod.chat.recordingstarted") || key.contains("flashback.recording_started")
			|| (plainText != null && plainText.equalsIgnoreCase("Recording started"));
		boolean replayStop = key.equals("replaymod.chat.recordingstopped") || key.contains("flashback.recording_stopped");
		if (replayStart) {
			lastReplayStartEpochMs = System.currentTimeMillis();
			if (!recording) start(dir, "replay", tick);
			else LOG.accept("[nbmachina] 回放开始录制：但已经在录音，沿用当前文件（t=0 以更早那次为准）");
		} else if (replayStop && recording) {
			stop();
		}
	}

	/* ---------------- 内部：混音 + 落盘 ---------------- */

	private static long elapsedFramesNow() {
		return (long) ((System.nanoTime() - startNanos) / 1e9 * SR);
	}

	private static void loop() {
		while (recording) {
			try {
				drainQueue();
				flushTo(elapsedFramesNow() - (long) (MARGIN_SECONDS * SR));
				if (elapsedSeconds() > MAX_RECORD_SECONDS) {
					LOG.accept("[nbmachina] 录音超过 90 分钟，自动停止");
					recording = false;
					finalizeAndClose();
					return;
				}
			} catch (Exception e) {
				LOG.accept("[nbmachina] 录音线程异常（继续）：" + e);
			}
			try {
				Thread.sleep(40L);
			} catch (InterruptedException e) {
				Thread.currentThread().interrupt();
				return;
			}
		}
	}

	/** 把引擎事件变成录音器里的声部 */
	private static void drainQueue() {
		while (true) {
			Object[] ev;
			synchronized (LOCK) {
				if (QUEUE.isEmpty()) return;
				ev = QUEUE.remove(0);
			}
			if (((Integer) ev[0]) == 0) {
				int id = (Integer) ev[1];
				Path wav = (Path) ev[2];
				float gain = (Float) ev[3];
				float pitch = (Float) ev[4];
				int durMs = (Integer) ev[5];
				int midi = (Integer) ev[6];
				long stampNanos = (Long) ev[7];
				NbmachinaWav.Pcm pcm;
				try {
					pcm = NbmachinaWav.read(wav);
				} catch (IOException e) {
					LOG.accept("[nbmachina] 录音读采样失败：" + wav + " → " + e);
					continue;
				}
				long startFrame = (long) ((stampNanos - startNanos) / 1e9 * SR);
				long maxFrames = Math.min(pcm.samples().length / Math.max(1, pcm.channels()),
					(long) (MAX_SECONDS * SR));
				Voice v = new Voice(id, pcm.samples(), pcm.channels(), pcm.sampleRate(), gain, pitch,
					startFrame, startFrame + maxFrames);
				// 谱面给了时值 → 制音器时刻是确定的，可以提前写死；没有时值就等冲突放音事件
				if (durMs > 0) {
					v.releaseFrame = startFrame + (long) (durMs / 1000.0 * SR);
					v.fadeFrames = Math.max(1L, damperMs(midi) * SR / 1000L);
				}
				synchronized (LOCK) {
					VOICES.add(v);
					startedVoices++;
				}
			} else {
				int id = (Integer) ev[1];
				long fadeMs = (Long) ev[2];
				long now = (long) (((Long) ev[3] - startNanos) / 1e9 * SR);
				synchronized (LOCK) {
					for (Voice v : VOICES) {
						if (v.id == id && v.releaseFrame < 0) {
							v.releaseFrame = now;
							v.fadeFrames = Math.max(1L, fadeMs * SR / 1000L);
						}
					}
				}
			}
		}
	}

	/** 制音器放音时长（与引擎 {@code NbmachinaAudio.damperMs} 同一口径） */
	static long damperMs(int midi) {
		return midi >= 60 ? 140L : midi >= 45 ? 200L : 300L;
	}

	/** 把 [flushedFrames, target) 这段混出来写盘；窗口外的声部顺手回收 */
	private static void flushTo(long target) throws IOException {
		if (out == null) return;
		long block = SR;   // 1 秒一块
		while (flushedFrames < target) {
			long to = Math.min(flushedFrames + block, target);
			int n = (int) (to - flushedFrames);
			float[] mix = new float[n * CH];
			synchronized (LOCK) {
				List<Voice> keep = new ArrayList<>(VOICES.size());
				for (Voice v : VOICES) {
					long end = effectiveEndOf(v);
					if (end <= flushedFrames) continue;           // 已经播完，回收
					if (v.startFrame >= to) {                     // 还没到它的戏
						keep.add(v);
						continue;
					}
					mixVoice(v, flushedFrames, to, mix);
					keep.add(v);                                  // 可能还有尾巴留在后面几块
				}
				VOICES.clear();
				VOICES.addAll(keep);
			}
			writeFrames(mix, n);
			flushedFrames = to;
		}
	}

	private static void mixVoice(Voice v, long from, long to, float[] mix) {
		long begin = Math.max(from, v.startFrame);
		long end = Math.min(to, effectiveEndOf(v));
		if (begin >= end) return;
		int srcFrames = v.pcm.length / Math.max(1, v.srcCh);
		double step = v.pitch * (v.srcRate / (double) SR);
		for (long f = begin; f < end; f++) {
			long rel = f - v.startFrame;
			double srcPos = rel * step;
			int i0 = (int) srcPos;
			if (i0 >= srcFrames) break;
			int i1 = Math.min(i0 + 1, srcFrames - 1);
			float frac = (float) (srcPos - i0);
			float env = 1f;
			if (v.releaseFrame >= 0 && f >= v.releaseFrame) {
				long d = f - v.releaseFrame;
				if (d >= v.fadeFrames) break;
				env = 1f - d / (float) v.fadeFrames;
			}
			float g = v.gain * env;
			int o = (int) ((f - from) * CH);
			for (int c = 0; c < CH; c++) {
				int sc = Math.min(c, v.srcCh - 1);
				float a = v.pcm[i0 * v.srcCh + sc];
				float b = v.pcm[i1 * v.srcCh + sc];
				mix[o + c] += (a + (b - a) * frac) * g;
			}
		}
	}

	/** 定稿长度：放音就按放音点算，否则按采样截断 */
	private static long effectiveEndOf(Voice v) {
		return v.releaseFrame >= 0 ? Math.min(v.maxEndFrame, v.releaseFrame + v.fadeFrames) : v.maxEndFrame;
	}

	private static void writeFrames(float[] mix, int frames) throws IOException {
		byte[] buf = new byte[frames * CH * 3];
		int p = 0;
		for (int i = 0; i < frames * CH; i++) {
			float s = mix[i];
			double a = Math.abs(s);
			if (a > peakAbs) peakAbs = a;
			if (s > 1f || s < -1f) {
				peakClamped++;
				s = Math.max(-1f, Math.min(1f, s));
			}
			int v = Math.round(s * 8388607f);
			buf[p++] = (byte) (v & 0xFF);
			buf[p++] = (byte) ((v >> 8) & 0xFF);
			buf[p++] = (byte) ((v >> 16) & 0xFF);
		}
		out.seek(44L + writtenFrames * CH * 3L);
		out.write(buf);
		writtenFrames += frames;
	}

	/** 标准 44 字节 WAV 头（24bit PCM）；先写 size=0，收尾时按真实长度回填 */
	private static byte[] wavHeader(long frames) {
		long dataBytes = frames * CH * 3;
		byte[] h = new byte[44];
		writeAscii(h, 0, "RIFF");
		writeInt(h, 4, (int) Math.min(Integer.MAX_VALUE, 36 + dataBytes));
		writeAscii(h, 8, "WAVEfmt ");
		writeInt(h, 16, 16);
		writeShort(h, 20, 1);
		writeShort(h, 22, CH);
		writeInt(h, 24, SR);
		writeInt(h, 28, SR * CH * 3);
		writeShort(h, 32, CH * 3);
		writeShort(h, 34, BITS);
		writeAscii(h, 36, "data");
		writeInt(h, 40, (int) Math.min(Integer.MAX_VALUE, dataBytes));
		return h;
	}

	private static void writeAscii(byte[] h, int off, String s) {
		for (int i = 0; i < s.length(); i++) h[off + i] = (byte) s.charAt(i);
	}

	private static void writeInt(byte[] h, int off, int v) {
		h[off] = (byte) (v & 0xFF);
		h[off + 1] = (byte) ((v >> 8) & 0xFF);
		h[off + 2] = (byte) ((v >> 16) & 0xFF);
		h[off + 3] = (byte) ((v >> 24) & 0xFF);
	}

	private static void writeShort(byte[] h, int off, int v) {
		h[off] = (byte) (v & 0xFF);
		h[off + 1] = (byte) ((v >> 8) & 0xFF);
	}

	/** 锚点文件：给 tools/mux-video.mjs --report 和 Flashback 手动对齐用 */
	private static void writeSidecar(long frames) throws IOException {
		// 手写 JSON：本类刻意不引 Gson，脱离游戏也能直接 javac 编译 + 跑自检
		StringBuilder b = new StringBuilder();
		b.append("{\n");
		b.append("  \"_comment\": \"nbmachina 游戏内无损录音锚点：WAV 的 t=0 == 回放录制开始的 t=0（offset 直接用 0）\",\n");
		b.append("  \"audio\": \"").append(wavPath.getFileName()).append("\",\n");
		b.append("  \"sampleRate\": ").append(SR).append(",\n");
		b.append("  \"bitsPerSample\": ").append(BITS).append(",\n");
		b.append("  \"channels\": ").append(CH).append(",\n");
		b.append("  \"frames\": ").append(frames).append(",\n");
		b.append("  \"durationSec\": ").append(String.format("%.3f", frames / (double) SR)).append(",\n");
		b.append("  \"recordStartEpochMs\": ").append(startEpochMs).append(",\n");
		b.append("  \"recordStartTick\": ").append(startTick).append(",\n");
		b.append("  \"replayRecordingStartEpochMs\": ").append(lastReplayStartEpochMs).append(",\n");
		b.append("  \"replayOffsetSec\": ")
			.append(String.format("%.3f", lastReplayStartEpochMs > 0 ? (startEpochMs - lastReplayStartEpochMs) / 1000.0 : 0.0)).append(",\n");
		b.append("  \"startedVoices\": ").append(startedVoices).append(",\n");
		b.append("  \"peak\": ").append(String.format("%.4f", peakAbs)).append(",\n");
		b.append("  \"clampedFrames\": ").append(peakClamped).append("\n");
		b.append("}\n");
		Files.writeString(jsonPath, b.toString(), StandardCharsets.UTF_8);
	}
}
