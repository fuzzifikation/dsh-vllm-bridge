/**
 * The real LlmAdapter: harness GenerateOptions in, core request path out,
 * StreamChunk back. All model behavior (params, modes, budgets, headers,
 * routing, personalities) comes from the vLLM-Copilot snapshot, ruling 6;
 * the harness never reaches a backend directly and dsh `compat` stays unset.
 */
import { LlmAdapter, LlmError, isContextWindowExceededError, isQuotaExceededError } from '@deepseek-ai/dsh-llm'
import path from 'node:path'
import { toWireMessages, toRequestTools } from './project.js'
import { toDshUsage, writeUsageRecord } from './usage-convert.js'
import { activeTracker } from './active.js'

const PROVIDER = 'vllmc'

export function createVllmcAdapter({ core, snapshot, deps = {} }) {
  const log = deps.log ?? { appendLine: () => {} }
  const outboxDir = deps.outboxDir
  const activeDir = deps.activeDir ?? (outboxDir ? path.join(path.dirname(outboxDir), 'active') : '')
  const active = activeTracker(activeDir, log)
  const chatTransport = new core.ChatTransport(log)
  const transport = {
    chatCompletionStream: (model, messages, options, signal, serverConfig) =>
      chatTransport.stream(model, messages, options, signal, serverConfig),
  }

  let personalityRules = null

  async function personality() {
    if (!snapshot.personalityFile) return []
    if (!personalityRules) personalityRules = await core.loadPromptReplacements(snapshot.personalityFile)
    return personalityRules
  }

  function entryFor(modelId) {
    const entry = snapshot.config.models.find((m) => m.id === modelId)
    if (!entry) {
      throw new LlmError(`model '${modelId}' is not in the vLLM-Copilot snapshot`, 'INVALID_ARGS')
    }
    const server = snapshot.config.servers.find((s) => s.id === entry.server)
    if (!server) {
      throw new LlmError(`model '${modelId}' references server '${entry.server}', absent from the snapshot`, 'INVALID_ARGS')
    }
    return { entry, server }
  }

  async function describe(modelId, selectedMode) {
    const { entry, server } = entryFor(modelId)
    const wireId = entry.vllmModelId ?? entry.id
    const serverType = core.resolveServerType(entry, snapshot.config.servers)
    const headers = core.sanitizeRequestHeaders(server.requestHeaders ?? {})
    const limits = await core.resolveRuntimeLimits(serverType, server.serverUrl, headers, wireId, entry.contextWindow)
    return core.describeModel({
      wireId,
      contextWindow: limits.contextWindow,
      serverType,
      override: entry,
      reportedMaxOutputTokens: limits.maxOutputTokens,
      selectedMode,
    })
  }

  function mapError(err) {
    if (err instanceof LlmError) return err
    const message = err?.message ?? String(err)
    let code = 'REQUEST_FAILED'
    if (err?.name === 'AbortError') code = 'ABORTED'
    else if (isContextWindowExceededError(message)) code = 'CONTEXT_WINDOW_EXCEEDED'
    else if (isQuotaExceededError(message)) code = 'QUOTA'
    else if (/\b401\b|\b403\b|unauthorized|forbidden|invalid api key|authentication/i.test(message)) code = 'AUTH'
    else if (/\b429\b|rate.?limit|too many requests/i.test(message)) code = 'RATE_LIMIT'
    return new LlmError(message, code, { cause: err })
  }

  return new (class VllmcLlmAdapter extends LlmAdapter {
    providerInfo(provider) {
      return { id: provider, name: 'vLLM-Copilot' }
    }

    async listModels(_provider) {
      return snapshot.config.models.map((model) => ({
        provider: PROVIDER,
        id: model.id,
        name: model.displayName ?? model.id,
        inputModalities: ['text'],
      }))
    }

    async resolveModel(_provider, model) {
      const descriptor = await describe(model)
      return {
        provider: PROVIDER,
        id: model,
        name: descriptor.name,
        inputModalities: ['text'],
        context: { contextWindow: descriptor.contextWindow },
        defaultMaxTokens: descriptor.maxOutputTokens,
        reasoning: descriptor.modeNames
          ? {
              efforts: descriptor.modeNames.map((mode) => ({ id: mode, name: mode })),
              defaultEffort: descriptor.defaultMode,
            }
          : undefined,
      }
    }

    async *stream(options) {
      // Marker spans the whole turn so the bridge's restart drain sees it, and
      // clears in `finally` even when dsh aborts or the generator is closed
      // early (a `.return()` on the generator still runs the finally).
      const done = active.begin({ model: options.model, purpose: options.purpose ?? null, sessionId: options.sessionId ?? null })
      try {
        yield* this.runStream(options)
      } finally {
        done()
      }
    }

    async *runStream(options) {
      const signal = options.signal ?? new AbortController().signal
      try {
        // Auxiliary calls (session titles, compaction) must not burn the session's
        // big model: the snapshot aims them explicitly and they stay metered.
        const aux = options.purpose ? snapshot.aux?.[options.purpose] : undefined
        const modelId = aux?.modelId ?? options.model ?? snapshot.defaultModelId
        // dsh reasoningEffort is the mode picker; absent, the snapshot's default
        // mode applies (ruling 6: model behavior is ours, not the harness's).
        const { entry } = entryFor(modelId)
        const modeNames = entry.modelModes ? Object.keys(entry.modelModes) : undefined
        const defaultMode = modeNames
          ? (entry.defaultMode && modeNames.includes(entry.defaultMode) ? entry.defaultMode : modeNames[0])
          : undefined
        const selectedMode = options.reasoningEffort ?? defaultMode

        const descriptor = await describe(modelId, selectedMode)

        const { messages } = toWireMessages(options)
        const rules = await personality()
        if (rules.length > 0) {
          for (const message of messages) {
            if (message.role === 'system') message.content = core.applyPromptReplacements(message.content, rules).result
          }
        }

        const runtimeOptions = {}
        const maxTokens = options.maxTokens ?? aux?.maxTokens
        if (maxTokens) runtimeOptions.max_tokens = maxTokens
        if (typeof options.temperature === 'number') runtimeOptions.temperature = options.temperature
        if (Array.isArray(options.stop) && options.stop.length > 0) runtimeOptions.stop = options.stop

        const assembled = core.assembleRequest(
          {
            modelId,
            selectedMode,
            openaiMessages: messages,
            runtimeOptions,
            tools: toRequestTools(options.tools),
            toolModeRequired: false,
            fixEmptyToolParameters: snapshot.fixEmptyToolParameters ?? true,
            advertisedMaxOutputTokens: descriptor.maxOutputTokens,
          },
          snapshot.config,
          log,
        )

        const state = core.createExecutionState(Date.now())
        const iterator = core.executeChatRequest(
          {
            transport,
            modelId,
            vllmModelId: assembled.vllmModelId,
            openaiMessages: assembled.openaiMessages,
            mergedOptions: assembled.mergedOptions,
            serverConfig: assembled.serverConfig,
            maxRetries: snapshot.maxRetries ?? 2,
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

        let index = -1
        let textBlock = null
        let reasoningBlock = null
        let completion = null
        for await (const event of iterator) {
          if (core.isAttemptCompletionEvent(event)) {
            completion = event.attemptCompletion
            continue
          }
          if (event.error) throw new Error(`Server error (mid-stream): ${event.error}`)

          if (event.reasoning_content) {
            if (!reasoningBlock) {
              reasoningBlock = { index: ++index, text: '' }
              yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' }
            }
            reasoningBlock.text += event.reasoning_content
            yield { type: 'reasoning-delta', index: reasoningBlock.index, text: event.reasoning_content }
          }
          if (event.content) {
            if (!textBlock) {
              textBlock = { index: ++index, text: '' }
              yield { type: 'block-start', index: textBlock.index, blockType: 'text' }
            }
            textBlock.text += event.content
            yield { type: 'text-delta', index: textBlock.index, text: event.content }
          }
          for (const call of event.finishedToolCalls) {
            const toolIndex = ++index
            yield { type: 'block-start', index: toolIndex, blockType: 'tool-call' }
            yield { type: 'tool-call-delta', index: toolIndex, id: call.id, name: call.name, argumentsDelta: call.arguments }
            yield {
              type: 'block-end',
              index: toolIndex,
              block: { type: 'tool-call', id: call.id, name: call.name, arguments: call.arguments },
            }
          }
        }

        for (const block of [reasoningBlock, textBlock]) {
          if (block) {
            yield {
              type: 'block-end',
              index: block.index,
              block: { type: block === reasoningBlock ? 'reasoning' : 'text', text: block.text },
            }
          }
        }

        if (completion) {
          yield { type: 'usage', usage: toDshUsage(completion.usage) }
          if (outboxDir) {
            writeUsageRecord(outboxDir, {
              sessionId: options.sessionId,
              purpose: options.purpose,
              model: modelId,
              wireModelId: assembled.wireModelId,
              lastRequest: completion.lastRequest,
              elapsedMs: completion.elapsedMs,
            })
          }
        }

        if (signal.aborted) {
          yield {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } },
          }
          return
        }
        const finishReason = state.outcome.finishReason
        yield {
          type: 'finish',
          reason:
            finishReason === 'length'
              ? { kind: 'max-tokens' }
              : state.outcome.hadToolCalls
                ? { kind: 'tool-calls' }
                : { kind: 'stop' },
        }
      } catch (err) {
        if (signal.aborted || err?.name === 'AbortError') {
          yield {
            type: 'finish',
            reason: { kind: 'aborted', failure: { message: 'request aborted', code: 'ABORTED' } },
          }
          return
        }
        throw mapError(err)
      }
    }
  })()
}
