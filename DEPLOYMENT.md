# Deployment Guide

This guide has two paths: a dependency-free portable build for ordinary users, and a reproducible source setup for developers and release maintainers. All paths are relative to the repository root.

## 1. Portable Release for Users

Recommended GitHub release assets:

```text
Star-Owner-v<version>-win-x64-core.zip
Star-Owner-v<version>-runtime-win-x64.zip
Star-Owner-v<version>-model-small.zip
Star-Owner-v<version>-model-medium.zip
```

The core archive contains Electron, all npm dependencies, Mermaid, and may include the base media/ASR runtime for immediate startup. The runtime repair asset contains `runtime/python` and `runtime/faster-whisper`; model assets preserve `runtime/models/<model>` paths. Assets remain separate because complete Windows distributions can exceed GitHub's 2GB per-file limit. Users do not install Node.js, Python, FFmpeg, yt-dlp, CUDA Toolkit, packages, or a model downloader.

Usage:

1. Read `THIRD_PARTY_NOTICES.md`, especially the NVIDIA runtime terms.
2. Extract the core archive to a writable directory. Do not run it from inside the ZIP.
3. Double-click `Start-StarOwner.cmd`.
4. If a required runtime or model is missing, accept the first-start prompt. The app downloads the matching assets from this repository's Releases, verifies SHA-256 when published, checks archive paths, and installs only under `runtime/`.
5. Download progress and repair controls remain available in `设置 -> 项目依赖包`. Manual overlay extraction is still supported for offline installations.
6. Log in from the application's Bilibili WebView and select a default Workspace.
7. Windows may show an unknown-publisher warning until releases are code-signed.

The AI features do not require another local model runtime. Open `AI -> AI 模型配置`, add an OpenAI-compatible or NewAPI-compatible provider, enter the API root (commonly ending in `/v1`), save it, pull the remote model list, and enable one or more models. This shared configuration powers `AI -> RAG 知识库助手`, `Agent 视频总结工作流`, and `视频总结（单个）`. Multiple providers and enabled models can be saved. API keys remain in the local application database in Electron `safeStorage` form where supported and are never included in release archives.

The application creates `workspace/` beside itself and uses only project-relative runtime paths. Moving the extracted directory is supported. Cached videos stay below the selected Workspace under the reserved internal user and selected managed cache collection. User cookies, SQLite data, cached videos, task artifacts, and generated Markdown are never included in a public release archive.

The bundled faster-whisper environment is relocated automatically. Release archives contain only a relative `pyvenv.cfg` marker; both the Electron main process and `tools/video-tool.js` rewrite its Python `home` to the current extracted directory before invoking the environment. This repair runs after the folder is moved as well as on first launch.

### Hardware

- Windows 10/11 x64.
- An NVIDIA driver capable of the bundled CUDA 12 runtime is recommended for GPU ASR.
- The default `medium` model balances recognition quality and throughput on an 8GB laptop GPU; `small` remains available as the faster, lower-memory option.
- CPU ASR can be enabled manually in Settings, but it is slower and disabled by default.

## 2. Source Setup for Developers

Requirements for building from source:

- Git
- Node.js 22 or newer
- npm
- PowerShell 5.1 or newer
- `uv` for creating the project-local Python runtime

```powershell
git clone https://github.com/Fenglin-Maple/star-owner.git
cd star-owner
npm ci
npm run setup:asr
npm run verify:release
npm start
```

The root `postinstall` only checks whether Electron's executable exists and, when needed, invokes the official `node_modules/electron/install.js`; it inherits `ELECTRON_MIRROR` and proxy environment variables. `npm run setup:asr` installs Python, CUDA Python wheels, faster-whisper, imageio-ffmpeg, yt-dlp, and both models under `runtime/`. It does not install them globally. `runtime-requirements.txt` pins the complete ASR/media environment, so `npm ci` itself does not run Python probes or media-binary downloaders.

## 3. Build a Portable Archive

First prepare the complete project-local runtime, then run:

```powershell
npm ci
npm run setup:asr
npm run verify:release
npm run package:portable
```

The output is written below `dist/`, which is excluded from Git. The default command creates the GitHub-safe portable core, runtime repair archive, and separate `small` and `medium` model ZIPs plus a SHA-256 file for each.

