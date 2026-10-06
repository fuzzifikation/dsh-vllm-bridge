/**
 * Projection from the harness message vocabulary (dsh RequestMessage[]) into the
 * core's OpenAI wire vocabulary. Input is deep-frozen by the loop: every result
 * is a freshly built object, and no field is ever written back.
 *
 * Gate-2 scope: text, reasoning, tool calls/results. Images and file attachments
 * project to stable placeholder text (real attachment handling is later work;
 * silently dropping them would make the model lie about what it sees).
 */

function blocksOf(content) {
  if (typeof content === 'string') return content ? [{ type: 'text', text: content }] : []
  return Array.isArray(content) ? content : []
}

function blocksToText(blocks) {
  const parts = []
  for (const block of blocksOf(blocks)) {
    if (block.type === 'text') parts.push(block.text ?? '')
    else if (block.type === 'image') parts.push('[image attached to this message; not forwarded by the bridge]')
    else if (block.type === 'file') parts.push('[file attached to this message; not forwarded by the bridge]')
    // reasoning/tool-call/tool-addition/tool-removal are handled per-role, not as text
  }
  return parts.join('')
}

/**
 * @param options - dsh GenerateOptions (never mutated).
 * @returns {{ messages: object[], notice?: string }} fresh wire messages; a
 * leading one-shot `system` string becomes the first system message.
 */
export function toWireMessages(options) {
  const out = []
  if (typeof options.system === 'string' && options.system.length > 0) {
    out.push({ role: 'system', content: options.system })
  }
  for (const message of options.messages ?? []) {
    const blocks = blocksOf(message.content)
    switch (message.role) {
      case 'system':
        out.push({ role: 'system', content: blocksToText(blocks) })
        break
      case 'user':
      case 'developer':
        // The wire has no developer role; instruction-shaped context stays model-visible as user text.
        out.push({ role: 'user', content: blocksToText(blocks) })
        break
      case 'assistant': {
        let text = ''
        const reasoningParts = []
        const toolCalls = []
        for (const block of blocks) {
          if (block.type === 'text') text += block.text ?? ''
          else if (block.type === 'reasoning') reasoningParts.push(block.text ?? '')
          else if (block.type === 'tool-call') {
            toolCalls.push({
              id: block.id,
              type: 'function',
              function: { name: block.name, arguments: block.arguments ?? '' },
            })
          }
        }
        const wire = { role: 'assistant', content: text }
        if (reasoningParts.length > 0) wire.reasoning = reasoningParts.join('\n\n')
        if (toolCalls.length > 0) wire.tool_calls = toolCalls
        out.push(wire)
        break
      }
      case 'tool': {
        const text = blocksToText(blocks)
        out.push({
          role: 'tool',
          tool_call_id: message.toolCallId,
          content: message.isError ? `Error: ${text}` : text,
        })
        break
      }
      default:
        // Unknown roles are merge-extensible upstream; forwarding a guessed shape would corrupt the history.
        break
    }
  }
  return { messages: out }
}

/** dsh ToolSchema[] → core RequestTool[] (`parameters` is the harness name for `inputSchema`). */
export function toRequestTools(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
  }))
}
