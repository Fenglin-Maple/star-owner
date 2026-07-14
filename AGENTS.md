# Agent and Contributor Guide

## Product Goal

Star Owner (星藏家) turns a user's Bilibili favorite folders into a managed queue of comprehensive, timestamp-linked, illustrated Markdown knowledge documents. The desktop application is the single source of truth for identities, task leases, tools, paths, submissions, and artifacts.

## Worker Agent Contract

1. Discover the current protocol with `GET http://127.0.0.1:17391/api/manifest`.
2. Every fresh Agent session registers its real caller and model with `POST /api/workers/register`.
3. Keep the returned `workerId` as this Agent session's identity across consecutive tasks. Every successful claim returns a brand-new one-time `workId`, including the next claim made by the same Worker; include both IDs in heartbeat, tool-run/cancel, submit, and abort requests. Never invent or reuse an ended `workId`.
4. External HTTP API Agents work only on the collection activated in the desktop Task Overview page and claim one task at a time. Internal application-managed Agent sessions instead use the collection selected when that session was created; the external active target does not redirect them.
5. Create files only inside the returned `artifactDir`.
6. Invoke media, metadata, subtitle, ASR, comment, and cleanup tools through the application API. Do not run internal scripts directly.
7. Always run ASR and use its sentence-level timeline. Prefer `asr/transcript.srt`; `asr/asr-result.json` exposes the same `segments[].start/end`, detected language/probability, and speech-coverage diagnostics, while `asr/asr-transcript.txt` is also timestamped. Auto language detection supports Chinese, English, Japanese, and other faster-whisper languages; request an explicit language only when evidence shows auto detection is wrong. Build Bilibili links from real times, never from guessed plain-text position. Compare the ASR with every usable station SRT and use frames/multimodal reasoning when needed.
8. Write the opening sections in this exact order: `小结`, `思维导图`, `目录`. The mind map must be a valid Mermaid fenced code block.
9. Include comprehensive body content, Bilibili timestamp links, selected keyframes, subtitle comparison, up to three hot-comment analyses, limitations, and processing provenance.
10. Clean temporary video/audio through the application tool API before submission. For a task with `cachedVideoId`/`reuseCachedMedia`, still call cleanup; the application preserves the registered merged video automatically.
11. Submit through `/api/tasks/<taskId>/submit`; the application validates and finalizes the directory and Markdown filename.
12. If an error, user instruction, or other condition prevents completion, call `/api/tasks/<taskId>/abort` with `workerId`, `workId`, and a concrete `reason`. Do not leave files as a checkpoint. The application cancels tools, removes this attempt, invalidates `workId`, and returns the task to `pending`.
13. On `WORK_ATTEMPT_ENDED`, stop using the old `workId` immediately. Keep the same `workerId` and call `/api/tasks/claim`; the next claim starts from scratch with a new `workId`.
14. `BILIBILI_VIDEO_UNAVAILABLE` is terminal, unlike an ordinary abort. Stop the current work, do not retry or recreate its files, keep the same `workerId`, and claim another task. The application removes the task/video inventory entry, cleans the attempt, records an `unavailableTasks` tombstone, and prevents collection sync from recreating it.
15. Collection synchronization has priority over all video-summary work. `REMOVED_FROM_FAVORITES` invalidates the old unfinished task but does not delete an already accepted Markdown artifact. `COLLECTION_SYNCING`, `COLLECTION_NOT_READY`, and `COLLECTION_REACTIVATION_REQUIRED` mean stop and wait for the desktop user while retaining the same `workerId`. `BILIBILI_COLLECTION_DELETED` is terminal for that collection; do not request or recreate its tasks.

The canonical Markdown contract is `templates/video-summary-template.md` and is also returned by `GET /api/templates/video-summary`.

## Code Contributor Contract

- Use project-relative paths derived from `__dirname`, `PROJECT_ROOT`, or script location. Never commit a maintainer's drive letter, home directory, username, cookie path, or temporary path.
- Do not commit `workspace/`, `runtime/`, `node_modules/`, `dist/`, logs, SQLite databases, cookies, generated media, model files, or local shortcuts. Runtime dependencies belong in the pinned setup manifests and portable release build.
- Keep ordinary user releases dependency-free by changing `scripts/build-portable-release.ps1` when a new runtime dependency is added.
- Update `THIRD_PARTY_NOTICES.md`, `runtime-requirements.txt`, and release documentation whenever dependency versions or licenses change.
- Preserve the API-first boundary: Agents do not directly mutate SQLite or application indexes.
- Treat `network-policy.js`, `desktop-security.js`, and the API origin/body limits as security boundaries; extend their tests when changing them.
- Keep desktop-owned collection synchronization out of the public Agent API. Reuse `CollectionSyncService` and `submission-artifacts` instead of importing `ApiServer` into other managers.
- Keep remote favorite-folder names out of path identity. Use `mediaId` for collection identity and `storageName` for an immutable existing disk root. A rename must not split accepted artifacts across directories.
- A full collection diff is applied only after all remote pages succeed and inside one recoverable Store transaction. Never delete accepted Markdown because a favorite or folder disappeared; archive it with explicit membership metadata for Document Library, Export, and RAG.
- Keep accepted-document deletion in `document-lifecycle.js`. Resolve restoration by immutable `collectionId`, preserve registered cache-source media, never revive removed favorites/deleted Bilibili folders, and keep single-video RAG revision selection in `task-versions.js`.
- Use `apply_patch` for scoped source edits and keep unrelated refactors out of focused changes.
- Run `npm run verify:release` before publishing or opening a release pull request.

