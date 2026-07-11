# Third-Party Notices

Star Owner (星藏家) is licensed under `GPL-3.0-or-later`. Third-party components remain under their own licenses; the project license does not replace or relicense them. A portable release is an aggregate containing separate executables, libraries, models, and application code.

This inventory is a practical release checklist, not legal advice. Release publishers should review the upstream terms again when dependency versions change.

## Desktop and JavaScript Runtime

| Component | Pinned/current version | License | Role / upstream |
| --- | --- | --- | --- |
| Electron | 43.1.0 | MIT | Desktop runtime, [electron/electron](https://github.com/electron/electron) |
| Mermaid | 11.16.0 | MIT | Offline mind-map rendering, [mermaid-js/mermaid](https://github.com/mermaid-js/mermaid) |
| markdown-it | 14.3.0 | MIT | Markdown parsing, [markdown-it/markdown-it](https://github.com/markdown-it/markdown-it) |
| mammoth | 1.11.0 | BSD-2-Clause | DOCX text extraction for RAG attachments, [mwilliamson/mammoth.js](https://github.com/mwilliamson/mammoth.js) |
| pdf-parse | 1.1.1 | MIT | PDF text extraction for RAG attachments, [autokent/pdf-parse](https://gitlab.com/autokent/pdf-parse) |
| sql.js | 1.14.1 | MIT | SQLite/WASM persistence, [sql-js/sql.js](https://github.com/sql-js/sql.js) |

The npm dependency tree also contains MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, Python-2.0, and similarly permissive transitive packages. Their package license files are preserved inside bundled `node_modules`; `package-lock.json` is the authoritative version inventory.

## Python, ASR, and Models

| Component | Version | License | Role / upstream |
| --- | --- | --- | --- |
| CPython | 3.12.13 | PSF License | Project-local Python runtime, [python/cpython](https://github.com/python/cpython) |
| faster-whisper | 1.2.1 | MIT | Speech recognition, [SYSTRAN/faster-whisper](https://github.com/SYSTRAN/faster-whisper) |
| CTranslate2 | 4.8.1 | MIT | GPU/CPU inference, [OpenNMT/CTranslate2](https://github.com/OpenNMT/CTranslate2) |
| PyAV | 18.0.0 | BSD-3-Clause | Audio/video decoding, [PyAV-Org/PyAV](https://github.com/PyAV-Org/PyAV) |
| NumPy | 2.5.1 | BSD-3-Clause and bundled notices | PCM and tensor processing, [numpy/numpy](https://github.com/numpy/numpy) |
| huggingface-hub | 1.23.0 | Apache-2.0 | Model snapshot acquisition for source builds |
| ONNX Runtime | 1.27.0 | MIT | Tokenizer/runtime support |
| imageio-ffmpeg / FFmpeg | 0.6.0 / 7.1 essentials build | BSD-2-Clause wrapper / GPL-3.0-or-later binary | Project-local FFmpeg provider, [imageio/imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg), [FFmpeg](https://ffmpeg.org/) |
| yt-dlp | 2026.07.04 | Unlicense | Project-local media acquisition module, [yt-dlp/yt-dlp](https://github.com/yt-dlp/yt-dlp) |
| `Systran/faster-whisper-small` | revision `536b0662742c02347bc0e980a01041f333bce120` | MIT | Built-in low-latency multilingual ASR model |
| `Systran/faster-whisper-medium` | revision `08e178d48790749d25932bbc082711ddcfdfbc4f` | MIT | Default balanced multilingual ASR model |

Model files are data artifacts and are published as release payloads rather than committed to Git. Their repository/model-card terms must be retained in any redistributed model archive.

## NVIDIA Runtime

The GPU bundle contains `nvidia-cublas-cu12` 12.9.2.10, `nvidia-cuda-nvrtc-cu12` 12.9.86, and `nvidia-cudnn-cu12` 9.24.0.43. These are **not open-source** and remain governed by the NVIDIA CUDA Toolkit and cuDNN redistribution terms (`LicenseRef-NVIDIA-Proprietary`). They are separate runtime components used by CTranslate2. Do not describe the entire portable archive as containing only open-source software.

Users who cannot or do not want to accept the NVIDIA terms should use a CPU-only release assembled without these packages. CPU ASR is slower and remains disabled by default in the application.

## GPL Corresponding Source

The prepared runtime's imageio-ffmpeg 0.6.0 executable reports `ffmpeg version 7.1-essentials_build-www.gyan.dev` with `--enable-gpl --enable-version3`. A publisher distributing it must satisfy GPL source obligations. At minimum:

1. Publish the exact application source corresponding to the release tag.
2. Preserve `LICENSE` and this notice in the binary archive.
3. Publish or provide a durable written offer for the corresponding FFmpeg 7.1 source and the GPL-covered linked build inputs. Start from [FFmpeg 7.1 source](https://ffmpeg.org/releases/ffmpeg-7.1.tar.xz) and the build provenance at [gyan.dev FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/).
4. Keep the source offer available for the period required by GPLv3 section 6.

The safest GitHub release layout is to attach the portable core archive, model archive, both SHA-256 files, a corresponding-source archive/source offer, and this notice to the same release. Splitting the model for GitHub's file-size limit does not change any component's license.

## Online Services

Bilibili Web APIs and websites are accessed at runtime but are not redistributed software. Their use is governed by Bilibili's terms and applicable law. Users are responsible for their own accounts, cookies, downloaded media, and publication rights.