Available model modes:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle none
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle small
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle medium
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle all
powershell -ExecutionPolicy Bypass -File scripts/build-portable-release.ps1 -ModelBundle all -SeparateModelAsset
```

- `all -SeparateModelAsset`: recommended GitHub release; produces a core ZIP, runtime repair ZIP, and ready-to-overlay `small` and `medium` model ZIPs.
- `small` or `medium`: produces an immediately usable single-model archive for channels that permit larger files.
- `none`: core runtime for a separately published model archive.
- `all`: includes both models and is too large for GitHub as one file; add `-SeparateModelAsset` to emit the core, `small`, and `medium` assets separately.

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

When the activated collection is an internal video-cache collection, the returned task includes `cachedVideoId`, `cachedVideoFile`, and `reuseCachedMedia`. Run the same material and cleanup APIs: the application reuses the merged video and preserves it during cleanup. Do not move or delete that cached file directly.

See `AGENTS.md` for the complete worker and contributor contract.

## 5. GitHub Release Checklist

1. Run `npm run verify:release`.
2. Confirm `git status` contains no `workspace/`, `runtime/`, `node_modules/`, logs, archives, SQLite files, cookies, or machine-specific shortcuts.
3. Build the portable core/model assets and verify every SHA-256 file.
4. Test extraction and launch in a clean Windows account or VM.
5. Attach `LICENSE`, `THIRD_PARTY_NOTICES.md`, and GPL corresponding-source/source-offer material beside both release assets.
6. Publish the source from the exact Git tag used to build the binary.
7. Do not upload credentials, Bilibili cookies, account names, task databases, or generated media without permission.

Before a public release, also verify the RAG supplier dialog, remote model pull against a test-compatible endpoint, one streaming response, one knowledge search, restricted-mode approval, and context compression. Never configure a maintainer API key in the database used to assemble a release.

Also verify one internal collection Agent and one single-task run with a disposable compatible provider: confirm streamed output, Worker accounting, material-tool queueing, Markdown validation, cache cleanup, the canonical `内置用户/<内置收藏夹>` archive, and the second copy in the requested external directory. Remove the test provider and test Workspace before building release assets.

### Release asset contract for in-app installation

Publish all dependency assets under the same tagged Release as the portable core whenever possible. The app first looks for exact `v<app version>` filenames, then checks latest and recent releases for a compatible filename pattern. Dependency archives must begin with `runtime/`; absolute paths and `..` are rejected. For compatibility with an older Release lacking a dedicated runtime asset, the app may select its portable core archive but extracts only the two validated runtime subtrees.

```text
Star-Owner-v<version>-runtime-win-x64.zip
Star-Owner-v<version>-runtime-win-x64.zip.sha256
Star-Owner-v<version>-model-small.zip
Star-Owner-v<version>-model-small.zip.sha256
Star-Owner-v<version>-model-medium.zip
Star-Owner-v<version>-model-medium.zip.sha256
```

The runtime archive must contain both `runtime/python/cpython-3.12.13-windows-x86_64-none/python.exe` and `runtime/faster-whisper/Lib/site-packages/faster_whisper`. The model archives must contain `runtime/models/small/model.bin` and `runtime/models/medium/model.bin`. Without these probes, extraction succeeds but installation is reported as incomplete.

## 6. Troubleshooting

- Tool health is visible on the Startup page.
- Dependency availability, download progress, and reinstall actions are visible in Settings. A partial or failed download remains non-active and can be retried.
- GPU queue state and memory are visible in Settings and `GET /api/scheduler`.
- If a portable build says Electron is missing, the archive was assembled incorrectly; do not ask the user to run `npm install` inside it.
- If the GPU service cannot start, update the NVIDIA driver or enable CPU ASR after reviewing the performance tradeoff.
- If Mermaid cannot render a diagram, the document preview shows a local error and the source block; correct the Mermaid syntax rather than loading a CDN.
- If model pulling returns 404, the Base URL is usually one path level too high or low. It must resolve `<baseUrl>/models` and `<baseUrl>/chat/completions`.
- If `npm ci` times out while Electron itself is downloaded from GitHub, retry from a network that can reach GitHub Releases. In mainland China, a one-session mirror override is `$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'; npm ci`; do not commit personal registry or proxy settings.
- If a model returns no reasoning panel, confirm the provider exposes an explicit compatible reasoning field; the application does not reveal or synthesize hidden chain-of-thought.
- If tool calls fail, verify that the selected model really implements OpenAI-compatible function calling and that its model capability switch is enabled.
- In restricted RAG sessions, CMD and paths outside the selected sandbox intentionally wait for an in-app approval dialog.
