# Deployment Guide

Version: `0.10.0`

## 1. Portable Release for Users

Download `Star-Owner-v<version>-win-x64-core.zip` from GitHub Releases, extract the complete archive to a writable local directory, and double-click `Start-StarOwner.cmd` in the extracted root. Do not run it from the ZIP preview. The portable archive does not require a global Node.js, Python, FFmpeg or SQLite installation.

Do not install under a directory that the current user cannot modify. The portable application writes only to its project directory, registered Workspace libraries, and Electron user data required for the persistent Bilibili WebView partition.

On first launch:

1. The main window opens immediately.
2. SQLite and the default Workspace initialize.
3. After the portable backend first becomes ready, the application creates a `星藏家.lnk` shortcut on the current user's Desktop. It records completion in SQLite and does not recreate a shortcut deleted by the user; moving the complete portable directory allows the new location to replace the old shortcut on its next successful launch.
4. The application checks project-local runtime, faster-whisper, both model packages, FFmpeg, yt-dlp and VC++ runtime.
5. Missing required packages trigger an in-app download prompt.
6. Downloads come from this repository's Release assets, show progress, verify SHA-256 when available, stage extraction, and commit under `runtime/`.
7. Interrupted installation rolls back on next startup.

Release dependency assets:

```text
Star-Owner-v<version>-runtime-win-x64.zip
Star-Owner-v<version>-runtime-win-x64.zip.sha256
Star-Owner-v<version>-model-small.zip
Star-Owner-v<version>-model-small.zip.sha256
Star-Owner-v<version>-model-medium.zip
Star-Owner-v<version>-model-medium.zip.sha256
```

A code-only Release may reuse unchanged dependency assets from one of the recent Releases; users do not need to redownload packages already installed and healthy.

## 2. Hardware and ASR

Supported packaged CPU runtime: Windows x64.

Recommended local ASR capacity:

| Model | NVIDIA GPU memory | CPU system memory |
| --- | ---: | ---: |
| small | 2048 MiB | 6144 MiB |
| medium | 4096 MiB | 8192 MiB |

The application automatically checks:

- whether `nvidia-smi` reports an NVIDIA adapter;
- total/free GPU memory;
- whether project-local CTranslate2 detects a CUDA device;
- whether faster-whisper and the selected model are installed;
- OS, CPU architecture, memory and thread count for CPU fallback.

The CUDA lane is disabled when these checks fail. CPU ASR is disabled by default and can be enabled only when the packaged CPU environment is supported. If neither path is valid, starting an internal video Agent is blocked with concrete diagnostic reasons.

An 8GB laptop RTX 4070 is suitable for the default `medium` model with one persistent CUDA lane. Multiple video workflows may run concurrently, but ASR requests queue through the shared lane.

## 3. Source Setup

Requirements:

- Windows 10/11 x64;
- Node.js 22 or newer;
- PowerShell;
- Git;
- optional NVIDIA GPU and current driver.

```powershell
git clone https://github.com/Fenglin-Maple/star-owner.git
cd star-owner
npm install
npm start
```

Install or repair the complete ASR runtime:

```powershell
npm run setup:asr
```

Everything is installed below the repository:

```text
runtime/python/
runtime/faster-whisper/
runtime/vc-runtime/
runtime/models/small/
runtime/models/medium/
```

The application does not require a global FFmpeg, yt-dlp, Python virtual environment or SQLite native binary.

## 4. External Knowledge API

The local HTTP API is read-only. It is for external Codex, Claude Code, OpenCode or other Agent applications that need to inspect completed knowledge; it is not a video task execution API.

Default base URL:

```text
http://127.0.0.1:17391
```

Discover the current protocol:

```http
GET /api/manifest
```

Core endpoints:

```http
GET /api/knowledge/catalog
GET /api/knowledge/documents?offset=0&limit=100
GET /api/knowledge/documents/<documentId>
GET /api/knowledge/documents/<documentId>/content?startLine=1&lineCount=400
GET /api/knowledge/documents/<documentId>/assets
GET /api/knowledge/documents/<documentId>/assets/<assetId>
GET /api/knowledge/search?q=<query>&limit=20
```

Deployment rules for external clients:

