# 星藏家 Design

Version: `1.1.1`

## 1. Product Goal

星藏家 converts Bilibili favorites and application-managed cached videos into durable Markdown knowledge. The product is a desktop workbench, not a landing page: account login, synchronization, task controls, AI execution, media tools, documents, RAG, video playback, export, settings, and status inspection all live in one application.

The system optimizes for:

- long-running local ownership of personal knowledge;
- repeatable video-to-Markdown processing;
- safe multi-Agent concurrency inside the application;
- recoverable collection synchronization and task interruption;
- exact Markdown and image access for local RAG clients;
- project-local dependencies and portable distribution.

## 2. Core Boundaries

1. The desktop application is the only writer of SQLite, task state, Workspace indexes, artifacts, cookies, tool runs, and internal Worker records.
2. Video-summary execution is application-internal. External Agents cannot register video Workers, claim tasks, execute media tools, heartbeat, submit, or abort.
3. The public local HTTP API is read-only knowledge access across all completed Markdown documents.
4. Task Overview switches affect internal Agent claim eligibility. A disabled unfinished task is skipped; an already completed document remains readable. The filtered-only action atomically enables exactly the visible task IDs and disables every other unfinished task in the selected collection.
5. Each internal queue Agent binds its own collection. No global active external collection exists.
6. Single-video mode keeps one canonical output per internal collection/BV pair.
7. Only deletion of a completed task that still belongs to an active Bilibili favorite restores that task to pending.

## 3. Architecture

```mermaid
flowchart LR
  UI[Electron Renderer] --> IPC[Preload IPC]
  IPC --> Main[Electron Main]
  Main --> Store[(sql.js SQLite)]
  Main --> Sync[CollectionSyncService]
  Main --> Internal[InternalAgentManager]
  Main --> RAG[RagAssistant]
  Main --> Cache[VideoCacheManager]
  Main --> Docs[DocumentLifecycle]
  Internal --> Tools[ToolRunner and ResourceScheduler]
  Tools --> ASR[Persistent faster-whisper]
  Tools --> Media[yt-dlp and FFmpeg]
  Main --> API[Read-only Knowledge API]
  API --> Knowledge[KnowledgeApi]
  Knowledge --> Store
  Knowledge --> Workspace[Registered Workspace Libraries]
  External[Codex Claude OpenCode] --> API
```

Important modules:

- `src/main.js`: Electron lifecycle, secure IPC, login session, Renderer snapshots.
- `src/core/store.js`: sql.js persistence and typed record helpers.
- `src/core/collection-sync-service.js`: transactional favorite reconciliation.
- `src/core/internal-agent-manager.js`: internal queue and single-video orchestration.
- `src/core/tool-runner.js`: media tools, resource pools, leases, ASR services.
- `src/core/hardware-capabilities.js`: local ASR environment evaluation.
- `src/core/document-lifecycle.js`: managed deletion and restoration policy.
- `src/core/api-server.js`: minimal read-only local HTTP server.
- `src/core/knowledge-api.js`: knowledge catalog, exact content, search, assets.
- `src/core/rag-assistant.js`: in-app RAG sessions, tools, sandbox, compression.
- `src/core/video-cache-manager.js`: managed download queue and video library.

## 4. Persistence

The database is `workspace/orchestrator.sqlite`. sql.js exports atomically through a temporary file, fsync, backup, and recovery path. Transaction save failure restores the pre-transaction database. On portable-project relocation, the database location is authoritative for the built-in default Workspace: every absolute path below the old built-in root is recursively rewritten to the new root, while separately registered external Workspace paths remain unchanged.

Main record scopes include:

- users, collections, tasks, removedFavoriteTasks, unavailableTasks;
- workers, internalAgentSessions, taskEvents, toolRuns;
- videoCacheCollections, videoCache, videoCacheJobs;
- ragProviders, ragModels, ragSessions, ragMessages;
- workspaces, settings, activities;
- collectionSyncTransactions and submission finalization journals.

