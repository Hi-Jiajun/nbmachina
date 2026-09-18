# M3-25 · 拿"我们的渲染"和"原视频"逐音对比，删掉**原曲根本没有、我们却在响**的音
#
# 为什么需要（2026-09-18 用户反馈"4:37 出现不该出现的低音"）：
#   转谱在 264.97s 给了一颗 C#1（34.6Hz）。原视频在 33–37Hz 这一带只有 -54dB（听不见），
#   而我们的成品是 -37dB —— 一颗原曲没有的"地鸣"，还会拖 20 秒。
#   旧的可听度检查用的是"前 3 个谐波"，但 C#1 的 2 次/3 次谐波正好撞上真实存在的
#   C#2(69Hz)/G#2(104Hz)，所以查不出来。这里改成**只看基频 ±2%**，并且和我们的渲染对比。
#
# 判定：基频带里 我们 − 原曲 > 12dB  且  原曲该带占当时总能量 < −35dB  → 判定为幻觉，删除
import argparse
import json
from pathlib import Path

import numpy as np
import soundfile as sf


def load(p):
    x, sr = sf.read(p, dtype='float32')
    if x.ndim > 1:
        x = x.mean(axis=1)
    return x, sr


def bands(x, sr, f0, t0):
    """基频带 vs 总能量。窗长至少 12 个周期（低音才分得开），带宽 ±6% 或 ≥2.5 个 bin。"""
    win = max(0.08, 12.0 / f0)
    n = int(win * sr)
    a = int(t0 * sr)
    seg = x[a:a + n]
    if len(seg) < n:
        return None, None
    S = np.abs(np.fft.rfft(seg * np.hanning(n))) ** 2
    f = np.fft.rfftfreq(n, 1 / sr)
    binw = sr / n
    half = max(f0 * 0.06, 2.5 * binw)
    m = (f >= f0 - half) & (f <= f0 + half)
    return float(np.sum(S[m])), float(np.sum(S))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True)
    ap.add_argument('--orig', required=True)
    ap.add_argument('--render', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--offset', type=float, default=3.904, help='演奏起点（原视频时间）')
    ap.add_argument('--excess', type=float, default=12.0, help='我们比原曲高多少 dB 算异常')
    ap.add_argument('--frac', type=float, default=-35.0, help='原曲该带占比低于多少 dB 算"没有"')
    ap.add_argument('--report', default=None)
    args = ap.parse_args()

    data = json.load(open(args.inp, encoding='utf-8'))
    notes = sorted(data['note_events'], key=lambda n: n['onset'])
    og, sr = load(args.orig)
    rd, _ = load(args.render)

    kept, dropped = [], []
    for n in notes:
        f0 = 440.0 * 2 ** ((n['midi'] - 69) / 12)
        t = n['onset']
        bo, to = bands(og, sr, f0, t + 0.02)
        br, _ = bands(rd, sr, f0, t - args.offset + 0.02)
        if bo is None or br is None:
            kept.append(n)
            continue
        eo = 10 * np.log10(bo + 1e-20)
        er = 10 * np.log10(br + 1e-20)
        frac = 10 * np.log10(bo / (to + 1e-20) + 1e-20)
        if (er - eo) > args.excess and frac < args.frac:
            dropped.append({**n, 'orig_db': eo, 'render_db': er, 'frac_db': frac})
        else:
            kept.append(n)

    out = dict(data)
    out['note_events'] = kept
    out['filtered_vs_render'] = {'kept': len(kept), 'dropped': len(dropped),
                                 'excess_db': args.excess, 'frac_db': args.frac}
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    json.dump(out, open(args.out, 'w', encoding='utf-8'), ensure_ascii=False)
    print(f'保留 {len(kept)} / 删掉 {len(dropped)}（{len(dropped) / max(1, len(notes)) * 100:.2f}%）→ {args.out}')
    for d in dropped[:20]:
        print(f"   {d['onset'] - args.offset:8.2f}s midi={d['midi']:3d}  原曲 {d['orig_db']:7.1f}dB / 我们 {d['render_db']:7.1f}dB"
              f"（占比 {d['frac_db']:6.1f}dB）")
    if args.report:
        json.dump({'dropped': dropped}, open(args.report, 'w', encoding='utf-8'), ensure_ascii=False)


if __name__ == '__main__':
    main()
