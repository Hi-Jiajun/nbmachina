import org.bytedeco.javacv.FFmpegFrameRecorder;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;

import static org.bytedeco.ffmpeg.global.avcodec.AV_CODEC_ID_FLAC;
import static org.bytedeco.ffmpeg.global.avutil.AV_SAMPLE_FMT_S32;

/**
 * JavaCV + FLAC at 192 kHz failed with swr_convert(-5984) while every other lossless codec worked.
 * This probes whether the per-call sample count is what trips it.
 */
public class Flac192Probe {

    public static void main(String[] args) throws Exception {
        File dir = new File(args[0]);
        for (int chunk : new int[]{ 3200, 2048, 1600, 1024, 512 }) {
            File file = new File(dir, "probe_flac192_chunk" + chunk + ".mkv");
            try {
                write(file, chunk);
                System.out.printf("chunk %-5d OK   (%d bytes)%n", chunk, file.length());
            } catch (Throwable t) {
                System.out.printf("chunk %-5d FAIL %s%n", chunk, String.valueOf(t).split("\n")[0]);
            }
        }
    }

    private static void write(File file, int chunk) throws Exception {
        try (FFmpegFrameRecorder recorder = new FFmpegFrameRecorder(file, 2)) {
            recorder.setFormat("matroska");
            recorder.setAudioCodec(AV_CODEC_ID_FLAC);
            recorder.setSampleFormat(AV_SAMPLE_FMT_S32);
            recorder.setSampleRate(192000);
            recorder.setAudioBitrate(256000);
            recorder.start();

            FloatBuffer buffer = ByteBuffer.allocateDirect(chunk * 4 * 2).order(ByteOrder.nativeOrder()).asFloatBuffer();
            int total = 192000 * 2; // two seconds
            for (int written = 0; written < total; written += chunk) {
                int n = Math.min(chunk, total - written);
                buffer.clear();
                for (int i = 0; i < n; i++) {
                    float v = (float) Math.sin(2 * Math.PI * 440 * (written + i) / 192000.0) * 0.5f;
                    buffer.put(v).put(v);
                }
                buffer.flip();
                recorder.recordSamples(buffer);
            }
            recorder.stop();
        }
    }
}