Legacy fields such as historical external activation or single-video revision markers may remain in existing databases but have no active product behavior. New code does not create external activation state or multiple single-video revisions.

## 5. Workspace Libraries

At least one Workspace is always registered and one is default. New artifacts use the default library.

```text
<workspace>/
  orchestrator.sqlite
  <user>/
    cookies/
    <collection storageName>/
      <video metadata name>/
        summary.md
        info.json
        cover.*
        frames/
        subtitles/
        asr/
        comments/
        tool-runs/
```

Collection display names may change, so path identity uses collection ID plus a persistent `storageName`. The knowledge API accepts artifacts only inside a registered Workspace real path and rejects traversal and symlink escape.

On Windows, managed paths target a 259-character compatibility ceiling. Artifact naming budgets the final repeated Markdown basename, bounded subtitle names, ASR files and a worst-case tool-run log. Metadata is sanitized for reserved characters, device names and trailing dots/spaces. A long name is reduced with a stable hash but never below 24 characters; if the minimum still cannot fit, `PathSafetyError/WINDOWS_PATH_TOO_LONG` stops the attempt with portable migration instructions. Startup evaluates the default Workspace, its existing collection roots and a conservative future collection shape before dependency prompting. RAG attachments and Markdown export paths use the same guard.

## 6. Bilibili Login

The Bilibili WebView uses `persist:bili-orchestrator`, Electron sandboxing, no Node bridge, official-domain navigation only and persistent login state. Password, SMS and QR-code login converge on the same automatic synchronization of user ID, name, avatar and cookies. Every QR-login button press reloads the official login page without cache when it is already open, or navigates to a fresh official login page, before selecting the QR panel. Video navigations are removed from the embedded login surface and opened in a separate sandboxed BrowserWindow using the same persistent partition; unrelated popups and non-Bilibili navigation remain denied.

Saved account passwords require Electron `safeStorage`. Netscape cookie files remain plaintext because yt-dlp requires them and are stored under the user Workspace hierarchy with export time metadata.

## 7. Collection Sync

When the application starts with an authenticated account, `StartupFolderProbe` requests the folder directory exactly once for that account and process. It compares only stable `mediaId` and the last successful remote reported count, returns the folder inventory to the Renderer, and queues a one-time 12-second notice for the Collection Sync page when counts differ. This read-only probe never calls `listVideos`, writes collection/task state, reconciles deletion or rename, stops Agents, or marks a collection as syncing. The user must still start the maintenance transaction below explicitly.

Synchronization is a desktop-owned maintenance transaction:

1. Resolve the immutable Bilibili collection ID and current local snapshot.
2. Persist a `collectionSyncTransactions` recovery record.
3. Mark the collection `syncing` and `syncReady=false`.
4. Stop every internal queue Agent bound to the collection.
5. Abort current attempts, cancel tools, remove attempt files, and invalidate work IDs.
6. Fetch every remote page before changing inventory and retain reported count, visible count, and visibility gap.
7. Reconcile additions, completed archives, explicit unavailable tombstones, rename state, and counts in one SQLite transaction. Missing-item removal is allowed only for a zero-gap snapshot.
8. Remove the recovery record only after commit.
9. On interruption or startup recovery, restore the previous snapshot and log the rollback.

Reconciliation policy:

- new remote item -> create pending task;
- removed unfinished item -> remove task;
- removed completed item -> keep document and mark `favoriteState=removed`;
- renamed folder -> update display/source name, retain storage identity;
- deleted remote folder -> retain completed documents, mark collection deleted, remove unfinished work, block restart;
- unavailable-video tombstone -> never recreate during later sync.
- reported count exceeds visible pagination -> merge visible additions/updates, preserve every absent local task and artifact as unresolved, expose `remoteReportedCount`, `remoteVisibleCount`, `visibilityGap`, and `preservedUnresolved`;
- a later zero-gap snapshot -> resume ordinary missing-item removal/archive reconciliation.

## 8. Internal Task Lifecycle

