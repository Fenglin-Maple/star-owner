#!/usr/bin/env python
import argparse
import json
import os
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_ROOT = PROJECT_ROOT / "runtime"
MODELS_ROOT = RUNTIME_ROOT / "models"
HF_CACHE_ROOT = RUNTIME_ROOT / "cache" / "huggingface"
DEFAULT_MODEL = "medium"
DLL_HANDLES = []


def configure_project_dlls():
    if os.name != "nt":
        return
    site_packages = Path(sys.prefix) / "Lib" / "site-packages"
    project_site_packages = RUNTIME_ROOT / "faster-whisper" / "Lib" / "site-packages"
    candidates = [
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
    parser.add_argument("--language", default="zh")
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
        materialized = list(segments)
    except Exception as error:
        if args.device != "auto" or device == "cpu":
            raise
        print(f"CUDA inference failed, retrying on CPU int8: {error}", file=sys.stderr)
        device, compute_type = "cpu", "int8"
        segments, info = run_model(WhisperModel, target_model, source, args, device, compute_type)
        materialized = list(segments)

    srt_file = output_dir / "transcript.srt"
    text_file = output_dir / "asr-transcript.txt"
    json_file = output_dir / "asr-result.json"
    write_srt(srt_file, materialized)
    text_file.write_text("\n".join(segment.text.strip() for segment in materialized if segment.text.strip()) + "\n", encoding="utf-8")
    payload = {
        "model": args.model,
        "modelPath": str(target_model),
        "source": str(source),
        "language": info.language,
        "languageProbability": info.language_probability,
        "duration": info.duration,
        "device": device,
        "computeType": compute_type,
        "segments": [
            {"id": segment.id, "start": segment.start, "end": segment.end, "text": segment.text.strip()}
            for segment in materialized
        ],
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
    return model.transcribe(
        str(source),
        language=None if args.language == "auto" else args.language,
        beam_size=max(1, args.beam_size),
        vad_filter=True,
        condition_on_previous_text=True,
    )


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
