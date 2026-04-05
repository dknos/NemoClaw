#!/usr/bin/env python3
"""
Whisper transcription — word-level timestamps for lyrics/captions.
Usage: python3 whisper-transcribe.py /path/to/audio.mp3 [model_size]
Output: JSON to stdout with segments and word timestamps.

Models: tiny, base, small, medium, large-v3
Default: base (fast, decent accuracy for lyrics)
"""

import sys
import json
import os

def transcribe(audio_path, model_size="base"):
    from faster_whisper import WhisperModel

    device = "cuda" if os.environ.get("CUDA_VISIBLE_DEVICES", "") != "-1" else "cpu"
    compute_type = "float16" if device == "cuda" else "int8"

    print(f"[whisper] loading model: {model_size} on {device}", file=sys.stderr)
    model = WhisperModel(model_size, device=device, compute_type=compute_type)

    print(f"[whisper] transcribing: {audio_path}", file=sys.stderr)
    segments, info = model.transcribe(
        audio_path,
        word_timestamps=True,
        vad_filter=True,
        vad_parameters=dict(min_silence_duration_ms=300),
    )

    result = {
        "language": info.language,
        "language_probability": round(info.language_probability, 3),
        "duration": round(info.duration, 2),
        "segments": [],
        "words": [],
    }

    for seg in segments:
        seg_data = {
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
        }
        result["segments"].append(seg_data)

        if seg.words:
            for w in seg.words:
                result["words"].append({
                    "word": w.word.strip(),
                    "start": round(w.start, 3),
                    "end": round(w.end, 3),
                    "probability": round(w.probability, 3),
                })

    print(f"[whisper] done: {len(result['segments'])} segments, {len(result['words'])} words", file=sys.stderr)
    return result


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: whisper-transcribe.py <audio_path> [model_size]", file=sys.stderr)
        sys.exit(1)

    audio_path = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "base"

    result = transcribe(audio_path, model_size)
    json.dump(result, sys.stdout, ensure_ascii=False)
