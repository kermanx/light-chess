import { isObject, numberValue, stringValue, type JsonObject } from './trajectory-content.ts'

/** Compact runs and historical scalar chunks normalized for timing and partial replies. */
export function* streamChunks(value: unknown): Generator<{ time?: number; chunk: JsonObject }> {
  if (!Array.isArray(value)) return
  for (const record of value) {
    if (!isObject(record)) continue
    if (record.type === 'chunk' && isObject(record.chunk)) {
      yield { time: numberValue(record.time), chunk: record.chunk }
      continue
    }
    const members = record.type === 'tool-call-chunks' ? record.args : record.texts
    if (!Array.isArray(members) || !['text-chunks', 'reasoning-chunks', 'tool-call-chunks'].includes(String(record.type))) continue
    let time = numberValue(record.time0)
    for (const [index, member] of members.entries()) {
      if (index > 0) {
        const delta = Array.isArray(record.dt) ? numberValue(record.dt[index - 1]) : undefined
        time = time === undefined || delta === undefined ? undefined : time + delta
      }
      yield { time, chunk: record.type === 'tool-call-chunks'
        ? { type: 'tool-call-delta', index: record.index, id: record.id, name: record.name, argumentsDelta: member }
        : { type: record.type === 'text-chunks' ? 'text-delta' : 'reasoning-delta', index: record.index, text: member } }
    }
  }
}

export function isTokenChunk(chunk: JsonObject): boolean {
  if (chunk.type === 'text-delta' || chunk.type === 'reasoning-delta') return typeof chunk.text === 'string' && chunk.text !== ''
  return chunk.type === 'tool-call-delta' && (typeof chunk.name === 'string'
    || typeof chunk.argumentsDelta === 'string' && chunk.argumentsDelta !== '')
}

/** Assemble by block index; finalized blocks replace their preceding deltas. */
export function applyChunk(blocks: Map<number, JsonObject>, chunk: JsonObject): void {
  const index = numberValue(chunk.index)
  if (index === undefined || index < 0 || !Number.isInteger(index)) return
  const previous = blocks.get(index)
  switch (chunk.type) {
    case 'block-start': blocks.set(index, { type: chunk.blockType, text: '' }); break
    case 'text-delta':
    case 'reasoning-delta': {
      const type = chunk.type === 'text-delta' ? 'text' : 'reasoning'
      blocks.set(index, { type, text: (previous?.type === type ? stringValue(previous.text) ?? '' : '') + (stringValue(chunk.text) ?? '') })
      break
    }
    case 'tool-call-delta':
      blocks.set(index, { type: 'tool-call', id: chunk.id ?? previous?.id,
        name: chunk.name ?? previous?.name, arguments: (stringValue(previous?.arguments) ?? '') + (stringValue(chunk.argumentsDelta) ?? '') })
      break
    case 'block-end': if (isObject(chunk.block)) blocks.set(index, chunk.block); break
  }
}