Queue workflow states include idle, running, draining, stopping, paused, completed, model-unavailable, unavailable, and error reporting phases.

Task claim requirements:

- selected collection exists and is dispatchable;
- Bilibili collection is sync-ready and not deleted;
- task belongs to the session collection;
- task is enabled;
- task is pending, failed, or an unowned rejected record;
- task is not excluded by the current loop.

Every claim creates a new random `workId`, work directory, claim timestamp, and 15-minute lease. The persistent Worker ID belongs to the Agent session and is reused across videos; model messages are not.

An Agent session stores collection ID plus user/collection display snapshots. Public session state prefers the live collection names and falls back to the snapshots, so event ordering, startup hydration and collection renames cannot produce an empty identity row in the workflow list.

All interruption paths converge on `abortTaskAttempt`:

- cancel queued/running tools;
- stop provider generation;
- remove attempt files or preserve registered cache sources;
- clear work ID, claim, lease, output and error fields;
- return eligible ordinary tasks to pending;
- pause the internal Worker when required.

Confirmed deleted/down/unavailable video errors use `removeUnavailableTask`, not ordinary rollback. Classification requires explicit Bilibili terminal codes (`-404`, `62002`, `62004`, `62012`) or unambiguous video removal wording. Generic file-not-found, media, ASR, network, and Markdown validation errors never create unavailable tombstones. Startup recovery restores legacy validation-error tombstones to pending work.

## 9. Single-Video Lifecycle

Single-video mode creates a normal internal task with `singleTask=true`, but duplicate handling is collection/BV scoped:

- active duplicate -> return existing session;
- completed duplicate without decision -> require explicit user decision;
- abandon -> no state change;
- overwrite -> clean the old artifact, reuse one task identity, reset output state, and process from the beginning;
- failed/pending/missing artifact -> clean and reuse from the beginning;
- no duplicate -> create a fresh task.

There is no accepted revision history. `revision` remains `1` only for compatibility with old records. Overwrite cannot leave sibling single tasks for the same collection/BV.

Deleting a completed single-video document removes all same-BV single-task siblings, linked single sessions, generated files, and task/video records. A later identical BV creates a fresh task and does not show the duplicate modal.

## 10. Document Lifecycle

`deleteCompletedDocument` owns document deletion:

| Source state | Result after deletion |
| --- | --- |
| Active Bilibili favorite | Remove generated artifacts and restore same task to pending |
| Removed Bilibili favorite | Remove artifacts and task; write removed-favorite history |
| Deleted Bilibili collection | Remove artifacts and task; do not restore |
| Single-video internal task | Remove artifact, task, linked session |
| Other local/internal task | Remove artifact and task |
| Cache-backed source | Preserve registered video, cover and cache metadata |

Restoration always uses immutable `collectionId`; collection rename cannot redirect a task.

## 11. Read-Only Knowledge API

The server binds only to `127.0.0.1`. Protocol `3.0` exposes:

```text
GET /api/manifest
GET /api/health
GET /api/knowledge/catalog
GET /api/knowledge/documents
GET /api/knowledge/documents/<documentId>
GET /api/knowledge/documents/<documentId>/content
GET /api/knowledge/documents/<documentId>/assets
GET /api/knowledge/documents/<documentId>/assets/<assetId>
GET /api/knowledge/search
```

Directory filters include user, collection, BV, title, owner, tag, publish date, favorite date, and sort order. Responses expose semantic metadata but no local paths, cookies, keys, work IDs, or mutable task internals.

Content reads are exact UTF-8 Markdown, paged by 1-based lines with a maximum page size and SHA-256. Search scans at most 128 MiB per request and reports partial results. A snippet is never presented as full source.

Assets are document-scoped raster images. The server validates artifact root, regular file, real path, size, raster signature and opaque asset ID; supported formats are PNG, JPEG, GIF, WebP and AVIF. ETag supports repeat reads.

Old external video workflow prefixes return HTTP `410` with `EXTERNAL_VIDEO_WORKFLOW_DISABLED`. Non-GET knowledge requests return `405`.

