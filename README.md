# DeepSeek Harness Bridge (vLLM, local)

Run the [DeepSeek Harness](https://www.npmjs.com/package/@deepseek-ai/dsh) (dsh) agent loop entirely on your own vLLM or OpenRouter servers. No DeepSeek account, no credential setup, no vendor login. Your models come from your [vLLM-Copilot](https://github.com/fuzzifikation/vLLM-Copilot) registry, already configured and working in VS Code.

You install the extension. It installs a pinned `@deepseek-ai/dsh` into a private runtime directory (`npx` was rejected: a Windows `.cmd` shim handing you whatever version it feels like), supervises `dsh web` with a dedicated `DSH_HOME`, installs the adapter plugin from this repo into it, and writes a snapshot of your vLLM-Copilot registry (servers, models, modes, sampling params, headers, output budgets). Inside the dsh process, the plugin implements dsh-llm's `LlmAdapter` contract and routes every generation through the vLLM-Copilot core, so your model configs, personalities, and usage accounting apply to harness traffic too. dsh itself stays 100% upstream, never forked.

## What lives in this repo

| Artifact | What it is |
|---|---|
| VS Code extension | The marketplace product: detects Node and dsh, offers install, launches and supervises the harness, writes the registry snapshot and overlay config, reports health, hands completed requests to the vLLM-Copilot usage ledger. |
| dsh adapter plugin | A plain Node package with no VS Code imports. Loaded inside the dsh process as a cordis plugin. Implements `LlmAdapter.stream()` and projects every call onto the vLLM-Copilot core request path. |

## Requirements

- Node.js 22+ with `npm` on PATH (the extension installs the pinned harness with it; dsh's own packages require Node 22)
- The [vLLM-Copilot](https://github.com/fuzzifikation/vLLM-Copilot) extension with at least one working server and model

## Status

Pre-alpha (0.0.x), one developer. The loop works end to end: your registry becomes the harness's model list, models your servers stopped serving are hidden, the harness opens as a tab inside VS Code, the agent can call editor tools (diagnostics, open files and diffs, terminal commands, questions back to you), and harness traffic lands in the vLLM-Copilot usage ledger. Windows is the tested platform; others are untested. The design law for this repo (architecture, owner rulings, verification gates) lives in [docs/dsh-bridge-plan.md](docs/dsh-bridge-plan.md), this repo's own since 2026-10-08.

## License

MIT. Contains no code from other projects; if that ever changes, attribution lands in `THIRD-PARTY-NOTICES.txt`.
