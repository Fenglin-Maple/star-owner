# Agent and Contributor Guide

## Product Goal

星藏家 turns Bilibili favorites and managed cached videos into durable, timestamped Markdown knowledge. The desktop application owns synchronization, task state, model execution, tools, work directories, validation, cleanup, persistence, and document lifecycle.

## External Knowledge Agent Contract

External Codex, Claude Code, OpenCode, and other Agent applications are read-only knowledge clients.

1. Read `GET /api/manifest` first. Protocol `3.0` describes the current knowledge-only surface.
2. Use `GET /api/knowledge/catalog` to inspect users and collections before loading documents.
3. Use the paginated `/api/knowledge/documents` directory and its metadata filters to select relevant documents.
4. Treat `publishedAt` as the video publication date and `favoriteAddedAt` as the favorite-addition date. Preserve `favoriteMembership` in conclusions when a video or collection has been removed.
5. Read exact Markdown through `/content?startLine=...&lineCount=...`. Follow `nextStartLine` until `null` when complete source is required.
6. List `/assets` before reading an image. Asset IDs are opaque and document-scoped; never infer local filesystem paths.
7. Search is a bounded convenience index. A snippet is not the full source, and `partial=true` requires narrower filters or exact reads.
8. Cite document title, BV, user, and collection when grounding an answer. State clearly when the knowledge base lacks evidence.
9. Do not read or modify SQLite, Workspace indexes, cookies, provider credentials, or application files directly.
10. Do not call `/api/workers`, `/api/tasks`, `/api/tools`, `/api/tool-runs`, or other retired external video workflow endpoints. They return HTTP `410` and `EXTERNAL_VIDEO_WORKFLOW_DISABLED`.

The service binds to `127.0.0.1`, accepts origin-less local process requests, rejects unrelated browser origins, and has no mutation endpoint. This is not authentication against other local processes.

## Internal Video Agent Contract

- Application-managed video Agents use `InternalAgentManager`, not the HTTP knowledge API.
- Each workflow session has one persistent Worker ID. Every claimed video receives a fresh one-time `workId` and a fresh model request context.
- A workflow only claims tasks from its configured collection and skips `enabled === false` tasks.
- Collection synchronization has priority. It stops every bound queue workflow, aborts current attempts, removes attempt files, and requires a manual restart after successful sync.
- Every interruption path is an idempotent rollback: cancel model/tool work, remove attempt files, invalidate `workId`, and return an eligible ordinary task to `pending`.
- Confirmed deleted/down/unavailable videos are terminal: remove the task, write an `unavailableTasks` tombstone, and do not recreate it during sync.
- Tools run through `ToolRunner`; internal Agents never bypass resource pools to invoke project scripts directly.
- Every video runs ASR even when station subtitles exist. Timeline links use SRT or `segments[].start/end`, never inferred text order.
- Provider/model removal makes affected sessions unavailable. Active work must rollback and remain paused until configuration is valid and the user restarts it.
- Each normal video uses complete current-task material. At an estimated 82% context window, or after a provider context-limit error, use independent same-provider/model compaction requests that process every source chunk and retain evidence. Do not carry prior video messages into the next task.

## Single-Video Contract

- Single-video output is canonical under `内置用户/<selected internal collection>` in the default Workspace.
- The stable duplicate key is internal collection ID plus BV.
- Active work returns the existing session.
- A completed duplicate has exactly two user outcomes: abandon and preserve the old output, or regenerate and overwrite it.
- Overwrite cleans the old output and reuses one task identity. Do not create revision history or multiple accepted artifacts.
- Failed, pending, and missing-artifact rows are cleaned and reused from the beginning.
- Deleting a single-video document permanently removes its output, task, and linked single session. A later identical BV starts as a new task without a duplicate warning.

## Document Lifecycle Contract

- Keep document deletion in `document-lifecycle.js` and resolve collections by immutable `collectionId`.
- Only a completed task that still belongs to an existing Bilibili favorite returns to `pending` after deletion.
- Removed favorites, deleted Bilibili collections, single-video tasks, and other local tasks are deleted rather than restored.
- Preserve registered cache-source video, cover, and cache metadata while removing generated summary artifacts.
- Collection display-name changes must never fork or misroute task restoration.

## Code Contributor Contract

- Preserve service ownership: collection synchronization, internal orchestration, tool scheduling, knowledge API, submission finalization, and document lifecycle remain separate modules.
- External HTTP routes stay read-only. Adding a mutating endpoint requires explicit product approval and a new security review.
- Never expose `cookieFile`, API keys, `workId`, local absolute paths, SQLite records, or decrypted secrets through the knowledge API or Renderer.
- Knowledge content and assets must remain inside a registered Workspace. Reject symlinks, traversal, unsupported images, oversize sources, and unreadable artifacts with stable public errors.
- Use stable collection/task IDs for state, display names only for UI.
- Keep `safeStorage` mandatory for saved passwords and provider keys.
- Keep RAG raw HTML disabled and preserve sandbox/private-network approval rules.
- Update README, DESIGN, DEPLOYMENT, SECURITY, CODE_REVIEW, package tests, and protocol version together when contracts change.

## Dependency Asset Contract

- Dependency archives are GitHub Release assets, not Git-tracked runtime files.
- Archives may install only under `runtime/`; extraction rejects absolute paths and `..` traversal.
- Required assets use `Star-Owner-v<version>-runtime-win-x64.zip`, `Star-Owner-v<version>-model-small.zip`, and `Star-Owner-v<version>-model-medium.zip`, with matching SHA-256 assets.
- A code-only Release may reuse unchanged dependency assets from recent Releases.
- Never change probes or layouts without updating dependency manager, packaging, deployment docs, and regression tests.

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
npm run test:knowledge-api
npm run test:hardware
npm run test:image-clipboard
npm run test:persistence
npm run test:collection-sync
npm run test:bili-client
npm run test:asr-format
npm run test:analytics
npm run test:asr-service
npm audit --audit-level=high
```

`npm run verify:release` is the aggregate gate. The ASR service test loads both GPU models; stop another GPU ASR process first on memory-constrained systems.
