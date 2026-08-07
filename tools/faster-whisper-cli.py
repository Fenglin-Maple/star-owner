#!/usr/bin/env python
import argparse
import json
import math
import os
import platform
import re
import shutil
import sys
import time
import unicodedata
from pathlib import Path
from types import SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_ROOT = PROJECT_ROOT / "runtime"
MODELS_ROOT = RUNTIME_ROOT / "models"
HF_CACHE_ROOT = RUNTIME_ROOT / "cache" / "huggingface"
VC_RUNTIME_ROOT = RUNTIME_ROOT / "vc-runtime"
DEFAULT_MODEL = "large-v3-turbo"
# 模型下载完成标记：staging 目录内文件清单校验通过后才写入，
# 随 staging 原子改名一起进入正式目录，作为「完整下载」的凭证。
DOWNLOAD_COMPLETE_MARKER = ".download-complete"

# Apple Silicon 上使用 MLX 推理后端（GPU 加速）；其它平台保持 faster-whisper/CTranslate2。
IS_APPLE_SILICON = sys.platform == "darwin" and platform.machine().lower() == "arm64"

GPU_COMPUTE_TYPES = {
    "large-v3-turbo": "int8_float16",
    "turbo": "int8_float16",
}

# MLX 版模型仓库（HuggingFace mlx-community）
MLX_MODEL_REPOS = {
    "small": "mlx-community/whisper-small-mlx",
    "medium": "mlx-community/whisper-medium-mlx",
    "turbo": "mlx-community/whisper-large-v3-turbo",
    "large-v3-turbo": "mlx-community/whisper-large-v3-turbo",
}

DLL_HANDLES = []


class AsrOutputError(ValueError):
    """Raised when Whisper produced sentence data that cannot be materialized safely."""

    code = "ASR_OUTPUT_INVALID"
    failure_kind = "task"


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
        parser.error("audio path is required unless --health or --download-model is used")
    return transcribe(args)


def build_parser():
    parser = argparse.ArgumentParser(description="Project-local Whisper CLI (MLX on Apple Silicon, faster-whisper elsewhere)")
    parser.add_argument("audio", nargs="?", help="Input audio or video file")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--language", default="auto")
    parser.add_argument("--output_dir", default=".")
    parser.add_argument("--output_format", choices=["srt", "txt", "all"], default="all")
    parser.add_argument("--device", choices=["auto", "cuda", "cpu", "mlx"], default="auto")
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


def validate_model_files(path):
    """校验模型目录的完整文件清单：config.json + 权重文件必须齐全且非空。

    返回 (ok, missing, files)。small/large-v3-turbo 等不同模型的权重形态不同：
    faster-whisper 为 model.bin，MLX 为 weights.npz 或 *.safetensors 全集。
    """
    missing = []
    files = []
    if not path.is_dir():
        return False, ["目录不存在"], []
    config = path / "config.json"
    if not config.is_file() or config.stat().st_size == 0:
        missing.append("config.json（缺失或为空）")
    else:
        files.append(config.name)
    weights = []
    for name in ("model.bin", "weights.npz"):
        item = path / name
        if item.is_file():
            weights.append(item)
    weights.extend(sorted(path.glob("*.safetensors")))
    if not weights:
        missing.append("权重文件（model.bin / weights.npz / *.safetensors 均缺失）")
    else:
        for item in weights:
            if item.stat().st_size == 0:
                missing.append(f"{item.name}（为空）")
            else:
                files.append(item.name)
    return (not missing), missing, files


def model_ready(path):
    # 结构完整即视为可用：staging + 原子改名保证正式目录里不会出现半成品，
    # 因此这里只需做文件清单（含非空）校验。
    ok, _missing, _files = validate_model_files(path)
    return ok


