import com.moulberry.flashback.combo_options.AudioCodec;
import com.moulberry.flashback.combo_options.VideoContainer;
import org.bytedeco.javacv.FFmpegFrameRecorder;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.FloatBuffer;
import java.util.Arrays;

import static org.bytedeco.ffmpeg.global.avcodec.AV_CODEC_ID_FLAC;
import static org.bytedeco.ffmpeg.global.avutil.AV_SAMPLE_FMT_FLTP;

/**
 * Head-less check of the patched Flashback audio path (no Minecraft needed).
 *
 * 1. prints which audio codecs the export window will offer for every container
 * 2. control run: the unpatched combination (fltp + FLAC) must fail - that is the upstream bug
 * 3. encodes a known stereo signal with every lossless codec using the patched sample-format table
 *    and leaves the files for ffmpeg to decode and compare against the source samples
 */
public class AudioCodecHarness {

    private static final int SAMPLE_RATE = 48000;
    private static final int CHANNELS = 2;
    private static final int SECONDS = 2;

    public static void main(String[] args) throws Exception {
        File outDir = new File(args[0]);
        if (!outDir.isDirectory() && !outDir.mkdirs()) {
            throw new IllegalStateException("cannot create " + outDir);
        }

        System.out.println("== containers -> audio codecs offered in the export window ==");
        for (VideoContainer container : VideoContainer.values()) {
            System.out.printf("   %-14s %s%n", container.text(),
                    Arrays.toString(Arrays.stream(container.getSupportedAudioCodecs()).map(AudioCodec::text).toArray()));
        }

        System.out.println();
        System.out.println("== control: upstream hard-coded fltp + FLAC ==");
        try {
            encode(new File(outDir, "control_flac_fltp.mkv"), "matroska", AV_CODEC_ID_FLAC, AV_SAMPLE_FMT_FLTP, 2);
            System.out.println("   UNEXPECTED: fltp+FLAC succeeded (the upstream bug would not reproduce)");
        } catch (Throwable t) {
            System.out.println("   failed as expected: " + t);
        }

        System.out.println();
        System.out.println("== patched: lossless codecs with AudioCodec.sampleFormat() ==");
        for (AudioCodec codec : AudioCodec.values()) {
            if (!isLossless(codec)) {
                continue;
            }
            String container = codec == AudioCodec.ALAC ? "ipod" : "matroska";
            String extension = codec == AudioCodec.ALAC ? "m4a" : "mkv";
            File file = new File(outDir, codec.name().toLowerCase() + "." + extension);
            try {
                encode(file, container, codec.codecId(), codec.sampleFormat(), 2);
                System.out.printf("   %-10s sampleFormat=%-3d -> %s (%d bytes)%n",
                        codec.text(), codec.sampleFormat(), file.getName(), file.length());
            } catch (Throwable t) {
                System.out.printf("   %-10s sampleFormat=%-3d -> FAILED: %s%n", codec.text(), codec.sampleFormat(), t);
            }
        }
    }

    private static boolean isLossless(AudioCodec codec) {
        return switch (codec) {
            case FLAC, ALAC, PCM_S16LE, PCM_S24LE, PCM_S32LE, PCM_F32LE -> true;
            default -> false;
        };
    }

    /** Replays exactly the calls AsyncFFmpegVideoWriter makes, minus the video stream. */
    private static void encode(File file, String format, int codecId, int sampleFormat, int channels) throws Exception {
        try (FFmpegFrameRecorder recorder = new FFmpegFrameRecorder(file, channels)) {
            recorder.setFormat(format);
            recorder.setAudioCodec(codecId);
            recorder.setSampleFormat(sampleFormat);
            recorder.setSampleRate(SAMPLE_RATE);
            recorder.setAudioBitrate(256000);
            recorder.start();

            int perFrame = SAMPLE_RATE / 60;
            FloatBuffer chunk = ByteBuffer.allocateDirect(perFrame * 4 * channels)
                    .order(ByteOrder.nativeOrder()).asFloatBuffer();
            int sampleIndex = 0;
            for (int frame = 0; frame < SECONDS * 60; frame++) {
                chunk.clear();
                for (int i = 0; i < perFrame; i++, sampleIndex++) {
                    float value = signal(sampleIndex);
                    for (int c = 0; c < channels; c++) {
                        chunk.put(value);
                    }
                }
                chunk.flip();
                recorder.recordSamples(chunk);
            }
            recorder.stop();
        }
    }

    /** 440 Hz + 660 Hz mix at half scale - loud enough that quantisation error is measurable. */
    static float signal(int sampleIndex) {
        double t = sampleIndex / (double) SAMPLE_RATE;
        return (float) (0.5 * (Math.sin(2 * Math.PI * 440 * t) + 0.5 * Math.sin(2 * Math.PI * 661 * t)) / 1.5);
    }
}
