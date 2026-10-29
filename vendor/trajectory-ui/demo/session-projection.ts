import type { TrajectoryRecord, TrajectoryRequestDetails, TrajectoryToolDefinition, TrajectoryUsage } from '../src/types.ts'
import { applyChunk, isTokenChunk, streamChunks } from './session-stream.ts'
import { compactValue, contentText, firstLine, isObject, normalizeTools, normalizeUsage, numberValue, parseMaybeJson, sourceBlocks, stringValue, toolCallSummary, type JsonObject } from './trajectory-content.ts'

interface StepState {
  request: TrajectoryRequestDetails
  seq: number
  turn?: number
  step?: number
  firstToken?: number
  completedAt?: number
  record?: TrajectoryRecord
  blocks: Map<number, JsonObject>
  tools: readonly TrajectoryToolDefinition[]
  hasStart: boolean
  closed: boolean
}

interface CompactionState {
  request: TrajectoryRequestDetails
  record: TrajectoryRecord
}

// These events have no ledger row in Harness. Retain their raw data with the document.
const auxiliaryEvents = new Set([
  'agent-preset/selected', 'approval/asked', 'approval/decided', 'approval/policy',
  'command/done', 'command/run', 'compaction/prune', 'deliverables/presented',
  'feedback/message-delete', 'feedback/message-put', 'feedback/record', 'goal/change',
  'hook/invoked', 'hook/result', 'image/offload', 'llm/retry-started', 'model/selection',
  'permission/preset', 'plan/mode', 'request/context', 'sandbox/mode', 'schedule/change',
  'session-log-deepseek/delivery-accepted', 'session/title-llm-request',
  'subagent/catalog', 'subagent/descriptor', 'subagent/model-selection-policy',
  'team/member', 'team/message/delivered', 'team/message/queued', 'team/task', 'todo/write',
  'tool-workflow/agent-end', 'tool-workflow/agent-start', 'tool-workflow/run-end',
  'tool-workflow/run-start', 'web/deepseek-search-llm-request', 'workspace/changes',
])

