# M3-25 探针：逐音"可听度"体检 —— 每颗音在**原视频音频**里，它的谐波占当时总能量多少？
# 用途：找转谱幻觉（比如 4:37 那颗 34.6Hz 的 C#1：原视频里 33–37Hz 只有 -54dB，
# 我们的成品却有 -37dB —— 一颗原曲没有的"地鸣"）。
import json
import numpy as np
import soundfile as sf

B = r"C:\Users\hiliang\Documents\minecraft\build"
OFF = 3.904
names = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]


def nm(m):
    return f"{names[m % 12]}{m // 12 - 1}"


x, sr = sf.read(B + r"\ref_video_original.wav", dtype="float32")
if x.ndim > 1:
    x = x.mean(axis=1)
data = json.load(open(B + r"\ref_video_transcription.json", encoding="utf-8"))
notes = sorted(data["note_events"], key=lambda n: n["onset"])

WIN = 0.30
FRAME = int(WIN * sr)
WIN_H = np.hanning(FRAME)
FREQ = np.fft.rfftfreq(FRAME, 1 / sr)


def frac(midi, t0):
    a = int(t0 * sr)
    seg = x[a:a + FRAME]
    if len(seg) < FRAME:
        return None
    X = np.abs(np.fft.rfft(seg * WIN_H)) ** 2
    tot = np.sum(X)
    f0 = 440.0 * 2 ** ((midi - 69) / 12)
    e = 0.0
    for h in (1, 2, 3):
        fh = f0 * h
        if fh > sr * 0.45:
            break
        m = (FREQ >= fh * 0.98) & (FREQ <= fh * 1.02)
        e += np.sum(X[m])
    return 10 * np.log10(e / tot + 1e-18)


rows = []
for n in notes:
    v = frac(n["midi"], n["onset"] + 0.02)
    if v is not None:
        rows.append((v, n))
rows.sort(key=lambda r: r[0])
vals = np.array([r[0] for r in rows])
print(f"共 {len(rows)} 颗；可听度（谐波占当时总能量，dB）分位："
      f"p1 {np.percentile(vals,1):.1f}  p5 {np.percentile(vals,5):.1f}  中位 {np.median(vals):.1f}")
print("\n最可疑的 25 颗（原视频里几乎听不到）：")
print("   机器时间   音高       占比dB")
for v, n in rows[:25]:
    print(f"   {n['onset']-OFF:8.2f}s  {nm(n['midi']):5s}({n['midi']:3d})  {v:7.1f}")
low = [(v, n) for v, n in rows if n["midi"] <= 45]
print(f"\n低音（midi<=45）共 {len(low)} 颗；其中占比 < -45dB 的 {sum(1 for v,_ in low if v < -45)} 颗：")
for v, n in [r for r in low if r[0] < -45][:20]:
    print(f"   {n['onset']-OFF:8.2f}s  {nm(n['midi'])}({n['midi']})  {v:7.1f}")
