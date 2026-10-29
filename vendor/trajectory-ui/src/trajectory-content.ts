import type { TrajectoryContentBlock, TrajectoryUsage } from './types.ts'

export type JsonObject = Record<string, unknown>

export function normalizeUsage(value: unknown): TrajectoryUsage | undefined {
  if (!isObject(value)) return undefined
  const usage: TrajectoryUsage = {
    input: numberValue(value.input ?? value.inputTokens ?? value.prompt_tokens),
    cacheRead: numberValue(value.cacheRead ?? value.cacheReadTokens ?? value.cache_read_input_tokens),
    cacheWrite: numberValue(value.cacheWrite ?? value.cacheWriteTokens ?? value.cache_creation_input_tokens),
    output: numberValue(value.output ?? value.outputTokens ?? value.completion_tokens),
    reasoning: numberValue(value.reasoning ?? value.reasoningTokens ?? value.reasoning_tokens),
  }
  return Object.values(usage).some((entry) => entry !== undefined) ? usage : undefined
}

export function normalizeTools(value: unknown): Array<{ name: string; description?: string; parameters?: unknown }> {
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate) => {
    if (!isObject(candidate)) return []
    const name = stringValue(candidate.name)
    if (!name) return []
    const description = stringValue(candidate.description)
    return [{
      ...candidate,
      name,
      ...(description === undefined ? {} : { description }),
      ...(candidate.parameters === undefined ? {} : { parameters: candidate.parameters }),
    }]
  })
}

export function sourceBlocks(value: unknown): TrajectoryContentBlock[] {
  if (!Array.isArray(value)) return []
  const blocks: TrajectoryContentBlock[] = []
  for (const candidate of value) {
    if (!isObject(candidate)) continue
    const type = stringValue(candidate.type)
    if (type === 'text') {
      blocks.push({ ...candidate, type: 'text', content: stringValue(candidate.text) ?? '' })
      continue
    }
    if (type === 'reasoning' || type === 'thinking') {
      blocks.push({ ...candidate, type: 'thinking', content: stringValue(candidate.text ?? candidate.thinking) ?? '' })
      continue
    }
    if (type === 'tool-call' || type === 'tool_use') {
      blocks.push({
        ...candidate,
        type: 'tool-call',
        toolName: stringValue(candidate.name) ?? 'tool',
        callId: stringValue(candidate.id),
        input: parseMaybeJson(candidate.arguments ?? candidate.input),
        content: stringValue(candidate.arguments),
      })
      continue
    }
    if (type === 'image' || type === 'image_url') {
      const imageUrl = isObject(candidate.image_url) ? stringValue(candidate.image_url.url) : stringValue(candidate.url)
      blocks.push({
        ...candidate,
        type: 'image',
        ...(isObject(candidate.attachment) ? { attachment: candidate.attachment } : {}),
        ...(imageUrl === undefined ? {} : { url: imageUrl }),
        ...(stringValue(candidate.alt) === undefined ? {} : { alt: stringValue(candidate.alt) }),
      })
      continue
    }
    // Keep the established block union readable by v1 consumers.
    blocks.push({ type: 'text', content: `[${type ?? 'unknown'}] ${JSON.stringify(candidate)}`, original: candidate,
      ...(isObject(candidate.attachment) ? { attachment: candidate.attachment } : {}) })
  }
  return blocks
}

export function contentText(value: unknown, onlyType?: string): string {
  if (typeof value === 'string') return value
  if (!Array.isArray(value)) return ''
  const fragments: string[] = []
  for (const candidate of value) {
    if (typeof candidate === 'string' && onlyType === undefined) fragments.push(candidate)
    if (!isObject(candidate)) continue
    const type = stringValue(candidate.type)
    if (onlyType !== undefined && type !== onlyType) continue
    const text = stringValue(candidate.text ?? candidate.content ?? candidate.thinking)
    if (text) fragments.push(text)
    if (type === 'tool-result' && onlyType === undefined) {
      const nested = contentText(candidate.content)
      if (nested) fragments.push(nested)
    }
  }
  return fragments.join('\n\n')
}

export function toolCallSummary(value: unknown): string {
  if (!Array.isArray(value)) return ''
  const names = value.flatMap((candidate) => {
    if (!isObject(candidate)) return []
    const type = stringValue(candidate.type)
    if (type !== 'tool-call' && type !== 'tool_use') return []
    return [stringValue(candidate.name) ?? 'tool']
  })
  return names.length > 0 ? `Calls ${names.join(', ')}` : ''
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

export function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

export function compactValue(value: unknown): string {
  if (value === undefined) return 'completed'
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return firstLine(text || 'completed').slice(0, 160)
}

export function firstLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240)
}
