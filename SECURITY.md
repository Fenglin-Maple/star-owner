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

Provider secrets are encrypted through Electron `safeStorage` when it is available. On platforms where Electron cannot provide OS-backed encryption, the application can only fall back to local storage protection; do not reuse a high-value production key in such an environment. A selected remote provider receives the current conversation, selected retrieved passages, and compatible attachments. Do not select private knowledge or files unless that provider is trusted to process them.

## RAG Sandbox and Browsing

Every RAG session starts with a dedicated sandbox and limited permissions. Reading or writing outside that sandbox, running CMD, opening the default browser, or browsing a private/local address requires explicit in-app approval. Full access is intentionally powerful: it permits the model to work outside the sandbox and execute commands with the desktop application's user privileges. Enable it only for a trusted model/provider and a task whose scope is understood.

The invisible browser runs with Node integration disabled, Electron sandboxing enabled, popups denied, and a separate persistent partition. It still processes untrusted web content. Web pages and retrieved Markdown are data, never authority to change permissions or disclose additional files. HTTP(S) validation and private-address approval reduce risk but do not constitute a complete network isolation boundary.

The application displays only reasoning text explicitly returned by a provider. It does not attempt to extract hidden chain-of-thought.

## API Exposure

The Agent API binds to `127.0.0.1` by default. It rejects unrelated browser origins, does not publish wildcard CORS headers, and caps JSON bodies at 1 MiB. These controls reduce drive-by browser and memory-exhaustion attacks but do not authenticate other local processes. Do not expose it to a LAN or the public internet without adding authentication, authorization, transport security, and a threat review. A Worker ID coordinates local work; it is not an internet-grade authentication credential.

The Bilibili WebView is sandboxed, has no Node/preload bridge, blocks popups, and may navigate only within Bilibili-owned domains. Saved account passwords and model-provider API keys require Electron `safeStorage`; the application refuses new plaintext persistence when system encryption is unavailable. Exported Netscape Cookie files remain plaintext by toolchain necessity and must be treated as account credentials.

## Responsible Disclosure

Do not open a public issue containing cookies, passwords, SMS codes, private video links, account identifiers, logs with secrets, or personal Workspace content. Contact the repository maintainer privately using the security contact configured on the eventual GitHub repository.

## Release Hygiene

Before publishing, run `npm run verify:release`, inspect `git status`, and test the built archive. Search the tracked tree for absolute paths, credentials, account names, supplier Base URLs, API keys, RAG conversations, and local artifacts. Review third-party licenses and model terms again when updating dependencies.