## Built-in RAG Assistant Contract

- Treat the RAG assistant as an analysis client for accepted Markdown, not as a replacement for the external Worker submission protocol.
- Application-managed video Agents are a separate feature from RAG. They use the same Worker store, ToolRunner, leases, validation, cleanup, artifact finalization, and analytics as external Workers, but their orchestration is owned by `src/core/internal-agent-manager.js`.
- Internal task completion, rollback, and unavailable-video transitions must invalidate the renderer's shared task snapshot as well as update the AI session view. Snapshot invalidation that arrives during an in-flight read must schedule a second read; otherwise Document Library can remain stale until restart.
- Internal Agent stop is an immediate, idempotent rollback: one stop request aborts the provider/tool work, removes attempt files, invalidates the current `workId`, returns an ordinary task to `pending`, and leaves the persistent Worker paused until the user starts it again.
- Single-task mode creates an ordinary task under `内置用户` and a selected internal collection. Its only accepted output is the canonical default-Workspace artifact under that collection; there is no arbitrary external-destination copy.
- Single-task duplicate handling is collection/BV scoped. Active work reuses its session; completed work requires an explicit open/cancel/regenerate choice; failed, pending, deleted-output, and missing-artifact rows are cleaned and reused from scratch. Accepted regeneration preserves old revision files, and only the current accepted revision is RAG-active by default.
- Application-managed queue Agents retain one Worker ID but start a fresh model request context for every claimed video. Each video still gets a new `workId`; never carry a previous video's messages into a new task. Ordinary videos use their complete current-task material directly. Only when the estimated request reaches 82% of the configured model window, or the provider reports a context-limit error, may the manager use the same provider/model in independent requests to read every source chunk and build a hierarchical evidence pack. This semantic fallback must not character-truncate the original material, must preserve timeline/fact/step/parameter/code/constraint/conflict/uncertainty evidence, and must keep the original Worker ID and current `workId`.
- Provider/model records are shared by RAG and video Agents. Removing a provider or enabled model must expose affected sessions as unavailable; an active attempt must be aborted through the standard cleanup service, returned to `pending`, and leave its Worker paused until a valid configuration is restored and the user starts it again.
- A single task may request `keepVideoCache`; cache-collection tasks always preserve their registered merged video. Neither mode lets an Agent bypass application cleanup or edit the cache index directly.
- RAG, collection Agents, and single-task Agents share provider/model records and per-model usage accounting. Never expose decrypted API keys to the renderer or logs.
- RAG conversation history automatically compresses at 75% of the model window or the lower reserve-safe input boundary. Keep the current user turn verbatim, fold only history after the prior compression marker, process every source chunk, and never re-send both a durable summary and the messages it already represents.
- RAG knowledge tools must expose distinct publish and favorite-addition dates. Preserve the 24 tool-round budget plus one final-answer request, restricted-mode approvals, and cancellation through automatic compression.

## Dependency Asset Contract

- Dependency archives are GitHub Release assets, not Git-tracked runtime files.
- Archive entries must remain under `runtime/`; extraction rejects absolute paths and `..` traversal.
- Required dependency assets use `Star-Owner-v<version>-runtime-win-x64.zip`, `Star-Owner-v<version>-model-small.zip`, and `Star-Owner-v<version>-model-medium.zip`; every archive must have a matching `.sha256` asset. A code-only Release may reuse unchanged assets from one of the ten most recent Releases; keep the filename pattern and resolver regression test intact.
- Do not change a dependency probe or asset layout without updating `dependency-manager.js`, the release builder, README, DESIGN, and DEPLOYMENT together.
- Never expose decrypted provider API keys to preload or renderer code.
- Keep provider requests OpenAI-compatible and capability-gated; unsupported multimodal, reasoning, image, tool, compression, or subagent behavior must degrade honestly.
- Preserve the per-session sandbox boundary and approval flow for outside paths, CMD, private/local URLs, and default-browser opening.
- Knowledge retrieval must only read validation-accepted `done` tasks selected by the user for the current session.
- Provider-supplied usage is authoritative when present. Any local estimate must remain distinguishable in implementation and documentation.
- Add or update `scripts/rag-assistant-test.js` for provider protocol, tool-loop, retrieval, approval, attachment, compression, or usage changes.

## Required Tests

```powershell
npm run smoke
npm run test:scheduler
npm run test:rag
npm run test:internal-agent
npm run test:task-attempt
npm run test:document-lifecycle
npm run test:video-cache
npm run test:security
npm run test:image-clipboard
npm run test:persistence
npm run test:collection-sync
npm run test:bili-client
npm run test:asr-format
npm run test:analytics
npm run test:asr-service
npm audit --audit-level=high
```

The ASR service test is a release gate and loads both GPU models; stop another GPU ASR instance first on memory-constrained systems.
