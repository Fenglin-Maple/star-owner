# Security and Privacy

## Sensitive Local Data

The application can store or produce:

- encrypted saved account credentials through Electron `safeStorage`;
- persistent Bilibili WebView session data;
- exported Bilibili cookies under `workspace/users/<username>/cookies/`;
- SQLite task, Worker, and activity records;
- downloaded video/audio caches and generated knowledge documents.

`workspace/`, runtime logs, databases, archives, and shortcuts are excluded from Git. Portable release builds create an empty Workspace and never copy maintainer data.

## API Exposure

The Agent API binds to `127.0.0.1` by default. Do not expose it to a LAN or the public internet without adding authentication, authorization, transport security, and a threat review. A Worker ID coordinates local work; it is not an internet-grade authentication credential.

## Responsible Disclosure

Do not open a public issue containing cookies, passwords, SMS codes, private video links, account identifiers, logs with secrets, or personal Workspace content. Contact the repository maintainer privately using the security contact configured on the eventual GitHub repository.

## Release Hygiene

Before publishing, run `npm run verify:release`, inspect `git status`, and test the built archive. Search the tracked tree for absolute paths, credentials, account names, and local artifacts. Review third-party licenses and model terms again when updating dependencies.
