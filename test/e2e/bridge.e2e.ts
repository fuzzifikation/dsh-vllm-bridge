/**
 * The one handoff test that unit stubs can fake: the bridge reaching a REAL
 * installed vLLM-Copilot through the genuine `extensions.getExtension(...)`
 * boundary and pushing outbox records across it.
 *
 * Named breakages this catches and no vitest file can:
 *  - the bridge going dark (or never handing over) although an owner extension
 *    with a matching id IS installed, e.g. an id casing or export-shape drift;
 *  - the ledger double-counting: a record whose file survives its own ack gets
 *    accepted again on the next timer pass, silently inflating the user's
 *    dashboard totals. The quiet-period re-check is the whole point.
 *
 * The stand-in owner is built by `node scripts/e2e-stand-in.mjs` and installed
 * via --extensions-dir; it implements the same dedup contract as the real
 * `externalUsage.ts` and records every handed-over id on its exports.
 */
import * as assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import * as path from 'node:path'
import * as vscode from 'vscode'

const BRIDGE_ID = 'System-Sciences.dsh-vllm-bridge'
/** The exact string the product looks up. Casing drift here is a real bug. */
const OWNER_ID = 'System-Sciences.vllm-copilot'

interface HandoffCall {
  recordId: string
  modelId: string
}
interface OwnerExports {
  dshBridge: {
    apiVersion: number
    calls: HandoffCall[]
    counters: { prompt: number; completion: number }
  }
}

const RECORDS = [
  {
    recordId: 'e2e-handoff-a',
    recordedAt: '2026-10-05T00:00:01.000Z',
    lastRequest: {
      serverUrl: 'http://127.0.0.1:9/v1',
      modelId: 'e2e/test-model',
      timestamp: Date.UTC(2026, 9, 5),
      promptTokens: 120,
      completionTokens: 34,
      totalTokens: 154,
      reasoningTokens: 7,
    },
  },
  {
    recordId: 'e2e-handoff-b',
    recordedAt: '2026-10-05T00:00:02.000Z',
    lastRequest: {
      serverUrl: 'http://127.0.0.1:9/v1',
      modelId: 'e2e/test-model',
      timestamp: Date.UTC(2026, 9, 5) + 1000,
      promptTokens: 240,
      completionTokens: 68,
      totalTokens: 308,
      reasoningTokens: 0,
    },
  },
]

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function plant(dir: string, record: (typeof RECORDS)[number]): void {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, `${record.recordId}.json`), JSON.stringify(record))
}

describe('bridge ledger handoff across the real extension boundary', () => {
  it('delivers every outbox record exactly once to an installed owner', async () => {
    const bridge = vscode.extensions.getExtension(BRIDGE_ID)
    const owner = vscode.extensions.getExtension(OWNER_ID)
    assert.ok(bridge, `the bridge itself must be loaded (development path)`)
    assert.ok(owner, `the stand-in owner must be discoverable through --extensions-dir`)

    // The dev extension loads from the repo root, and the harness home lives
    // under this window's throwaway profile: the stable home name, exactly as
    // production uses.
    const repoRoot = bridge!.extensionUri.fsPath
    const outbox = path.join(
      repoRoot,
      '.vscode-test',
      'user-data',
      'User',
      'globalStorage',
      BRIDGE_ID,
      'dsh-home',
      'vllmc',
      'usage-outbox',
    )

    await owner!.activate()
    const exports = owner!.exports as OwnerExports
    assert.equal(exports.dshBridge.apiVersion, 1, 'stand-in must publish the handoff contract version')

    for (const record of RECORDS) plant(outbox, record)

    // Activation ordering is genuinely racy (onStartupFinished vs. this file),
    // and the ingest timer's default cadence is 10 s, so poll instead of
    // praying. A record file is re-planted only while its id has not been seen
    // yet: after the ledger acked it, the file's absence is the point.
    const ids = RECORDS.map((r) => r.recordId)
    const deadline = Date.now() + 120_000
    while (Date.now() < deadline) {
      await sleep(500)
      const seen = new Set(exports.dshBridge.calls.map((c) => c.recordId))
      for (const record of RECORDS) {
        if (!seen.has(record.recordId) && !existsSync(path.join(outbox, `${record.recordId}.json`))) {
          plant(outbox, record)
        }
      }
      if (ids.every((id) => seen.has(id))) break
    }
    const seenIds = exports.dshBridge.calls.map((c) => c.recordId)
    assert.ok(
      ids.every((id) => seenIds.includes(id)),
      `both records must cross the boundary; saw [${seenIds.join(', ')}]`,
    )
    assert.deepEqual(
      exports.dshBridge.counters,
      { prompt: 360, completion: 102 },
      'counters must equal the two records summed once each',
    )

    // The exactly-once proof: wait past a full ingest interval with nothing
    // new planted. Anything the ack failed to delete shows up here as a second
    // call, which in production would be a silently doubled dashboard.
    await sleep(15_000)
    assert.equal(exports.dshBridge.calls.length, 2, `no record may be handed over twice; saw ${exports.dshBridge.calls.length} calls`)
    assert.deepEqual(exports.dshBridge.counters, { prompt: 360, completion: 102 })
    const leftovers = readdirSync(outbox).filter((n) => n.endsWith('.json'))
    assert.deepEqual(leftovers, [], 'acked records must be deleted from the outbox')
  }).timeout(200_000)
})
