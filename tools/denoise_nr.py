#!/usr/bin/env python3
"""M3-8 第二级降噪：noisereduce（MIT）非平稳模式。

为什么用它：profile 谱减（第一级）只能处理"噪声与音乐弱重叠"的段落；
压在琴声下面的噪声需要**在信号内部估噪声轨迹**的方法 —— noisereduce 的
non-stationary 模式正是为此设计（时频平滑 + 逐帧噪声估计），且有 prop_decrease 控制力度。

用法（在 WSL 里跑，路径用 /mnt/c/...）：
  python3 tools/denoise_nr.py --probe
  python3 tools/denoise_nr.py --in <wav> --out <wav> --prop 0.8 --nfft 2048
"""
import argparse
import sys
import wave

import numpy as np


def probe():
    print("python", sys.version.split()[0])
    print("numpy", np.__version__)
    try:
        import scipy
        print("scipy", scipy.__version__)
    except Exception as e:  # pragma: no cover
        print("scipy MISSING:", e)
    try:
        import noisereduce
        print("noisereduce", getattr(noisereduce, "__version__", "?"))
    except Exception as e:  # pragma: no cover
        print("noisereduce MISSING:", e)


def read_wav(path):
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, "只支持 16bit PCM"
        sr = w.getframerate()
        ch = w.getnchannels()
        data = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32)
        if ch > 1:
            data = data.reshape(-1, ch).mean(axis=1)
        return data / 32768.0, sr


def write_wav(path, y, sr):
    y = np.clip(y, -1.0, 1.0)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes((y * 32767.0).astype("<i2").tobytes())


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--probe", action="store_true")
    ap.add_argument("--in", dest="inp")
    ap.add_argument("--out", dest="out")
    ap.add_argument("--prop", type=float, default=0.8, help="prop_decrease：降多少比例（0–1）")
    ap.add_argument("--nfft", type=int, default=2048)
    ap.add_argument("--smooth", type=int, default=1000, help="time_mask_smooth_ms")
    args = ap.parse_args()
    if args.probe:
        probe()
        return
    import noisereduce as nr
    y, sr = read_wav(args.inp)
    out = nr.reduce_noise(y=y, sr=sr, stationary=False, prop_decrease=args.prop,
                          n_fft=args.nfft, time_mask_smooth_ms=args.smooth)
    write_wav(args.out, out, sr)
    print(f"ok prop={args.prop} nfft={args.nfft} smooth={args.smooth} -> {args.out}")


if __name__ == "__main__":
    main()
