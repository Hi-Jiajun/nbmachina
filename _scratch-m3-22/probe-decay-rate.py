# M3-22 探针 10：同一颗低音，在参考演奏里 vs 在我们的渲染里，**衰减速度**差多少？
# 找"孤立音"（前后 0.4s 内没有别的音、2s 内没有同音高），跟基频 ±2% 带内的包络，
# 拟合 0.2–1.5s 的斜率（dB/s）。我们衰减得越慢，叠加起来就越"糊"。
import json
import numpy as np
import soundfile as sf

B = r"C:\Users\hiliang\Documents\minecraft\build"
ref, rsr = sf.read(B + r"\animenz_aligned.wav", dtype="float32")
if ref.ndim > 1:
    ref = ref.mean(axis=1)
ours, osr = sf.read(B + r"\ab\B_calibrated_full_48k24bit.wav", dtype="float32")
if ours.ndim > 1:
    ours = ours.mean(axis=1)
notes = json.load(open(B + r"\ref_transcription.json", encoding="utf-8"))["note_events"]
notes.sort(key=lambda n: n["onset"])


def env_of(x, sr, f0, t0, dur=2.0, hop=0.02):
    out = []
    win = int(0.06 * sr)
    for k in range(int(dur / hop)):
        a = int((t0 + k * hop) * sr)
        seg = x[a:a + win]
        if len(seg) < win:
            break
        X = np.abs(np.fft.rfft(seg * np.hanning(len(seg))))
        f = np.fft.rfftfreq(len(seg), 1 / sr)
        m = (f >= f0 * 0.98) & (f <= f0 * 1.02)
        out.append(np.sqrt(np.sum(X[m] ** 2)))
    return np.array(out)


def slope_db(e, hop=0.02, a=0.2, b=1.5):
    ia, ib = int(a / hop), min(len(e) - 1, int(b / hop))
    if ib - ia < 5:
        return None
    seg = e[ia:ib]
    if seg.max() <= 0:
        return None
    seg = 20 * np.log10(seg / seg.max() + 1e-12)
    tt = np.arange(len(seg)) * hop
    k = np.polyfit(tt, seg, 1)[0]
    return k


# 孤立音太少（全曲只有个位数）→ 换成"统计平均"：同一批音，在两个文件里各取
# "以该音起音为 0 时刻、基频 ±2% 带内的归一化包络"，再对全部音求平均。
# 织体噪声两边一样，所以曲线差异就是"衰减速度"的差异。
def mean_curve(pairs, x, sr, dur=1.6, hop=0.02):
    curves = []
    for (t0, f0) in pairs:
        e = env_of(x, sr, f0, t0, dur=dur, hop=hop)
        if len(e) < 10 or e.max() <= 0:
            continue
        curves.append(e / e.max())
    n = min(len(c) for c in curves)
    return np.mean([c[:n] for c in curves], axis=0)


for lo, hi in [(40, 48), (49, 54), (55, 60), (61, 72)]:
    pairs = [(n["onset"], 440 * 2 ** ((n["midi"] - 69) / 12)) for n in notes
             if lo <= n["midi"] <= hi]
    # 让两个文件的样本集合完全一致（同一批 onset/音高）
    if not pairs:
        continue
    a = mean_curve(pairs, ref, rsr)
    b = mean_curve(pairs, ours, osr)
    k = min(len(a), len(b))
    a, b = a[:k], b[:k]
    db_a = 20 * np.log10(a + 1e-9)
    db_b = 20 * np.log10(b + 1e-9)
    tt = np.arange(k) * 0.02
    print(f"midi {lo}-{hi}（{len(pairs)} 颗）：参考 0.5s {db_a[int(0.5/0.02)]:6.1f}dB / 1.0s {db_a[int(1.0/0.02)]:6.1f}dB"
          f" | 我们 0.5s {db_b[int(0.5/0.02)]:6.1f}dB / 1.0s {db_b[int(1.0/0.02)]:6.1f}dB")