def versions():
    if IS_APPLE_SILICON:
        import importlib.metadata as metadata
        import mlx
        import mlx_whisper

        return {
            "fasterWhisper": mlx_whisper.__version__,
            "ctranslate2": metadata.version("mlx"),
            "cudaDevices": 0,
            "mlxAvailable": True,
        }
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
    target = model_dir(model_name)
    HF_CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    target.parent.mkdir(parents=True, exist_ok=True)

    # staging 目录与正式目录同文件系统（同父目录），保证 os.rename 原子
    staging = target.parent / f".staging-{target.name}-{os.getpid()}"

    # 中断清理：先清掉同模型残留的旧 staging（上次被 kill -9 / 崩溃中断留下的）。
    # 放在幂等判断之前：即使本次跳过下载，也顺带清扫残留，保证不留下半成品目录。
    stale_prefix = f".staging-{target.name}-"
    for entry in target.parent.iterdir():
        if entry.name.startswith(stale_prefix) and entry != staging:
            print(f"清理上次中断下载残留的 staging 目录：{entry}", file=sys.stderr)
            shutil.rmtree(entry, ignore_errors=True)

    # 幂等：目标正式目录已存在且文件清单完整 → 直接跳过。
    # staging + 原子改名保证正式目录里只会出现完整模型，因此完整即可信。
    if model_ready(target):
        print(f"模型 {model_name} 已存在且完整，跳过下载：{target}", file=sys.stderr)
        print(json.dumps({"ok": True, "model": model_name, "modelPath": str(target), "skipped": True}, ensure_ascii=False))
        return 0

    # 目标存在但不完整：说明是历史半成品下载。只自动清理受管 models 目录下的；
    # 用户自定义路径不完整时不自动删除，避免误删用户数据。
    if target.exists():
        if str(target.resolve()).startswith(str(MODELS_ROOT.resolve())):
            print(f"检测到不完整的旧下载，清理后重新下载：{target}", file=sys.stderr)
            shutil.rmtree(target, ignore_errors=True)
        else:
            raise RuntimeError(f"目标目录已存在但不完整，请手动清理后重试：{target}")

    try:
        print(f"开始下载模型 {model_name}（staging：{staging}）", file=sys.stderr)
        if IS_APPLE_SILICON:
            from huggingface_hub import snapshot_download

            repository = MLX_MODEL_REPOS.get(str(model_name).lower()) or f"mlx-community/whisper-{model_name}"
            snapshot_download(repository, local_dir=str(staging))
        else:
            from faster_whisper.utils import download_model as fetch_model

            fetch_model(model_name, output_dir=str(staging), cache_dir=str(HF_CACHE_ROOT))

        print(f"校验模型文件清单：{model_name}", file=sys.stderr)
        ok, missing, files = validate_model_files(staging)
        if not ok:
            raise RuntimeError(f"模型下载不完整，缺少文件：{', '.join(missing)}")

        # 完成标记：文件清单校验通过后才写入，随原子改名进入正式目录
        marker = staging / DOWNLOAD_COMPLETE_MARKER
        marker.write_text(
            json.dumps(
                {
                    "model": model_name,
                    "backend": "mlx" if IS_APPLE_SILICON else "faster-whisper",
                    "files": files,
                    "completedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                },
                ensure_ascii=False,
                indent=2,
            )
            + "\n",
            encoding="utf-8",
        )

        print(f"校验通过，原子改名 staging → 正式目录：{target}", file=sys.stderr)
        if target.exists() and not model_ready(target):
            # 防御：下载期间目标被其它进程创建了不完整目录
            shutil.rmtree(target, ignore_errors=True)
        if target.exists():
            # 竞态兜底：目标已完整（其它进程刚下载完成），丢弃 staging 直接复用
            print(f"目标目录已由其它进程完成，复用现有目录：{target}", file=sys.stderr)
            shutil.rmtree(staging, ignore_errors=True)
        else:
            os.rename(str(staging), str(target))
        print(f"模型下载完成：{target}", file=sys.stderr)
    except BaseException:
        # 中断清理：异常/被中断时删除当前 staging，避免半成品残留
        if staging.exists():
            print(f"下载失败，清理 staging 目录：{staging}", file=sys.stderr)
            shutil.rmtree(staging, ignore_errors=True)
        raise

    print(json.dumps({"ok": True, "model": model_name, "modelPath": str(target)}, ensure_ascii=False))
    return 0


def transcribe(args):
    source = Path(args.audio).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"input file does not exist: {source}")
    target_model = model_dir(args.model)
    if not model_ready(target_model):
        raise RuntimeError(f"model is not installed: {target_model}; run with --download-model first")

    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    device, compute_type = choose_runtime(args.device, args.compute_type, args.model)
    print(f"Loading {target_model.name} on {device} ({compute_type})", file=sys.stderr)

    try:
        segments, info = run_model(target_model, source, args, device, compute_type)
        materialized, normalization = normalize_sentence_segments(sentence_segments(list(segments)))
    except Exception as error:
        if IS_APPLE_SILICON or args.device != "auto" or device == "cpu":
            raise
        print(f"CUDA inference failed, retrying on CPU int8: {error}", file=sys.stderr)
        device, compute_type = "cpu", "int8"
        segments, info = run_model(target_model, source, args, device, compute_type)
        materialized, normalization = normalize_sentence_segments(sentence_segments(list(segments)))

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
        "diagnostics": transcript_diagnostics(materialized, info.duration, normalization),
    }
    json_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "srt": str(srt_file), "text": str(text_file), "json": str(json_file), "segments": len(materialized)}, ensure_ascii=False))
    return 0


