import type { TrajectoryKind, TrajectoryRecord, TrajectoryStatus } from './types'

export function recordStatus(record: TrajectoryRecord): TrajectoryStatus {
  if (record.status !== undefined) return record.status
  if ((record.kind === 'tool' || record.kind === 'subtool') && record.output === undefined) {
    return 'running'
  }
  if (record.kind === 'compacted' && record.output === undefined && record.durationMs == null) {
    return 'running'
  }
  if (record.durationMs === null) return 'running'
  return 'complete'
}

export function formatDuration(milliseconds: number | null | undefined): string {
  if (milliseconds === null || milliseconds === undefined || !Number.isFinite(milliseconds)) {
    return '—'
  }
  if (milliseconds < 1_000) return `${Math.round(milliseconds).toLocaleString()} ms`
  return `${(milliseconds / 1_000).toFixed(milliseconds < 10_000 ? 2 : 1)} s`
}

export function formatClock(timestamp: number | null | undefined): string {
  if (timestamp === null || timestamp === undefined || !Number.isFinite(timestamp)) return '—'
  const date = new Date(timestamp)
  const two = (value: number) => String(value).padStart(2, '0')
  const three = (value: number) => String(value).padStart(3, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())} ${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${three(date.getMilliseconds())}`
}

export function formatValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === undefined) return ''
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

export function searchableRecordText(record: TrajectoryRecord): string {
  return [
    record.kind,
    record.summary,
    record.provider,
    record.model,
    record.callId,
    formatValue(record.input),
    formatValue(record.output),
    record.reasoning,
    formatValue(record.source),
    formatValue(record.schema),
    formatValue(record.metadata),
    formatValue(record.sourceBlocks),
    formatValue(record.outputBlocks),
    formatValue(record.error),
    record.inputRaw,
  ].filter(Boolean).join('\n').toLocaleLowerCase()
}

/** Match every whitespace-delimited search term against one record's indexed text. */
export function recordMatchesSearch(record: TrajectoryRecord, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const text = searchableRecordText(record)
  return terms.every(term => text.includes(term))
}

export function kindLane(kind: TrajectoryKind): 0 | 1 | 2 {
  if (kind === 'assistant' || kind === 'compacted') return 1
  if (kind === 'tool' || kind === 'subtool') return 2
  return 0
}
