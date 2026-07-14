import importlib.util
import tempfile
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parent.parent
CLI_FILE = ROOT / "tools" / "faster-whisper-cli.py"


def load_cli():
    spec = importlib.util.spec_from_file_location("star_owner_asr_format", CLI_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    cli = load_cli()
    defaults = cli.build_parser().parse_args([])
    assert defaults.language == "auto" and defaults.beam_size == 5
    options = cli.transcription_options()
    assert options["language"] is None
    assert options["beam_size"] == 5 and options["max_new_tokens"] == 448
    assert options["condition_on_previous_text"] is True
    raw = [SimpleNamespace(
        start=1.2,
        end=5.6,
        text="第一句话。第二句话！",
        words=[
            SimpleNamespace(start=1.2, end=2.0, word="第一句"),
            SimpleNamespace(start=2.0, end=2.4, word="话。"),
            SimpleNamespace(start=3.1, end=4.5, word="第二句"),
            SimpleNamespace(start=4.5, end=5.6, word="话！"),
        ],
    )]
    segments = cli.sentence_segments(raw, offset=10.0)
    assert len(segments) == 2
    assert segments[0].text == "第一句话。" and segments[0].start == 11.2 and segments[0].end == 12.4
    assert segments[1].text == "第二句话！" and segments[1].start == 13.1 and segments[1].end == 15.6

    across_raw_segments = [
        SimpleNamespace(start=20.0, end=21.5, text="这是跨段的", words=[
            SimpleNamespace(start=20.0, end=20.8, word="这是"),
            SimpleNamespace(start=20.8, end=21.5, word="跨段的"),
        ]),
        SimpleNamespace(start=21.5, end=23.0, text="完整句子。", words=[
            SimpleNamespace(start=21.5, end=22.3, word="完整"),
            SimpleNamespace(start=22.3, end=23.0, word="句子。"),
        ]),
    ]
    across = cli.sentence_segments(across_raw_segments)
    assert len(across) == 1
    assert across[0].text == "这是跨段的完整句子。"
    assert across[0].start == 20.0 and across[0].end == 23.0

    paused = cli.sentence_segments([
        SimpleNamespace(start=30.0, end=34.0, text="无标点口语", words=[
            SimpleNamespace(start=30.0, end=30.8, word="第一句无标点"),
            SimpleNamespace(start=32.3, end=34.0, word="第二句也无标点"),
        ])
    ])
    assert len(paused) == 2
    assert paused[0].start == 30.0 and paused[0].end == 30.8
    assert paused[1].start == 32.3 and paused[1].end == 34.0

    japanese = cli.sentence_segments([SimpleNamespace(
        start=40.0,
        end=44.0,
        text="これは日本語です。次の文です！",
        words=[
            SimpleNamespace(start=40.0, end=42.0, word="これは日本語です。"),
            SimpleNamespace(start=42.2, end=44.0, word="次の文です！"),
        ],
    )])
    assert len(japanese) == 2 and japanese[0].text == "これは日本語です。"

    diagnostics = cli.transcript_diagnostics([
        SimpleNamespace(start=1.0, end=3.0),
        SimpleNamespace(start=15.0, end=18.0),
    ], 30.0)
    assert diagnostics["speechSeconds"] == 5.0
    assert diagnostics["largeGapCount"] == 1 and diagnostics["largestGaps"][0]["seconds"] == 12.0

    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        srt = root / "transcript.srt"
        text = root / "asr-transcript.txt"
        cli.write_srt(srt, segments)
        cli.write_timestamped_text(text, segments)
        srt_value = srt.read_text(encoding="utf-8")
        text_value = text.read_text(encoding="utf-8")
        assert "00:00:11,200 --> 00:00:12,400" in srt_value
        assert "[00:00:13,100 --> 00:00:15,600] 第二句话！" in text_value

    print("ASR sentence timestamp format test passed")


if __name__ == "__main__":
    main()
