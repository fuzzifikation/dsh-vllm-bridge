#!/usr/bin/env node
/**
 * Step 3 manual rail (bridge gate 3).
 *
 * Drives the COMPILED extension modules (`out/bridge/*.js`) with no VS Code
 * present, which is the point: the same code the editor runs has to boot a real
 * dsh, discover its URL, share it with a second window instead of fighting it,
 * survive a real agent turn, and hand the resulting usage to a ledger.
 *
 * Proves, in order:
 *   1. prepare(): runtime install, core staged from an installed extension,
 *      profile created from the web default, adapter installed, snapshot and
 *      overlay composed.
 *   2. start(): web boot, URL discovered from stdout, token never logged.
 *   3. adoption: a second Bridge reuses the live harness, and a pid whose port
 *      does not answer is never adopted.
 *   4. a completed-request record written by the staged plugin module waits in
 *      the outbox when no ledger accepts it and is handed over exactly once when
 *      one does. (The turn itself through a live harness is Step 4: the web
 *      profile is the entry mode and takes no subcommand here.)
 *   5. stop(): pid file gone, nothing left in flight.
 *
 * Usage: node scripts/step3-bridge-check.mjs
 * Env: VLLMC_EXT_DIR = installed (compiled) vLLM-Copilot extension dir.
 * Requires Node >= 22, npm, pnpm on PATH.
 */
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { bridgePaths, ensureBridgeDirs } from '../out/bridge/paths.js'
import { Bridge } from '../out/bridge/bridge.js'
import { createCoreCatalogSource } from '../out/bridge/core-catalog.js'
import { classifyPidRecord, probeHarness } from '../out/bridge/supervisor.js'
import { startDemoBackend } from './demo-backend.mjs'
import { describeDshVersion } from './dsh-version.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const work = path.join(root, 'temp', 'step3')
const mainExtDir = process.env.VLLMC_EXT_DIR ?? path.join(root, '..', 'vLLM-Copilot-public')
const { version: DSH_VERSION } = describeDshVersion()

const WIRE_MODEL = 'wire-rail'
const MODEL_ID = 'rail-model'
const PROFILE = 'vllmc'

function fail(step, detail) {
  console.error(`FAIL: ${step}`)
  if (detail !== undefined) console.error(typeof detail === 'string' ? detail : JSON.stringify(detail, null, 2).slice(0, 4000))
  process.exit(1)
}
function ok(step, detail = '') {
  console.log(`ok: ${step}${detail ? ` (${detail})` : ''}`)
}

if (!existsSync(path.join(mainExtDir, 'out', 'core', 'index.js'))) {
  fail(`no compiled core under ${mainExtDir}; build it or set VLLMC_EXT_DIR`)
}
const mainVersion = String(JSON.parse(readFileSync(path.join(mainExtDir, 'package.json'), 'utf8')).version ?? 'unknown')

// The rail is a gate, so it starts clean. KEEP=1 skips the wipe while iterating
// on a failure, which otherwise costs a full dsh reinstall per attempt.
if (!process.env.KEEP) rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

const backend = await startDemoBackend({ models: [{ id: WIRE_MODEL, max_model_len: 200000 }] })
const paths = bridgePaths(work)
ensureBridgeDirs(paths)

// Stub editor MCP endpoint: the rail has no VS Code, so this stands in for
// the extension control channel. What it PROVES is the composition question:
// the generated overlay must give the upstream `dsh-mcp-client` a URL and
// bearer token that dsh actually resolves and starts as a preset child, and
// the handshake must arrive here carrying that token. Wrong indent, wrong
// package name, or a dangling import all land here as a timeout.
const mcpStub = { hits: { initialize: 0, toolsList: 0, unauthorized: 0 }, token: randomUUID() }
const stub = createServer((req, res) => {
  if (req.url !== '/mcp' || req.method === 'DELETE') {
    res.writeHead(404).end()
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405).end()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    if (req.headers.authorization !== `Bearer ${mcpStub.token}`) {
      mcpStub.hits.unauthorized++
      res.writeHead(401).end()
      return
    }
    let msg
    try {
      msg = JSON.parse(body)
    } catch {
      res.writeHead(400).end()
      return
    }
    if (msg.id === undefined) {
      res.writeHead(202).end()
      return
    }
    const result =
      msg.method === 'initialize'
        ? { protocolVersion: msg.params?.protocolVersion ?? '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'rail-mcp-stub', version: '0' } }
        : msg.method === 'tools/list'
          ? { tools: [] }
          : {}
    if (msg.method === 'initialize') mcpStub.hits.initialize++
    if (msg.method === 'tools/list') mcpStub.hits.toolsList++
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }))
  })
})
await new Promise((resolve) => stub.listen(0, '127.0.0.1', resolve))
const stubUrl = `http://127.0.0.1:${stub.address().port}`

