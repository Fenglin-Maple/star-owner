#!/usr/bin/env python
import argparse
import importlib.util
import json
import sys
import time
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CLI_FILE = PROJECT_ROOT / "tools" / "faster-whisper-cli.py"


def load_cli_module():
    spec = importlib.util.spec_from_file_location("star_note_faster_whisper_cli", CLI_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Persistent Xing Cang Jia faster-whisper service")
    parser.add_argument("--device", choices=["cuda", "cpu"], required=True)
    parser.add_argument("--compute-type", required=True)
    parser.add_argument("--model", default="medium")
    args = parser.parse_args()

    cli = load_cli_module()
    from faster_whisper import WhisperModel

    model_path = cli.model_dir(args.model)
    if not cli.model_ready(model_path):
        raise RuntimeError(f"model is not installed: {model_path}")
    started = time.perf_counter()
    model = WhisperModel(str(model_path), device=args.device, compute_type=args.compute_type)
    emit({
        "event": "ready",
        "device": args.device,
        "computeType": args.compute_type,
        "model": args.model,
        "modelPath": str(model_path),
        "loadMs": round((time.perf_counter() - started) * 1000),
    })

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        request = {}
        try:
            request = json.loads(raw)
            request_id = str(request.get("id") or "")
            action = request.get("action")
            if action == "shutdown":
                emit({"id": request_id, "ok": True, "status": "stopping"})
                return
            if action == "health":
                emit({"id": request_id, "ok": True, "status": "ready", "device": args.device, "model": args.model})
                continue
            if action != "transcribe":
                raise ValueError(f"unknown action: {action}")
            emit(transcribe(model, cli, args, request_id, request))
        except Exception as error:
            emit({"id": request.get("id", ""), "ok": False, "error": str(error)})


def transcribe(model, cli, args, request_id, request):
    source = Path(request["audio"]).resolve()
    output_dir = Path(request["outputDir"]).resolve()
    if not source.is_file():
        raise FileNotFoundError(f"audio does not exist: {source}")
    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    emit({"event": "progress", "id": request_id, "phase": "audio-loading", "progress": 0})
    segments, info = model.transcribe(
        str(source),
        language=None if request.get("language") == "auto" else request.get("language", "zh"),
        beam_size=max(1, int(request.get("beamSize", 1))),
        temperature=0.0,
        repetition_penalty=1.05,
        no_repeat_ngram_size=3,
        vad_filter=True,
        max_new_tokens=max(32, int(request.get("maxNewTokens", 64))),
        hallucination_silence_threshold=2.0,
        word_timestamps=True,
        condition_on_previous_text=bool(request.get("conditionOnPreviousText", False)),
    )
    total_duration = max(0.0, float(getattr(info, "duration", 0.0) or 0.0))
    emit({"event": "progress", "id": request_id, "phase": "audio-loaded", "progress": 0, "totalSeconds": total_duration})
    recognized = []
    for segment_index, segment in enumerate(segments):
        recognized.append(segment)
        processed_seconds = min(total_duration, max(0.0, float(getattr(segment, "end", 0.0) or 0.0))) if total_duration else 0.0
        emit({
            "event": "progress",
            "id": request_id,
            "phase": "segment-completed",
            "segmentIndex": segment_index,
            "segmentCount": len(recognized),
            "audioSeconds": processed_seconds,
            "totalSeconds": total_duration,
            "progress": min(1, processed_seconds / total_duration) if total_duration else 1,
        })
    materialized = cli.sentence_segments(recognized)
    emit({
        "event": "progress",
        "id": request_id,
        "phase": "transcription-completed",
        "segmentCount": len(materialized),
        "audioSeconds": total_duration,
        "totalSeconds": total_duration,
        "progress": 1,
    })
    srt_file = output_dir / "transcript.srt"
    text_file = output_dir / "asr-transcript.txt"
    json_file = output_dir / "asr-result.json"
    cli.write_srt(srt_file, materialized)
    cli.write_timestamped_text(text_file, materialized)
    payload = {
        "model": args.model,
        "source": str(source),
        "language": info.language,
        "languageProbability": info.language_probability,
        "duration": total_duration,
        "device": args.device,
        "computeType": args.compute_type,
        "segments": [
            {"id": item.id, "start": item.start, "end": item.end, "text": item.text.strip()}
            for item in materialized
        ],
    }
    json_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "id": request_id,
        "ok": True,
        "device": args.device,
        "computeType": args.compute_type,
        "duration": total_duration,
        "segments": len(materialized),
        "elapsedMs": round((time.perf_counter() - started) * 1000),
        "srt": str(srt_file),
        "text": str(text_file),
        "json": str(json_file),
    }


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        emit({"event": "fatal", "ok": False, "error": str(error)})
        raise SystemExit(1)
