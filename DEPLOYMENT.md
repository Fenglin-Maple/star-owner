# Deployment Guide

This guide has two paths: a dependency-free portable build for ordinary users, and a reproducible source setup for developers and release maintainers. All paths are relative to the repository root.

## 1. Portable Release for Users

Recommended GitHub release asset:

```text
StarNote-BiliNote-v<version>-win-x64-small.zip
```

The `small` portable archive contains Electron, all npm dependencies, Mermaid, FFmpeg, yt-dlp, CPython 3.12, faster-whisper, CTranslate2, CUDA/cuDNN runtime libraries, and the multilingual `small` model. Users do not install Node.js, Python, FFmpeg, yt-dlp, CUDA Toolkit, or a model downloader.

Usage:

1. Read `THIRD_PARTY_NOTICES.md`, especially the NVIDIA runtime terms.
2. Extract the archive to a writable directory. Do not run it from inside the ZIP.
3. Double-click `Start-StarNote.cmd`.
4. Log in from the application's Bilibili WebView and select a default Workspace.
5. Windows may show an unknown-publisher warning until releases are code-signed.

The application creates `workspace/` beside itself and uses only project-relative runtime paths. Moving the extracted directory is supported. User cookies, SQLite data, task artifacts, and generated Markdown are never included in a public release archive.

### Hardware

- Windows 10/11 x64.
- An NVIDIA driver capable of the bundled CUDA 12 runtime is recommended for GPU ASR.
- The default `small` model is intended for 8GB laptop GPUs.
- CPU ASR can be enabled manually in Settings, but it is slower and disabled by default.

## 2. Source Setup for Developers

Requirements for building from source:

- Git
- Node.js 22 or newer
- npm
- PowerShell 5.1 or newer
- `uv` for creating the project-local Python runtime

```powershell
git clone <repository-url>
cd bili-agent-orchestrator
npm ci
npm run setup:asr
npm run verify:release
npm start
```

`npm run setup:asr` installs Python, CUDA Python wheels, faster-whisper, and both models under `runtime/`. It does not install them globally. `runtime-requirements.txt` pins the ASR environment.

## 3. Build a Portable Archive

First prepare the complete project-local runtime, then run:

```powershell
npm ci
npm run setup:asr
npm run verify:release
npm run package:portable
```

The output is written below `dist/`, which is excluded from Git.

Available model modes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle none
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle small
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle all
```

- `small`: recommended public release, immediately usable and normally easier to keep below GitHub's per-asset limit.
- `none`: core runtime for a separately published model archive.
- `all`: includes both models and may exceed GitHub's 2GB per-file limit. Publish core and model archives separately if warned.

The builder copies only application/runtime inputs. It creates a fresh empty `workspace/`; it never copies the maintainer's SQLite database, cookies, downloaded videos, generated documents, logs, or shortcuts.

## 4. Agent Deployment and API Use

Start the desktop application before connecting an Agent. The local API defaults to:

```text
http://127.0.0.1:17391
```

An Agent should:

1. `GET /api/manifest`
2. `POST /api/workers/register`
3. save the returned `workerId`
4. `GET /api/active-collection`
5. `POST /api/tasks/claim`
6. invoke tools only through the returned application API
7. submit validated artifacts and let the application finalize paths

See `AGENTS.md` for the complete worker and contributor contract.

## 5. GitHub Release Checklist

1. Run `npm run verify:release`.
2. Confirm `git status` contains no `workspace/`, `runtime/`, `node_modules/`, logs, archives, SQLite files, cookies, or machine-specific shortcuts.
3. Build the portable archive and verify its SHA-256 file.
4. Test extraction and launch in a clean Windows account or VM.
5. Attach `LICENSE`, `THIRD_PARTY_NOTICES.md`, and GPL corresponding-source/source-offer material.
6. Publish the source from the exact Git tag used to build the binary.
7. Do not upload credentials, Bilibili cookies, account names, task databases, or generated media without permission.

## 6. Troubleshooting

- Tool health is visible on the Startup page.
- GPU queue state and memory are visible in Settings and `GET /api/scheduler`.
- If a portable build says Electron is missing, the archive was assembled incorrectly; do not ask the user to run `npm install` inside it.
- If the GPU service cannot start, update the NVIDIA driver or enable CPU ASR after reviewing the performance tradeoff.
- If Mermaid cannot render a diagram, the document preview shows a local error and the source block; correct the Mermaid syntax rather than loading a CDN.