def choose_runtime(requested_device, requested_compute, model_name=DEFAULT_MODEL):
    if IS_APPLE_SILICON:
        # MLX 默认走 Metal GPU；显式 --device cpu 时强制 CPU 推理（mx.set_default_device(mx.cpu)，实测有效）。
        # 注意：darwin 上 'cuda' 语义映射为 MLX 通道（与 JS 侧一致）；Intel Mac 不满足 IS_APPLE_SILICON，走下方 faster-whisper 原逻辑。
        return ("cpu" if requested_device == "cpu" else "mlx"), "fp16"
    import ctranslate2

    device = requested_device
    if device == "auto":
        device = "cuda" if ctranslate2.get_cuda_device_count() > 0 else "cpu"
    compute_type = requested_compute
    if compute_type == "auto":
        compute_type = GPU_COMPUTE_TYPES.get(str(model_name).lower(), "float16") if device == "cuda" else "int8"
    return device, compute_type


def mlx_force_cpu():
    """Apple Silicon 上把 MLX 默认设备强制为 CPU，返回是否真的切到了 CPU。

    实测（mlx 0.32.0 / mlx_whisper 0.4.3）：mx.set_default_device(mx.cpu) 有效，
    推理正常且结果正确（解码约 82 frames/s，比 Metal GPU 慢约 5 倍）；
    环境变量 MLX_CPU_ONLY=1 对 default_device 无效（仍为 gpu），不要依赖。
    """
    if not IS_APPLE_SILICON:
        return False
    import mlx.core as mx

    mx.set_default_device(mx.cpu)
    return True


def run_model(model_path, source, args, device, compute_type):
    options = transcription_options(args.language, args.beam_size, True)
    if IS_APPLE_SILICON:
        import mlx_whisper

        if device == "cpu":
            mlx_force_cpu()
        # 先加载音频获取真实时长，再交给 MLX 推理（Metal GPU，或 --device cpu 时的强制 CPU）。
        audio = mlx_whisper.audio.load_audio(str(source))
        duration = max(0.0, float(len(audio)) / 16000.0)
        result = mlx_whisper.transcribe(audio, path_or_hf_repo=str(model_path), **options)
        segments = [to_segment(entry) for entry in result.get("segments") or []]
        info = SimpleNamespace(
            language=str(result.get("language") or ""),
            language_probability=1.0,
            duration=duration,
        )
        return segments, info
    from faster_whisper import WhisperModel

    model = WhisperModel(str(model_path), device=device, compute_type=compute_type)
    return model.transcribe(str(source), **transcription_options(args.language, args.beam_size, True))


def to_segment(entry):
    """把 MLX 的 dict 段包装成与原 faster-whisper segment 对象兼容的结构。"""
    wrapped = {key: value for key, value in entry.items() if key != "words"}
    # mlx_whisper 0.4.x 的 words 不含标点（引擎不输出标点 token），且段边界由时间戳驱动、
    # 本身就是句子级粒度；置空 words 让 sentence_segments 直接采用段边界，
    # 避免无标点时按 24s/180 字兜底造成长句不切分。
    wrapped["words"] = None
    return SimpleNamespace(**wrapped)


