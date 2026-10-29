import type { TrajectoryRecord } from './types'

export interface TrajectoryTimingEstimate {
  start: number
  end: number
  basis: 'preceding-event' | 'call-result'
}

/** Derive display-only estimates. Never populate measured duration or TTFT fields. */
export function estimateTrajectoryTimings(records: readonly TrajectoryRecord[]): ReadonlyMap<string, TrajectoryTimingEstimate> {
  const estimates = new Map<string, TrajectoryTimingEstimate>()
  let preceding: { time: number; turn: number | null | undefined } | undefined
  let incompleteTools = false

  for (const record of records) {
    const observed = record.timestampKind === 'observation'
    const time = record.startedAt
    const result = record.resultObservedAt
    const missingDuration = record.durationMs == null
    const tool = record.kind === 'tool' || record.kind === 'subtool'

    if (tool) {
      // Results are matched to calls by the importer. Parallel calls may have
      // results in a different order: the next reply starts after the latest.
      if (observed && finite(result) && (!finite(time) || result >= time) && record.status !== 'running') {
        if (missingDuration && finite(time) && result > time) {
          estimates.set(record.id, { start: time, end: result, basis: 'call-result' })
        }
        if (!incompleteTools) {
          preceding = { time: Math.max(preceding?.time ?? result, result), turn: record.turn }
        }
      } else {
        // Do not charge an unfinished/missing tool result to the next model reply.
        preceding = undefined
        incompleteTools = true
      }
      continue
    }

    const sameTurn = preceding?.turn == null || record.turn == null || preceding.turn === record.turn
    if (observed && record.kind === 'assistant' && !record.requestOnly && record.status !== 'running'
      && missingDuration && !incompleteTools && preceding !== undefined && sameTurn
      && finite(time) && time > preceding.time) {
      estimates.set(record.id, { start: preceding.time, end: time, basis: 'preceding-event' })
    }
    // Inputs establish a new boundary; missing/reversed timestamps break the
    // chain instead of silently reaching farther back across unknown activity.
    preceding = observed && finite(time) && (preceding === undefined || time >= preceding.time)
      ? { time, turn: record.turn } : undefined
    incompleteTools = false
  }
  return estimates
}

function finite(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}
