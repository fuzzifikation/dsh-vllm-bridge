# AI Assistant Instructions: dsh-vllm-bridge

Companion to [vLLM-Copilot](https://github.com/fuzzifikation/vLLM-Copilot). Two artifacts, one repo:

- **VS Code extension** (`src/`, marketplace id `dsh-vllm-bridge`, display "DeepSeek Harness Bridge (vLLM, local)"): installs the pinned `@deepseek-ai/dsh` into a private runtime directory and supervises `dsh web` under a dedicated `DSH_HOME`, writes the registry snapshot and dsh overlays, reports health, hands usage records to the main extension's ledger.
- **dsh adapter plugin** (`plugin/`, plain Node package, zero `vscode` imports): cordis plugin implementing dsh-llm's `LlmAdapter`, loaded inside the dsh process, routing every generation through the vLLM-Copilot core.

## Law and plans

- **Design law** (architecture mermaid, six owner rulings, adapter contract, verification gates 1-5, spike-verified dsh facts): [docs/dsh-bridge-plan.md](../docs/dsh-bridge-plan.md). Read it before designing anything; it is the repo's own law since 2026-10-08.
- **Executable plan and current status**: [docs/plan.md](../docs/plan.md). Work from it; update its status line as units move.

## Standing rulings (do not re-propose around them)

- dsh stays 100% upstream: overlays and supervision only, never a fork, never a patched install.
- Core consumption: the bridge stages the vLLM-Copilot extension's compiled `out/core` into `DSH_HOME/vendor/vllm-copilot-core/` with a version stamp, and installs the adapter plugin into the dsh profile as a `file:` package beside it, so pnpm links the core underneath. No npm publish pipeline, no git-tag dependency: tags carry source only.
- The harness owns the conversation, we own the request: dsh's model `compat` keys stay unset, all model behavior comes from our model configs.
- No dependency on `NEXTINDIE/DeepSeek-Harness-for-VS-Code` (MIT): copy with attribution into `THIRD-PARTY-NOTICES.txt`, never import.
- Never commit hostnames, URLs of private servers, keys, or captured prompt text. Our config ids and server ids embed hostnames, so tooling output and fixtures print only wire model ids and user-chosen display names. Public repo, assume every byte is read by strangers.

## vLLM-Copilot companion API (adopted against 1.37.1-rc0, nothing shipped yet)

- **The core's decisions are called, never copied.** `src/bridge/catalog.ts` (home-rolled served-model probe) and the e2e stub's hand-rolled dedupe are deleted and do not come back. Served verdicts come from the staged core's `resolveServedModels` (prune `state: 'absent'` ONLY, `unknown`/missing verdict keeps every model offered, a throwing core means unfiltered); display keys come from `buildDisplayKeys` when the core exports it (the writer's own name fallback and ` (2)` collision guard stay for older cores); `scripts/e2e-stand-in.mjs` wraps the real `ingestExternalUsage` from the staged core (`usage/ingest.js` imports nothing, so a node_modules-less CJS stub can load it) and the builder fails loudly on a core too old to carry it. Duplicated decision logic is what caused the 0.0.12 catalog wipe. Per-item adoption status: [docs/vllm-copilot-integration.md](../docs/vllm-copilot-integration.md).
- **Unreleased dev loop, no tag/push/publish needed:** `node scripts/stage-core.mjs --dir ..\vLLM-Copilot-public` stages the core straight from the local working tree (compiles on demand), and `VLLMC_EXT_DIR` points `bridge:check` at the same tree. The `--dir` mode exists precisely because the companion API lives in a checkout long before it exists as a tag.
- **Ledger record shape is load-bearing:** `recordExternalRequests` takes records whose `request` carries `serverUrl` and `timestamp > 0` plus finite counters, and returns ARRAYS of record ids (`accepted`/`duplicate`/`preReset`/`rejected`) — the core's `usage/ingest.ts` is the authority, mirror it by importing it, not by guessing counts.

## General working rules

Same doctrine as the main repo: [working-principles](https://github.com/fuzzifikation/vLLM-Copilot/blob/main/.github/instructions/working-principles.instructions.md). Commit locally freely, never push without the owner's live words, squash silently, tests only as tripwires for real breakage, no coverage metric, plain prose without em dashes.
