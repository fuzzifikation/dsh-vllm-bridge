#!/usr/bin/env node
/**
 * Smoke test against the running spike gateway. Proves, in one pass:
 *  1. fat catalog      — /v1/models answers with context windows + modes (core probed live)
 *  2. policy in-line   — a system message containing the preset's `find` text comes back
 *                        REWRITTEN (personality applied by the gateway), and lands in the
 *                        capture file with rulesApplied — i.e. P6+P7 without the extension
 *  3. streaming relay  — real tokens streamed from the real server through the relay
 *  4. accounting       — /usage shows the turn's tokens
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const base = process.env.SPIKE_BASE ?? 'http://127.0.0.1:8787'
const settings = JSON.parse(readFileSync(path.join(here, 'gateway.settings.json'), 'utf8'))
const auth = { authorization: `Bearer ${settings.token}`, 'content-type': 'application/json' }
const model = settings.registry.models[0].displayName

const fail = (m) => {
  console.error(`\nFAIL: ${m}`)
  process.exit(1)
}

// ── 1. fat catalog ──────────────────────────────────────────────────────────
const catalog = await (await fetch(`${base}/v1/models`, { headers: auth })).json()
const entry = catalog.data?.[0]
console.log(`[1] /v1/models → ${entry?.id}: window=${entry?.context_window} modes=[${entry?.modes?.join(' | ')}] default=${entry?.default_mode} personality=${entry?.personality}`)
if (!entry || !entry.context_window || entry.modes?.length < 2) fail('catalog lacks the fat fields')

// ── 2. personality find-text, taken from the LIVE preset (deterministic) ────
const expand = (s) => s.replace(/%APPDATA%/g, process.env.APPDATA ?? '').replace(/%USERPROFILE%/g, process.env.USERPROFILE ?? '')
const presetFile = path.join(expand(settings.personalityDirs.globalDir), 'prompt-replacements-sarcastic-robot.json')
const preset = JSON.parse(readFileSync(presetFile, 'utf8'))
const rule = preset.rules[0]
const systemPrompt = `${rule.find} Today is a fine day.`
console.log(`[2] using preset rule "${rule.ruleName}" find-text (${rule.find.length} chars) as the system prompt`)

// ── 3. streamed completion through the relay ────────────────────────────────
const t0 = Date.now()
const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: auth,
  body: JSON.stringify({
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 120,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: 'Reply with exactly: SPIKE-OK' },
    ],
  }),
})
if (!res.ok && res.headers.get('content-type')?.includes('json')) fail(`chat HTTP ${res.status}: ${await res.text()}`)
let text = ''
let sawUsage = false
let sawDone = false
const reader = res.body.getReader()
const decoder = new TextDecoder()
let pending = ''
for (;;) {
  const { done, value } = await reader.read()
  if (done) break
  pending += decoder.decode(value, { stream: true })
  const frames = pending.split('\n\n')
  pending = frames.pop()
  for (const frame of frames) {
    const line = frame.split('\n').find((l) => l.startsWith('data: '))
    if (!line) continue
    const payload = line.slice(6)
    if (payload === '[DONE]') {
      sawDone = true
      continue
    }
    const chunk = JSON.parse(payload)
    if (chunk.error) fail(`stream error: ${chunk.error.message}`)
    if (chunk.usage) sawUsage = true
    text += chunk.choices?.[0]?.delta?.content ?? ''
  }
}
console.log(`[3] streamed "${text.trim()}" in ${Date.now() - t0} ms (SSE relay: done=${sawDone}, usage-chunk=${sawUsage})`)
if (!sawDone || text.trim().length === 0) fail('no streamed content')

// ── 4. capture proves the personality ran INSIDE the gateway ────────────────
await new Promise((r) => setTimeout(r, 700)) // capture queue is fire-and-forget
const capture = JSON.parse(readFileSync(path.join(here, settings.captureFile), 'utf8'))
const captured = capture.messages?.find?.((m) => m.receivedContent === systemPrompt) ?? (Array.isArray(capture) ? capture.find((m) => m.receivedContent === systemPrompt) : undefined)
if (!captured) fail(`capture file has no entry for our system prompt (keys: ${Object.keys(capture)})`)
const rewritten = captured.deliveredContent.includes('gloriously arrogant robot')
console.log(`[4] capture entry found: rulesApplied=[${captured.rulesApplied?.join(', ')}] rewritten=${rewritten}`)
if (!(captured.rulesApplied ?? []).includes(rule.ruleName)) fail('personality rule did NOT fire server-side')
if (!rewritten) fail('delivered content lacks the replacement text')

// ── 5. usage ────────────────────────────────────────────────────────────────
const u = await (await fetch(`${base}/usage`, { headers: auth })).json()
console.log(`[5] gateway /usage → requests=${u.requests} prompt=${u.prompt} completion=${u.completion} last=${JSON.stringify(u.lastRequest)}`)
if (u.requests < 1 || u.prompt < 1) fail('usage not metered')

console.log('\nALL SPIKE CHECKS PASSED — modes + personality + capture + streaming + accounting, extension not on the wire.')
