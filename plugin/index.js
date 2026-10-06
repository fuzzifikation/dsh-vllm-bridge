/**
 * vLLM-Copilot adapter plugin for the DeepSeek Harness (dsh).
 *
 * Cordis bundle plugin: registers the `vllmc` LlmAdapter inside the dsh
 * process. Reads the registry snapshot written by the bridge extension, loads
 * the staged vLLM-Copilot core (installed as this package's dependency), and
 * routes every generation through the real core request path. Completed
 * request records land in the usage outbox for the bridge to ingest into the
 * main extension's canonical ledger.
 *
 * Certified contract facts (dsh 0.2.0-rc.2): `inject = ['llm']` is required
 * for ctx.llm; registerAdapter returns a disposer; chunk order
 * block-start -> deltas -> block-end -> usage -> finish renders; usage counts
 * are cache-disjoint; the loop deep-freezes its GenerateOptions, hence the
 * fully detached projection in project.js.
 */
import path from 'node:path'
import { loadSnapshot, snapshotPathFrom } from './snapshot.js'
import { createVllmcAdapter } from './adapter.js'

export const inject = ['llm']

export function apply(ctx) {
  const file = snapshotPathFrom()
  let snapshot
  try {
    snapshot = loadSnapshot(file)
  } catch (err) {
    ctx.logger.error(
      `vllmc bridge: refusing to register (${err.message}). ` +
        'Install the vLLM-Copilot extension and launch dsh through the bridge, or remove this bundle.',
    )
    return
  }
  const adapterDeps = {
    outboxDir: path.join(path.dirname(file), 'usage-outbox'),
    activeDir: path.join(path.dirname(file), 'active'),
    log: { appendLine: (line) => ctx.logger.info(`[vllmc] ${line}`) },
  }
  return import('vllm-copilot-core').then((core) => {
    const adapter = createVllmcAdapter({ core, snapshot, deps: adapterDeps })
    const registration = ctx.llm.registerAdapter(['vllmc'], adapter)
    ctx.effect(() => () => registration())
    ctx.logger.info(
      `vllmc adapter registered: ${snapshot.config.models.length} model(s), default '${snapshot.defaultModelId}' (snapshot v${snapshot.version})`,
    )
  })
}
