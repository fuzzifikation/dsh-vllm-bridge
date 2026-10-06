# What vLLM-Copilot can change to serve the dsh bridge better

Audience: the vLLM-Copilot repo. This is the companion extension's wishlist, ordered by how much drift each change deletes. Every item lists what the bridge does today as a workaround, so nothing here is speculative: all friction was measured while shipping 0.0.8 through 0.0.13.

Standing law this document does not challenge: no npm publish pipeline, the registry settings stay the single source of truth, the harness consumes the compiled core through file-staging, and the bridge never imports from the extension's internals.

> **Status (2026-10-06): this wishlist is spent.** P1-P4 are adopted in the
> bridge and implemented in a locally staged vLLM-Copilot 1.37.1-rc0; read the
> [Adoption status](#adoption-status-2026-10-06-vllm-copilot-1371-rc0-unshipped)
> at the end FIRST. The body keeps its original present tense as the measured
> record it was, so every "the bridge does X today" describes 0.0.13 and
> before: those workarounds (own prober, defensive record normalization,
> mirrored dedupe) are deleted code. Do not "fix" them, and do not re-propose
> the shapes the adoption section marks rejected. The rulings' rationale below
> is still live law; only the workaround descriptions are history.

## P1: one tri-state verdict for "is this model alive"

The chat model picker hides a model whose wire id disappeared from the server's model list. The harness must not offer such a model either, or selecting it produces only an error toast (live incident 2026-10-06). As of 0.0.12 the bridge probes on its own with the core's exported `detectServerType` and `listServerModels`.

A certified fact before any signature: the two consumers deliberately react differently, and that difference is not drift. The core's own `catalog/describe.js` header records the picker's live-inventory ruling: an unreachable server drops its models from the picker entirely, because the picker shows what works right now. The bridge at boot does the opposite for the same signal: an unreachable server keeps all of its models, because refusing to start the harness over a network hiccup punishes the user for a fact nobody actually verified. What must live once is the verdict, not the reaction.

Export one resolver that answers the question and nothing else: something like `resolveServedModels(entries, servers)` taking the parsed settings entries and server list (both consumers already hold exactly those), resolving per wire id to one of `served`, `absent` (with a reason string for the bridge's warning line), or `unknown` (probe failed, or the list came back empty: "could not ask" is never "serves nothing"). Each surface keeps its own posture on top: the picker drops `absent` and `unknown`, the bridge prunes only `absent`. The picker paths (`vllmClient` and `testAndRefresh` each carry their own ad-hoc probe handling today) and the bridge all call it, and the bridge deletes `src/bridge/catalog.ts` plus its injected prober.

One cache fact so the resolver does not grow a redundant layer: `listServerModels` and `resolveRuntimeLimits` already share a 5 second TTL memo with in-flight dedupe, and a failed probe is never cached past the TTL. No consumer needs a cache-clear call, so `resolveServedModels` should not grow a knob for it.

## P2: a declared, typed surface for the staged core

`out/core/index.js` is consumed by the adapter (inside the pnpm profile, works), by the bridge rails, and since 0.0.12 by the extension host via dynamic import with duck-typed feature checks, because there is no declaration file and no documented stability promise on the export list.

That gap is where the first real accident happened. `listServerModels` resolves to model descriptor records (the `describeModel` shape, keyed by `id`), not strings, and the name does not say so. A consumer that guesses `string[]` compares wire ids against objects, reads every model as absent, and the bridge's prune posture turns that into a refusal to boot a healthy setup. The shipped bridge normalizes records defensively for exactly this ambiguity; an untyped surface guarantees the next consumer guesses differently.

Three cheap changes:

1. Add `out/core/index.d.ts` to the shipped output (tsc can emit it; the types already exist in source). The declaration is where the real contract gets pinned, specifically: `listServerModels` resolves to descriptor records with an `id` field, never bare strings, and an empty answer means "unknown", never "serves nothing".
2. Document `ServerProbeError` (already exported) as the signal for "the probe could not get an answer", so consumers use `instanceof` instead of the `err.name` string match the bridge is forced into today.
3. State in the core module header that the export list is the public API of `vllm-copilot-core`, same discipline as any package. The bridge pins the extension version in staging stamps, so a signature change should mean a version bump, and then the bridge's rail (`npm run bridge:check`) catches it at pin time instead of the user catching it at boot.

Related fact for whoever wires this: the raw `vendor/vllm-copilot-core` staging has no `node_modules`, so importing its `core/index.js` outside the profile fails on the core's own bare imports. The profile-installed copy (`profiles/vllmc/node_modules/vllm-copilot-core`) is the only location where the dependency graph resolves. A core with zero runtime dependencies, or a staged bundle without bare imports, would remove this whole trap.

## P3: harness-safe model identity

dsh displays the model **id** wherever it shows the active model, and the registry's generated ids embed hostnames (`<wire> on <host>`), which puts a private server's name on screen in any third-party UI and collides with this repo's public-hygiene law. Since 0.0.12 the bridge re-keys snapshot ids to the user-chosen `displayName` (uniquified with suffixes on collision, warnings by label), which fixes display but is a second identity system to maintain.

Two candidate changes upstream, either suffices:

1. Guarantee `displayName` uniqueness in the settings UI and registry normalization, so the bridge's collision suffix never fires and display names are valid keys by construction.
2. Better: have the core expose the same keying helper the bridge uses, so any future consumer that needs a display-safe stable key gets the identical one instead of inventing a third scheme.

Registry ids themselves must stay stable (they are persistence keys); this item is only about the display-safe key.

## P4: fold the bridge's ingest path into the core

Release prerequisite first: no released vLLM-Copilot through 1.37.0 contains this handoff at all, so a companion user on any published build defers every usage record and sees an "update vLLM-Copilot" reminder that no available update satisfies. The export exists in development and needs a release that bumps the version past 1.37.0; the dev tree's own `package.json` still carries the shipped number, and every version stamp in the ecosystem (marketplace, the bridge's staging stamps) compares that number.

The bridge hands usage records to the main extension through the `dshBridge` export, validated by strict `apiVersion` equality, with the extension's `externalUsage.ts` performing dedupe and merge against the ledger. The core already exports every primitive (`parsePersisted`, `mergePersisted`, `emptyCounts`, ledger types). Exporting one `ingestExternalUsage(records, persisted)` that wraps dedupe plus merge would leave `externalUsage.ts` as transport glue, and the bridge's e2e stand-in (which reimplements the dedupe contract to stay honest about double-counting) could wrap the real function instead of mirroring it. That removes the one contract this repo's e2e has to imitate by hand.

## P5: small honest annoyances

- Personality winner selection: the harness applies exactly one personality file per session. The bridge warns when several models carry personality files and picks the default model's file. A core helper `resolvePersonalityFile(entries, defaultId)` would state that rule where the personality feature lives.
- `LEDGER_API_VERSION` is a strict integer. Adding an optional second capability to the export forces a version bump that breaks older bridges. A capability array with the current integer as one entry would let additive changes land without a forced handshake change on both sides. Only worth doing the next time a real capability is added, not as churn.

## What should NOT change

- The staging mechanism (compiled `out/core` copied by the bridge, version stamped) works and is certified on rails; packaging it as an npm tarball would violate the no-publish ruling for no measured gain.
- The strict snapshot contract between bridge writer and adapter loader (`parseSnapshot` owns the version) is the pattern; if any P1 or P2 API grows a payload, keep one loader as the single authority.
- The registry settings stay the input. A future `listModels()` on the main extension's export would just be P1's core function re-exposed through IPC for no consumer's benefit; the bridge can call the core directly once P2 lands.
- Both reactions described in P1 are deliberate rulings. The picker's live-inventory drop and the bridge's keep-on-unknown boot posture stay separate: only the verdict is shared.

## Adoption status (2026-10-06, vLLM-Copilot 1.37.1-rc0, unshipped)

Everything below is against the locally staged rc core (`node
scripts/stage-core.mjs --dir ..\vLLM-Copilot-public` — the `--dir` mode exists
precisely because none of this is tagged or shipped yet).

- **P1 adopted.** `src/bridge/catalog.ts` is deleted. The bridge injects a
  `coreCatalog` dependency that duck-loads `resolveServedModels` from the
  staged core; `buildSnapshot` now takes the core's per-model verdicts
  (`served: { [modelId]: { state, reason? } }`) and prunes on `absent` only,
  exactly the ruling above. A core too old to export the resolver, or one
  that throws, means models are offered unfiltered — the same posture the
  old probe failure had. The 0.0.12 `{id}`-entry normalization canary moved
  to the core repo with the logic (`companionApi.test.ts`).
- **P2 adopted.** Declarations are emitted into `out/core` and shipped in the
  VSIX; `shared/core-staging.mjs` gives the staged manifest a `types`
  condition so consumers resolve them.
- **P3 adopted.** `buildDisplayKeys` (when the core exports it) is the
  re-key base for snapshot ids; the writer's own name fallback and collision
  suffix stay as the guard for older cores. Identity is one rule, shared with
  the Copilot picker.
- **P4 adopted.** The e2e ledger double no longer mirrors the dedupe: it
  imports the real `ingestExternalUsage` from the staged core (that module
  imports nothing, which is what makes this possible from a stub with no
  node_modules) and keeps only the host glue — seen-id state and counters —
  that the real `externalUsage.ts` also keeps. The stand-in build fails
  loudly if the staged core predates the module.
- **P5 not adopted.** No `resolvePersonalityFile` was written: each side holds
  the rule once, a shared helper would have had no second production caller
  to pay its rent, and the capability-array idea waits for the next real
  capability, as the request itself said.