The API rejects unrelated browser Origin values and omits wildcard CORS. It does not authenticate other local processes and must not be exposed to a LAN or public network.

## 12. Tool and ASR Scheduling

Internal tools are registered in SQLite but invoked only through `ToolRunner`. Pools:

- API: Bilibili metadata/subtitles/comments with start-rate limiting;
- media: yt-dlp, FFmpeg, audio extraction and keyframes;
- disk: cleanup;
- ASR: one selected CUDA lane or one selected CPU lane; the lanes are mutually exclusive.

GPU ASR is a persistent faster-whisper service. CPU ASR is disabled by default and starts only after the user enables it.

Hardware detection combines:

- project-local Python and faster-whisper health process;
- selected `small` or `large-v3-turbo` model files; the old `medium` asset remains only in the historical dependency Release for older applications;
- CTranslate2 version and CUDA device count;
- `nvidia-smi` adapter name, total/free/used memory;
- Windows x64 CPU runtime support, system memory, CPU thread count.

Recommended thresholds:

| Model | CUDA compute | GPU total | Startup free | CPU system memory |
| --- | --- | ---: | ---: | ---: |
| small | `float16` | 2048 MiB | 1536 MiB | 6144 MiB |
| large-v3-turbo | `int8_float16` | 3072 MiB | 2048 MiB | 8192 MiB |

`src/core/asr-models.js` is the single registry for model IDs, labels, package IDs, compute types and memory gates. ToolRunner configures both model path and compute type before every persistent service start, so switching models cannot leave the process on stale quantization. A selected CUDA mode disables the CPU lane and a selected CPU mode disables the GPU lane; there is never simultaneous ASR model residency. All requests in the selected lane still share one queue.

Turbo keeps the same multilingual auto-detection, VAD, word timestamps, sentence materialization, SRT, timeline text and diagnostics as the existing models. A real RTX 4070 Laptop comparison over Chinese, English vertical-video and Japanese/music Bilibili audio measured about 1348 MiB Turbo peak allocation above baseline. The 3072 MiB total / 2048 MiB startup-free policy includes headroom beyond that observed peak and remains a capability gate rather than a universal performance guarantee.

Unsupported GPU lanes are disabled. Unsupported CPU environments disable the CPU toggle and block workflow startup when no valid ASR path exists.

Every video passes through the ASR precondition and language-detection workflow. Sources with audio produce sentence-level SRT, readable timeline text, structured segments, language/probability, coverage and silence diagnostics. A video-only source produces a successful empty diagnostic with `noAudioStream=true`; the Agent continues with station subtitles and keyframes instead of retrying an impossible extraction.

Keyframe extraction writes FFmpeg MJPEG output through an image pipe and then persists validated numbered JPEG files. It never exposes the artifact directory to FFmpeg's image-sequence pattern parser, so percent signs or other title metadata in Bilibili, cached-video, and single-video paths cannot corrupt `frame-001.jpg` naming. Material discovery accepts only concrete numbered frame files and ignores legacy pattern placeholders.

Each internal workflow stores a minimum frame count and an interval budget. The effective count is `max(minimumFrames, ceil(duration / frameIntervalSeconds))`, clamped to the supported range and with the final partial interval counted. The default is at least 12 frames and one additional budget slot per 25 seconds. A workflow may opt into `retainProcessCache`; cleanup then preserves the process video and subtitle/ASR cache while still recording disk usage and refusing new work when the protected free-space threshold is crossed.

## 13. Markdown Validation

Accepted output requires:

- Markdown and `info.json` under the assigned artifact directory;
- opening order Summary, Mind Map, Contents;
- Mermaid fenced mind map;
- substantive body and timeline links;
- subtitle comparison and ASR evidence;
- keyframe references that resolve to validated local images;
- comments section and processing record;
- temporary media cleanup unless cache preservation is explicit.

