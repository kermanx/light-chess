import type { TrajectoryDocument, TrajectoryRecord, TrajectoryRequestDetails, TrajectoryUsage } from './types'
import { contentText, firstLine, isObject, normalizeTools, numberValue, parseMaybeJson, sourceBlocks, stringValue, type JsonObject } from './trajectory-content'

const FORMAT = 'code_cli.trajectory/v1'

/**
 * Read a Code CLI benchmark export into one document per agent trajectory.
 * Returns null for unrelated formats; rejects malformed or newer Code CLI envelopes.
 * Raw export data is retained under codeCli without changing normalized document v1.
 */
export function parseCodeCliTrajectory(value: unknown, fallbackName = 'Code CLI'): TrajectoryDocument[] | null {
  if (!isObject(value) || typeof value.format !== 'string' || !value.format.startsWith('code_cli.trajectory/')) return null
  if (value.format !== FORMAT) throw new Error(`Unsupported Code CLI trajectory format: ${value.format}.`)
  if (!isObject(value.agents)) throw new Error('Code CLI trajectory requires an agents object.')
  const { agents, ...run } = value
  const documents: TrajectoryDocument[] = []
  const entries = Object.entries(agents as JsonObject)
  // Match the producer's designated main agent without losing other agents or branches.
  entries.sort(([a], [b]) => Number(b === value.primary_agent_id) - Number(a === value.primary_agent_id))
  for (const [agentKey, candidate] of entries) {
    if (!isObject(candidate) || !Array.isArray(candidate.trajs)) throw new Error(`Code CLI agent ${agentKey} requires a trajs array.`)
    const { trajs, ...agent } = candidate
    for (const [index, trajectory] of (trajs as unknown[]).entries()) {
      if (!isObject(trajectory) || !Array.isArray(trajectory.messages)) throw new Error(`Code CLI agent ${agentKey}, trajectory ${index + 1} requires messages.`)
      const id = stringValue(trajectory.traj_id) ?? String(index + 1)
      const name = `${stringValue(value.task_id) ?? stringValue(value.run_id) ?? fallbackName} · ${agentKey} / ${id}`
      documents.push(projectMessages(trajectory.messages, name, { run, agentKey, agent, trajectory, trajectoryIndex: index }))
    }
  }
  if (documents.length === 0) throw new Error('No Code CLI trajectories were found.')
  return documents
}

