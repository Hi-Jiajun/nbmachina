package net.nbmachina.mod.audio;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;
import net.nbmachina.mod.NbmachinaMod;

import java.lang.reflect.Proxy;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;

/**
 * M5-41 · **把无损音轨直接混进 Flashback 的导出成片**。
 *
 * <p>为什么不能靠 Flashback 自己的音频通路（2026-09-25 取证）：`Record Audio` 抓的是原版
 * SoundEngine 设备上的 `SOFTLoopback.alcRenderSamplesSOFT`，而 nbmachina 的引擎走**自有 OpenAL 设备**
 * （{@link NbmachinaAudio}，M3-16）——mod 播的实时音、以及挂在回放里的音频轨，都不会进成片。
 * 实测 `StyxHelix.mkv`：音轨是 pcm_s24le 48k/2ch，但逐样本为 0（`volumedetect` 报 -91 dB）。
 *
 * <p>这里改走 Flashback 的导出音频桥（本地补丁 `exporting/NbmAudioBridge`，纯反射注册，没装/没打补丁
 * 就静默跳过）：**每导出一帧**，Flashback 问我们要这一帧时间轴上的样本，我们直接读无损 WAV 写进去。
 * 好处：不经过任何设备/回环/编码，剪辑裁剪与变速也自动跟随（因为是按导出时间轴取的样本）。
 *
 * <p>配置：`&lt;游戏目录&gt;/nbmachina/export_audio.json`
 * <pre>{ "enabled": true, "audio": "D:/.../styx_master_v2_48k24bit.wav", "offsetSec": 3.3458, "gain": 1.0 }</pre>
 * 其中 `offsetSec` = **音乐第 0 秒落在回放时间轴的第几秒**（工具 `tools/nbm-export-audio.mjs` 会扫回放
 * 里的 nbmachina payload 自动算出来，不用手量）。
 */
public final class NbmExportAudio {
	private static final String BRIDGE_CLASS = "com.moulberry.flashback.exporting.NbmAudioBridge";

	/** 立体声交错样本（48k） */
	private static volatile float[] samples;
	private static volatile int srcRate = 48000;
	private static volatile double offsetSec = 0.0;
	private static volatile float gain = 1.0f;
	private static volatile String audioPath = null;
	private static volatile String status = "未配置（缺 export_audio.json）";

	private NbmExportAudio() {
	}

	public static Path configPath() {
		return FabricLoader.getInstance().getGameDir().resolve("nbmachina").resolve("export_audio.json");
	}

	public static String status() {
		return status;
	}

	/** 反射注册桥的 Provider；Flashback 没装/没打补丁时返回 false（什么都不做） */
	public static boolean register() {
		try {
			Class<?> bridge = Class.forName(BRIDGE_CLASS);
			Class<?> provider = Class.forName(BRIDGE_CLASS + "$Provider");
			Object proxy = Proxy.newProxyInstance(NbmExportAudio.class.getClassLoader(), new Class<?>[]{provider},
				(proxyObj, method, args) -> {
					switch (method.getName()) {
						case "fillAudio":
							fill((FloatBuffer) args[0], (Integer) args[1], (Integer) args[2],
								(Double) args[3], (Integer) args[4]);
							return null;
						case "toString":
							return "NbmExportAudio.Provider";
						case "hashCode":
							return System.identityHashCode(proxyObj);
						case "equals":
							return proxyObj == args[0];
						default:
							return null;
					}
				});
			bridge.getMethod("register", provider).invoke(null, proxy);
			NbmachinaMod.LOGGER.info("[nbmachina] 导出音频桥已注册（{}）", status);
			reload();
			return true;
		} catch (ClassNotFoundException e) {
			NbmachinaMod.LOGGER.info("[nbmachina] Flashback 导出音频桥不存在（未装 Flashback 补丁版）——导出音轨走原样");
			return false;
		} catch (Throwable t) {
			NbmachinaMod.LOGGER.warn("[nbmachina] 导出音频桥注册失败：{}", t.toString());
			return false;
		}
	}

	/** 读 `export_audio.json` 并把 WAV 载进内存（导出要用时才会真的占内存） */
	public static void reload() {
		Path cfg = configPath();
		if (!Files.isRegularFile(cfg)) {
			samples = null;
			status = "未配置（缺 " + cfg + "）";
			return;
		}
		try {
			JsonObject json = JsonParser.parseString(Files.readString(cfg, StandardCharsets.UTF_8)).getAsJsonObject();
			boolean enabled = !json.has("enabled") || json.get("enabled").getAsBoolean();
			if (!enabled) {
				samples = null;
				status = "已停用（export_audio.json 里 enabled=false）";
				return;
			}
			String audio = json.get("audio").getAsString();
			double offset = json.has("offsetSec") ? json.get("offsetSec").getAsDouble() : 0.0;
			float g = json.has("gain") ? json.get("gain").getAsFloat() : 1.0f;
			Path wav = Path.of(audio);
			if (!Files.isRegularFile(wav)) {
				samples = null;
				status = "音轨文件不存在：" + audio;
				return;
			}
			float[] loaded = readWav(wav);
			samples = loaded;
			srcRate = lastReadRate;
			offsetSec = offset;
			gain = g;
			audioPath = audio;
			status = String.format("%s（%.1fs / %dHz / offset %.3fs / gain %.2f）",
				wav.getFileName(), loaded.length / 2.0 / srcRate, srcRate, offset, g);
			NbmachinaMod.LOGGER.info("[nbmachina] 导出音轨已就绪：{}", status);
		} catch (Throwable t) {
			samples = null;
			status = "读取失败：" + t;
			NbmachinaMod.LOGGER.warn("[nbmachina] 导出音轨读取失败：{}", t.toString());
		}
	}