/** Ledger stand-in with the real contract: dedup by recordId, ack what you settled. */
function fakeLedger() {
  const seen = new Set()
  return {
    apiVersion: 1,
    accepted: [],
    async recordExternalRequests(records) {
      const out = { accepted: [], duplicate: [], preReset: [] }
      for (const record of records) {
        if (seen.has(record.recordId)) out.duplicate.push(record.recordId)
        else {
          seen.add(record.recordId)
          out.accepted.push(record.recordId)
        }
      }
      this.accepted.push(...out.accepted)
      return out
    },
  }
}

let ledgerPort = undefined
const log = {
  info: (m) => console.log(`   [bridge] ${m}`),
  warn: (m) => console.log(`   [bridge warn] ${m}`),
  error: (m) => console.log(`   [bridge error] ${m}`),
}

function makeBridge() {
  return new Bridge({
    extensionRoot: root,
    extensionVersion: '0.0.1-rail',
    paths,
    log,
    dshVersion: DSH_VERSION,
    registry: () => ({
      servers: [{ id: 'rail-server', serverUrl: `${backend.url}/v1`, displayName: 'Loopback Wiretap', requestHeaders: { 'x-rail': '1' } }],
      models: [
        { id: MODEL_ID, vllmModelId: WIRE_MODEL, server: 'rail-server', displayName: 'Rail Model' },
        // Not in the wiretap's /v1/models: the REAL staged core's resolver must
        // verdict it absent and prepare must drop it from the snapshot. This is
        // the gate's only proof that resolveServedModels runs; without it the
        // companion API would be exercised solely by fakes echoing themselves.
        { id: 'retired-model', vllmModelId: 'wire-retired', server: 'rail-server', displayName: 'Rail Retired' },
      ],
      fixEmptyToolParameters: true,
    }),
    choices: () => ({ defaultModelId: MODEL_ID, drainTimeoutMs: 5000 }),
    ledgerPort: () => ledgerPort,
    mainExtension: () => ({ path: mainExtDir, version: mainVersion }),
    controlEndpoint: () => ({ url: stubUrl, token: mcpStub.token }),
    coreCatalog: createCoreCatalogSource({
      // Same loader the extension builds, against the profile-installed core:
      // the rail exercises the shipped code path, not a rail-shaped double.
      entryFile: () => path.join(paths.profileModules, 'vllm-copilot-core', 'core', 'index.js'),
      log,
    }),
  })
}

const bridge = makeBridge()
let prepared
try {
  prepared = await bridge.prepare()
} catch (err) {
  await backend.close()
  fail(`prepare with dsh ${DSH_VERSION} against vLLM-Copilot ${mainVersion}`, err.message)
}
ok('prepare', `dsh ${prepared.dshVersion}, core ${prepared.coreVersion}, snapshot v${prepared.snapshotVersion}, ${prepared.rowsDisabled} rows disabled`)
if (prepared.rowsDisabled < 8) fail('overlay disabled fewer privacy rows than certified', prepared.rowsDisabled)

const snapshot = JSON.parse(readFileSync(paths.snapshot, 'utf8'))
// Snapshot ids are display keys since 0.0.12 (dsh prints the id as the active
// model; registry ids embed hostnames).
if (snapshot.defaultModelId !== 'Rail Model') fail('snapshot default model is not the configured one', snapshot.defaultModelId)
{
  const modelIds = snapshot.config.models.map((m) => m.id)
  if (!modelIds.includes('Rail Model')) fail('snapshot lost the model the server serves', modelIds)
  if (modelIds.includes('Rail Retired')) {
    fail(
      'the core resolver did not prune the model the wiretap does not serve; is VLLMC_EXT_DIR a vLLM-Copilot build exporting resolveServedModels?',
      modelIds,
    )
  }
  if (!prepared.warnings.some((w) => w.includes('Rail Retired'))) {
    fail('pruning the absent model happened without a warning the user can read', prepared.warnings)
  }
  ok('served catalog', 'the real core resolver pruned the unserved model and said why')
}

const url = await bridge.start().catch((err) => fail('web boot', err.message))
if (!/^http:\/\/127\.0\.0\.1:\d+\/?\?token=/.test(url)) fail('discovered URL is not a loopback token URL', url)
ok('start', `URL ${url.replace(/\?.*$/, '?<token redacted>')}`)

const state = classifyPidRecord(paths.pid)
if (state.kind !== 'live') fail('the running harness is not recorded as live', state)
if (!(await probeHarness(state.record.url))) fail('the recorded URL does not answer', state.record.pid)
ok('pid record', `pid ${state.record.pid} answers its port`)

// Second window: must reuse, not spawn a rival harness or kill the first.
const second = makeBridge()
const url2 = await second.start().catch((err) => fail('second window start', err.message))
if (!second.supervisor.adopted) fail('second window spawned a rival harness instead of adopting')
if (url2 !== url) fail('second window reports a different URL', url2)
ok('adoption', 'second window reused the running harness')

