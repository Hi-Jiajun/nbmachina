# M3-22 探针 9：模型给的"踏板抬起"到底可不可信？
# 做法：从音频里找"突然变干"的时刻（100-600Hz 包络 150ms 内掉 ≥6dB 且之后维持更低），
# 再看这些时刻附近有没有模型的 pedal off。模型漏掉的越多，说明它把该换的踏板合并了
# → 我们的"响到踏板抬起"就会把低音拖长，听感就是"一直踩着踏板"。
import json
import numpy as np
import soundfile as sf

B = r"C:\Users\hiliang\Documents\minecraft\build"
x, sr = sf.read(B + r"\animenz_aligned.wav", dtype="float32")
if x.ndim > 1:
    x = x.mean(axis=1)
HOP = 0.025
n = int(HOP * sr)
m = len(x) // n
frames = x[:m * n].reshape(m, n) * np.hanning(n)
X = np.abs(np.fft.rfft(frames, axis=1))
f = np.fft.rfftfreq(n, 1 / sr)
mask = (f >= 100) & (f < 600)
env = np.sqrt(np.sum(X[:, mask] ** 2, axis=1) / mask.sum())
db = 20 * np.log10(env + 1e-12)

# 突然变干：与 150ms 前比掉 ≥6dB，且之后 100ms 仍低于"之前"至少 3dB
lag = int(0.15 / HOP)
after = int(0.10 / HOP)
events = []
for k in range(lag, len(db) - after):
    drop = db[k - lag] - db[k]
    if drop < 6:
        continue
    if db[k:k + after].mean() < db[k - lag] - 3:
        if events and (k - events[-1]) * HOP < 0.30:      # 合并相邻事件
            continue
        events.append(k)

ped = json.load(open(B + r"\ref_transcription.json", encoding="utf-8"))["pedal_events"]
offs = np.array([p["off"] for p in ped])
ons = np.array([p["on"] for p in ped])
print(f"音频里'突然变干'的时刻：{len(events)} 个；模型 pedal off：{len(offs)} 个")
hit = 0
missed = []
for k in events:
    t = k * HOP
    if np.min(np.abs(offs - t)) <= 0.35 or np.min(np.abs(ons - t)) <= 0.35:
        hit += 1
    else:
        missed.append(t)
print(f"  其中 {hit} 个附近（±0.35s）有模型踏板事件 = {hit / max(1, len(events)) * 100:.0f}%")
print(f"  模型**漏掉**的变干时刻 {len(missed)} 个，前 20 个："
      + " ".join(f"{t:.2f}" for t in missed[:20]))

# 反向：模型说"踏板抬起"时，音频真的变干了吗？
ok = 0
for t in offs:
    k = int(t / HOP)
    if k < lag + 1 or k + after >= len(db):
        continue
    if db[k - lag] - db[k] >= 3:
        ok += 1
print(f"反向：模型 {len(offs)} 次 pedal off 里，音频在那一刻确实变干的 {ok} 次 = {ok / len(offs) * 100:.0f}%")
