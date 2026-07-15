#!/usr/bin/env python
import argparse
import json
import os
import re
import sys
from pathlib import Path
from types import SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_ROOT = PROJECT_ROOT / "runtime"
MODELS_ROOT = RUNTIME_ROOT / "models"
HF_CACHE_ROOT = RUNTIME_ROOT / "cache" / "huggingface"
VC_RUNTIME_ROOT = RUNTIME_ROOT / "vc-runtime"
DEFAULT_MODEL = "medium"
DLL_HANDLES = []


def configure_project_dlls():
    if os.name != "nt":
        return
    site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    project_site_packages = RUNTIME_ROOT / "faster-whisper" / "Lib" / "site-packages"
    candidates = [
        VC_RUNTIME_ROOT,
        project_site_packages / "nvidia" / "cublas" / "bin",
        project_site_packages / "nvidia" / "cudnn" / "bin",
        project_site_packages / "nvidia" / "cuda_nvrtc" / "bin",
        site_packages / "nvidia" / "cublas" / "bin",
        site_packages / "nvidia" / "cudnn" / "bin",
        site_packages / "nvidia" / "cuda_nvrtc" / "bin",
    ]
    available = [str(path) for path in candidates if path.is_dir()]
    if not available:
        return
    os.environ["PATH"] = os.pathsep.join(available + [os.environ.get("PATH", "")])
    for directory in available:
        DLL_HANDLES.append(os.add_dll_directory(directory))


configure_project_dlls()


def main():
    parser = build_parser()
    args = parser.parse_args()
    if args.health:
        return print_health(args.model)
    if args.download_model:
        return download_model(args.model)
    if not args.audio:
        parser.error("audio file is required unless --health or --download-model is used")
    return transcribe(args)


def build_parser():
    parser = argparse.ArgumentParser(description="Project-local faster-whisper CLI")
    parser.add_argument("audio", nargs="?", help="Input audio or video file")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--output_dir", default=".")
    parser.add_argument("--output_format", choices=["srt", "txt", "all"], default="all")
    parser.add_argument("--device", choices=["auto", "cuda", "cpu"], default="auto")
    parser.add_argument("--compute_type", default="auto")
    parser.add_argument("--beam_size", type=int, default=5)
    parser.add_argument("--health", action="store_true")
    parser.add_argument("--download-model", action="store_true")
    return parser


def model_dir(model_name):
    candidate = Path(model_name)
    if candidate.exists():
        return candidate.resolve()
    return (MODELS_ROOT / model_name).resolve()


def model_ready(path):
    return path.is_dir() and (path / "model.bin").is_file() and (path / "config.json").is_file()


def versions():
    import ctranslate2
    import faster_whisper

    return {
        "fasterWhisper": faster_whisper.__version__,
        "ctranslate2": ctranslate2.__version__,
        "cudaDevices": ctranslate2.get_cuda_device_count(),
    }


def print_health(model_name):
    target = model_dir(model_name)
    try:
        package_versions = versions()
        ready = model_ready(target)
        payload = {
            "ok": ready,
            "response": "pong",
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "model": model_name,
            "modelPath": str(target),
            "modelReady": ready,
            **package_versions,
        }
    except Exception as error:
        payload = {
            "ok": False,
            "response": "error",
            "python": sys.version.split()[0],
            "executable": sys.executable,
            "model": model_name,
            "modelPath": str(target),
            "modelReady": False,
            "error": str(error),
        }
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if payload["ok"] else 2


def download_model(model_name):
    from faster_whisper.utils import download_model as fetch_model

    target = model_dir(model_name)
    target.mkdir(parents=True, exist_ok=True)
    HF_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    print(f"Downloading {model_name} to {target}", file=sys.stderr)
    resolved = fetch_model(model_name, output_dir=str(target), cache_dir=str(HF_CACHE_ROOT))
    if not model_ready(target):
        raise RuntimeError(f"model download finished but required files are missing: {resolved}")
    print(json.dumps({"ok": True, "model": model_name, "modelPath": str(target)}, ensure_ascii=False))
    return 0


