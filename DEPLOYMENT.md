# Deployment Guide

Version: `1.4.6`

## 1. Portable Release for Users

Download `Star-Owner-v<version>-win-x64-core.zip` from GitHub Releases, extract the complete archive to a writable short local directory such as `D:\Star-Owner`, and double-click `Start-StarOwner.cmd` in the extracted root. Do not run it from the ZIP preview. The portable archive does not require a global Node.js, Python, FFmpeg or SQLite installation.

Do not install under a directory that the current user cannot modify. The portable application writes only to its project directory, registered Workspace libraries, and Electron user data required for the persistent Bilibili WebView partition.

On first launch:

1. The main window opens immediately.
2. SQLite and the default Workspace initialize.
3. After the portable backend first becomes ready, the application creates a `星藏家.lnk` shortcut on the current user's Desktop. It records completion in SQLite and does not recreate a shortcut deleted by the user; moving the complete portable directory allows the new location to replace the old shortcut on its next successful launch.
4. The Renderer waits for the portable backend ready signal before hydrating “B站之外” tools or offering dependency actions, so startup does not produce premature multi-part/tool-service errors.
5. The application checks project-local runtime, required large-v3-turbo package, optional small package, FFmpeg, yt-dlp and VC++ runtime.
6. Missing required packages trigger an in-app download prompt.
7. Downloads come from this repository's Release assets, show progress, retain `.partial` files, retry transient failures with backoff, and resume with HTTP Range requests.
8. Verification prefers the SHA-256 digest in GitHub Release asset metadata. If the unauthenticated API is unavailable, the predictable direct URL fallback fetches the matching `.sha256` before downloading the large archive. A complete archive is retained across checksum-network failures and reused on retry; unverified content is never installed.
9. Verified archives extract into staging and commit atomically below `runtime/`. Successful installation deletes the archive, refreshes ASR and tool health immediately, and an interrupted installation rolls back on next startup.
10. Users may instead download a model ZIP manually and choose `设置 -> 应用设置 -> 项目依赖包 -> 从本地导入`. The application cancels the same model's automatic download, validates the exact baseline filename, official SHA-256 and archive layout, then uses the same atomic installer. Do not extract the ZIP manually.
11. Shared-document upload uses `runtime/git/cmd/git.exe` from the same portable package. It does not use a global Git, SSH configuration, HOME, credential helper or user Git config. The primary GitHub authorization button opens the default browser through the bundled Git Credential Manager and forces credential storage into the application's private DPAPI directory; pasted Fine-grained Token remains available as a fallback. Clearing authorization deletes only this private store and the encrypted application record, never Windows Credential Manager or global Git data.
12. The shared target repository is persisted independently of local mounts only after its `_star-owner-repository.json`, identity, default branch and capabilities pass validation. Verified repositories appear in the application registry and the active repository is health-checked when the tool opens. Users can connect an accessible public or private compliant repository, or create a public repository in the authenticated account with README, policy files, PR template and validation/catalog Actions. Repository creation/validation, catalog reads, mounts and synchronization expose visible progress. An upload is limited to 1000 documents and 1 GiB, locks the application behind a progress modal, and can be cancelled; cancellation terminates GitHub/Git work and cleans recognizable temporary branches and checkout directories.

Release dependency assets:

```text
Star-Owner-v<dependency-version>-runtime-win-x64.zip
Star-Owner-v<dependency-version>-runtime-win-x64.zip.sha256
Star-Owner-v<dependency-version>-model-small.zip
Star-Owner-v<dependency-version>-model-small.zip.sha256
Star-Owner-v<dependency-version>-model-large-v3-turbo.zip
Star-Owner-v<dependency-version>-model-large-v3-turbo.zip.sha256
```

The application version and dependency version are independent. `package.json.dependencyReleaseVersion` is copied into `portable-manifest.json` and controls API lookup, direct fallback URLs, local-import Release links and exact accepted asset names. Version `1.4.6` uses the unchanged published `v1.0.0` runtime, required Turbo and optional small assets. The historical v1.0.0 medium asset remains available for older applications and is not used by the current dependency registry. The core archive also contains the project-local Git runtime used for shared Fork/PR uploads.

### Updating and migrating an existing installation

For a portable installation, use `设置 -> 应用更新与迁移 -> 检查更新`. Only the GitHub `latest` stable Release is eligible. The application downloads the core archive with retry and Range continuation, verifies its SHA-256, inspects archive paths, stages it, and uses the staged package's helper to replace the complete application file set, including `templates` and the newly packaged project-local `runtime/git`. `workspace/`, the ASR/runtime directories other than `runtime/git`, and `.updates/` are retained; a failed transaction rolls back and records the result for the next launch. An `operation-journal.json` left by an interrupted helper is surfaced on the next startup instead of being silently ignored.

To move data from a v1.0.3 or newer installation, first stop all Agents and close the old application. Copy the complete old project directory to a short new location, start the new release, and use `设置 -> 应用更新与迁移 -> 从旧版目录迁移`. The application validates the source SQLite database and version, backs up the target workspace, migrates it atomically, and can restore the backup if the operation fails. Never copy only individual artifact folders or mix two live installations against the same workspace. Each project copy now gets an independent Bilibili login partition; a blank copy does not inherit another copy's cookies.

## 2. Hardware and ASR

Supported packaged CPU runtime: Windows x64.

Recommended local ASR capacity:

| Model | CUDA compute | NVIDIA total | Free before load | CPU system memory |
| --- | --- | ---: | ---: | ---: |
| small | `float16` | 2048 MiB | 1536 MiB | 6144 MiB |
| large-v3-turbo | `int8_float16` | 3072 MiB | 2048 MiB | 8192 MiB |