// The MCP mount must survive REAL composition, not just overlay text math:
// dsh has to resolve the generated `vllmc-editor-mcp` preset child (upstream
// dsh-mcp-client) from the profile graph and that child must dial the URL and
// token the overlay generated, with the bearer header intact.
{
  const deadline = Date.now() + 60_000
  while (mcpStub.hits.initialize === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 1000))
  if (mcpStub.hits.initialize === 0) {
    await backend.close()
    stub.close()
    fail(
      'mcp preset child mount',
      mcpStub.hits.unauthorized
        ? 'the harness dialed the editor endpoint WITHOUT a valid bearer token (overlay header wiring broken)'
        : 'the harness never dialed the editor MCP endpoint (preset child not resolved, or it starts only on session create: re-certify the timing)',
    )
  }
  ok('mcp mount', `initialize x${mcpStub.hits.initialize}, tools/list x${mcpStub.hits.toolsList}, unauthorized ${mcpStub.hits.unauthorized}`)
}

// A pid that is alive but does not answer must never be adopted: that is a
// recycled pid belonging to somebody else's program.
const stranger = spawn(process.execPath, ['-e', 'setTimeout(()=>{},20000)'], { stdio: 'ignore', windowsHide: true })
stranger.unref()
try {
  writeFileSync(paths.pid, JSON.stringify({ pid: stranger.pid, startedAt: new Date().toISOString(), profile: PROFILE, dshVersion: DSH_VERSION, url: 'http://127.0.0.1:9/?token=wrong' }))
  const probe = await probeHarness('http://127.0.0.1:9/?token=wrong')
  if (probe) fail('a dead port answered the probe')
  ok('probe', 'an unanswered port is not adopted')
} finally {
  stranger.kill()
  // Put the honest record back: the rail overwrote it to simulate a stranger.
  writeFileSync(paths.pid, JSON.stringify({ ...state.record, url }))
}

// Usage handoff, written by the STAGED plugin module, which is the file that
// actually runs inside the dsh process. A turn driven from the harness UI is
// Step 4's job (the web profile takes no subcommand: the profile is the entry
// mode), so this proves the cross-process record contract, not the UI.
const stagedWriter = path.join(paths.vendor.adapter, 'usage-convert.js')
if (!existsSync(stagedWriter)) fail(`staged plugin missing at ${stagedWriter}`)
const { writeUsageRecord } = await import(pathToFileURL(stagedWriter).href)
writeUsageRecord(paths.outbox, {
  sessionId: 'rail-session',
  purpose: 'agent',
  model: 'Rail Model',
  wireModelId: WIRE_MODEL,
  elapsedMs: 1234,
  lastRequest: {
    serverUrl: `${backend.url}/v1`,
    modelId: WIRE_MODEL,
    timestamp: Date.now(),
    promptTokens: 1200,
    completionTokens: 80,
    totalTokens: 1280,
    cachedTokens: 0,
    reasoningTokens: 12,
    totalTimeMs: 1234,
  },
})
ok('request path', `harness up on the bridge profile, snapshot v${snapshot.version} in force`)

const outboxFiles = () => readdirSync(paths.outbox).filter((f) => f.endsWith('.json'))
const before = outboxFiles()
if (before.length === 0) fail('usage outbox received no completed-request record')
const kept = path.join(work, 'replay-record.json')
copyFileSync(path.join(paths.outbox, before[0]), kept)
ok('outbox', `${before.length} record(s) written by the plugin`)

// No ledger available (main extension absent or older than the handoff):
// records must wait, never be dropped.
ledgerPort = undefined
const deferred = await bridge.ingest()
if (deferred.deferred !== before.length || outboxFiles().length !== before.length) {
  fail('records were not preserved while no ledger accepts them', deferred)
}
ok('ingest without a ledger', `${deferred.deferred} record(s) kept for later`)

ledgerPort = fakeLedger()
const firstPass = await bridge.ingest()
if (firstPass.accepted !== before.length || outboxFiles().length !== 0) {
  fail('records were not handed over exactly once', firstPass)
}
ok('ingest with a ledger', `${firstPass.accepted} record(s) accepted, outbox empty`)

// A replayed record (crash between ack and delete) must dedup, not double count.
copyFileSync(kept, path.join(paths.outbox, 'replayed.json'))
const replay = await bridge.ingest()
if (replay.duplicate !== 1 || replay.accepted !== 0) fail('a replayed record was counted twice', replay)
ok('idempotence', 'replayed record recognized as duplicate')

const stopped = await bridge.stop()
if (!stopped.drained) fail('stop reported undrained requests', stopped)
if (existsSync(paths.pid)) fail('pid file survived stop()')
if (classifyPidRecord(paths.pid).kind !== 'none') fail('pid record still readable after stop')
ok('stop', 'pid cleared, nothing in flight')

await backend.close()
stub.close()
console.log(`\nPASS: gate 3 holds for dsh ${DSH_VERSION} with vLLM-Copilot core ${mainVersion}`)
