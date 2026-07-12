# Agent and Contributor Guide

## Product Goal

Star Owner (星藏家) turns a user's Bilibili favorite folders into a managed queue of comprehensive, timestamp-linked, illustrated Markdown knowledge documents. The desktop application is the single source of truth for identities, task leases, tools, paths, submissions, and artifacts.

## Worker Agent Contract

1. Discover the current protocol with `GET http://127.0.0.1:17391/api/manifest`.
2. Every fresh Agent session registers its real caller and model with `POST /api/workers/register`.
3. Use the returned `workerId` for every state-changing request. Do not invent or reuse an identity from another session.
4. Work only on the collection activated by the desktop user and claim one task at a time.
5. Create files only inside the returned `artifactDir`.
6. Invoke media, metadata, subtitle, ASR, comment, and cleanup tools through the application API. Do not run internal scripts directly.
7. Always run ASR, compare it with usable station subtitles, and use frames/multimodal reasoning when needed.
8. Write the opening sections in this exact order: `小结`, `思维导图`, `目录`. The mind map must be a valid Mermaid fenced code block.
9. Include comprehensive body content, Bilibili timestamp links, selected keyframes, subtitle comparison, up to three hot-comment analyses, limitations, and processing provenance.
10. Clean temporary video/audio through the application tool API before submission. For a task with `cachedVideoId`/`reuseCachedMedia`, still call cleanup; the application preserves the registered merged video automatically.
11. Submit through `/api/tasks/<taskId>/submit`; the application validates and finalizes the directory and Markdown filename.
12. If an error, user instruction, or other condition prevents completion, call `/api/tasks/<taskId>/abort` with `workerId` and a concrete `reason`. Do not leave files as a checkpoint. The application cancels tools, removes this attempt, and returns the task to `pending` so the next worker starts from scratch. `/fail` is a legacy alias with the same behavior.

The canonical Markdown contract is `templates/video-summary-template.md` and is also returned by `GET /api/templates/video-summary`.

## Code Contributor Contract

- Use project-relative paths derived from `__dirname`, `PROJECT_ROOT`, or script location. Never commit a maintainer's drive letter, home directory, username, cookie path, or temporary path.
- Do not commit `workspace/`, `runtime/`, `node_modules/`, `dist/`, logs, SQLite databases, cookies, generated media, model files, or local shortcuts. Runtime dependencies belong in the pinned setup manifests and portable release build.
- Keep ordinary user releases dependency-free by changing `scripts/build-portable-release.ps1` when a new runtime dependency is added.
- Update `THIRD_PARTY_NOTICES.md`, `runtime-requirements.txt`, and release documentation whenever dependency versions or licenses change.
- Preserve the API-first boundary: Agents do not directly mutate SQLite or application indexes.
- Treat `network-policy.js`, `desktop-security.js`, and the API origin/body limits as security boundaries; extend their tests when changing them.
- Keep desktop-owned collection synchronization out of the public Agent API. Reuse `CollectionSyncService` and `submission-artifacts` instead of importing `ApiServer` into other managers.
- Use `apply_patch` for scoped source edits and keep unrelated refactors out of focused changes.
- Run `npm run verify:release` before publishing or opening a release pull request.

## Built-in RAG Assistant Contract

- Treat the RAG assistant as an analysis client for accepted Markdown, not as a replacement for the external Worker submission protocol.
- Application-managed video Agents are a separate feature from RAG. They use the same Worker store, ToolRunner, leases, validation, cleanup, artifact finalization, and analytics as external Workers, but their orchestration is owned by `src/core/internal-agent-manager.js`.
- Single-task mode creates an ordinary task under `内置用户` and a selected internal collection, then archives the accepted artifact in the default Workspace and copies it to the explicitly selected external destination.
- A single task may request `keepVideoCache`; cache-collection tasks always preserve their registered merged video. Neither mode lets an Agent bypass application cleanup or edit the cache index directly.
- RAG, collection Agents, and single-task Agents share provider/model records and per-model usage accounting. Never expose decrypted API keys to the renderer or logs.

## Dependency Asset Contract

- Dependency archives are GitHub Release assets, not Git-tracked runtime files.
- Archive entries must remain under `runtime/`; extraction rejects absolute paths and `..` traversal.
- Required Release assets use `Star-Owner-v<version>-runtime-win-x64.zip`, `Star-Owner-v<version>-model-small.zip`, and `Star-Owner-v<version>-model-medium.zip`, preferably with matching `.sha256` assets.
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
npm run test:video-cache
npm run test:security
npm run test:persistence
npm run test:collection-sync
npm run test:asr-service
npm audit --audit-level=high
```

The ASR service test loads the GPU model; stop another GPU ASR instance first on memory-constrained systems.
