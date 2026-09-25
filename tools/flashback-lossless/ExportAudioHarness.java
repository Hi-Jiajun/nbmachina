import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * M5-41 离线自检：把 mod 里的导出音轨混音逻辑（NbmExportAudio.readWav / fill）单独拎出来跑，
 * 和 WAV 原始字节逐样本对账 —— 证明"导出时混进去的 == 母版本身的样本"，不经过任何设备/重采样。
 *
 * 用法：java -cp <nbmachina.jar>;<classes> ExportAudioHarness <wav> <offsetSec>
 */
public class ExportAudioHarness {
	public static void main(String[] args) throws Exception {
		Path wav = Path.of(args[0]);
		double offset = Double.parseDouble(args[1]);

		Class<?> c = Class.forName("net.nbmachina.mod.audio.NbmExportAudio");
		Method readWav = c.getDeclaredMethod("readWav", Path.class);
		readWav.setAccessible(true);
		long t0 = System.nanoTime();
		float[] samples = (float[]) readWav.invoke(null, wav);
		double loadMs = (System.nanoTime() - t0) / 1e6;
		System.out.printf("readWav: %d 帧（%.2fs）  载入 %.0f ms%n", samples.length / 2, samples.length / 2.0 / 48000.0, loadMs);

		set(c, "samples", samples);
		set(c, "srcRate", 48000);
		set(c, "offsetSec", offset);
		set(c, "gain", 1.0f);

		Method fill = c.getDeclaredMethod("fill", FloatBuffer.class, int.class, int.class, double.class, int.class);
		fill.setAccessible(true);

		// 原始字节：作为对账基准（PCM 24-bit little-endian 立体声）
		byte[] raw = Files.readAllBytes(wav);
		int dataOffset = findData(raw);

		check(fill, samples, raw, dataOffset, offset, 0.50, "前奏静音段（母版 0.5s）");
		check(fill, samples, raw, dataOffset, offset, 3.95, "第一颗音（母版 3.95s）");
		check(fill, samples, raw, dataOffset, offset, 120.25, "中段（母版 120.25s）");
		check(fill, samples, raw, dataOffset, offset, 283.90, "末和弦（母版 283.90s）");
		check(fill, samples, raw, dataOffset, offset, 297.5, "片尾静音（母版 297.5s）");
	}

	private static void check(Method fill, float[] samples, byte[] raw, int dataOffset, double offset,
							  double wavSeconds, String label) throws Exception {
		// 导出时间轴上的起点：wavSeconds + offset
		double startSeconds = wavSeconds + offset;
		int frames = 4800;                                   // 0.1s
		FloatBuffer dst = ByteBuffer.allocateDirect(frames * 2 * 4).order(ByteOrder.nativeOrder()).asFloatBuffer();
		fill.invoke(null, dst, frames, 2, startSeconds, 48000);

		double maxErr = 0.0, peak = 0.0, refPeak = 0.0;
		for (int i = 0; i < frames; i++) {
			long frame = Math.round(wavSeconds * 48000.0) + i;
			for (int ch = 0; ch < 2; ch++) {
				float got = dst.get(i * 2 + ch);
				float ref = raw24(raw, dataOffset, frame, ch);
				maxErr = Math.max(maxErr, Math.abs(got - ref));
				peak = Math.max(peak, Math.abs(got));
				refPeak = Math.max(refPeak, Math.abs(ref));
			}
		}
		System.out.printf("  %-22s 峰值 %.4f（参考 %.4f）  最大误差 %.2e %s%n",
			label, peak, refPeak, maxErr, maxErr <= 1e-6 ? "✅ 逐样本一致" : (maxErr < 1e-4 ? "✅ 在量化误差内" : "❌ 不一致"));
	}

	private static float raw24(byte[] b, int dataOffset, long frame, int ch) {
		int o = dataOffset + (int) (frame * 6 + ch * 3);
		if (o < 0 || o + 3 > b.length) {
			return 0.0f;
		}
		int v = (b[o] & 0xFF) | ((b[o + 1] & 0xFF) << 8) | ((b[o + 2] & 0xFF) << 16);
		if ((v & 0x800000) != 0) {
			v |= 0xFF000000;
		}
		return v / 8388608.0f;
	}

	private static int findData(byte[] b) {
		int p = 12;
		while (p + 8 <= b.length) {
			String id = new String(b, p, 4);
			int size = (b[p + 4] & 0xFF) | ((b[p + 5] & 0xFF) << 8) | ((b[p + 6] & 0xFF) << 16) | ((b[p + 7] & 0xFF) << 24);
			if (id.equals("data")) {
				return p + 8;
			}
			p += 8 + size + (size & 1);
		}
		throw new IllegalStateException("no data chunk");
	}

	private static void set(Class<?> c, String name, Object value) throws Exception {
		Field f = c.getDeclaredField(name);
		f.setAccessible(true);
		f.set(null, value);
	}
}
