#!/usr/bin/env node
/**
 * Gateway spike — one process, zero dependencies, everything below from the
 * vLLM-Copilot core's own PUBLIC export list (out/core/index.js, staged copy).
 *
 * Thesis under test: "core + settings file + small http server" gives any client
 * (dsh, BYOK, curl) the full vLLM-Copilot behavior — modes, budgets, retries,
 * personalities, capture, accounting — without the extension being on the wire.
 *
 * Endpoints (spike scope):
 *   GET  /health               liveness + core/registry state
 *   GET  /v1/models            fat catalog: OpenAI list + descriptor fields
 *   POST /v1/chat/completions  streamed relay (SSE) or single JSON, personality +
 *                              modes + retry loop via core.executeChatRequest
 *   GET  /usage                in-memory token counters (spike simplification)
 *
 * Deliberate spike cuts (documented in README, NOT architecture findings):
 *  - usage is memory-only (a real gateway persists via the core UsageLedger)
 *  - no liveness pruning (core.resolveServedModels would supply it verbatim)
 *  - one secrets source file, no hot reload, no config watcher
 */
import { readFileSync, existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

// ─── Settings (the independent settings file) ───────────────────────────────
const here = path.dirname(fileURLToPath(import.meta.url))
const expand = (s) =>
  s
    .replace(/%APPDATA%/g, process.env.APPDATA ?? '')
    .replace(/%USERPROFILE%/g, process.env.USERPROFILE ?? '')

const settingsFile = process.argv[2] ?? path.join(here, 'gateway.settings.json')
const settings = JSON.parse(readFileSync(settingsFile, 'utf8'))
const corePath = expand(settings.corePath)
const secretsPath = expand(settings.secretsSourceSnapshot)
const personalityDirs = {
  globalDir: expand(settings.personalityDirs.globalDir),
  bundledDir: expand(settings.personalityDirs.bundledDir),
}
const captureFile = path.join(here, expand(settings.captureFile ?? 'system-messages.json'))

// ─── Core (the staged public API — the same file the harness adapter imports) ─
const core = await import(pathToFileURL(corePath).href)
const log = { appendLine: (m) => console.log(`[core] ${m}`) }

// Registry: {servers, models} exactly as core consumes it; server headers come
// from the local secrets source at boot (see settings comment).
const registry = structuredClone(settings.registry)
if (!existsSync(secretsPath)) throw new Error(`secrets source not found: ${secretsPath}`)
const secretsDoc = JSON.parse(readFileSync(secretsPath, 'utf8'))
for (const server of registry.servers) {
  const src = (secretsDoc.config?.servers ?? []).find((s) => s.id === server.id)
  server.requestHeaders = core.sanitizeRequestHeaders(src?.requestHeaders ?? {})
}
const models = registry.models
const modelKeys = new Map() // client-facing key -> entry (id and displayName both answer)
for (const entry of models) {
  modelKeys.set(entry.id, entry)
  if (entry.displayName) modelKeys.set(entry.displayName, entry)
}

// ─── Personality: name→path resolution is ALREADY core (P7 finding) ─────────
const rulesCache = new Map()
async function rulesFor(entry) {
  if (rulesCache.has(entry.id)) return rulesCache.get(entry.id)
  let rules = []
  const resolved = await core
    .resolveModelReplacements(
      personalityDirs,
      { personality: entry.personality, systemMessageReplacementsFile: entry.systemMessageReplacementsFile },
      { onLog: (m) => console.log(`[persona] ${m}`) },
    )
    .catch((err) => (console.log(`[persona] resolve failed: ${err.message}`), null))
  if (resolved) {
    console.log(`[persona] "${entry.personality ?? entry.systemMessageReplacementsFile}" → ${resolved.sourcePath}`)
    try {
      rules = await core.loadPromptReplacements(resolved.sourcePath, (m) => console.log(`[persona-warn] ${m}`))
    } catch (err) {
      console.log(`[persona] load failed, continuing without it: ${err.message}`)
    }
  }
  rulesCache.set(entry.id, rules)
  return rules
}

// ─── System-message capture (P6 finding: writer is core CaptureQueue) ───────
const captureQueue = new core.CaptureQueue()
function captureSystemMessages(entries) {
  if (!settings.systemMessageCapture || entries.length === 0) return
  const unique = [...new Map(entries.map((e) => [e.receivedContent, e])).values()]
  captureQueue.enqueueWrite(captureFile, unique, log).catch((err) => console.log(`[capture] ${err.message}`))
}

// ─── Model description (the fat catalog the pickers need) ───────────────────
function serverFor(entry) {
  return registry.servers.find((s) => s.id === entry.server)
}
async function describe(entry, selectedMode) {
  const server = serverFor(entry)
  if (!server) throw new Error(`model '${entry.id}' references absent server '${entry.server}'`)
  const wireId = entry.vllmModelId ?? entry.id
  const serverType = core.resolveServerType(entry, registry.servers)
  const limits = await core.resolveRuntimeLimits(serverType, server.serverUrl, server.requestHeaders ?? {}, wireId, entry.contextWindow)
  return core.describeModel({
    wireId,
    contextWindow: limits.contextWindow,
    serverType,
    override: entry,
    reportedMaxOutputTokens: limits.maxOutputTokens,
    selectedMode,
  })
}

// ─── Usage (memory-only in the spike; core UsageLedger would replace this) ──
const usage = { requests: 0, prompt: 0, completion: 0, cached: 0, reasoning: 0, lastRequest: null }
function recordUsage(completion) {
  const u = completion?.usage ?? {}
  const n = (v) => (Number.isFinite(v) ? v : 0)
  const prompt = n(u.prompt_tokens ?? u.promptTokens)
  const completionTokens = n(u.completion_tokens ?? u.completionTokens)
  usage.requests += 1
  usage.prompt += prompt
  usage.completion += completionTokens
  usage.cached += n(u.prompt_tokens_details?.cached_tokens)
  usage.reasoning += n(u.completion_tokens_details?.reasoning_tokens)
  usage.lastRequest = { at: new Date().toISOString(), prompt, completion: completionTokens, elapsedMs: completion?.elapsedMs }
}

// ─── The request path: personality → assemble → execute → relay ─────────────
const chatTransport = new core.ChatTransport(log)
const transport = {
  chatCompletionStream: (model, messages, options, signal, serverConfig) =>
    chatTransport.stream(model, messages, options, signal, serverConfig),
}

async function runCompletion(body, signal, onEvent) {
  const entry = modelKeys.get(body.model)
  if (!entry) throw Object.assign(new Error(`model '${body.model}' is not served by this gateway`), { status: 404 })
  const selectedMode = body.mode ?? (entry.modelModes ? (entry.defaultMode ?? Object.keys(entry.modelModes)[0]) : undefined)

  // Personality: the vscode-layer pipeline's job, done here with core calls only.
  const rules = await rulesFor(entry)
  const messages = structuredClone(body.messages ?? [])
  const captureEntries = []
  for (const message of messages) {
    if (message.role !== 'system' || typeof message.content !== 'string' || message.content.length === 0) continue
    const received = message.content
    let delivered = received
    let matched = []
    if (rules.length > 0) {
      const applied = core.applyPromptReplacements(received, rules)
      delivered = applied.result
      matched = applied.matchedRuleNames
    }
    message.content = delivered
    captureEntries.push({ receivedContent: received, deliveredContent: delivered, rulesApplied: matched })
  }
  captureSystemMessages(captureEntries)

  const runtimeOptions = {}
  if (Number.isFinite(body.max_tokens)) runtimeOptions.max_tokens = body.max_tokens
  if (Number.isFinite(body.temperature)) runtimeOptions.temperature = body.temperature
  if (Array.isArray(body.stop) && body.stop.length > 0) runtimeOptions.stop = body.stop

  // OpenAI tool vocabulary → core RequestTool vocabulary.
  const tools = Array.isArray(body.tools) && body.tools.length > 0
    ? body.tools.map((t) => ({ name: t.function?.name, description: t.function?.description, inputSchema: t.function?.parameters ?? t.inputSchema }))
    : undefined

  const descriptor = await describe(entry, selectedMode)
  const assembled = core.assembleRequest(
    {
      modelId: entry.id,
      selectedMode,
      openaiMessages: messages,
      runtimeOptions,
      tools,
      toolModeRequired: false,
      fixEmptyToolParameters: true,
      advertisedMaxOutputTokens: descriptor.maxOutputTokens,
    },
    registry,
    log,
  )
  const state = core.createExecutionState(Date.now())
  const iterator = core.executeChatRequest(
    {
      transport,
      modelId: entry.id,
      vllmModelId: assembled.vllmModelId,
      openaiMessages: assembled.openaiMessages,
      mergedOptions: assembled.mergedOptions,
      serverConfig: assembled.serverConfig,
      maxRetries: 2,
      signal,
      log,
      limits: {
        wireModelId: assembled.wireModelId,
        contextWindow: descriptor.contextWindow,
        maxInputTokens: descriptor.maxInputTokens,
        maxOutputTokens: descriptor.maxOutputTokens,
      },
    },
    state,
  )
  let completion = null
  for await (const event of iterator) {
    if (core.isAttemptCompletionEvent(event)) {
      completion = event.attemptCompletion
      continue
    }
    if (event.error) throw new Error(`server error (mid-stream): ${event.error}`)
    onEvent(event)
  }
  if (completion) recordUsage(completion)
  return { state, completion, entry, assembled }
}

// ─── HTTP surface ───────────────────────────────────────────────────────────
function json(res, status, obj) {
  const payload = JSON.stringify(obj)
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
  res.end(payload)
}
function openaiError(res, status, message) {
  json(res, status, { error: { message, type: status === 404 ? 'invalid_request_error' : 'server_error', code: String(status) } })
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > 20 * 1024 * 1024) return reject(new Error('body too large'))
      chunks.push(c)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch (err) {
        reject(new Error(`invalid JSON body: ${err.message}`))
      }
    })
    req.on('error', reject)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': '*' })
    return res.end()
  }
  if (settings.token && (url.pathname.startsWith('/v1') || url.pathname === '/usage')) {
    if (req.headers.authorization !== `Bearer ${settings.token}`) return openaiError(res, 401, 'missing or wrong bearer token')
  }

  if (req.method === 'GET' && url.pathname === '/health') {
    return json(res, 200, { ok: true, served: models.map((m) => m.displayName ?? m.id), capture: settings.systemMessageCapture })
  }

  if (req.method === 'GET' && url.pathname === '/usage') {
    return json(res, 200, usage)
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') {
    const data = []
    for (const entry of models) {
      let extra = {}
      try {
        const d = await describe(entry)
        extra = {
          context_window: d.contextWindow,
          max_output_tokens: d.maxOutputTokens,
          modes: d.modeNames ?? [],
          default_mode: d.defaultMode ?? null,
        }
      } catch (err) {
        extra = { catalog_warning: `limits unknown: ${err.message}` }
      }
      data.push({
        id: entry.displayName ?? entry.id,
        object: 'model',
        owned_by: 'vllm-copilot-gateway-spike',
        display_name: entry.displayName ?? entry.id,
        personality: entry.personality ?? entry.systemMessageReplacementsFile ?? null,
        wire_model_id: entry.vllmModelId ?? entry.id,
        ...extra,
      })
    }
    return json(res, 200, { object: 'list', data })
  }

  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let body
    try {
      body = await readBody(req)
    } catch (err) {
      return openaiError(res, 400, err.message)
    }
    const controller = new AbortController()
    req.on('close', () => controller.abort()) // client hangup → upstream cancel (relay duty #1)

    const id = `chatcmpl-spike-${randomUUID()}`
    const created = Math.floor(Date.now() / 1000)
    const stream = body.stream !== false
    let streamed = false

    if (stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
      streamed = true
      const send = (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`)
      send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] })
      var finishReason = 'stop' // eslint-disable-line no-var
      try {
        const out = await runCompletion(
          body,
          controller.signal,
          (event) => {
            const delta = {}
            if (event.reasoning_content) delta.reasoning_content = event.reasoning_content
            if (event.content) delta.content = event.content
            const toolCalls = (event.finishedToolCalls ?? []).map((tc, i) => ({ index: i, id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } }))
            if (toolCalls.length > 0) {
              finishReason = 'tool_calls'
              send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] })
            }
            if (delta.content || delta.reasoning_content) send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason: null }] })
          },
        )
        if (out.state.outcome?.finishReason === 'length') finishReason = 'length'
        if (out.state.outcome?.hadToolCalls) finishReason = 'tool_calls'
        send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: finishReason }] })
        if (body.stream_options?.include_usage) {
          const u = out.completion?.usage ?? {}
          send({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: u })
        }
        res.write('data: [DONE]\n\n')
        return res.end()
      } catch (err) {
        res.write(`data: ${JSON.stringify({ error: { message: String(err?.message ?? err) } })}\n\n`)
        res.write('data: [DONE]\n\n')
        return res.end()
      }
    }

    // Non-streamed: accumulate, answer once.
    let text = ''
    let reasoning = ''
    const toolCalls = []
    try {
      const out = await runCompletion(body, controller.signal, (event) => {
        if (event.content) text += event.content
        if (event.reasoning_content) reasoning += event.reasoning_content
        for (const tc of event.finishedToolCalls ?? []) toolCalls.push({ id: tc.id, type: 'function', function: { name: tc.name, arguments: tc.arguments } })
      })
      return json(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: text, ...(reasoning ? { reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
            finish_reason: out.state.outcome?.finishReason === 'length' ? 'length' : toolCalls.length ? 'tool_calls' : 'stop',
          },
        ],
        usage: out.completion?.usage ?? {},
      })
    } catch (err) {
      const status = err.status ?? 500
      if (streamed) return res.end()
      return openaiError(res, status, String(err?.message ?? err))
    }
  }

  json(res, 404, { error: { message: `no such spike endpoint: ${req.method} ${url.pathname}` } })
})

server.listen(settings.port, settings.host, () => {
  console.log(`[spike] vllm-copilot gateway spike on http://${settings.host}:${settings.port}`)
  console.log(`[spike] core: ${corePath}`)
  console.log(`[spike] models: ${models.map((m) => m.displayName ?? m.id).join(', ')}  capture: ${settings.systemMessageCapture} → ${captureFile}`)
})
