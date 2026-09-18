# sta 与 leg 的响度/时长对照：如果 sta 明显更轻或更短，"短音换 sta"就会听成"缺音"
import os
import re
import numpy as np
import soundfile as sf

D = r"C:\Users\hiliang\Documents\minecraft\_toolchain\olpc\x\yamahaGrandPiano44"
sta, leg = {}, {}
for f in os.listdir(D):
    m = re.match(r'^pno(\d+)v(\d+)(sta|leg)\.wav$', f, re.I)
    if not m:
        continue
    key, vel, kind = int(m.group(1)), int(m.group(2)), m.group(3).lower()
    (sta if kind == 'sta' else leg).setdefault(key, []).append((vel, os.path.join(D, f)))

def stats(path):
    x, sr = sf.read(path, dtype='float32')
    if x.ndim > 1:
        x = x.mean(axis=1)
    rms = float(np.sqrt(np.mean(x ** 2)) + 1e-12)
    peak = float(np.max(np.abs(x)) + 1e-12)
    # 衰减到 -40dB（相对峰值包络）的时间
    hop = int(0.02 * sr)
    env = np.array([np.sqrt(np.mean(x[i:i + hop] ** 2) + 1e-12) for i in range(0, max(1, len(x) - hop), hop)])
    rel = np.where(env < env.max() * 0.01)[0]
    tail = (rel[0] * 0.02) if len(rel) else len(x) / sr
    return 20 * np.log10(rms), 20 * np.log10(peak), len(x) / sr, tail

print("根音  力度(sta/leg)   RMS差(sta-leg)   峰值差   时长 sta/leg      衰减到-40dB sta/leg")
rows = []
for key in sorted(sta):
    if key not in leg:
        continue
    sa = sorted(sta[key])
    le = sorted(leg[key])
    for sv, sp in sa[:3]:
        lv, lp = min(le, key=lambda t: abs(t[0] - sv))
        try:
            sr_, pk_s, dur_s, tail_s = stats(sp)
            lr_, pk_l, dur_l, tail_l = stats(lp)
        except Exception as e:
            continue
        rows.append((sr_ - lr_, pk_s - pk_l, dur_s, dur_l, tail_s, tail_l))
        if len(rows) <= 12:
            print(f"{key:5d} {sv:4d}/{lv:<4d}   {sr_-lr_:+7.1f} dB   {pk_s-pk_l:+6.1f} dB   {dur_s:5.2f}/{dur_l:5.2f}s   {tail_s:5.2f}/{tail_l:5.2f}s")
a = np.array([[r[0], r[1], r[2], r[3], r[4], r[5]] for r in rows])
print(f"\n共 {len(rows)} 对：RMS 差中位 {np.median(a[:,0]):+.1f} dB（p10 {np.percentile(a[:,0],10):+.1f} / p90 {np.percentile(a[:,0],90):+.1f}）")
print(f"峰值差中位 {np.median(a[:,1]):+.1f} dB；时长中位 sta {np.median(a[:,2]):.2f}s vs leg {np.median(a[:,3]):.2f}s")
print(f"衰减到 -40dB 用时中位：sta {np.median(a[:,4]):.2f}s vs leg {np.median(a[:,5]):.2f}s")