	/** 每帧回调：把这一帧时间轴上的样本**叠加**进 Flashback 的缓冲 */
	private static void fill(FloatBuffer dst, int frames, int channels, double startSeconds, int sampleRate) {
		float[] src = samples;
		if (src == null || frames <= 0) {
			return;
		}
		int srcFrames = src.length / 2;
		double pos = (startSeconds - offsetSec) * srcRate;
		double step = (double) srcRate / Math.max(1, sampleRate);
		float g = gain;
		int base = 0;
		for (int i = 0; i < frames; i++, base += channels) {
			int i0 = (int) Math.floor(pos);
			float l = 0.0f, r = 0.0f;
			if (i0 >= -1 && i0 < srcFrames) {
				double frac = pos - i0;
				int a = Math.max(0, i0);
				int b = Math.min(srcFrames - 1, i0 + 1);
				float la = src[a * 2], ra = src[a * 2 + 1];
				float lb = src[b * 2], rb = src[b * 2 + 1];
				if (i0 < 0) {
					la = 0.0f;
					ra = 0.0f;
				}
				l = (float) (la + (lb - la) * frac);
				r = (float) (ra + (rb - ra) * frac);
			}
			if (channels >= 2) {
				dst.put(base, dst.get(base) + l * g);
				dst.put(base + 1, dst.get(base + 1) + r * g);
			} else {
				dst.put(base, dst.get(base) + (l + r) * 0.5f * g);
			}
			pos += step;
		}
	}

	private static volatile int lastReadRate = 48000;

	/**
	 * 极简 WAV 读取：支持 PCM 16/24/32 与 IEEE float32/64、单/双声道。
	 * 输出统一成 **立体声交错 float**（mono 复制成两声道）。
	 */
	private static float[] readWav(Path file) throws Exception {
		byte[] bytes = Files.readAllBytes(file);
		if (bytes.length < 44 || bytes[0] != 'R' || bytes[1] != 'I' || bytes[2] != 'F' || bytes[3] != 'F') {
			throw new IllegalArgumentException("不是 RIFF/WAVE 文件");
		}
		int pos = 12;
		int format = 1;
		int channels = 2;
		int rate = 48000;
		int bits = 16;
		int dataOffset = -1;
		int dataLength = 0;
		while (pos + 8 <= bytes.length) {
			String id = new String(bytes, pos, 4, StandardCharsets.US_ASCII);
			int size = le32(bytes, pos + 4);
			int body = pos + 8;
			if (id.equals("fmt ")) {
				format = le16(bytes, body);
				channels = Math.max(1, le16(bytes, body + 2));
				rate = le32(bytes, body + 4);
				bits = le16(bytes, body + 14);
				if (format == 0xFFFE && size >= 40) {
					format = le16(bytes, body + 24);   // WAVE_FORMAT_EXTENSIBLE 的子格式
				}
			} else if (id.equals("data")) {
				dataOffset = body;
				dataLength = Math.min(size, bytes.length - body);
			}
			pos = body + size + (size & 1);
		}
		if (dataOffset < 0) {
			throw new IllegalArgumentException("WAV 没有 data 块");
		}
		int frameBytes = Math.max(1, channels) * Math.max(8, bits) / 8;
		int srcFrames = dataLength / frameBytes;
		float[] out = new float[srcFrames * 2];
		for (int i = 0; i < srcFrames; i++) {
			int o = dataOffset + i * frameBytes;
			float l, r;
			if (format == 3) {
				if (bits == 32) {
					l = Float.intBitsToFloat(le32(bytes, o));
					r = channels > 1 ? Float.intBitsToFloat(le32(bytes, o + 4)) : l;
				} else {
					l = (float) Double.longBitsToDouble(le64(bytes, o));
					r = channels > 1 ? (float) Double.longBitsToDouble(le64(bytes, o + 8)) : l;
				}
			} else if (bits == 24) {
				l = (float) le24s(bytes, o) / 8388608.0f;
				r = channels > 1 ? (float) le24s(bytes, o + 3) / 8388608.0f : l;
			} else if (bits == 32) {
				l = le32s(bytes, o) / 2147483648.0f;
				r = channels > 1 ? le32s(bytes, o + 4) / 2147483648.0f : l;
			} else {
				l = le16s(bytes, o) / 32768.0f;
				r = channels > 1 ? le16s(bytes, o + 2) / 32768.0f : l;
			}
			out[i * 2] = clamp(l);
			out[i * 2 + 1] = clamp(r);
		}
		lastReadRate = rate;
		return out;
	}

	private static float clamp(float v) {
		return v < -1.0f ? -1.0f : (v > 1.0f ? 1.0f : v);
	}

	private static int le16(byte[] b, int o) {
		return (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8);
	}

	private static int le16s(byte[] b, int o) {
		return (short) le16(b, o);
	}

	private static int le32(byte[] b, int o) {
		return (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8) | ((b[o + 2] & 0xFF) << 16) | ((b[o + 3] & 0xFF) << 24);
	}

	private static int le32s(byte[] b, int o) {
		return le32(b, o);
	}

	private static int le24s(byte[] b, int o) {
		int v = (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8) | ((b[o + 2] & 0xFF) << 16);
		if ((v & 0x800000) != 0) {
			v |= 0xFF000000;
		}
		return v;
	}

	private static long le64(byte[] b, int o) {
		long v = 0;
		for (int i = 7; i >= 0; i--) {
			v = (v << 8) | (b[o + i] & 0xFFL);
		}
		return v;
	}
}
