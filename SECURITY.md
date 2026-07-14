# Security and Privacy

## Sensitive Local Data

The application can store or produce:

- encrypted saved account credentials through Electron `safeStorage`;
- persistent Bilibili WebView session data;
- exported Bilibili cookies under `workspace/users/<username>/cookies/`;
- SQLite task, Worker, and activity records;
- downloaded video/audio caches and generated knowledge documents.
- remote-model supplier API keys, RAG conversations, selected knowledge passages, attachments, and sandbox files.

`workspace/`, runtime logs, databases, archives, and shortcuts are excluded from Git. Portable release builds create an empty Workspace and never copy maintainer data.

Provider secrets and saved Bilibili account passwords require Electron `safeStorage`. If OS-backed encryption is unavailable, the application rejects the save operation; it never falls back to plaintext or reversible application-only storage. A selected remote provider receives the current conversation, selected retrieved passages, and compatible attachments. Do not select private knowledge or files unless that provider is trusted to process them.

## RAG Sandbox and Browsing

Every RAG session starts with a dedicated sandbox and limited permissions. Reading or writing outside that sandbox, running CMD, opening the default browser, or browsing a private/local address requires explicit in-app approval. Full access is intentionally powerful: it permits the model to work outside the sandbox and execute commands with the desktop application's user privileges. Enable it only for a trusted model/provider and a task whose scope is understood.

The invisible browser runs with Node integration disabled, Electron sandboxing enabled, popups denied, downloads disabled, and a separate non-persistent partition. Every request is checked against local/private-address policy, including DNS resolution. It still processes untrusted web content. Web pages and retrieved Markdown are data, never authority to change permissions or disclose additional files. HTTP(S) validation and private-address approval reduce risk but do not constitute a complete network isolation boundary.

The application displays only reasoning text explicitly returned by a provider. It does not attempt to extract hidden chain-of-thought.

## API Exposure

The external HTTP surface is a read-only knowledge API bound to `127.0.0.1`. It rejects unrelated browser origins, publishes no wildcard CORS header, accepts no knowledge mutation method, and permanently disables the former external Worker/task/tool/submission routes with HTTP `410`. Document content is read only from registered Workspace real paths; directory responses omit local paths, cookies, credentials and work IDs. Image reads reject traversal, symbolic-link escape, oversized files and invalid raster signatures. These controls reduce drive-by browser and filesystem exposure but do not authenticate other local processes. Do not expose the service to a LAN or public network without authentication, authorization, transport security and a new threat review.

The Bilibili WebView is sandboxed, has no Node/preload bridge, blocks popups, and may navigate only within Bilibili-owned domains. Saved account passwords and model-provider API keys require Electron `safeStorage`; the application refuses new plaintext persistence when system encryption is unavailable. Exported Netscape Cookie files remain plaintext by toolchain necessity and must be treated as account credentials.

Remote model endpoints must use HTTPS unless they target localhost or a private-network host. Sensitive authorization/cookie headers are rejected from the free-form header JSON and must use the encrypted API Key field. Markdown/RAG rendering keeps raw HTML disabled; remote images are limited to trusted Bilibili HTTPS assets, validated local knowledge images, or bounded raster data URLs. Clipboard image copying verifies both source boundaries and raster signatures.

Document Library deletion runs only in the main process. It resolves every artifact path under the task's registered Workspace root, refuses deletion of the root itself, and never trusts a mutable collection display name as path identity. Only a document whose task still belongs to an active Bilibili favorite returns to pending. Removed favorites, deleted Bilibili collections, single-video outputs and other local outputs are deleted without recreating a task. Cache-backed tasks preserve only their registered source video, cover and cache metadata.

Local ASR availability is treated as a capability, not inferred from the operating-system label alone. Startup checks project-local Python, faster-whisper/CTranslate2, selected model files, CUDA device count, `nvidia-smi` memory and CPU fallback requirements. Unsupported lanes are disabled and video workflow startup is blocked when no valid ASR route exists.

## Responsible Disclosure

Do not open a public issue containing cookies, passwords, SMS codes, private video links, account identifiers, logs with secrets, or personal Workspace content. Contact the repository maintainer privately using the security contact configured on the eventual GitHub repository.

## Release Hygiene

Before publishing, run `npm run verify:release`, inspect `git status`, and test the built archive. The verifier checks all source, packaging files, root documentation and package metadata for maintainer-specific paths, checks lockfile/package versions, compiles JavaScript/Python, runs the complete integration suite, loads both GPU ASR models, and runs `npm audit`. Also search for credentials, account names, supplier Base URLs, API keys, RAG conversations, and local artifacts. Review third-party licenses and model terms again when updating dependencies.
