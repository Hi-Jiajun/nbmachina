#!/usr/bin/env python3
# M3-22 · 从参考演奏里"听"出每个音的实际发声时长（键释放）与踏板事件
#
# 为什么需要它：红石谱面只说"第几刻敲下哪个键"，**不说声音该持续多久**。
# 在真钢琴上，一颗音什么时候停由两件事决定：
#   ① 手指什么时候松开（note offset）
#   ② 踏板什么时候抬起（pedal offset，抬起时踩着的所有音一起被制音器放掉）
# 这两个量都藏在参考演奏的音频里。这里用 MIT 许可的 piano_transcription_inference
# （qiuqiangkong，"Onsets and Frames" 系 CRNN，MAESTRO 训练；官方指标 note F1=0.9677 /
#  pedal F1=0.9186）直接估出来——于是我们不是"猜用几拍"，而是照抄 Animenz 这一遍的弹法。
#
# 输出的 JSON 是给 tools/make-note-lengths.mjs 用的：
#   note_events  → 每颗音的 onset / offset（秒，时间轴 = 传入音频的时间轴）
#   pedal_events → 每次"踏板踩下 → 抬起"
#
# 用法（Windows Python 3.12 @ _toolchain/py312，CPU 即可）：
#   python tools/transcribe-reference.py \
#     --in  build/animenz_aligned.wav \
#     --out build/ref_transcription.json \
#     --midi build/ref_transcription.mid \
#     --checkpoint _toolchain/piano_transcription/note_F1=0.9677_pedal_F1=0.9186.pth
import argparse
import json
import time
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument('--in', dest='inp', required=True, help='参考演奏音频（与谱面同一时间轴）')
    ap.add_argument('--out', required=True, help='输出 JSON')
    ap.add_argument('--midi', default=None, help='可选：顺带写一份转谱 MIDI，方便拿 DAW 对照')
    ap.add_argument('--checkpoint', required=True, help='模型权重（~165MB）')
    ap.add_argument('--device', default='cpu', help='cpu / cuda')
    args = ap.parse_args()

    import librosa
    import numpy as np
    import torch
    from piano_transcription_inference import PianoTranscription, config

    t0 = time.time()
    audio, _ = librosa.load(args.inp, sr=config.sample_rate, mono=True)
    print(f'音频 {args.inp}：{len(audio) / config.sample_rate:.1f}s @ {config.sample_rate}Hz'
          f'（读取 {time.time() - t0:.1f}s）')

    model = PianoTranscription(device=torch.device(args.device), checkpoint_path=args.checkpoint)
    t1 = time.time()
    result = model.transcribe(audio, midi_path=args.midi)
    print(f'推理完成：{time.time() - t1:.1f}s（{len(audio) / config.sample_rate:.1f}s 音频）')

    notes = [{'onset': float(e['onset_time']), 'offset': float(e['offset_time']),
              'midi': int(e['midi_note']), 'velocity': float(e['velocity'])}
             for e in result['est_note_events']]
    pedals = [{'on': float(e['onset_time']), 'off': float(e['offset_time'])}
              for e in (result['est_pedal_events'] or [])]
    notes.sort(key=lambda n: (n['onset'], n['midi']))
    pedals.sort(key=lambda p: p['on'])

    dur = np.array([n['offset'] - n['onset'] for n in notes]) if notes else np.zeros(0)
    vel = np.array([n['velocity'] for n in notes]) if notes else np.zeros(0)
    total = len(audio) / config.sample_rate
    down = sum(p['off'] - p['on'] for p in pedals)
    print(f'音符 {len(notes)} 颗：时长 中位 {np.median(dur):.2f}s / p10 {np.percentile(dur, 10):.2f}s'
          f' / p90 {np.percentile(dur, 90):.2f}s；力度 中位 {np.median(vel):.0f}'
          if notes else '音符 0 颗')
    print(f'踏板 {len(pedals)} 段：踩下时间占比 {down / total * 100:.0f}%')

    out = {
        'source': str(Path(args.inp).resolve()),
        'sample_rate': config.sample_rate,
        'duration_seconds': total,
        'note_events': notes,
        'pedal_events': pedals,
    }
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding='utf-8')
    print(f'写出 {args.out}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