1. Run on the same machine as the desktop application.
2. Read the manifest on every new integration version.
3. List catalog or document metadata before reading large content.
4. Follow `nextOffset` and `nextStartLine` pagination.
5. Use exact Markdown as source of truth; search snippets only identify candidates.
6. Use returned asset URLs and opaque asset IDs; do not access Workspace paths.
7. Distinguish `publishedAt`, `favoriteAddedAt`, `completedAt`, and `favoriteMembership`.
8. Handle stable JSON errors by HTTP status and `code`.
9. Do not send write methods or attempt old video workflow calls.

Retired endpoints under `/api/workers`, `/api/tasks`, `/api/tools`, `/api/tool-runs`, `/api/active-collection`, `/api/scheduler`, and related paths return:

```text
HTTP 410
EXTERNAL_VIDEO_WORKFLOW_DISABLED
```

The service binds to `127.0.0.1` and rejects unrelated browser Origin headers. It has no authentication against other processes on the same computer. Do not proxy, port-forward or expose it to a LAN/public network without adding authentication, authorization, TLS and a fresh threat review.

## 5. Build a Portable Archive

Run the release gate first:

```powershell
npm run verify:release
```

Build the portable archives:

```powershell
npm run package:portable
```

The builder verifies required runtime files, model files, license notices, package version consistency and machine-specific path hygiene before producing assets.

## 6. Release Checklist

1. Ensure `package.json` and `package-lock.json` versions match.
2. Update README, DESIGN, DEPLOYMENT, AGENTS, SECURITY and CODE_REVIEW for changed contracts.
3. Run `npm run verify:release`.
4. Inspect `git status` for cookies, logs, Workspace artifacts, test databases, model keys and local paths.
5. Build portable archives only when a Release is requested.
6. Verify archive extraction in a clean directory.
7. Check shortcuts, icon, first-run dependency prompt, login persistence, both themes and one real video workflow.
8. Upload only changed Release assets. Unchanged model/runtime assets may remain from a compatible recent Release.

## 7. Verification Commands

Focused gates:

```powershell
npm run smoke
npm run test:knowledge-api
npm run test:hardware
npm run test:internal-agent
npm run test:document-lifecycle
npm run test:collection-sync
npm run test:security
npm run test:asr-service
```

The aggregate verifier also runs scheduler, RAG, task rollback, video cache, image clipboard, persistence, Bilibili client, ASR timestamp format, analytics, JavaScript/Python syntax and `npm audit --audit-level=high`.

## 8. Troubleshooting

### Application starts but video Agent cannot run

Open `设置 -> 应用设置 -> 资源调度`. Check the ASR compatibility card for project runtime, model, NVIDIA/CUDA, memory and CPU fallback details. Install missing packages or choose `small` if the current GPU/RAM cannot support `medium`.

### NVIDIA is detected but CUDA ASR is unavailable

Confirm the driver exposes the GPU through `nvidia-smi`, then run:

```powershell
runtime\faster-whisper\Scripts\python.exe tools\faster-whisper-cli.py --model medium --health
```

The JSON should report `modelReady: true` and at least one CUDA device. Repair dependencies in Settings if imports or DLL loading fail.

### CPU ASR switch is disabled

CPU ASR is intentionally unavailable when the selected model is missing, the packaged environment is not Windows x64, system memory is below the recommendation, or the runtime health check fails.

### Knowledge API returns 409

The indexed Markdown or asset directory is missing, unreadable, outside a registered Workspace, or no longer a regular managed file. Refresh the document library, verify the Workspace registration, and restore the artifact from backup if needed. The API never follows arbitrary paths.

### Knowledge search returns partial results

One request reached the 128 MiB scan budget. Filter by user, collection, BV, tag or date, then repeat search or read exact selected documents.

### Port 17391 is occupied

The server automatically selects an available local port. Read the current address from the title bar, Startup prompt, Runtime settings or Agent Tool Status page.

### Collection sync was interrupted

On restart the application restores the previous complete snapshot from `collectionSyncTransactions` and logs the rollback. Run synchronization again. Related internal workflows remain stopped until the user restarts them.

### Single-video duplicate prompt appears

The selected internal collection already contains a completed output for the same BV. Choose abandon to preserve it, or overwrite to remove it and generate one replacement. Deleting that document from Document Library removes the duplicate state entirely.