function projectMessages(messages: unknown[], name: string, codeCli: JsonObject): TrajectoryDocument {
  const records: TrajectoryRecord[] = []
  const requests: TrajectoryRequestDetails[] = []
  const pendingCalls = new Map<string, TrajectoryRecord>()
  const pendingInputs: TrajectoryRecord[] = []
  let tools = normalizeTools(undefined)
  let systemPrompt: string | undefined
  let turn = 0
  let step = 0
  let lastWasAssistant = false
  let cumulative: TrajectoryUsage = {}

  for (const [index, candidate] of messages.entries()) {
    if (!isObject(candidate)) throw new Error(`Code CLI message ${index + 1} must be an object.`)
    const role = stringValue(candidate.role) ?? 'unknown'
    const metadata = isObject(candidate.metadata) ? candidate.metadata : {}
    const time = timestamp(metadata.timestamp ?? candidate.timestamp ?? candidate.createdAt)
    const blocks = messageBlocks(candidate)
    const id = `message-${index + 1}` // metadata.msg_id is shared across roles in these exports.
    const base = { id, seq: index, startedAt: time, timestampKind: 'observation' as const, metadata: { ...metadata, codeCliMessageIndex: index } }
    const resultBlocks = blocks.filter(block => block.type === 'tool_result' || block.type === 'tool-result')
    if (role === 'tool' && resultBlocks.length === 0) {
      resultBlocks.push({ type: 'tool_result', tool_use_id: candidate.tool_call_id ?? candidate.toolCallId, content: candidate.content, is_error: candidate.is_error ?? candidate.isError })
    }
    for (const [resultIndex, result] of resultBlocks.entries()) {
      const callId = stringValue(result.tool_use_id ?? result.toolCallId)
      let tool = callId === undefined ? undefined : pendingCalls.get(callId)
      if (tool === undefined) {
        tool = { ...base, id: `result-${index + 1}-${resultIndex + 1}`, kind: 'tool', summary: 'Tool result', callId }
        records.push(tool)
      }
      tool.output = result.content
      tool.outputBlocks = sourceBlocks(typeof result.content === 'string' ? [{ type: 'text', text: result.content }] : result.content)
      tool.status = (result.is_error ?? result.isError) === true ? 'error' : 'complete'
      tool.resultObservedAt = time
      tool.metadata = { ...tool.metadata, resultMessageIndex: index, resultBlockIndex: resultIndex, completedAt: time }
      if (callId !== undefined) pendingCalls.delete(callId)
    }

    const visible = blocks.filter(block => block.type !== 'tool_result' && block.type !== 'tool-result')
    // Structured results already contain their output. Never duplicate the flattened <tool_result> string.
    if (role === 'tool' || (role !== 'assistant' && resultBlocks.length > 0 && visible.length === 0)) continue
    const text = contentText(visible, 'text')
    if (role === 'assistant') {
      step++
      if (turn === 0) turn = 1
      const requestId = `request-${step}`
      const calls = toolCalls(candidate, visible)
      const reasoning = contentText(visible, 'thinking') || contentText(visible, 'reasoning') || stringValue(candidate.reasoning_content)
      let callIndex = 0
      const toBlock = (call: (typeof calls)[number]): JsonObject => ({ type: 'tool-call', id: call.id, name: call.name, input: call.input, arguments: call.raw })
      const ordered = visible.map(block => block.type === 'tool_use' || block.type === 'tool-call' ? toBlock(calls[callIndex++]!) : block)
      ordered.push(...calls.slice(callIndex).map(toBlock))
      if (reasoning && !visible.some(block => block.type === 'thinking' || block.type === 'reasoning')) ordered.unshift({ type: 'thinking', thinking: reasoning })
      const usage = codeCliUsage(metadata.usage ?? candidate.usage)
      cumulative = addUsage(cumulative, usage)
      const record: TrajectoryRecord = { ...base, kind: 'assistant', turn, step, requestId, requestNumber: step, status: 'complete',
        summary: firstLine(text || reasoning || calls.map(call => call.name).join(', ')), output: text, reasoning,
        sourceBlocks: sourceBlocks(ordered), usage }
      for (const input of pendingInputs.splice(0)) Object.assign(input, { turn, step, requestId, requestNumber: step })
      records.push(record)
      requests.push({ id: requestId, number: step, turn, purpose: 'generation', status: 'complete', resultId: id,
        systemPrompt, tools: [...tools], usage, cumulativeUsage: { ...cumulative }, timingRecorded: false })
      for (const [callIndex, call] of calls.entries()) {
        const tool: TrajectoryRecord = { id: `tool-${index + 1}-${callIndex + 1}`, seq: index, kind: 'tool', turn, step,
          parentId: id, requestId, requestNumber: step, callId: call.id, toolName: call.name,
          summary: `${call.name}${isObject(call.input) && typeof call.input.description === 'string' ? ` · ${call.input.description}` : ''}`,
          input: call.input, inputRaw: call.raw, schema: tools.find(tool => tool.name === call.name),
          startedAt: time, timestampKind: 'observation', status: 'running', metadata: { codeCliMessageIndex: index } }
        records.push(tool)
        // No fabricated identity matching: a result without an id stays a standalone record.
        if (call.id !== undefined) pendingCalls.set(call.id, tool)
      }
      lastWasAssistant = true
      continue
    }

    if (role === 'user' && resultBlocks.length === 0 && (turn === 0 || lastWasAssistant)) { turn++; step = requests.length }
    const kind = role === 'system' ? 'system' : role === 'user' ? 'user' : 'context'
    const record: TrajectoryRecord = { ...base, kind, turn: turn || undefined,
      summary: firstLine(text || `Unsupported ${role} content`), input: text,
      sourceBlocks: sourceBlocks(visible) }
    if (role === 'system') {
      record.previousInput = systemPrompt
      record.previousTools = tools.length ? tools : undefined
      systemPrompt = text
      if (candidate.tools !== undefined) tools = normalizeTools(candidate.tools)
      record.tools = [...tools]
    }
    records.push(record)
    pendingInputs.push(record)
    lastWasAssistant = false
  }
  const trajectory = codeCli.trajectory as JsonObject
  const status = stringValue(trajectory.status)
  if (status !== undefined && ['done', 'complete', 'completed', 'error', 'failed', 'cancelled', 'canceled'].includes(status)) {
    for (const tool of records) if (tool.kind === 'tool' && tool.status === 'running') {
      tool.status = 'error'; tool.interrupted = true
      tool.error = { code: 'missing_tool_result', reason: 'The saved trajectory ended without a result for this call.' }
    }
  }
  return { version: 1, name, records, requests, codeCli }
}

