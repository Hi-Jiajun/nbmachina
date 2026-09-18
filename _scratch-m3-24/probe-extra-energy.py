# M3-25 探针：在"我们的渲染 − 原视频"的时频谱上找**多出来的能量**
# 用途：定位"2:47 那个双击感"这类"原曲没有、我们却有"的东西。
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
r4, _ = load(B + r"\ab\R4b_modelvel_48k24bit.wav")


def spec(x, t0, t1, off):
    seg = x[int((t0 + off) * sr):int((t1 + off) * sr)]
    n = int(0.06 * sr)          # 60ms 窗
    hop = int(0.02 * sr)
    frames = np.stack([seg[i:i + n] for i in range(0, len(seg) - n, hop)]) * np.hanning(n)
    S = np.abs(np.fft.rfft(frames, axis=1)) ** 2
    f = np.fft.rfftfreq(n, 1 / sr)
    return S, f, hop / sr


for (a, b, label) in [(166.0, 169.0, "2:47 附近（机器 166–169s）"), (276.0, 279.5, "4:37 附近（机器 276–279.5s）")]:
    Sa, f, hop = spec(og, a, b, OFF)
    Sb, _, _ = spec(r4, a, b, 0.0)
    k = min(len(Sa), len(Sb))
    ratio = 10 * np.log10((Sb[:k] + 1e-12) / (Sa[:k] + 1e-12))
    print(f"\n=== {label}：我们比原曲多出来的能量（>12dB 才列）")
    hits = []
    for ti in range(k):
        for fi in range(len(f)):
            if f[fi] < 30 or f[fi] > 6000:
                continue
            if ratio[ti, fi] > 12 and Sb[ti, fi] > 1e-3 * Sb.max():
                hits.append((ratio[ti, fi], a + ti * hop, f[fi]))
    hits.sort(reverse=True)
    shown = []
    for v, t, fr in hits:
        if any(abs(t - t2) < 0.10 and abs(np.log2(fr / f2)) < 0.05 for _, t2, f2 in shown):
            continue
        shown.append((v, t, fr))
        if len(shown) >= 18:
            break
    for v, t, fr in shown:
        print(f"   t={t:7.2f}s  频率 {fr:7.1f}Hz = {nm(fr):9s}  超出 +{v:.1f}dB")
