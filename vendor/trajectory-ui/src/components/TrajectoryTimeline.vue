<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { formatClock, formatDuration } from '../format'
import type { MessageKey } from '../i18n'
import { projectTrajectoryTimeline, type TrajectoryTimelineSpan } from '../timeline'
import type {
  TrajectoryDurationMode,
  TrajectoryRecord,
  TrajectoryTimeRange,
} from '../types'

interface TimelineSpan extends TrajectoryTimelineSpan {
  left: number
  width: number
  ttft: number | null
}

const props = defineProps<{
  records: readonly TrajectoryRecord[]
  mode: TrajectoryDurationMode
  range: TrajectoryTimeRange | null
  selectedId: string | null
  searchMatchIds: ReadonlySet<string> | null
  hasEarlierRecords: boolean
  loadingEarlier: boolean
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const emit = defineEmits<{
  'update:range': [value: TrajectoryTimeRange | null]
  select: [record: TrajectoryRecord]
  focus: [record: TrajectoryRecord]
  loadEarlier: []
}>()

const track = ref<HTMLElement | null>(null)
const hover = ref<{ x: number; span: TimelineSpan | null } | null>(null)
const draft = ref<TrajectoryTimeRange | null>(null)
const viewport = ref<TrajectoryTimeRange | null>(null)
const drag = ref<{ pointerId: number; x: number; time: number; record: TrajectoryRecord | null } | null>(null)
const pan = ref<{ pointerId: number; x: number; start: number; moved: boolean; pannable: boolean } | null>(null)

const base = computed(() => projectTrajectoryTimeline(props.records, props.mode))
const hasEstimates = computed(() => base.value?.spans.some(span => span.estimate !== undefined) ?? false)

const activeDomain = computed(() => {
  const model = base.value
  if (model === null) return null
  if (viewport.value === null) return { start: model.start, end: model.end }
  const duration = Math.min(
    model.end - model.start,
    Math.max(1, viewport.value.end - viewport.value.start),
  )
  const start = Math.min(
    Math.max(viewport.value.start, model.start),
    model.end - duration,
  )
  return { start, end: start + duration }
})

const spans = computed<readonly TimelineSpan[]>(() => {
  const model = base.value
  const domain = activeDomain.value
  if (model === null || domain === null) return []
  const duration = Math.max(1, domain.end - domain.start)
  return model.spans
    .filter(span => span.end >= domain.start && span.start <= domain.end)
    .map((span) => {
      const visibleStart = Math.max(domain.start, span.start)
      const visibleEnd = Math.min(domain.end, span.end)
      const width = (visibleEnd - visibleStart) / duration * 100
      const total = span.record.durationMs ?? 0
      const ttft = span.estimate === undefined && total > 0 && span.record.ttftMs != null
        ? Math.min(100, Math.max(0, span.record.ttftMs / total * 100))
        : null
      return {
        ...span,
        left: (visibleStart - domain.start) / duration * 100,
        width,
        ttft,
      }
    })
})

const boundaries = computed(() => {
  const model = base.value
  const domain = activeDomain.value
  if (model === null || domain === null) return []
  const duration = Math.max(1, domain.end - domain.start)
  const starts = new Map<number, number>()
  for (const span of model.spans) {
    const turn = span.record.turn
    if (turn == null) continue
    starts.set(turn, Math.min(starts.get(turn) ?? Number.POSITIVE_INFINITY, span.start))
  }
  return [...starts].flatMap(([turn, start]) => (
    start <= domain.start || start > domain.end
      ? []
      : [{ turn, left: (start - domain.start) / duration * 100 }]
  ))
})

const activeRange = computed(() => draft.value ?? props.range)
const visibleDuration = computed(() => {
  const domain = activeDomain.value
  if (domain === null) return ''
  const lastEvent = base.value!.spans.reduce((end, span) => Math.max(end, span.end), domain.start)
  const milliseconds = Math.min(domain.end, lastEvent) - domain.start
  if (milliseconds < 60_000) return formatDuration(milliseconds)
  return `${Math.floor(milliseconds / 60_000)} m ${((milliseconds % 60_000) / 1_000).toFixed(1)} s`
})
const rangeStyle = computed<CSSProperties | undefined>(() => {
  const range = activeRange.value
  const domain = activeDomain.value
  if (range === null || domain === null) return undefined
  const duration = Math.max(1, domain.end - domain.start)
  const start = Math.max(domain.start, Math.min(range.start, range.end))
  const end = Math.min(domain.end, Math.max(range.start, range.end))
  if (end < start) return undefined
  return {
    left: `${(start - domain.start) / duration * 100}%`,
    width: `${Math.max(0.1, (end - start) / duration * 100)}%`,
  }
})

watch(base, (next) => {
  if (next === null) {
    viewport.value = null
    if (props.range !== null) emit('update:range', null)
    return
  }
  if (viewport.value !== null && (
    viewport.value.end < next.start || viewport.value.start > next.end
  )) viewport.value = null
  if (props.range !== null && (
    props.range.end < next.start || props.range.start > next.end
  )) emit('update:range', null)
})

watch(() => props.mode, () => {
  viewport.value = null
  draft.value = null
  if (props.range !== null) emit('update:range', null)
})

watch(() => props.selectedId, (id) => {
  const model = base.value
  const current = viewport.value
  if (model === null || current === null || id === null) return
  const matches = model.spans.filter(span => span.record.id === id)
  if (matches.some(span => span.end >= current.start && span.start <= current.end)) return
  const selected = matches[0]
  if (selected === undefined) return
  const duration = Math.max(1, current.end - current.start)
  const desiredStart = selected.end <= current.start ? selected.start : selected.end - duration
  const start = Math.min(
    Math.max(desiredStart, model.start),
    Math.max(model.start, model.end - duration),
  )
  viewport.value = { start, end: start + duration }
})

function fractionAt(event: PointerEvent): number {
  const element = track.value
  if (element === null) return 0
  const rect = element.getBoundingClientRect()
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
}

function timeAt(event: PointerEvent): number {
  const domain = activeDomain.value
  if (domain === null) return 0
  return domain.start + fractionAt(event) * (domain.end - domain.start)
}

function spanAt(event: PointerEvent): TimelineSpan | null {
  const target = event.target instanceof HTMLElement
    ? event.target.closest<HTMLElement>('[data-timeline-id]')
    : null
  if (target === null) return null
  return spans.value.find(span => span.record.id === target.dataset.timelineId && span.phase === target.dataset.timelinePhase) ?? null
}

function onPointerDown(event: PointerEvent) {
  if (event.button === 2) {
    const domain = activeDomain.value
    if (domain === null) return
    pan.value = {
      pointerId: event.pointerId,
      x: event.clientX,
      start: domain.start,
      moved: false,
      pannable: viewport.value !== null,
    }
    track.value?.setPointerCapture(event.pointerId)
    return
  }
  if (event.button !== 0) return
  const time = timeAt(event)
  drag.value = {
    pointerId: event.pointerId,
    x: event.clientX,
    time,
    record: spanAt(event)?.record ?? null,
  }
  draft.value = { start: time, end: time }
  track.value?.setPointerCapture(event.pointerId)
}

function onPointerMove(event: PointerEvent) {
  const element = track.value
  const domain = activeDomain.value
  const model = base.value
  if (element === null || domain === null || model === null) return
  const fraction = fractionAt(event)
  hover.value = { x: fraction, span: spanAt(event) }
  if (pan.value?.pointerId === event.pointerId) {
    if (!pan.value.pannable) return
    const rect = element.getBoundingClientRect()
    const delta = (event.clientX - pan.value.x) / Math.max(1, rect.width)
    const duration = domain.end - domain.start
    if (Math.abs(event.clientX - pan.value.x) >= 3) pan.value.moved = true
    const start = Math.min(
      Math.max(pan.value.start - delta * duration, model.start),
      model.end - duration,
    )
    viewport.value = { start, end: start + duration }
    return
  }
  if (drag.value?.pointerId === event.pointerId) {
    draft.value = {
      start: Math.min(drag.value.time, timeAt(event)),
      end: Math.max(drag.value.time, timeAt(event)),
    }
  }
}

function onPointerUp(event: PointerEvent) {
  if (pan.value?.pointerId === event.pointerId) {
    if (!pan.value.moved) emit('update:range', null)
    pan.value = null
    return
  }
  if (drag.value?.pointerId !== event.pointerId) return
  const clicked = Math.abs(event.clientX - drag.value.x) < 3
  const clickedRecord = drag.value.record
  const clickedTime = drag.value.time
  const next = draft.value
  drag.value = null
  draft.value = null
  if (clicked && clickedRecord !== null) {
    emit('update:range', null)
    emit('select', clickedRecord)
    return
  }
  if (next === null) return
  const domain = activeDomain.value
  if (clicked) {
    const model = base.value
    if (model === null || model.spans.length === 0) return
    const nearest = model.spans.reduce((candidate, span) => {
      const candidateDistance = dragTimeDistance(clickedTime, candidate)
      const spanDistance = dragTimeDistance(clickedTime, span)
      return spanDistance < candidateDistance ? span : candidate
    })
    emit('update:range', { start: nearest.start, end: nearest.end })
    emit('focus', nearest.record)
  } else if (domain !== null) {
    emit('update:range', { start: Math.max(domain.start, next.start), end: Math.min(domain.end, next.end) })
  }
}

function dragTimeDistance(time: number, span: Pick<TimelineSpan, 'start' | 'end'>): number {
  if (time < span.start) return span.start - time
  if (time > span.end) return time - span.end
  return 0
}

function onWheel(event: WheelEvent) {
  event.preventDefault()
  const model = base.value
  const domain = activeDomain.value
  const element = track.value
  if (model === null || domain === null || element === null) return
  const full = model.end - model.start
  const current = domain.end - domain.start
  const next = Math.min(full, Math.max(full / Math.max(4, props.records.length), current * Math.exp(event.deltaY * 0.0015)))
  if (next >= full * 0.999) {
    viewport.value = null
    return
  }
  const rect = element.getBoundingClientRect()
  const anchor = Math.min(1, Math.max(0, (event.clientX - rect.left) / Math.max(1, rect.width)))
  const at = domain.start + anchor * current
  const start = Math.min(Math.max(at - anchor * next, model.start), model.end - next)
  viewport.value = { start, end: start + next }
}

function tooltip(span: TimelineSpan): string {
  const record = span.record
  const parts = [record.kind.toUpperCase()]
  if (span.estimate !== undefined) {
    const estimate = span.estimate
    return [...parts, `${props.t('estimatedDuration')}: ≈ ${formatDuration(estimate.end - estimate.start)}`,
      props.t(estimate.basis === 'call-result' ? 'estimateCallResult' : 'estimatePrecedingEvent'),
      `${formatClock(estimate.start)} → ${formatClock(estimate.end)}`, props.t('estimateTimingHint')].join(' · ')
  }
  const time = span.phase === 'result' ? record.resultObservedAt : record.startedAt
  const label = span.phase === 'result' ? 'resultRecordedAt' : record.timestampKind === 'observation' ? 'recordedAt' : 'started'
  if (time != null) parts.push(`${props.t(label)}: ${formatClock(time)}`)
  if (record.timestampKind === 'observation') parts.push(`${props.t('durationValue')}: ${props.t('notRecorded')}`)
  else if (record.durationMs != null) parts.push(`${props.t('durationValue')}: ${formatDuration(record.durationMs)}`)
  if (record.ttftMs != null && record.timestampKind !== 'observation') parts.push(`TTFT ${formatDuration(record.ttftMs)}`)
  return parts.join(' · ')
}
</script>

<template>
  <section class="tui-timeline" :aria-label="t('trajectoryTimeline')">
    <div class="tui-timeline__plot">
      <div class="tui-timeline__labels" aria-hidden="true">
        <span>{{ t('input') }}</span>
        <span>{{ t('model') }}</span>
        <span>{{ t('tools') }}</span>
      </div>
      <div
        ref="track"
        class="tui-timeline__track"
        tabindex="0"
        @wheel="onWheel"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="() => { drag = null; pan = null; draft = null }"
        @pointerleave="() => { if (drag === null && pan === null) hover = null }"
        @dblclick="emit('update:range', null)"
        @contextmenu.prevent
        @keydown.esc="emit('update:range', null)"
      >
        <button
          v-if="hasEarlierRecords && (base === null || activeDomain?.start === base.start)"
          type="button"
          class="tui-timeline__earlier"
          :disabled="loadingEarlier"
          :title="t(loadingEarlier ? 'loadingEarlier' : 'loadEarlier')"
          @pointerdown.stop
          @click.stop="emit('loadEarlier')"
        >…</button>
        <span v-if="spans.length === 0" class="tui-timeline__empty">{{ t('noTiming') }}</span>
        <span
          v-for="boundary in boundaries"
          :key="boundary.turn"
          class="tui-timeline__boundary"
          :style="{ left: `${boundary.left}%` }"
          aria-hidden="true"
        />
        <span
          v-if="hover !== null && hover.span === null && draft === null"
          class="tui-timeline__hover-line"
          :style="{ left: `${hover.x * 100}%` }"
          aria-hidden="true"
        />
        <span v-if="rangeStyle" class="tui-timeline__selection" :class="{ 'is-dragging': draft !== null }" :style="rangeStyle" aria-hidden="true" />
        <span v-if="rangeStyle" class="tui-timeline__selection-edges" :class="{ 'is-dragging': draft !== null }" :style="rangeStyle" aria-hidden="true" />
        <span
          v-for="span in spans"
          :key="`${span.record.id}:${span.phase}`"
          class="tui-timeline__span"
          :class="[
            `tui-timeline__span--${span.record.kind}`,
            { 'is-current': span.record.id === selectedId },
            { 'is-error': span.record.status === 'error' },
            { 'is-equal': mode === 'equal' },
            { 'is-point': mode !== 'equal' && span.point },
            { 'is-result': span.phase === 'result' },
            { 'is-estimated': span.estimate !== undefined },
            { 'is-muted': range !== null && !(span.start <= range.end && span.end >= range.start) },
            { 'is-search-muted': searchMatchIds !== null && !searchMatchIds.has(span.record.id) },
          ]"
          :data-timeline-id="span.record.id"
          :data-timeline-phase="span.phase"
          :title="tooltip(span)"
          :style="{
            left: mode === 'equal' || span.point ? `clamp(2px, calc(${span.left}% - 4px), calc(100% - 10px))` : `min(calc(100% - 2px), calc(${span.left}% + min(${span.width * 0.08}%, 1px)))`,
            width: mode === 'equal' || span.point ? '8px' : `max(2px, calc(${span.width}% - min(${span.width * 0.08}%, 1px) * 2))`,
            top: `${7 + span.lane * 14}px`,
            '--tui-ttft': span.ttft === null ? '0%' : `${span.ttft}%`,
          } as CSSProperties"
        />
      </div>
    </div>
    <div v-if="base !== null && mode === 'actual'" class="tui-timeline__caption" :title="t(base.clock === 'elapsed' ? 'timelineElapsedHint' : 'timelineActiveHint')">
      <span>{{ t(base.clock === 'elapsed' ? 'elapsedTime' : 'activeTime') }} · {{ visibleDuration }}</span>
      <span class="tui-timeline__legend">{{ t(hasEstimates ? 'timelineEstimatedLegend' : 'timelineLegend') }}</span>
      <span v-if="base.missingTimestamps > 0">{{ t('missingTimestamps', { count: base.missingTimestamps }) }}</span>
      <button v-if="viewport !== null" type="button" @click="viewport = null">{{ t('resetTimelineZoom') }}</button>
    </div>
  </section>
</template>
