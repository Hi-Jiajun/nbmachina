# 用户点名"4m32-4m44 有很明显的不同" —— 把这一段（机器时间 272–284s）逐 0.5s 摊开对比
import numpy as np
import soundfile as sf

B = r"C:\Users\hiliang\Documents\minecraft\build"
T = r"C:\Users\hiliang\AppData\Local\Temp"
OFF = 3.904
names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def nm(f):
    if f < 20:
        return "?"
    mi = int(round(12 * np.log2(f / 440.0) + 69))
    return f"{names[mi % 12]}{mi // 12 - 1}({mi})"


def load(p):
    x, sr = sf.read(p, dtype="float32")
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x, sr


og, sr = load(T + r"\orig290.wav")
rn, _ = load(B + r"\ab\R10_hpf48x2_48k24bit.wav")


def peaks(x, t0, sec=0.5, lo=40, hi=1500, n=6):
    seg = x[int(t0 * sr):int((t0 + sec) * sr)]
    X = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
    f = np.fft.rfftfreq(len(seg), 1 / sr)
    m = (f >= lo) & (f <= hi)
    Xs, fs = X[m], f[m]
    idx = np.argsort(Xs)[::-1]
    out = []
    for i in idx:
        fr = fs[i]
        if any(abs(fr - g) / max(g, 1) < 0.025 for g, _ in out):
            continue
        out.append((fr, Xs[i]))
        if len(out) >= n:
            break
    mx = out[0][1] if out else 1.0
    return [(fr, 20 * np.log10(v / mx + 1e-12)) for fr, v in out]


print("机器时间 272–284s（= 用户说的 4:32–4:44）：原视频 vs 我们（R10）")
for t0 in np.arange(272.0, 283.5, 0.5):
    a = peaks(og, t0 + OFF)
    b = peaks(rn, t0)
    print(f"  t={t0:6.1f}s")
    print(f"     原曲: " + "  ".join(f"{nm(fr)}@{fr:.0f}[{db:.0f}dB]" for fr, db in a))
    print(f"     我们: " + "  ".join(f"{nm(fr)}@{fr:.0f}[{db:.0f}dB]" for fr, db in b))