def transcribe(args):
    from faster_whisper import WhisperModel

    source = Path(args.audio).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"input file does not exist: {source}")
    target_model = model_dir(args.model)
    if not model_ready(target_model):
        raise RuntimeError(f"model is not installed: {target_model}; run with --download-model first")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    device, compute_type = choose_runtime(args.device, args.compute_type)
    print(f"Loading {target_model.name} on {device} ({compute_type})", file=sys.stderr)

    try:
        segments, info = run_model(WhisperModel, target_model, source, args, device, compute_type)
        materialized = sentence_segments(list(segments))
    except Exception as error:
        if args.device != "auto" or device == "cpu":
            raise
        print(f"CUDA inference failed, retrying on CPU int8: {error}", file=sys.stderr)
        device, compute_type = "cpu", "int8"
        segments, info = run_model(WhisperModel, target_model, source, args, device, compute_type)
        materialized = sentence_segments(list(segments))

    srt_file = output_dir / "transcript.srt"
    text_file = output_dir / "asr-transcript.txt"
    json_file = output_dir / "asr-result.json"
    write_srt(srt_file, materialized)
    write_timestamped_text(text_file, materialized)
    payload = {
        "model": args.model,
        "modelPath": str(target_model),
        "source": str(source),
        "language": info.language,
        "languageProbability": info.language_probability,
        "requestedLanguage": args.language,
        "duration": info.duration,
        "device": device,
        "computeType": compute_type,
        "segments": [
            {"id": segment.id, "start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in materialized
        ],
        "diagnostics": transcript_diagnostics(materialized, info.duration),
    }
    json_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "srt": str(srt_file), "text": str(text_file), "json": str(json_file), "segments": len(materialized)}, ensure_ascii=False))
    return 0


def choose_runtime(requested_device, requested_compute):
    import ctranslate2

    device = requested_device
    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    compute_type = requested_compute
    if compute_type == "auto":
        compute_type = "float16" if device == "cuda" else "int8"
    return device, compute_type


def run_model(model_class, model_path, source, args, device, compute_type):
    model = model_class(str(model_path), device=device, compute_type=compute_type)
    return model.transcribe(str(source), **transcription_options(args.language, args.beam_size, True))


def transcription_options(language="auto", beam_size=5, condition_on_previous_text=True, max_new_tokens=None):
    requested = str(language or "auto").strip().lower()
    normalized_max_new_tokens = None
    if max_new_tokens not in (None, ""):
        # Previous-text prompts can occupy roughly half of Whisper's 448-token window.
        normalized_max_new_tokens = max(32, min(220, int(max_new_tokens)))
    return {
        "language": None if requested in ("", "auto") else requested,
        "beam_size": max(1, min(10, int(beam_size or 5))),
        "temperature": 0.0,
        "repetition_penalty": 1.05,
        "no_repeat_ngram_size": 3,
        "vad_filter": True,
        "vad_parameters": {
            "min_speech_duration_ms": 150,
            "min_silence_duration_ms": 500,
            "speech_pad_ms": 400,
        },
        "max_new_tokens": normalized_max_new_tokens,
        "hallucination_silence_threshold": 2.0,
        "word_timestamps": True,
        "condition_on_previous_text": bool(condition_on_previous_text),
    }


def transcript_diagnostics(segments, duration):
    total_duration = max(0.0, float(duration or 0.0))
    intervals = sorted((max(0.0, float(item.start)), max(0.0, float(item.end))) for item in segments if float(item.end) >= float(item.start))
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    speech_seconds = sum(max(0.0, end - start) for start, end in merged)
    gaps = []
    for index in range(1, len(merged)):
        gap = merged[index][0] - merged[index - 1][1]
        if gap >= 8.0:
            gaps.append({"start": round(merged[index - 1][1], 3), "end": round(merged[index][0], 3), "seconds": round(gap, 3)})
    warnings = []
    if not intervals:
        warnings.append("No speech segments were recognized; verify that the source contains audible speech and retry with the correct audio track.")
    elif total_duration >= 60 and speech_seconds / total_duration < 0.04:
        warnings.append("Recognized speech occupies less than 4% of the audio. This may be music/silence, a wrong audio track, or incomplete recognition.")
    return {
        "sentenceCount": len(segments),
        "speechSeconds": round(speech_seconds, 3),
        "speechCoverage": round(speech_seconds / total_duration, 4) if total_duration else 0,
        "firstSpeechAt": round(intervals[0][0], 3) if intervals else None,
        "lastSpeechAt": round(intervals[-1][1], 3) if intervals else None,
        "largeGapCount": len(gaps),
        "largestGaps": sorted(gaps, key=lambda item: item["seconds"], reverse=True)[:8],
        "warnings": warnings,
    }


