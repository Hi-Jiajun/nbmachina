# M3-22 探针 7：挑几颗低音，逐帧跟"这条弦到底还响不响"——参考演奏 vs 我们的渲染
import sys
import numpy as np
import soundfile as sf

B = r"C:\Users\hiliang\Documents\minecraft\build"
REF = B + r"\animenz_aligned.wav"
RENDERS = {
    "A现状": B + r"\ab\A_current_full_48k24bit.wav",
    "B校准": B + r"\ab\B_calibrated_full_48k24bit.wav",
}


def load(path):
    x, sr = sf.read(path, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x, sr


def harmonic_env(x, sr, f0, t0, dur, hop=0.05, n_harm=5):
    """每 hop 秒统计 f0 前 5 个谐波的总能量（±3% 带）"""
    out = []
    frames = int(dur / hop)
    win = int(0.08 * sr)
    for k in range(frames):
        a = int((t0 + k * hop) * sr)
        seg = x[a:a + win]
        if len(seg) < 64:
            break
        X = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        f = np.fft.rfftfreq(len(seg), 1 / sr)
        e = 0.0
        for h in range(1, n_harm + 1):
            fh = f0 * h
            if fh > sr / 2 - 100:
                break
            m = (f >= fh * 0.97) & (f <= fh * 1.03)
            e += float(np.sum(X[m] ** 2))
        out.append(e)
    return np.array(out)


PICKS = [
    (57.60, 59, 2.459),
    (61.44, 49, 0.966),
    (62.40, 59, 0.932),
    (63.36, 59, 0.966),
    (65.28, 57, 0.979),
    (80.00, 57, 1.5),
]
names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
ref, rsr = load(REF)
rend = {k: load(v) for k, v in RENDERS.items()}
for (t0, midi, dur) in PICKS:
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    label = f"{names[midi % 12]}{midi // 12 - 1}({midi})"
    print(f"\n=== t={t0}s {label} {f0:.1f}Hz 谱面时值 {dur*1000:.0f}ms")
    series = {"参考": harmonic_env(ref, rsr, f0, t0 - 0.05, dur + 0.6)}
    for k, (x, sr) in rend.items():
        series[k] = harmonic_env(x, sr, f0, t0 - 0.05, dur + 0.6)
    for k, e in series.items():
        if len(e) == 0:
            continue
        e = e / max(e.max(), 1e-12)
        step = max(1, len(e) // 20)
        print(f"  {k}: " + " ".join(f"{v:.2f}" for v in e[::step][:20]))
