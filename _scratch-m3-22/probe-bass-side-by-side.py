# M3-22 探针 11：把"低音"逐帧摊开看 —— 同一时刻，原曲和我们渲染的低频里各有哪些音、各多响
#
# 目的：用户说"低音完全不一样"。这里不做统计，直接把 55–95s 每 0.5s 的低频峰列出来对比：
#   参考演奏 vs B 现状（校准后）：低音区（55–260Hz）最强的 3 个峰，写成音名 + 相对电平。
import numpy as np
import soundfile as sf

B = r"C:\Users\hiliang\Documents\minecraft\build"
names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def nm(f):
    if f <= 20:
        return "?"
    mi = int(round(12 * np.log2(f / 440.0) + 69))
    return f"{names[mi % 12]}{mi // 12 - 1}"


def peaks(x, sr, lo=55, hi=260, n=3):
    w = np.hanning(len(x))
    X = np.abs(np.fft.rfft(x * w))
    f = np.fft.rfftfreq(len(x), 1 / sr)
    m = (f >= lo) & (f <= hi)
    Xs, fs = X[m], f[m]
    idx = np.argsort(Xs)[::-1]
    out = []
    for i in idx:
        fr = fs[i]
        if any(abs(fr - g) / max(g, 1) < 0.04 for g, _ in out):
            continue
        out.append((fr, Xs[i]))
        if len(out) >= n:
            break
    return out


ref, rsr = sf.read(B + r"\animenz_aligned.wav", dtype="float32")
if ref.ndim > 1:
    ref = ref.mean(axis=1)
our, osr = sf.read(B + r"\ab\B_calibrated_full_48k24bit.wav", dtype="float32")
if our.ndim > 1:
    our = our.mean(axis=1)

for t0 in [56.0, 60.0, 62.0, 64.0, 66.0, 70.0, 80.0, 86.0]:
    win = 0.6
    a = ref[int(t0 * rsr):int((t0 + win) * rsr)]
    b = our[int(t0 * osr):int((t0 + win) * osr)]
    pa = peaks(a, rsr)
    pb = peaks(b, osr)
    fmt = lambda p: "  ".join(f"{nm(f):4s}({f:5.1f}Hz,{20*np.log10(v/max(pa[0][1] if p is pa else pb[0][1],1e-12)):5.1f}dB)" for f, v in p)
    print(f"t={t0:5.1f}s  原曲: {fmt(pa)}")
    print(f"          我们: {fmt(pb)}")