def write_srt(file, segments):
    lines = []
    for index, segment in enumerate(segments, start=1):
        lines.extend([
            str(index),
            f"{srt_time(segment.start)} --> {srt_time(segment.end)}",
            segment.text.strip(),
            "",
        ])
    file.write_text("\n".join(lines), encoding="utf-8")


def write_timestamped_text(file, segments):
    lines = [
        f"[{srt_time(segment.start)} --> {srt_time(segment.end)}] {segment.text.strip()}"
        for segment in segments
        if segment.text.strip()
    ]
    file.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")


def sentence_segments(segments, offset=0.0, starting_id=0):
    result = []
    parts = []
    sentence_start = None
    sentence_end = None
    fallback_start = None
    fallback_end = None
    previous_word_end = None
    for segment in segments:
        segment_start = getattr(segment, "start", 0)
        segment_end = getattr(segment, "end", segment_start)
        words = list(getattr(segment, "words", None) or [])
        if not words:
            flush_sentence(result, parts, starting_id, sentence_start, sentence_end, fallback_start, fallback_end, offset)
            parts = []
            sentence_start = None
            sentence_end = None
            fallback_start = None
            fallback_end = None
            previous_word_end = None
            append_sentence(result, starting_id, segment_start, segment_end, getattr(segment, "text", ""), offset)
            continue
        fallback_start = segment_start if fallback_start is None else fallback_start
        fallback_end = segment_end
        for word in words:
            text = str(getattr(word, "word", "") or "")
            if not text:
                continue
            if not parts and fallback_start is None:
                fallback_start = segment_start
            fallback_end = segment_end
            start = getattr(word, "start", None)
            end = getattr(word, "end", None)
            if parts and start is not None and previous_word_end is not None and float(start) - float(previous_word_end) >= 1.2:
                append_sentence(result, starting_id, sentence_start, sentence_end if sentence_end is not None else previous_word_end, "".join(parts), offset)
                parts = []
                sentence_start = None
                sentence_end = None
                fallback_start = segment_start
                fallback_end = segment_end
            if sentence_start is None:
                sentence_start = start if start is not None else segment_start
            if end is not None:
                sentence_end = end
                previous_word_end = end
            parts.append(text)
            if re.search(r"[。！？!?；;]+[”’\"')】》]*\s*$", "".join(parts)):
                append_sentence(result, starting_id, sentence_start, sentence_end if sentence_end is not None else segment_end, "".join(parts), offset)
                parts = []
                sentence_start = None
                sentence_end = None
                fallback_start = None
                fallback_end = None
                previous_word_end = None
            elif len("".join(parts)) >= 180 or ((sentence_end or segment_end) - (sentence_start or segment_start)) >= 24:
                # Keep punctuation-free speech bounded while preserving actual word timestamps.
                append_sentence(result, starting_id, sentence_start or segment_start, sentence_end or segment_end, "".join(parts), offset)
                parts = []
                sentence_start = None
                sentence_end = None
                fallback_start = None
                fallback_end = None
                previous_word_end = None
    flush_sentence(result, parts, starting_id, sentence_start, sentence_end, fallback_start, fallback_end, offset)
    for index, item in enumerate(result, start=starting_id):
        item.id = index
    return result


def flush_sentence(target, parts, starting_id, sentence_start, sentence_end, fallback_start, fallback_end, offset):
    if not parts:
        return
    append_sentence(
        target,
        starting_id,
        sentence_start if sentence_start is not None else fallback_start,
        sentence_end if sentence_end is not None else fallback_end,
        "".join(parts),
        offset,
    )


def append_sentence(target, starting_id, start, end, text, offset):
    content = str(text or "").strip()
    if not content:
        return
    safe_start = max(0.0, float(start or 0.0) + float(offset or 0.0))
    safe_end = max(safe_start, float(end if end is not None else start or 0.0) + float(offset or 0.0))
    target.append(SimpleNamespace(id=starting_id + len(target), start=safe_start, end=safe_end, text=content))


def srt_time(seconds):
    total_ms = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
