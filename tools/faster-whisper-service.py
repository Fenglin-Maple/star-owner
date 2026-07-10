#!/usr/bin/env python
import argparse
import importlib.util
import json
import sys
import time
import wave
from pathlib import Path
from types import SimpleNamespace


PROJECT_ROOT = Path(__file__).resolve().parent.parent
CLI_FILE = PROJECT_ROOT / "tools" / "faster-whisper-cli.py"


def load_cli_module():
    spec = importlib.util.spec_from_file_location("star_note_faster_whisper_cli", CLI_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser(description="Persistent Star Owner faster-whisper service")
    parser.add_argument("--device", choices=["cuda", "cpu"], required=True)
    parser.add_argument("--compute-type", required=True)
    parser.add_argument("--model", default="large-v3-turbo")
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
    import numpy as np

    try:
        with wave.open(str(source), "rb") as input_wave:
            if input_wave.getnchannels() != 1 or input_wave.getsampwidth() != 2 or input_wave.getframerate() != 16000:
                raise ValueError("non-canonical wav")
            audio = np.frombuffer(input_wave.readframes(input_wave.getnframes()), dtype=np.int16).astype(np.float32) / 32768.0
    except (wave.Error, ValueError):
        from faster_whisper.audio import decode_audio
        audio = decode_audio(str(source), sampling_rate=16000)
    total_duration = len(audio) / 16000
    emit({"event": "progress", "id": request_id, "phase": "audio-loaded", "progress": 0, "totalSeconds": total_duration})
    chunk_seconds = max(5, int(request.get("chunkLength", 10)))
    chunk_samples = chunk_seconds * 16000
    materialized = []
    detected_language = request.get("language", "zh")
    language_probability = 1.0
    for chunk_index, chunk_start in enumerate(range(0, len(audio), chunk_samples)):
        offset = chunk_start / 16000
        chunk = audio[chunk_start:chunk_start + chunk_samples]
        chunk_file = output_dir / f".asr-chunk-{chunk_index:04d}.wav"
        pcm = (chunk.clip(-1, 1) * 32767).astype("int16")
        with wave.open(str(chunk_file), "wb") as target:
            target.setnchannels(1)
            target.setsampwidth(2)
            target.setframerate(16000)
            target.writeframes(pcm.tobytes())
        emit({
            "event": "progress",
            "id": request_id,
            "phase": "chunk-started",
            "chunkIndex": chunk_index,
            "audioSeconds": offset,
            "totalSeconds": total_duration,
            "progress": min(1, offset / total_duration) if total_duration else 0,
        })
        try:
            segments, info = model.transcribe(
                str(chunk_file),
                language=None if request.get("language") == "auto" else request.get("language", "zh"),
                beam_size=max(1, int(request.get("beamSize", 1))),
                temperature=0.0,
                repetition_penalty=1.05,
                no_repeat_ngram_size=3,
                vad_filter=True,
                max_new_tokens=max(32, int(request.get("maxNewTokens", 64))),
                hallucination_silence_threshold=2.0,
                condition_on_previous_text=bool(request.get("conditionOnPreviousText", False)),
            )
            chunk_segments = list(segments)
        finally:
            chunk_file.unlink(missing_ok=True)
        detected_language = info.language
        language_probability = info.language_probability
        for item in chunk_segments:
            materialized.append(SimpleNamespace(
                id=len(materialized),
                start=item.start + offset,
                end=item.end + offset,
                text=item.text,
            ))
        processed_seconds = min(total_duration, offset + len(chunk) / 16000)
        emit({
            "event": "progress",
            "id": request_id,
            "phase": "chunk-completed",
            "chunkIndex": chunk_index,
            "segmentCount": len(materialized),
            "audioSeconds": processed_seconds,
            "totalSeconds": total_duration,
            "progress": min(1, processed_seconds / total_duration) if total_duration else 1,
        })
    srt_file = output_dir / "transcript.srt"
    text_file = output_dir / "asr-transcript.txt"
    json_file = output_dir / "asr-result.json"
    cli.write_srt(srt_file, materialized)
    text_file.write_text("\n".join(item.text.strip() for item in materialized if item.text.strip()) + "\n", encoding="utf-8")
    payload = {
        "model": args.model,
        "source": str(source),
        "language": detected_language,
        "languageProbability": language_probability,
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