Before validation, deterministic normalization repairs frame filename placeholders against the real extracted frame inventory, rejects literal FFmpeg pattern files, canonicalizes decorated/numbered headings, and orders Summary, Mind Map, and Contents. A remaining validation failure returns the task to pending and cannot be reclassified as a missing video. When a workflow explicitly enables `retainProcessCache`, final validation disables only the temporary-media cleanup assertion because the cleanup tool has already been instructed to preserve the merged video, downloaded subtitles and ASR timestamp files. The normal cleanup path remains strict. Tool-run progress distinguishes queued work, downloader progress and FFmpeg stages; a stage with no stdout is reported as active processing rather than being presented as a fixed 29% completion state.

Finalization applies metadata naming with Windows path budgeting, move retries, copy fallback, and a recoverable journal.

## 14. Context Management

Queue Agents create a clean model request for every video. At 82% estimated context usage, or after a provider context-limit response, the same provider/model runs independent semantic map/reduce requests over every source chunk. The resulting evidence pack preserves timeline, facts, steps, parameters, code, constraints, conflicts and uncertainty. It does not alter Worker ID or work ID.

RAG sessions retain conversation history. At 75% of the model window or a lower reserve-safe input boundary, automatic compression summarizes eligible history while preserving the current user turn and avoiding duplicate resend of already summarized messages. Manual compression remains available.

## 15. RAG Assistant

RAG sessions share provider/model configuration with video Agents but have separate conversation state, sandbox, permissions and usage counters. Knowledge tools provide catalog search, exact Markdown, metadata dates and images. Restricted mode requires approval for shell commands, sandbox-external paths, default-browser opening and private-network browsing.

The UI displays only reasoning text returned by the provider. Unsupported vision, tools, reasoning, image output, compression or subagent capabilities degrade honestly.

## 16. UI Design

The application uses a custom frameless title bar, eight themes, a compact left sidebar and non-default form controls. The Endfield theme is an original, moderate-density engineering treatment built from warm neutrals, restrained signal yellow and status green; it does not redistribute game artwork, logos or proprietary fonts. Settings navigation has three levels:

```text
设置
  应用设置
  状态查询
    Agent 工作列表
    Agent 工具模块
    Agent 工具状态
```

Renderer snapshots update lightweight global metrics immediately, then schedule only the active page after the navigation frame has painted. Task, document, tool-run, Worker, export and settings DOM trees carry snapshot revisions and are rebuilt only when visible and stale. Internal-Agent streams, RAG streams and video-cache events retain backend state while hidden but do not continuously rebuild hidden surfaces. This prevents large libraries and concurrent background work from blocking pointer and navigation events. The Endfield sidebar uses its black shell with a warm-white selected row, and the optional “B站之外” root entry uses an interruptible height/opacity/position transition while preference restoration remains animation-free.

Favorite Sync keeps the last successful reported, visible, visibility-gap, unavailable, and valid-task counts under the progress bar. Task Overview has no external activation button. Its collection selector defines the inventory currently inspected, and row switches affect internal workflow claims. Mutually exclusive status segments show and filter all, pending, claimed, done, failed/rejected, and disabled tasks; text/date/duration filters compose with the selected status.

Startup is an independently scrollable page. It includes a five-step first-run journey whose buttons navigate in order to model configuration, Bilibili login, favorite synchronization, task inspection and internal Agent workflow creation. The collapsed external knowledge API prompt documents health/manifest discovery, URL-encoded filters, supported sort forms, 1-1000-line exact Markdown pages, validated image reads, source citation and bounded error recovery. Agent Tool Status includes the read-only protocol reference. Resource Scheduling displays ASR hardware compatibility and disables unsupported controls.

## 17. Startup and Dependencies

The main window appears before heavy initialization. Bootstrap progress covers database, dependencies, models, resource pools, ASR health, knowledge API and login synchronization. Tool probes run during startup and report online/degraded/offline state. Startup uses content-height rows and its own vertical scroll container so onboarding, health, prompt and the bounded 500-event log remain reachable at the default and reduced window sizes. Once a Windows portable backend first reaches Ready, it creates a Desktop shortcut that targets the bundled Electron executable with the current portable root as its application argument, working directory and icon source. A per-installation SQLite record prevents repeated creation; failures are non-fatal and reported in the UI.

