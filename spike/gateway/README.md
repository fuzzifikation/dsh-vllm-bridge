# Gateway spike — findings and verdict

**Date:** 2026-10-06 · **Scope rule honored:** the vLLM-Copilot repo was not touched;
this spike consumes its already-shipped public core API (`out/core/index.js`, staged copy).

## Thesis under test

> core + independent settings file + a small HTTP server = any client (dsh, BYOK,
> curl, the next UI nobody has written yet) gets the full vLLM-Copilot behavior —
> modes, budgets, retries, personalities, capture, accounting — with the extension
> nowhere on the wire.

## Result: PASSED, first run

`node gateway.mjs` then `node smoke.mjs`:

```
[1] /v1/models → Qwen3.8-Flash-Next: window=262144 modes=[Think (Deep) | Think (Balanced) | No Think] default=No Think personality=Sarcastic Robot
[2] using preset rule "Sarcastic Genius Identity" find-text (86 chars) as the system prompt
[3] streamed "SPIKE-OK" in 149 ms (SSE relay: done=true, usage-chunk=true)
[4] capture entry found: rulesApplied=[Sarcastic Genius Identity] rewritten=true
[5] gateway /usage → requests=1 prompt=136 completion=5 last={...}
```

One ~250-line Node file, zero npm dependencies, against the real server.

## What the spike settled

1. **The fat catalog is real, not speculative.** `/v1/models` served the live-probed
   context window (262144) plus every mode and the personality, all from
   `describeModel`/`resolveRuntimeLimits`. The "pickers need more than ids" concern
   is answered by the core's existing descriptor.
2. **P7 (personality name-resolution) is NOT needed — the premise was wrong.**
   `resolveModelReplacements` is already a **core export**; the vscode-layer
   `personalityStore` is a thin wrapper. The bridge's own mirror is the gap (it only
   reads `systemMessageReplacementsFile` paths and ignores the `personality` name
   field). Fix location: `src/extension.ts` registry() — call the core resolver.
   The Sarcastic Robot reaching a prompt here proves the path end to end.
3. **P6 shrinks to a placement question.** The capture *writer* (`CaptureQueue`) is
   core-exported; only the settings-read + trigger lives in the vscode layer. A
   bridge-side capture can feed the same file/queue today, no upstream change.
4. **The SSE relay costs nothing measurable.** 149 ms round trip through the relay
   for a streamed completion — one localhost hop, invisible next to generation.
5. **Accounting rides along.** Usage was metered at the relay point (prompt 136 /
   completion 5) — in a real gateway straight into the core `UsageLedger`, which is
   also core-exported. This is the "one ledger, every client" property the library
   architecture cannot give without sync machinery.

## Corroboration from the core itself

`out/core/index.d.ts` header, written by the core's own author: *"the Copilot
provider today, **a harness gateway tomorrow**, and any standalone Node consumer
… without an editor."* The export list was built for this.

## Deliberate spike cuts (NOT architecture findings)

- usage is memory-only (a real gateway persists via core `UsageLedger`)
- no liveness pruning (`resolveServedModels` supplies it verbatim)
- secrets read once from the local bridge snapshot file to keep them out of the repo;
  a real gateway owns a secrets file with the same `ServerEntry` shape
- no hot reload / config watcher, no `/usage` history, bearer token is fixed and local

## Decision gate for the real thing

Before committing to "service owns settings", the open questions the spike did NOT
answer (by design):

- settings ownership migration: what does "edit in VS Code settings" mean once the
  file is the gateway's (mirror? projection? editor-only UI?)
- lifecycle UX: who supervises the gateway, with what drain/adoption (the bridge's
  supervisor already implements the pattern — candidate for extraction, not rewrite)
- the bridge's fate: the adapter collapses to "plain OpenAI client" — verify BYOK
  (VS Code custom endpoint) → gateway keeps personalities/capture end to end

## Run it

```
node spike/gateway/gateway.mjs        # listens on 127.0.0.1:8787 (settings.json)
node spike/gateway/smoke.mjs          # five checks, one small real request
```

Machine paths (core, presets, secrets) are `%APPDATA%`/`%USERPROFILE%` patterns in
`gateway.settings.json` — this spike is a one-machine artifact by design.