def transcription_options(
    language="auto",
    beam_size=5,
    condition_on_previous_text=True,
    max_new_tokens=None,
    vad_min_silence_duration_ms=500,
    vad_speech_pad_ms=400,
    hallucination_silence_threshold=2.0,
):
    requested = str(language or "auto").strip().lower()
    if IS_APPLE_SILICON:
        # MLX 0.4.x：language/beam_size/temperature 走 decode_options（DecodingOptions），
        # condition_on_previous_text/word_timestamps/hallucination_silence_threshold 是 transcribe 层参数；
        # 不支持 faster-whisper 的 repetition_penalty/no_repeat_ngram_size/VAD，跳过以免 TypeError。
        return {
            "language": None if requested in ("", "auto") else requested,
            # mlx_whisper 0.4.x：beam_size 传任何值都会触发未实现的 beam search，
            # 必须不传（None）才走 GreedyDecoder。
            "temperature": 0.0,
            "condition_on_previous_text": bool(condition_on_previous_text),
            "word_timestamps": True,
            "hallucination_silence_threshold": max(0.1, min(5.0, float(hallucination_silence_threshold or 2.0))),
        }
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
            "min_silence_duration_ms": max(100, min(2000, int(vad_min_silence_duration_ms or 500))),
            "speech_pad_ms": max(0, min(1000, int(vad_speech_pad_ms or 0))),
        },
        "max_new_tokens": normalized_max_new_tokens,
        "hallucination_silence_threshold": max(0.1, min(5.0, float(hallucination_silence_threshold or 2.0))),
        "word_timestamps": True,
        "condition_on_previous_text": bool(condition_on_previous_text),
    }


def transcript_diagnostics(segments, duration, normalization=None):
    total_duration = max(0.0, float(duration or 0.0))
    intervals = sorted((max(0.0, float(item.start)), max(0.0, float(item.end))) for item in segments if float(item.end) >= float(item.start))
    merged = []
    for start, end in intervals:
        if merged and start <= merged[-1][1]:
            merged[-1][1] = max(merged[-1][1], end)
        else:
            merged.append([start, end])
    covered = sum(end - start for start, end in merged)
    speech_seconds = covered
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
    # 上游 v1.6.2 原版字段（sentenceCount/speechSeconds/...）与 mac 适配新增字段（duration/segmentCount/...）并存，
    # 保持旧字段兼容（review 建议），同时保留新字段供后续消费。
    payload = {
        "duration": total_duration,
        "segmentCount": len(segments),
        "coveredSeconds": covered,
        "coverageRatio": round(covered / total_duration, 4) if total_duration > 0 else 0.0,
        "sentenceCount": len(segments),
        "speechSeconds": round(speech_seconds, 3),
        "speechCoverage": round(speech_seconds / total_duration, 4) if total_duration else 0,
        "firstSpeechAt": round(intervals[0][0], 3) if intervals else None,
        "lastSpeechAt": round(intervals[-1][1], 3) if intervals else None,
        "largeGapCount": len(gaps),
        "largestGaps": sorted(gaps, key=lambda item: item["seconds"], reverse=True)[:8],
        "warnings": warnings,
    }
    if normalization is not None:
        payload["normalization"] = normalization
    return payload


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