Project-local runtime and models may be installed from GitHub Release assets. Downloads use bounded retry with backoff and HTTP Range continuation while retaining `.partial` data. Verification prefers the Release asset SHA-256 digest; direct-URL fallback obtains the matching `.sha256` before transferring the large archive. Complete archives survive transient checksum-network failures, but unverified content is never installed. Installation uses staging, backup, a transaction journal and startup rollback, then refreshes ASR and tool health without requiring an application restart. Archives may write only below `runtime/`.

The two current models support local ZIP import. The accepted asset name is generated only from `dependencyReleaseVersion`; the selected file must exactly match that name and the official Release SHA-256. Archive inspection rejects links, traversal, foreign runtime paths, the wrong model directory and missing probes before maintenance mode or target replacement. Import cancels and joins an in-flight automatic download for the same model, removes its `.partial`, archive, staging, backup and transaction residue, then copies the selected file into a managed temporary location. Existing healthy model files remain untouched until verified staging commits atomically, and remain available after validation failure. Package-name links and error dialogs point to the exact dependency Release. The v1.0.0 medium asset remains untouched for older applications.

Version `1.1.1` keeps runtime and ASR dependencies pinned to baseline `1.0.0`. The current dependency manager exposes `large-v3-turbo` as the required default and `small` as an optional alternate. The historical `medium` package remains untouched in the v1.0.0 Release for older applications and is not exposed by the current model registry. The published Turbo asset contract is `Star-Owner-v1.0.0-model-large-v3-turbo.zip`; packaging can build it with `npm run package:model:turbo`.

Media tool subprocesses never resolve `node` through the system `PATH`. Normal source tests use `process.execPath`; the desktop application launches its bundled Electron executable with `ELECTRON_RUN_AS_NODE=1`. Python processes receive `PYTHONUTF8=1` and `PYTHONIOENCODING=utf-8`, and streamed stdout/stderr use incremental UTF-8 decoders so a multibyte Chinese character split across chunks is not replaced.

## 18. Supported Video Boundary

The stable workflow accepts ordinary Bilibili BV videos with exactly one page. Metadata inspection is mandatory before media download: more than one `pages` entry produces `UNSUPPORTED_VIDEO_TYPE`, cleans the current attempt, disables the task and records a skipped rather than failed Agent outcome. Inputs under Bilibili bangumi (`ep/ss/md`), cheese, festival, audio and live routes are rejected before URL-to-BV resolution. Favorite entries without a BV are retained as disabled inventory records with a visible reason. A future multi-part implementation must be developed on a separate Git branch and may merge only after per-part download, ASR, frame, cache, rollback and `?p=<page>&t=<seconds>` link tests pass.

## 19. Security and Reliability

- Electron main and WebView run with sandbox boundaries and strict navigation policies.
- Credentials require safeStorage; cookies remain local plaintext only where tools require it.
- Provider Base URLs, headers, private networks and hidden browsing are validated.
- Markdown raw HTML is disabled; images are constrained by source, size and signature.
- Filesystem deletion and API reading resolve real paths under registered roots.
- Application shutdown and restart recovery abort active video attempts rather than resuming partial state.
- SQLite and dependency installation use recoverable writes.

## 20. Verification

`npm run verify:release` checks package/lock versions, machine-specific paths, JavaScript/Python syntax, all integration tests, both ASR models and npm audit. `test:runtime-node` deliberately removes the global `PATH` and verifies that the bundled Electron Node mode still executes the video tool.

Protocol and lifecycle gates include:

- `scripts/knowledge-api-test.js`;
- `scripts/hardware-capabilities-test.js`;
- `scripts/internal-agent-test.js`;
- `scripts/document-lifecycle-test.js`;
- `scripts/collection-sync-test.js`;
- `scripts/security-test.js`;
- `scripts/smoke-test.js`.
