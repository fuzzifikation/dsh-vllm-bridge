#!/usr/bin/env node
/**
 * Build the stand-in "installed vLLM-Copilot" for the extension-host e2e.
 *
 * Not a mock of the bridge's logic: a real, separately installed extension
 * that VS Code discovers through --extensions-dir, whose exports the bridge
 * reaches through the genuine `extensions.getExtension(...).exports` boundary.
 * The bridge's dark mode (refuse to launch without the owner) is product
 * behavior, so the honest test is to give it an owner, not to stub the check
 * away. The ledger double here implements the same contract the real
 * `externalUsage.ts` publishes: dedup by recordId, ack every id settled.
 *
 * The compiled core is copied from the staging output (run
 * `node scripts/stage-core.mjs` first), so the bridge stages a byte-real core
 * into the harness home exactly as it would from a marketplace install.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const stage = path.join(root, 'temp', 'stage', 'vllm-copilot-core')
const out = path.join(root, 'temp', 'e2e-extensions', 'system-sciences.vllm-copilot')

if (!existsSync(path.join(stage, 'core', 'index.js'))) {
  console.error('FAIL: no staged core; run `node scripts/stage-core.mjs` first')
  process.exit(1)
}

const STUB_VERSION = '9.9.9-e2e'

rmSync(out, { recursive: true, force: true })
mkdirSync(path.join(out, 'out'), { recursive: true })

// Deliberately no "type": "module": this stub wears the real extension's
// shape (CJS main), and VS Code's own loader decides how to require it.
writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify(
    {
      name: 'vllm-copilot',
      displayName: 'vLLM-Copilot (e2e stand-in)',
      publisher: 'System-Sciences',
      version: STUB_VERSION,
      private: true,
      engines: { vscode: '^1.128.0' },
      main: './extension.js',
      activationEvents: ['onStartupFinished'],
      contributes: {},
    },
    null,
    2,
  ) + '\n',
)

writeFileSync(
  path.join(out, 'extension.js'),
  `'use strict'
/**
 * Ledger double implementing the published handoff contract. Records every
 * batch on the exports so the test, running in the same extension host, can
 * assert what the bridge actually handed over.
 *
 * The accept/duplicate/preReset/rejected decision is the REAL core function:
 * ingestExternalUsage from the staged core copied into out/core below — the
 * same code the real externalUsage.ts glue calls (that module is thin glue
 * precisely so this stays possible). This stub keeps only the host-side state
 * the real glue keeps: the seen-id list and applying the plan to counters.
 * A hand-rolled mirror of the dedupe here once let the e2e go green while the
 * shipped decision code drifted — that era ends now.
 */
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
let corePromise
const coreIngest = () =>
  (corePromise ??= import(pathToFileURL(join(__dirname, 'out', 'core', 'usage', 'ingest.js')).href))
const api = {
  apiVersion: 1,
  /** Every recordId the bridge handed over, in arrival order, with its bucket. */
  calls: [],
  counters: { prompt: 0, completion: 0 },
  seenIds: [],
  async recordExternalRequests(records) {
    const { outcome, requests, nextSeenIds } = (await coreIngest()).ingestExternalUsage(records, {
      seenIds: api.seenIds,
      barriers: {},
    })
    api.seenIds = nextSeenIds
    for (const r of requests) {
      api.counters.prompt += r.promptTokens
      api.counters.completion += r.completionTokens
    }
    for (const r of records) api.calls.push({ recordId: r.recordId, modelId: r.request.modelId })
    return outcome
  },
}

function activate() {
  return { dshBridge: api }
}

module.exports = { activate }
`,
)

cpSync(path.join(stage, 'core'), path.join(out, 'out', 'core'), { recursive: true })
// The double imports the real ingest module at first call, so the staged core
// must carry it. No silent degradation: a stale stage would exercise a ledger
// path the shipped code never takes.
if (!existsSync(path.join(out, 'out', 'core', 'usage', 'ingest.js'))) {
  console.error('FAIL: the staged core has no usage/ingest.js — stage vLLM-Copilot >= 1.37.1 (node scripts/stage-core.mjs --dir ..\\vLLM-Copilot-public)')
  process.exit(1)
}
if (existsSync(path.join(stage, 'LICENSE'))) cpSync(path.join(stage, 'LICENSE'), path.join(out, 'LICENSE'))

console.log(`built stand-in owner ${STUB_VERSION} -> ${out}`)
console.log(`core copied: ${readFileSync(path.join(out, 'out', 'core', 'index.js'), 'utf8').length} bytes of index.js`)