The application automatically checks:

- whether `nvidia-smi` reports an NVIDIA adapter;
- total/free GPU memory;
- whether project-local CTranslate2 detects a CUDA device;
- whether faster-whisper and the selected model are installed;
- OS, CPU architecture, memory and thread count for CPU fallback.

The CUDA lane is disabled when these checks fail. CPU ASR is disabled by default and can be enabled only when the packaged CPU environment is supported. If neither path is valid, starting an internal video Agent is blocked with concrete diagnostic reasons. The application never resolves the media or shared-document tools through a global Node, Python, FFmpeg, yt-dlp or Git.

An 8GB laptop RTX 4070 is suitable for the default `large-v3-turbo` model with one persistent CUDA lane. Multiple video workflows may run concurrently, but ASR requests queue through the selected lane. CPU mode is an explicit alternative and is never loaded beside CUDA ASR. On that adapter, three real Bilibili samples measured about 1348 MiB Turbo peak allocation over baseline; lower-memory devices still need enough free memory for Windows display use and other applications.

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
runtime/models/large-v3-turbo/
```

The application does not require a global FFmpeg, yt-dlp, Python virtual environment or SQLite native binary. Desktop media tools also use the bundled Electron executable in Node mode and never resolve a global `node.exe` through `PATH`.

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

For an ordinary code-only maintenance Release, build only the core archive:

```powershell
npm run package:core
```

`package:core` omits new runtime/model archives and records the pinned dependency Release in the portable manifest. Use `package:portable` only when publishing a new dependency baseline.

The builder verifies required runtime files, model files, license notices, package version consistency and machine-specific path hygiene before producing assets. It removes virtual-environment activation scripts that embed the build location and rejects staged text files containing the builder's project or user-profile path. At application startup, the bundled Python home is repaired to the current extraction directory.

## 6. Release Checklist

1. Ensure `package.json` and `package-lock.json` versions match.
2. Update README, DESIGN, DEPLOYMENT, AGENTS, SECURITY and CODE_REVIEW for changed contracts.
3. Run `npm run verify:release`.
4. Inspect `git status` for cookies, logs, Workspace artifacts, test databases, model keys and local paths.
5. Build portable archives only when a Release is requested.
6. Verify archive extraction in a clean directory.
7. Check shortcuts, icon, first-run dependency prompt, login persistence, both themes and one real video workflow.
8. For a code-only Release, upload only the core ZIP and checksum. Keep `dependencyReleaseVersion` pinned to the compatible dependency Release; publish new model/runtime assets only when their content or layout changes.
9. Write the GitHub Release title and body in a UTF-8 Markdown file (prefer UTF-8 without BOM). When updating through PowerShell/API, send UTF-8 bytes explicitly; do not use the shell's default `Out-File`/`Set-Content` encoding for Chinese text. After publishing, read the Release back and verify the title, body and unchanged asset names before announcing it.

## 7. Verification Commands

Focused gates:

```powershell
npm run smoke
npm run test:knowledge-api
npm run test:hardware
npm run test:runtime-node
npm run test:runtime-isolation
npm run test:internal-agent
npm run test:document-lifecycle
npm run test:collection-sync
npm run test:security
npm run test:asr-models
npm run test:asr-service
npm run test:local-toolbox
```

The aggregate verifier also runs scheduler, RAG, task rollback, video cache, image clipboard, persistence, Bilibili client, ASR timestamp format, local toolbox media/document import, runtime isolation, analytics, JavaScript/Python syntax and `npm audit --audit-level=high`.

## 8. Troubleshooting

### Automatic ASR model download is slow

Open the dependency Release linked by a model name in Settings. For version `1.4.6`, the required published package is `Star-Owner-v1.0.0-model-large-v3-turbo.zip`; `Star-Owner-v1.0.0-model-small.zip` is the optional alternate. Keep the ZIP intact and click `从本地导入` on the matching row. The historical medium filename is only for older releases. The application stops an active automatic download for that model and removes its managed cache. A downloading model can be paused from the same row; pausing preserves the `.partial` file for a later ranged resume. Importing while downloading or paused first cancels the automatic transfer and removes its managed partial/install residue, but never removes the source ZIP selected by the user. A wrong version, wrong model, damaged file, modified archive or unexpected layout is rejected with the correct Release URL; an already healthy model remains installed.

### Windows reports a path-too-long risk

Stop every Agent and close the application. Copy the **entire extracted project directory** to a short location such as `D:\Star-Owner`, start it there, and verify tasks, documents and login state before deleting the old copy. Do not move only `workspace/`. On the first start from the new location, `workspace/orchestrator.sqlite` automatically relocates paths below the built-in Workspace; registered external libraries remain unchanged. Video names are automatically sanitized and shortened to at least 24 characters, but a Workspace that cannot fit even that minimum is rejected with `WINDOWS_PATH_TOO_LONG`.

### Chinese child-process logs contain replacement characters

Version `1.0.4` forces project Python tools to UTF-8 and uses streaming UTF-8 decoders for tool, dependency and ASR output. Characters already stored as `�` by an older version cannot be reconstructed; reproduce the command after upgrading to obtain a clean log.

### Application starts but video Agent cannot run

Open `设置 -> 应用设置 -> 资源调度`. Check the ASR compatibility card for project runtime, model, NVIDIA/CUDA, memory and CPU details. Install the required Turbo package, choose `small`, or switch to the independent CPU ASR mode when CUDA is unavailable.

### NVIDIA is detected but CUDA ASR is unavailable

Confirm the driver exposes the GPU through `nvidia-smi`, then run:

```powershell
runtime\faster-whisper\Scripts\python.exe tools\faster-whisper-cli.py --model large-v3-turbo --health
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
