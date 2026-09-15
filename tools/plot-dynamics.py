#!/usr/bin/env python3
"""M3-15 · 力度编排曲线图（Pillow）。

输入：build/dynamics-curve.json（tools/dynamics-report.mjs 生成）
输出：PNG —— 横轴=时间；纵轴=velMidi(0..127)。浅蓝=源曲响度（映射到 40..122），
      灰虚线=恒定力度（现状），橙=乐句级（平滑实测），绿=段落解读（段电平 + 段内弧线）。
      竖线=段落边界，底部小字=段号 / 段电平（0..1）。

用法：_toolchain\\py312\\python.exe tools\\plot-dynamics.py <in.json> <out.png>
"""
import json
import sys

from PIL import Image, ImageDraw, ImageFont


def load_font(size):
    # 中文必须用带 CJK 字形的字体（segoeui/arial 都没有 CJK，实测渲染成"豆腐块"）
    for name in (
        r"C:\Windows\Fonts\msyh.ttc",
        r"C:\Windows\Fonts\msyhbd.ttc",
        r"C:\Windows\Fonts\simhei.ttf",
        "segoeui.ttf",
        "DejaVuSans.ttf",
    ):
        try:
            return ImageFont.truetype(name, size)
        except Exception:
            continue
    return ImageFont.load_default()


def main(src, dst):
    data = json.load(open(src, encoding="utf-8"))
    duration = float(data["duration"])
    sections = data["sections"]
    env = data["envelope"]
    notes = data["notes"]

    W, H = 1680, 760
    L, R, T, B = 84, 40, 64, 84
    pw, ph = W - L - R, H - T - B
    img = Image.new("RGB", (W, H), (252, 252, 250))
    dr = ImageDraw.Draw(img)
    f14, f16, f18 = load_font(14), load_font(16), load_font(18)

    def x(t):
        return L + pw * (t / duration)

    def y(v):
        return T + ph * (1 - v / 127.0)

    # 段落底色 + 边界 + 段号/段电平（放底部，避免压住曲线）
    for i, s in enumerate(sections):
        if i % 2 == 0:
            dr.rectangle([x(s["start"]), T, x(s["end"]), T + ph], fill=(243, 243, 240))
        dr.line([x(s["start"]), T, x(s["start"]), T + ph], fill=(205, 205, 205), width=1)
        dr.text((x(s["start"]) + 6, T + ph - 42), f"{i + 1}", font=f16, fill=(110, 110, 110))
        dr.text((x(s["start"]) + 6, T + ph - 24), f'{s["level"]:.2f}', font=f14, fill=(152, 152, 152))
    dr.line([x(sections[-1]["end"]), T, x(sections[-1]["end"]), T + ph], fill=(205, 205, 205), width=1)

    # 网格 + 刻度
    for v in (0, 32, 64, 96, 127):
        dr.line([L, y(v), L + pw, y(v)], fill=(228, 228, 224), width=1)
        dr.text((L - 46, y(v) - 9), f"{v}", font=f14, fill=(90, 90, 90))
    for t in range(0, int(duration) + 1, 20):
        dr.line([x(t), T + ph, x(t), T + ph + 5], fill=(150, 150, 150), width=1)
        dr.text((x(t) - 15, T + ph + 10), f"{t}s", font=f14, fill=(90, 90, 90))

    # 源曲响度：映射到 40..122（否则安静段贴 0，曲线全挤在上半区）
    dr.line([(x(t), y(40 + v * 82)) for t, v in env], fill=(178, 210, 240), width=2)

    # 恒定力度（现状）参考虚线
    yc = y(44)
    for t in range(0, int(duration), 4):
        dr.line([x(t), yc, x(min(t + 2, duration)), yc], fill=(200, 200, 200), width=2)

    # 旋律力度曲线
    phrase = [(x(t), y(v)) for t, is_harp, v, _ in notes if is_harp and v is not None]
    interp = [(x(t), y(v)) for t, is_harp, _, v in notes if is_harp and v is not None]
    dr.line(phrase, fill=(230, 150, 60), width=2)
    dr.line(interp, fill=(40, 150, 90), width=3)

    # 图例
    dr.rectangle([L, 16, W - R, T - 16], outline=(226, 226, 220), fill=(255, 255, 255))
    dr.text((L + 12, 26), "力度编排曲线", font=f18, fill=(40, 40, 40))
    dr.line([L + 200, 36, L + 240, 36], fill=(178, 210, 240), width=3)
    dr.text((L + 248, 27), "源曲响度", font=f16, fill=(60, 60, 60))
    dr.line([L + 340, 36, L + 380, 36], fill=(200, 200, 200), width=3)
    dr.text((L + 388, 27), "恒定力度（现状）", font=f16, fill=(60, 60, 60))
    dr.line([L + 560, 36, L + 600, 36], fill=(230, 150, 60), width=3)
    dr.text((L + 608, 27), "乐句级（平滑实测）", font=f16, fill=(60, 60, 60))
    dr.line([L + 790, 36, L + 830, 36], fill=(40, 150, 90), width=3)
    dr.text((L + 838, 27), "段落解读（段电平 + 段内弧线）", font=f16, fill=(60, 60, 60))

    dr.rectangle([L, T, L + pw, T + ph], outline=(180, 180, 180), width=1)
    img.save(dst)
    print(f"曲线图 → {dst}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
