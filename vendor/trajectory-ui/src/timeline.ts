import { kindLane } from './format'
import { estimateTrajectoryTimings, type TrajectoryTimingEstimate } from './timing-estimates'
import type {
  TrajectoryDurationMode,
  TrajectoryRecord,
  TrajectoryTimeRange,
} from './types'

export interface TrajectoryTimelineSpan {
  record: TrajectoryRecord
  start: number
  end: number
  lane: 0 | 1 | 2
  point: boolean
  phase: 'start' | 'result' | 'estimate'
  estimate?: TrajectoryTimingEstimate
}

export interface TrajectoryTimelineProjection {
  start: number
  end: number
  spans: readonly TrajectoryTimelineSpan[]
  clock: 'sequence' | 'elapsed' | 'active'
  missingTimestamps: number
}

/** Project records into the coordinate system shared by the timeline and ledger. */
export function projectTrajectoryTimeline(
  records: readonly TrajectoryRecord[],
  mode: TrajectoryDurationMode,
): TrajectoryTimelineProjection | null {
  if (records.length === 0) return null
  if (mode === 'equal') {
    return {
      start: 0,
      end: Math.max(1, records.length),
      clock: 'sequence',
      missingTimestamps: 0,
      spans: records.map((record, index) => ({
        record,
        start: index,
        end: index + 1,
        lane: kindLane(record.kind),
        point: false,
        phase: 'start',
      })),
    }
  }

  const estimates = estimateTrajectoryTimings(records)
  const rawSpans = records.flatMap((record): TrajectoryTimelineSpan[] => {
    const spans: TrajectoryTimelineSpan[] = []
    const estimate = estimates.get(record.id)
    if (estimate !== undefined) {
      spans.push({ record, start: estimate.start, end: estimate.end, estimate,
        lane: kindLane(record.kind), point: false, phase: 'estimate' })
    }
    const duration = record.timestampKind !== 'observation' && recordedDuration(record)
      ? record.durationMs! : 0
    if (finiteTime(record.startedAt) && Number.isFinite(record.startedAt + duration)) {
      spans.push({ record, start: record.startedAt, end: record.startedAt + duration,
        lane: kindLane(record.kind), point: duration === 0, phase: 'start' })
    }
    if (finiteTime(record.resultObservedAt)) {
      spans.push({ record, start: record.resultObservedAt, end: record.resultObservedAt,
        lane: kindLane(record.kind), point: true, phase: 'result' })
    }
    return spans
  })
  if (rawSpans.length === 0) return null

  // A gap is only known to be idle when operation timing is complete. Keep
  // observation-only and partially timed exports on their actual wall clock.
  const elapsed = !rawSpans.some(span => !span.point) || records.some(record => (
    record.timestampKind === 'observation' || finiteTime(record.resultObservedAt)
    || (kindLane(record.kind) !== 0 && (!finiteTime(record.startedAt) || !recordedDuration(record)))
  ))
  const missingTimestamps = records.filter(record => !finiteTime(record.startedAt) && !finiteTime(record.resultObservedAt)).length
  if (elapsed) return projection(rawSpans, 'elapsed', missingTimestamps)

  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>()
  let removedIdle = 0
  let coveredUntil: number | null = null
  for (const span of [...rawSpans].sort((left, right) => (
    left.start - right.start || left.end - right.end
  ))) {
    if (coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil
    }
    removedIdleBySpan.set(span, removedIdle)
    coveredUntil = coveredUntil === null ? span.end : Math.max(coveredUntil, span.end)
  }
  const spans = rawSpans.map((span) => {
    const offset = removedIdleBySpan.get(span) ?? 0
    return { ...span, start: span.start - offset, end: span.end - offset }
  })
  return projection(spans, 'active', missingTimestamps)
}

function finiteTime(value: number | null | undefined): value is number {
  return value != null && Number.isFinite(value)
}

function recordedDuration(record: TrajectoryRecord): boolean {
  return finiteTime(record.durationMs) && record.durationMs >= 0
}

function projection(spans: TrajectoryTimelineSpan[], clock: 'elapsed' | 'active', missingTimestamps: number): TrajectoryTimelineProjection {
  const minimum = spans.reduce((value, span) => Math.min(value, span.start), Infinity)
  const maximum = spans.reduce((value, span) => Math.max(value, span.end), -Infinity)
  return {
    start: minimum,
    end: Math.max(minimum + 1, maximum),
    spans,
    clock,
    missingTimestamps,
  }
}

/** Return records whose projected timeline spans overlap a selected range. */
export function trajectoryTimelineFocusIds(
  records: readonly TrajectoryRecord[],
  range: TrajectoryTimeRange | null,
  mode: TrajectoryDurationMode,
): ReadonlySet<string> | null {
  if (range === null) return null
  const projection = projectTrajectoryTimeline(records, mode)
  if (projection === null) return new Set()
  return new Set(projection.spans
    .filter(span => span.start <= range.end && span.end >= range.start)
    .map(span => span.record.id))
}
