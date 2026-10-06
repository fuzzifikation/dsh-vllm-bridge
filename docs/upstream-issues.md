# Upstream issues to file

Reports we owe the DeepSeek Harness team, drafted from certified behavior in our pinned composition (`@deepseek-ai/dsh` per `config/dsh.json`). No private hosts or paths appear below.

Filed 2026-10-06 as Discussions (the repository's issue tracker is disabled): [notice acknowledgement](https://github.com/deepseek-ai/deepseek-harness/discussions/9001), [webview cookies](https://github.com/deepseek-ai/deepseek-harness/discussions/9002).

## 1. Preview Notice acknowledgement never persists without a DeepSeek account

The first-run "Preview Notice" modal gates on `ui-settings-general.welcomeNoticeVersion` equaling the client constant (exact equality, `@deepseek-ai/dsh-client-ui-settings-models`). Clicking Continue in a profile with no DeepSeek account logs "The acknowledgement could not be saved" and sends no RPC at all; the modal reappears every boot forever. The setting itself is writable by other means (a patch-layer config row with the field set makes the notice never render), so the storage layer is fine and only the acknowledgement path is broken in the no-account composition.

Request: persist the acknowledgement through the same local settings path when no account is connected.

Current bridge workaround: the generated overlay states `welcomeNoticeVersion` itself, pinned to the upstream constant and bumped with each dsh pin update.

## 2. Harness UI cannot be embedded in editor webviews (cookie policy)

The web server's browser session cookie is `HttpOnly; SameSite=Strict` (dsh-client-connection, `sessionCookie()`), and the `/api` transport authenticates with that cookie only. Chromium never stores or sends Strict cookies in a cross-site frame, so embedding the harness in any editor webview (VS Code extension panels, every other IDE's equivalent) shows only the 401 text. Top-level browser tabs and desktop webview shells are unaffected, which is why nobody notices upstream.

Request: support `Partitioned` (CHIPS) cookies, which are exactly designed for authenticated loopback frames on trustworthy origins like `http://127.0.0.1`, or accept the session token through a header fallback for embedded clients. Either one makes "open the harness inside the editor without its own browser chrome" possible for every editor integration, not just ours.

Current bridge posture: we open the harness in VS Code's built-in Browser area (top-level, cookie works, toolbar visible). A bridge-side proxy rewriting cookie attributes was evaluated and rejected.