/** Project current DSH events and conservatively display recognizable fallback events. */
export function projectSession(events: unknown[], fallbackName: string) {
  const header = events.find(event => isObject(event) && event.type === 'session') as JsonObject | undefined
  const version = header?.version
  let name = stringValue(header?.title) ?? fallbackName
  let turn: number | undefined
  let step: number | undefined
  let config: JsonObject | undefined
  let tools: readonly TrajectoryToolDefinition[] = []
  let system: string | undefined
  let legacyHeaderPrompt = false
  let lastSystem: TrajectoryRecord | undefined
  const records: TrajectoryRecord[] = []
  const steps = new Map<string, StepState>()
  const allSteps: StepState[] = []
  const stepsByTurn = new Map<number | undefined, StepState[]>()
  const requests: TrajectoryRequestDetails[] = []
  const calls = new Map<string, TrajectoryRecord>()
  const pendingCalls = new Set<TrajectoryRecord>()
  const compactions = new Map<string, CompactionState>()
  const retained: unknown[] = []
  const pendingInbox: string[] = []
  let claimed = new Set<string>()
  // Only system nodes and replacement positions are needed to restore surviving prompts.
  let systemNodes: Array<{ seq: number; position: number; text: string }> = []
  const positions = new Map<number, number>()
  let surfaceStart: number | undefined
  let uncertainSystem = false

  function newRequest(seq: number, time: number | undefined, owner: number | null | undefined, purpose = 'generation') {
    const request: TrajectoryRequestDetails = {
      id: `${purpose === 'compaction' ? 'compaction' : 'request'}-${seq}`,
      number: requests.length + 1, turn: owner, purpose, status: 'running', startedAt: time,
      ...(purpose === 'generation' ? { options: config, systemPrompt: system, ...(config === undefined ? {} : { tools }), provider: stringValue(config?.provider), model: stringValue(config?.model) } : {}),
    }
    requests.push(request)
    return request
  }

  function getStep(data: JsonObject, seq: number, time?: number, start = false): StepState {
    const owner = numberValue(data.turn) ?? turn
    const number = numberValue(data.step) ?? step
    const key = `${owner ?? '-'}:${number ?? '-'}`
    let state = steps.get(key)
    // Headerless legacy messages can lack both coordinates and still be separate requests.
    if (state === undefined || (owner === undefined && number === undefined && state.record !== undefined)) {
      state = { request: newRequest(seq, start ? time : undefined, owner), seq, turn: owner, step: number,
        blocks: new Map(), tools, hasStart: start, closed: false }
      steps.set(key, state)
      allSteps.push(state)
      const inTurn = stepsByTurn.get(owner) ?? []
      inTurn.push(state)
      stepsByTurn.set(owner, inTurn)
    }
    return state
  }

  function promptRecord(seq: number, time: number | undefined, text: string | undefined, catalog = tools) {
    if (text === system && JSON.stringify(catalog) === JSON.stringify(lastSystem?.tools ?? [])) return
    const previous = system
    system = text
    const record: TrajectoryRecord = {
      id: `system-${seq}`, seq, kind: 'system', turn, step,
      summary: firstLine(text || 'System prompt'), input: text, startedAt: time,
      ...(config === undefined ? {} : { tools: catalog }),
      ...(lastSystem === undefined ? {} : { previousInput: previous, previousTools: lastSystem.tools }),
    }
    records.push(record)
    lastSystem = record
    const state = steps.get(`${turn ?? '-'}:${step ?? '-'}`)
    if (state !== undefined && state.completedAt === undefined) state.request.systemPrompt = text
  }

  function closeStep(state: StepState, time: number | undefined) {
    state.closed = true
    if (state.request.status === 'complete') return
    state.request.status = 'error'
    state.completedAt ??= time
    if (state.record === undefined && hasStreamContent(state.blocks)) {
      const content = [...state.blocks].sort(([a], [b]) => a - b).map(([, block]) => block)
      state.record = assistantRecord(state, { content }, state.seq, time, true)
      records.push(state.record)
    }
    if (state.record !== undefined) {
      state.record.status = 'error'
      state.record.interrupted = true
    }
  }

  function assistantRecord(state: StepState, raw: JsonObject, seq: number, time: number | undefined, interrupted: boolean): TrajectoryRecord {
    const content = raw.content
    const source = isObject(raw.source) ? raw.source : undefined
    const output = contentText(content, 'text')
    const reasoning = contentText(content, 'reasoning')
    return {
      id: stringValue(raw.id) ?? `assistant-${state.seq}`, seq, kind: 'assistant',
      turn: state.turn, step: state.step, requestId: state.request.id, requestNumber: state.request.number,
      summary: firstLine(output || reasoning || toolCallSummary(content)),
      status: interrupted ? 'error' : 'complete', ...(interrupted ? { interrupted: true } : {}),
      startedAt: state.request.startedAt, output, reasoning, sourceBlocks: sourceBlocks(content), source,
      provider: stringValue(source?.provider) ?? state.request.provider,
      model: stringValue(source?.model) ?? state.request.model,
      metadata: { message: raw, completedAt: time },
    }
  }

  for (const [index, candidate] of events.entries()) {
    if (!isObject(candidate)) continue
    let type = stringValue(candidate.type) ?? ''
    const data = isObject(candidate.data) ? candidate.data : candidate
    const seq = numberValue(candidate.seq) ?? index + 1
    const time = numberValue(candidate.time)
    if (type === 'session') continue
    // v1/v2 used code-dispatch and scalar assistant chunks; newer snapshots use live-chunk.
    if (type === 'tool/code-dispatch-start') type = 'tool/ptc-dispatch-start'
    if (type === 'tool/code-dispatch') type = 'tool/ptc-dispatch'
    if (type === 'assistant/chunk') type = 'assistant/live-chunk'
    if (type === 'session/title') { name = stringValue(data.title) ?? name; continue }
    if (type === 'turn/start') { turn = numberValue(data.turn); step = undefined; continue }
    if (type === 'step/start') {
      turn = numberValue(data.turn) ?? turn
      step = numberValue(data.step)
      getStep(data, seq, time, true)
      continue
    }
    if (type === 'agent/inbox/spliced') {
      if (data.target === 'next-step') {
        const inserted = Array.isArray(data.inserted) ? data.inserted.flatMap(value => isObject(value) && typeof value.id === 'string' ? [value.id] : []) : []
        const removed = pendingInbox.splice(numberValue(data.start) ?? 0, numberValue(data.removedCount) ?? 0, ...inserted)
        if (removed.length > 0 && data.outcome !== 'canceled') claimed = new Set(removed)
        else for (const id of inserted) claimed.delete(id)
      }
      retained.push(candidate)
      continue
    }

    if (type === 'system/message' || candidate.surfaceOp !== undefined && !legacyHeaderPrompt) {
      if (type === 'system/message') legacyHeaderPrompt = false
      surfaceStart ??= seq
      const operation = candidate.surfaceOp
      let position = seq
      if (isObject(operation) && operation.op === 'replace') {
        const start = numberValue(operation.startSeq ?? operation.start)
        const end = numberValue(operation.endSeq ?? operation.end)
        if (start === undefined || end === undefined
          || (start < surfaceStart && !positions.has(start)) || (end < surfaceStart && !positions.has(end))) {
          uncertainSystem = true
          systemNodes = []
        } else {
          position = positions.get(start) ?? start
          const endPosition = positions.get(end) ?? end
          systemNodes = systemNodes.filter(node => node.position < position || node.position > endPosition)
          for (const [id, value] of positions) if (value >= position && value <= endPosition) positions.delete(id)
          positions.set(seq, position)
        }
      }
      if (type === 'system/message') {
        const raw = isObject(data.message) ? data.message : data
        // System blocks are contiguous prompt text, unlike separate prose paragraphs.
        const text = typeof raw.content === 'string' ? raw.content : Array.isArray(raw.content)
          ? raw.content.flatMap(block => isObject(block) && block.type === 'text' ? [stringValue(block.text) ?? ''] : []).join('') : ''
        systemNodes.push({ seq, position, text })
        systemNodes.sort((a, b) => a.position - b.position)
      }
      const effective = uncertainSystem || systemNodes.length === 0 && system === undefined
        ? undefined : [...systemNodes].reverse().find(node => node.text !== '')?.text ?? ''
      if (type === 'system/message' || effective !== system) {
        if (type === 'system/message') {
          turn = numberValue(data.turn) ?? turn
          step = numberValue(data.step) ?? step
        }
        promptRecord(seq, time, effective)
        if (lastSystem?.seq === seq) lastSystem.metadata = { event: candidate, ...(uncertainSystem ? { promptUnavailable: true } : {}) }
      }
      if (type === 'system/message') continue
    }

    if (type === 'request/header') {
      const headerData = isObject(data.header) ? data.header : data
      config = isObject(headerData.config) ? headerData.config : undefined
      tools = normalizeTools(headerData.tools)
      // Released v1/v2 kept system text in the header instead of surface messages.
      legacyHeaderPrompt = typeof headerData.system === 'string'
      const text = stringValue(headerData.system) ?? system
      if (lastSystem !== undefined && lastSystem.tools === undefined && system === text) lastSystem.tools = tools
      else promptRecord(seq, time, text, tools)
      const state = steps.get(`${turn ?? '-'}:${step ?? '-'}`)
      if (state !== undefined) {
        state.tools = tools
        state.request.systemPrompt = text
        state.request.tools = tools
        state.request.options = config
        state.request.provider = stringValue(config?.provider)
        state.request.model = stringValue(config?.model)
      }
      retained.push(candidate)
      continue
    }
    if (type === 'user/message' || type === 'developer/message') {
      const raw = isObject(data.message) ? data.message : data
      const source = isObject(raw.source) ? raw.source : undefined
      const compactId = source?.kind === 'compact-checkpoint' || source?.kind === 'plugin' && source.plugin === 'compact'
        ? stringValue(source.compactionId) : undefined
      const compact = compactId === undefined ? undefined : compactions.get(compactId)
      if (compact !== undefined) {
        compact.record.metadata = { ...compact.record.metadata, checkpoint: candidate }
        continue
      }
      const text = contentText(raw.content, 'text')
      const changes = type === 'developer/message' && Array.isArray(raw.content) && raw.content.length > 0
        && raw.content.every(block => isObject(block) && ['tool-addition', 'tool-removal'].includes(String(block.type)))
        ? { added: raw.content.flatMap(block => isObject(block) && block.type === 'tool-addition' && typeof block.toolName === 'string' ? [block.toolName] : []),
            removed: raw.content.flatMap(block => isObject(block) && block.type === 'tool-removal' && typeof block.toolName === 'string' ? [block.toolName] : []) } : undefined
      const context = type === 'developer/message' || source !== undefined && source.kind !== 'user'
      records.push({
        id: stringValue(raw.id) ?? `user-${seq}`, seq, kind: context ? 'context' : 'user',
        turn: numberValue(data.turn) ?? turn, step: numberValue(data.step) ?? step,
        summary: changes ? [...changes.added.map(name => `Added ${name}`), ...changes.removed.map(name => `Removed ${name}`)].join(' · ') : firstLine(text),
        ...(changes ? { toolChanges: changes } : {}), input: text, source, sourceBlocks: sourceBlocks(raw.content), startedAt: time,
        ...(claimed.has(String(raw.id)) ? { steering: true } : {}), metadata: { event: candidate },
      })
      continue
    }
    if (type === 'assistant/attempt' || type === 'assistant/live-chunk' || type === 'assistant/message' || type === 'llm/retry') {
      const state = getStep(data, seq, time)
      if (type === 'llm/retry') {
        state.blocks.clear()
        state.request.status = 'running'
        state.request.retry = numberValue(data.retry)
        state.request.maxRetries = data.mode === 'normal' || data.mode === undefined ? numberValue(data.maxRetries) : undefined
        state.request.retryDelayMs = numberValue(data.delayMs)
        state.request.error = displayFailure(data.failure)
        retained.push(candidate)
        continue
      }
      if (type === 'assistant/live-chunk') {
        if (isObject(data.chunk)) {
          applyChunk(state.blocks, data.chunk)
          if (isTokenChunk(data.chunk)) state.firstToken ??= time
          if (data.chunk.type === 'usage') state.request.usage = addUsage(state.request.usage, normalizeUsage(data.chunk.usage))
        }
        continue
      }
      for (const item of streamChunks(data.stream)) if (isTokenChunk(item.chunk)) { state.firstToken ??= item.time; break }
      if (type === 'assistant/attempt') { retained.push(candidate); continue }
      const raw = isObject(data.message) ? data.message : data
      state.completedAt = time
      const record = assistantRecord(state, raw, seq, time, data.interrupted === true)
      record.metadata = { event: candidate }
      record.usage = normalizeUsage(data.usage)
      if (state.record !== undefined) records.splice(records.indexOf(state.record), 1)
      state.record = record
      state.request.status = record.status
      state.request.resultId = record.id
      state.request.provider = record.provider
      state.request.model = record.model
      state.request.usage = record.usage
      records.push(record)
      continue
    }
    if (type === 'tool/call' || type === 'tool/result' || type === 'tool/ptc-dispatch-start' || type === 'tool/ptc-dispatch') {
      const nested = type.startsWith('tool/ptc-')
      const result = type === 'tool/result' || type === 'tool/ptc-dispatch'
      const message = isObject(data.message) ? data.message : undefined
      const source = isObject(message?.source) ? message.source : undefined
      const resultBlock = Array.isArray(message?.content) ? message.content.find(value => isObject(value) && value.type === 'tool-result') as JsonObject | undefined : undefined
      const callId = stringValue(nested ? data.subCallId : data.callId ?? source?.callId ?? message?.toolCallId ?? resultBlock?.toolCallId) ?? `call-${seq}`
      let record = calls.get(callId)
      if (record === undefined) {
        const owner = numberValue(data.turn) ?? turn
        const number = numberValue(data.step) ?? step
        const state = steps.get(`${owner ?? '-'}:${number ?? '-'}`)
        const toolName = stringValue(data.name) ?? 'tool'
        const input = parseMaybeJson(data.arguments)
        const parentCall = stringValue(data.parentCallId)
        record = {
          id: `tool-${callId}`, seq, kind: nested ? 'subtool' : 'tool', callId, toolName,
          turn: owner, step: number, requestId: state?.request.id, requestNumber: state?.request.number,
          summary: `${toolName} · ${compactValue(input)}`, input,
          inputRaw: nested ? JSON.stringify(data.arguments) : stringValue(data.arguments),
          startedAt: result ? undefined : time, status: result ? 'complete' : 'running',
          parentId: parentCall === undefined ? state?.record?.id : `tool-${parentCall}`,
          schema: (state?.tools ?? tools).find(tool => tool.name === toolName), metadata: { call: candidate },
        }
        calls.set(callId, record)
        if (!result) pendingCalls.add(record)
        records.push(record)
      }
      if (result) {
        pendingCalls.delete(record)
        const output = nested ? data.content : resultBlock?.content ?? message?.content
        record.output = output
        record.outputBlocks = sourceBlocks(output)
        record.status = (nested ? data.isError : message?.isError ?? resultBlock?.isError) === true ? 'error' : 'complete'
        record.resultSeq = seq
        if (isObject(data.error)) record.error = {
          name: stringValue(data.error.name), code: stringValue(data.error.code), reason: stringValue(data.error.reason),
        }
        record.durationMs = elapsed(record.startedAt, time)
        record.metadata = { ...record.metadata, ...(isObject(data.meta) ? data.meta : {}), result: candidate }
      }
      continue
    }
    if (type === 'compaction/start' || type === 'compaction/summary' || type === 'compaction/end') {
      const id = stringValue(data.compactionId) ?? 'legacy-compaction'
      let state = compactions.get(id)
      if (state === undefined) {
        const owner = data.turn === null ? null : numberValue(data.turn) ?? turn
        const request = newRequest(seq, type === 'compaction/start' ? time : undefined, owner ?? null, 'compaction')
        const record: TrajectoryRecord = {
          id: `compacted-${id}`, seq, kind: 'compacted', turn: owner ?? null, requestId: request.id,
          requestNumber: request.number, summary: 'Context compaction', status: 'running', startedAt: request.startedAt,
        }
        state = { request, record }
        compactions.set(id, state)
        records.push(record)
        request.resultId = record.id
      }
      if (type === 'compaction/summary') {
        state.record.output = contentText(data.summary, 'text') || data.summary
        state.record.rawOutput = data.rawOutput ?? data.summary
        state.record.sourceBlocks = sourceBlocks(data.summary)
        state.record.summary = firstLine(contentText(data.summary, 'text')) || 'Context compaction'
        state.record.usage = normalizeUsage(data.usage)
        state.record.provider = state.request.provider = stringValue(data.provider)
        state.record.model = state.request.model = stringValue(data.model)
        state.request.usage = state.record.usage
        state.request.options = { provider: data.provider, model: data.model, purpose: 'compaction', ...(data.maxTokens === undefined ? {} : { maxTokens: data.maxTokens }) }
      }
      if (type === 'compaction/end') {
        state.record.status = state.request.status = data.error === undefined ? 'complete' : 'error'
        state.record.durationMs = state.request.durationMs = elapsed(state.request.startedAt, time)
        state.request.error = data.error
      }
      state.record.metadata = { ...state.record.metadata, [type]: candidate }
      continue
    }
    if (type === 'step/end' || type === 'turn/end' || type === 'session/end-seed') {
      const owner = numberValue(data.turn) ?? turn
      const number = numberValue(data.step) ?? step
      const ending = type === 'step/end' ? [steps.get(`${owner ?? '-'}:${number ?? '-'}`)]
        : type === 'turn/end' ? stepsByTurn.get(owner) ?? [] : allSteps
      for (const state of ending) if (state !== undefined) closeStep(state, time)
      for (const call of pendingCalls) {
        if (call.status !== 'running' || type !== 'session/end-seed' && call.turn !== owner || type === 'step/end' && call.step !== number) continue
        pendingCalls.delete(call)
        call.status = 'error'; call.interrupted = true
        call.error = { name: 'Interrupted', code: 'interrupted' }
        call.durationMs = elapsed(call.startedAt, time)
      }
      if (type !== 'step/end') for (const compact of compactions.values()) {
        if (compact.request.status !== 'running' || type === 'turn/end' && compact.record.turn !== owner) continue
        compact.record.status = compact.request.status = 'error'
        compact.record.interrupted = true
        compact.request.error = 'Compaction interrupted'
        compact.record.durationMs = compact.request.durationMs = elapsed(compact.request.startedAt, time)
      }
      if (type === 'turn/end') {
        const reason = isObject(data.reason) ? data.reason : undefined
        if (reason?.kind === 'error') {
          const request = [...requests].reverse().find(value => value.turn === owner && value.purpose === 'generation')
          if (request !== undefined && request.status !== 'complete') { request.status = 'error'; request.error = displayFailure(reason.error) }
        }
        turn = undefined; step = undefined
      } else if (type === 'step/end') step = undefined
      continue
    }
    if (type.includes('compact') && (type.endsWith('/result') || type.endsWith('/message'))) {
      records.push({ id: `compacted-${seq}`, seq, kind: 'compacted', summary: stringValue(data.summary) ?? 'Context compacted', output: data.output, startedAt: time, metadata: { event: candidate } })
      continue
    }
    if (auxiliaryEvents.has(type)) retained.push(candidate)
    else records.push({ id: `event-${seq}`, seq, kind: 'context', turn, step, summary: `Unsupported event: ${type}`,
      input: candidate, startedAt: time, metadata: { unsupportedEvent: type } })
  }

  for (const state of allSteps) {
    const request = state.request
    if (state.record === undefined) {
      if (hasStreamContent(state.blocks)) {
        const content = [...state.blocks].sort(([a], [b]) => a - b).map(([, value]) => value)
        state.record = assistantRecord(state, { content }, state.seq, undefined, state.closed)
        state.record.status = state.closed ? 'error' : 'running'
      } else {
        state.record = { id: `assistant-${state.seq}`, seq: state.seq, kind: 'assistant', summary: '', turn: state.turn, step: state.step,
          requestId: request.id, requestNumber: request.number, status: request.status, startedAt: request.startedAt, requestOnly: true }
      }
      records.push(state.record)
    }
    if (!state.record.requestOnly) request.resultId = state.record.id
    request.timingRecorded = state.hasStart && state.firstToken !== undefined && state.completedAt !== undefined
    request.durationMs = elapsed(request.startedAt, state.completedAt)
    request.ttftMs = elapsed(request.startedAt, state.firstToken)
    request.generationMs = elapsed(state.firstToken, state.completedAt)
    request.throughput = request.generationMs !== undefined && request.generationMs > 0 && request.usage?.output !== undefined
      ? request.usage.output * 1000 / request.generationMs : undefined
    Object.assign(state.record, { durationMs: request.durationMs, ttftMs: request.ttftMs, usage: request.usage })

  }
  const resultIds = new Map(allSteps.map(state => [state.request.id, state.record?.id]))
  for (const call of calls.values()) if (call.kind === 'tool' && call.parentId === undefined && call.requestId !== undefined) call.parentId = resultIds.get(call.requestId)
  let cumulative: TrajectoryUsage | undefined
  for (const request of requests) { cumulative = addUsage(cumulative, request.usage); request.cumulativeUsage = cumulative }
  records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0))
  // Inputs before a response belong to its Step; separators follow those inputs.
  const lastInput = new Map<string, TrajectoryRecord>()
  let nextStep = 0
  for (const record of records) {
    while (allSteps[nextStep] && allSteps[nextStep]!.seq < (record.seq ?? 0)) nextStep++
    if (record.kind !== 'user' && record.kind !== 'context' && record.kind !== 'system') continue
    if (record.metadata?.unsupportedEvent !== undefined) continue
    const following = allSteps[nextStep]
    const state = record.step !== undefined ? steps.get(`${record.turn ?? '-'}:${record.step}`)
      : following && (record.turn === undefined || following.turn === record.turn) ? following : undefined
    if (state === undefined) continue
    record.turn = state.turn; record.step = state.step
    record.requestId = state.request.id; record.requestNumber = state.request.number
    lastInput.set(state.request.id, record)
  }
  const afterInput = new Map<string, TrajectoryRecord>()
  const moved = new Set<string>()
  for (const state of allSteps) {
    const input = lastInput.get(state.request.id)
    if (input === undefined || state.record === undefined || state.record.seq !== state.seq || (input.seq ?? 0) <= state.seq) continue
    moved.add(state.record.id)
    afterInput.set(input.id, state.record)
  }
  const ordered = records.flatMap(record => moved.has(record.id) ? []
    : afterInput.has(record.id) ? [record, afterInput.get(record.id)!] : [record])
  return { name, records: ordered, requests, session: { header, formatVersion: version ?? 'legacy', auxiliaryEvents: retained } }
}

function hasStreamContent(blocks: Map<number, JsonObject>): boolean {
  return [...blocks.values()].some(block => block.type === 'tool-call'
    ? Boolean(block.name || block.arguments)
    : typeof block.text === 'string' && block.text.length > 0)
}

function elapsed(start: number | null | undefined, end: number | undefined): number | undefined {
  return start == null || end === undefined ? undefined : Math.max(0, end - start)
}

function addUsage(left: TrajectoryUsage | undefined, right: TrajectoryUsage | undefined): TrajectoryUsage | undefined {
  if (right === undefined) return left
  const sum = { ...left }
  for (const key of Object.keys(right) as Array<keyof TrajectoryUsage>) {
    if (right[key] !== undefined) sum[key] = (sum[key] ?? 0) + right[key]
  }
  return sum
}

function displayFailure(value: unknown): unknown {
  // Match Harness's AUTH presentation: the diagnostic message can contain credentials.
  return isObject(value) && value.code === 'AUTH' ? { code: 'AUTH' } : value
}