function messageBlocks(message: JsonObject): JsonObject[] {
  if (Array.isArray(message.content_blocks) && message.content_blocks.length > 0) return message.content_blocks.filter(isObject)
  if (Array.isArray(message.content)) return message.content.filter(isObject)
  return typeof message.content === 'string' && message.content !== '' ? [{ type: 'text', text: message.content }] : []
}

function toolCalls(message: JsonObject, blocks: JsonObject[]) {
  const declared = Array.isArray(message.tool_calls) ? message.tool_calls.filter(isObject).map(call => {
    const fn = isObject(call.function) ? call.function : call
    return { id: stringValue(call.id), name: stringValue(fn.name) ?? 'tool', input: parseMaybeJson(fn.arguments ?? fn.input), raw: stringValue(fn.arguments) }
  }) : []
  const result = blocks.filter(block => block.type === 'tool_use' || block.type === 'tool-call').map(block => {
    const id = stringValue(block.id)
    const match = id === undefined ? undefined : declared.find(call => call.id === id)
    const input = Object.hasOwn(block, 'input') ? block.input : parseMaybeJson(block.arguments) ?? match?.input
    // Preserve exact arguments only when they describe the authoritative structured block.
    const raw = stringValue(block.arguments) ?? (match && JSON.stringify(parseMaybeJson(match.raw)) === JSON.stringify(input) ? match.raw : undefined)
    return { id, name: stringValue(block.name) ?? match?.name ?? 'tool', input, raw }
  })
  for (const call of declared) if (call.id === undefined || !result.some(item => item.id === call.id)) result.push(call)
  return result
}

function codeCliUsage(value: unknown): TrajectoryUsage | undefined {
  if (!isObject(value)) return undefined
  const total = numberValue(value.input_tokens ?? value.prompt_tokens)
  const cached = numberValue(value.input_cached_tokens ?? value.cached_input_tokens ?? value.cache_read_input_tokens)
  const usage = { input: total === undefined ? undefined : Math.max(0, total - (cached ?? 0)), cacheRead: cached,
    output: numberValue(value.output_tokens ?? value.completion_tokens), reasoning: numberValue(value.reasoning_tokens) }
  return Object.values(usage).some(item => item !== undefined) ? usage : undefined
}

function addUsage(previous: TrajectoryUsage, next: TrajectoryUsage | undefined): TrajectoryUsage {
  const result = { ...previous }
  for (const key of Object.keys(next ?? {}) as (keyof TrajectoryUsage)[]) {
    if (next?.[key] !== undefined) result[key] = (result[key] ?? 0) + next[key]
  }
  return result
}

function timestamp(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return undefined
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : undefined
}
