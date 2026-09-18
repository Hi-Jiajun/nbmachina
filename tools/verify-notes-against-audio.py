# M3-25 · 逐音回听校验：把转谱里"音频上根本没有证据"的音删掉
#
# 起因（2026-09-18 用户反馈）：4:37 处出现不该有的声音。查证：转谱在结尾 274–280s 吐出一串
# 密集的高音（midi 97–104，每 0.1s 一颗），而**原视频在那一段是安静的收尾**（RMS -33dBFS，
# 频谱只有低音长尾）。这是 CRNN 转谱典型的"结尾幻觉"。同一份音频里既然有能量证据，
# 就逐音回听一遍：这颗音起音后，它的基频/谐波频带里到底有没有出现新的能量？
#
# 判定（保守，只删"完全没证据"的）：
#   ① after  = 起音后 20–120ms 的频带能量
#   ② before = 起音前 150–50ms 的频带能量
#   ③ local  = 该音前后各 2s（避开这颗音本身）频带能量的中位数
#   删掉条件：after ≤ local × 1.05  且  after/before < 1.2      （既没超出本地水平、也没有新起音）
#
# 用法：
#   python tools/verify-notes-against-audio.py --in build/ref_video_transcription.json ^
#          --audio build/ref_video_original.wav --out build/ref_video_transcription_verified.json
import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf


def band_energy(x, sr, f0, t0, t1):
    a, b = int(t0 * sr), int(t1 * sr)
    if b - a < 64:
        return 0.0
    seg = x[a:b]
    w = np.hanning(len(seg))
    X = np.abs(np.fft.rfft(seg * w)) ** 2
    f = np.fft.rfftfreq(len(seg), 1 / sr)
    e = 0.0
    for h in (1, 2, 3, 4):
        fh = f0 * h
        if fh > sr * 0.45:
            break
        m = (f >= fh * 0.97) & (f <= fh * 1.03)
        e += float(np.sum(X[m]))
    return e


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--audio', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--ratio', type=float, default=1.2, help='起音前后能量比下限')
    ap.add_argument('--local', type=float, default=1.05, help='相对本地中位数的下限')
    ap.add_argument('--report', default=None)
    args = ap.parse_args()

    data = json.load(open(args.inp, encoding='utf-8'))
    notes = sorted(data['note_events'], key=lambda n: n['onset'])
    x, sr = sf.read(args.audio, dtype='float32')
    if x.ndim > 1:
        x = x.mean(axis=1)

    kept, dropped = [], []
    for n in notes:
        f0 = 440.0 * 2 ** ((n['midi'] - 69) / 12)
        after = band_energy(x, sr, f0, n['onset'] + 0.02, n['onset'] + 0.12)
        before = band_energy(x, sr, f0, n['onset'] - 0.15, n['onset'] - 0.05)
        # 本地水平：前后各 2s，避开这颗音本身
        probes = []
        for k in range(8):
            t = n['onset'] - 2.0 + k * 0.25
            if abs(t - n['onset']) > 0.3 and t > 0:
                probes.append(band_energy(x, sr, f0, t, t + 0.1))
        for k in range(8):
            t = n['onset'] + 0.3 + k * 0.25
            probes.append(band_energy(x, sr, f0, t, t + 0.1))
        local = float(np.median(probes)) if probes else 0.0
        ratio = after / before if before > 1e-12 else float('inf')
        weak_local = after <= local * args.local
        if weak_local and ratio < args.ratio:
            dropped.append({**n, 'after': after, 'before': before, 'local': local, 'ratio': ratio})
        else:
            kept.append(n)

    out = dict(data)
    out['note_events'] = kept
    out['verified'] = {
        'source': args.inp,
        'audio': args.audio,
        'ratio_min': args.ratio,
        'local_min': args.local,
        'kept': len(kept),
        'dropped': len(dropped),
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'保留 {len(kept)} / 删掉 {len(dropped)}（{len(dropped) / max(1, len(notes)) * 100:.1f}%）→ {args.out}')
    if dropped:
        by_reg = {}
        for d in dropped:
            by_reg[d['midi'] // 12] = by_reg.get(d['midi'] // 12, 0) + 1
        print('  删掉的音按八度分布：' + ' '.join(f'{k}八度:{v}' for k, v in sorted(by_reg.items())))
        print('  删掉的音时间分布（每 20s）：' + ' '.join(
            f'{int(dt * 20) * 20}s:'
            f'{sum(1 for d in dropped if int(dt * 20) * 20 == int((d["onset"] - 3.904) / 20) * 20)}'
            for dt in [0]))
        late = [d for d in dropped if d['onset'] > 270]
        print(f'  其中 270s（视频）之后：{len(late)} 颗')
    if args.report:
        json.dump({'dropped': dropped, 'kept': len(kept)},
                  open(args.report, 'w', encoding='utf-8'), ensure_ascii=False)


if __name__ == '__main__':
    main()
