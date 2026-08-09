# Agent and Contributor Guide

## Product Goal

星藏家 turns Bilibili favorites and managed cached videos into durable, timestamped Markdown knowledge. The desktop application owns synchronization, task state, model execution, tools, work directories, validation, cleanup, persistence, and document lifecycle.

## External Knowledge Agent Contract

External Codex, Claude Code, OpenCode, and other Agent applications are read-only knowledge clients.

1. Read `GET /api/manifest` first. Protocol `3.1` describes the current knowledge-only surface, including multi-part and shared-document metadata.
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

## Shared Bilibili Knowledge Contract

The complete, authoritative design for this feature is [DESIGN_SHARED_KNOWLEDGE.md](DESIGN_SHARED_KNOWLEDGE.md). Keep this guide, the implementation, repository templates and the startup prompt synchronized with that document whenever the sharing design changes.

- GitHub sharing accepts only completed Bilibili video-summary artifacts. Local videos, local documents, raw media, Agent drafts, ASR/subtitle/comment caches, local process JSON, cookies, credentials and shared imports are rejected. A single-video package has canonical `summary.md`; a multi-part video must be uploaded as its complete parent package with `index.md` and `parts/cid-*/summary.md`, never as an isolated P child. Generated metadata must declare the canonical entry and SHA-256 hashes so repository validation, mounting and RAG resolve the same final Markdown.
- The default shared repository is `https://github.com/Fenglin-Maple/Blibili-Markdowns`, but users may persist another accessible GitHub repository or create a public personal repository from the application. One-click creation must install the repository contract, README/policy files, CODEOWNERS, PR template, validation Action and catalog Action against the repository's actual default branch. A public repository is read anonymously only when no application credential is configured. If GitHub rejects an attached credential with HTTP 401, stop that operation and require reauthorization; never hide the invalid credential by retrying anonymously. Private repository reads require the application-owned GitHub authorization and must not fall back to anonymous or global credentials.
- Contributors are represented by GitHub numeric ID and stable document/source IDs, not by a mutable display name. The application opens the default browser for GitHub access and stores the credential in a project-private DPAPI store used only by bundled `runtime/git`; a pasted Fine-grained Token remains a fallback. Compare the authenticated numeric ID with the repository owner ID: owners create a temporary upstream branch and Pull Request, while other users create or reuse exactly one valid Fork for that upstream repository, then create a fresh contribution branch from the latest upstream target branch for each upload. Commit authors use the authenticated GitHub noreply identity. Clearing authorization removes only application-owned credentials and must never erase Windows Credential Manager, system Git or user-global Git data.
- The required pre-merge check is named `validate-shared-docs`. Fork PR workflows may require the repository owner to approve and run them under GitHub's fork security policy. After a passing check and human review, merge the PR into the upstream target branch once; the `build-shared-catalog` Action then validates the merged branch and updates `catalog.json` automatically. A manual workflow run is a recovery operation when that Action fails or the catalog is stale, not a second catalog PR.
- One upload accepts at most 1000 documents and 1 GiB. Keep the whole application input-locked behind a cancellable progress modal while GitHub/Git work is active, stream validated source files into the checkout, abort child processes and HTTP requests on cancellation, and clean recognizable temporary branches/directories. Do not weaken per-file, per-document, path, metadata or content allowlists to reach the batch limit.
- A downloaded document is mounted under the local `共享` user. A local shared collection can contain several independent remote collection mounts and single-document mounts; synchronization keys include the remote repository plus contributor/source collection/document IDs, not local or renamed display names. Switching the active repository must not retarget existing mounts.
- Read the remote catalog before mounting. A remote deletion marks the local task `remote-deleted` and keeps its Markdown available; a remote update replaces the managed artifact atomically. Shared tasks are knowledge-only and never enter Bilibili sync, Task Overview, or Agent claims.
- For multi-part knowledge, read the parent/index document first, then follow `parentDocumentId`, `partId`/`cid`, and P metadata to read the required child Markdown. Do not merge same-BVID documents from different contributors or source collections.

## Internal Video Agent Contract

- Application-managed video Agents use `InternalAgentManager`, not the HTTP knowledge API.
- Each workflow session has one persistent Worker ID. Every claimed video receives a fresh one-time `workId` and a fresh model request context.
- A workflow only claims tasks from its configured collection and skips `enabled === false` tasks.
- Collection synchronization has priority. It stops every bound queue workflow, aborts current attempts, removes attempt files, and requires a manual restart after successful sync.
- Every interruption path is an idempotent rollback: cancel model/tool work, remove attempt files, invalidate `workId`, and return an eligible ordinary task to `pending`.
- Confirmed deleted/down/unavailable videos are terminal: remove the task, write an `unavailableTasks` tombstone, and do not recreate it during sync.
- Tools run through `ToolRunner`; internal Agents never bypass resource pools to invoke project scripts directly.
- Every video runs ASR even when station subtitles exist. Timeline links use SRT or `segments[].start/end`, never inferred text order.
- ASR writes SRT, timestamped text and segment JSON from one normalized sentence list. Empty `segments=[]` is a valid no-speech result with diagnostics; malformed individual timestamps are repaired when safe or retried with up to three parameter profiles before the Agent model is called.
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
- Current required assets use `Star-Owner-v<dependency-version>-runtime-win-x64.zip` and `Star-Owner-v<dependency-version>-model-large-v3-turbo.zip`, with matching SHA-256 assets. `small` uses `Star-Owner-v<dependency-version>-model-small.zip` as an optional alternate. The historical medium asset remains in the v1.0.0 Release for older applications but is not exposed by the current registry.
- Keep model IDs, compute types, package IDs and hardware thresholds centralized in `src/core/asr-models.js`; do not add model-specific ternaries back to ToolRunner or hardware detection.
- `package.json.dependencyReleaseVersion` is the explicit compatibility contract shared by the dependency manager and portable manifest. A code-only Release keeps it pinned and uploads only the new core ZIP plus checksum.
- Installed runtime/model payloads require a matching managed manifest under `runtime/.dependency-manifests/`; package ID, dependency release, asset name, SHA-256 and probes commit and roll back in the same dependency journal. Compatibility adoption is limited to the known official v1.0.0 checksums and may run only once.
- Never change probes or layouts without updating dependency manager, packaging, deployment docs, and regression tests.
- GitHub Release titles and notes are UTF-8 metadata. Keep notes in a UTF-8 Markdown file, send explicit UTF-8 bytes when using an API or PowerShell, and read the Release back after publishing to verify Chinese text and asset names. Never pipe release notes through a shell's default encoding.

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
npm run test:asr-models
npm run test:dependency-manifest
npm run test:image-clipboard
npm run test:persistence
npm run test:collection-sync
npm run test:bili-client
npm run test:asr-format
npm run test:asr-output
npm run test:analytics
npm run test:asr-service
npm run test:local-toolbox
npm run test:runtime-isolation
npm audit --audit-level=high
```

`npm run verify:release` is the aggregate gate. The ASR service test loads every installed GPU model, including optional Turbo when present; stop another GPU ASR process first on memory-constrained systems.