def normalize_sentence_segments(segments, starting_id=0):
    source = list(segments or [])
    result = []
    report = {
        "sourceSentenceCount": len(source),
        "sentenceCount": 0,
        "droppedEmptyCount": 0,
        "mergedDuplicateCount": 0,
        "mergedOverlapCount": 0,
        "adjustedStartCount": 0,
    }
    for source_index, item in enumerate(source):
        content = str(getattr(item, "text", "") or "").strip()
        if not content:
            report["droppedEmptyCount"] += 1
            continue
        start = finite_timestamp(getattr(item, "start", None), source_index, "start")
        end = finite_timestamp(getattr(item, "end", None), source_index, "end")
        if start < 0:
            start = 0.0
            report["adjustedStartCount"] += 1
        if end < start:
            raise AsrOutputError(f"ASR sentence {source_index + 1} ends before it starts: {start} > {end}")
        current = SimpleNamespace(id=0, start=start, end=end, text=content)
        if not result:
            result.append(current)
            continue

        previous = result[-1]
        if current.start <= previous.end and duplicate_text_relation(previous.text, current.text):
            previous_text = comparable_text(previous.text)
            current_text = comparable_text(current.text)
            selected_text = current.text if len(current_text) >= len(previous_text) else previous.text
            previous.start = min(previous.start, current.start)
            previous.end = max(previous.end, current.end)
            previous.text = selected_text
            report["mergedDuplicateCount"] += 1
            continue

        if current.start < previous.start:
            if current.end <= previous.end:
                previous.text = join_segment_text(previous.text, current.text)
                report["mergedOverlapCount"] += 1
                continue
            current.start = previous.end
            report["adjustedStartCount"] += 1
        result.append(current)

    for index, item in enumerate(result):
        if index > 0 and item.start < result[index - 1].start:
            item.start = result[index - 1].end
            report["adjustedStartCount"] += 1
        if item.end < item.start:
            raise AsrOutputError(f"ASR sentence {index + 1} cannot be normalized: {item.start} > {item.end}")
        item.id = starting_id + index
    report["sentenceCount"] = len(result)
    report["applied"] = any(report[key] for key in (
        "droppedEmptyCount",
        "mergedDuplicateCount",
        "mergedOverlapCount",
        "adjustedStartCount",
    ))
    return result, report


def finite_timestamp(value, source_index, label):
    try:
        number = float(value)
    except (TypeError, ValueError) as error:
        raise AsrOutputError(f"ASR sentence {source_index + 1} has an invalid {label} timestamp") from error
    if not math.isfinite(number):
        raise AsrOutputError(f"ASR sentence {source_index + 1} has a non-finite {label} timestamp")
    return number


def comparable_text(value):
    return "".join(
        character.casefold()
        for character in str(value or "")
        if not character.isspace() and not unicodedata.category(character).startswith(("P", "S"))
    )


def duplicate_text_relation(left, right):
    left_value = comparable_text(left)
    right_value = comparable_text(right)
    if min(len(left_value), len(right_value)) < 6:
        return False
    return left_value in right_value or right_value in left_value


def join_segment_text(left, right):
    left_value = str(left or "").rstrip()
    right_value = str(right or "").lstrip()
    if not left_value:
        return right_value
    if not right_value:
        return left_value
    separator = "" if is_cjk(left_value[-1]) or is_cjk(right_value[0]) else " "
    return f"{left_value}{separator}{right_value}"


def is_cjk(character):
    codepoint = ord(character)
    return (
        0x3400 <= codepoint <= 0x4DBF
        or 0x4E00 <= codepoint <= 0x9FFF
        or 0x3040 <= codepoint <= 0x30FF
        or 0xAC00 <= codepoint <= 0xD7AF
    )


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
    safe_start = float(start if start is not None else 0.0) + float(offset or 0.0)
    safe_end = float(end if end is not None else (start if start is not None else 0.0)) + float(offset or 0.0)
    target.append(SimpleNamespace(id=starting_id + len(target), start=safe_start, end=safe_end, text=content))


def srt_time(seconds):
    total_ms = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, milliseconds = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{milliseconds:03d}"


def write_srt(file, segments):
    lines = []
    for index, segment in enumerate(segments):
        lines.append(str(index + 1))
        lines.append(f"{srt_time(segment.start)} --> {srt_time(segment.end)}")
        lines.append(str(segment.text).strip())
        lines.append("")
    file.write_text("\n".join(lines), encoding="utf-8")


def write_timestamped_text(file, segments):
    lines = [f"[{srt_time(segment.start)} --> {srt_time(segment.end)}] {segment.text.strip()}" for segment in segments]
    file.write_text(("\n".join(lines) + "\n") if lines else "", encoding="utf-8")


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
    except Exception as error:
        print(json.dumps({"ok": False, "error": str(error)}, ensure_ascii=False), file=sys.stderr)
        raise SystemExit(1)
