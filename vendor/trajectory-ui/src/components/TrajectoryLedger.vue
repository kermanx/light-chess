<script setup lang="ts">
import { trajectoryCodeProgram } from '../code-program'
import { attachmentCounts, trajectoryResultValue, toolChangeSummary } from '../content'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { formatValue, recordMatchesSearch, recordStatus } from '../format'
import type { MessageKey } from '../i18n'
import { trajectoryTimelineFocusIds } from '../timeline'
import type {
  TrajectoryDurationMode,
  TrajectoryRecord,
  TrajectoryTimeRange,
} from '../types'
import TrajectoryRoleIcon from './TrajectoryRoleIcon.vue'

interface RecordRow {
  key: string
  type: 'record'
  record: TrajectoryRecord
  height: 30
  turnStart: boolean
  requestStart: boolean
  requestNumber?: number
}

interface SummaryRow {
  key: string
  type: 'summary'
  record: TrajectoryRecord
  height: 20
  summary: string
  summaryKind: 'turn' | 'assistant'
}

type DisplayRow = RecordRow | SummaryRow

interface PositionedRow {
  row: DisplayRow
  top: number
  bottom: number
}

const props = defineProps<{
  records: readonly TrajectoryRecord[]
  selectedId: string | null
  selectedRequestId: string | null
  requestErrorIds?: ReadonlySet<string>
  searchQuery: string
  timelineRange: TrajectoryTimeRange | null
  timelineMode?: TrajectoryDurationMode
  collapsedTurns: ReadonlySet<number>
  collapsedAssistants: ReadonlySet<string>
  loadingInitial: boolean
  loadingEarlier: boolean
  hasEarlierRecords: boolean
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const emit = defineEmits<{
  select: [record: TrajectoryRecord]
  selectRequest: [record: TrajectoryRecord]
  clear: []
  loadEarlier: []
  toggleTurn: [turn: number]
  toggleAssistant: [id: string]
}>()

const pane = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const viewportHeight = ref(600)
const followsTail = ref(true)
const tailReady = ref(false)
let resizeObserver: ResizeObserver | null = null
let tailInitialized = false
let firstSourceRecordId = props.records[0]?.id

const searchMatchIds = computed<ReadonlySet<string> | null>(() => {
  const query = props.searchQuery.trim()
  if (query === '') return null
  return new Set(
    props.records
      .filter(record => recordMatchesSearch(record, query))
      .map(record => record.id),
  )
})

const filteredRecords = computed(() => searchMatchIds.value === null
  ? props.records
  : props.records.filter(record => searchMatchIds.value?.has(record.id)),
)

const requestNumbers = computed(() => {
  const numbers = new Map<string, number>()
  for (const record of props.records) {
    if (record.requestId !== undefined && record.requestNumber !== undefined) {
      numbers.set(record.requestId, record.requestNumber)
    }
  }
  return numbers
})

const requestBoundaryIds = computed(() => {
  const seen = new Set<string>()
  const boundaries = new Set<string>()
  for (const record of props.records) {
    if (
      record.requestId === undefined
      || record.kind === 'user'
      || record.kind === 'context'
      || record.kind === 'system'
      || seen.has(record.requestId)
    ) continue
    seen.add(record.requestId)
    boundaries.add(record.id)
  }
  return boundaries
})

function callCount(count: number): string {
  return props.t(count === 1 ? 'toolCallOne' : 'toolCalls', { count })
}

function stepCount(count: number): string {
  return props.t(count === 1 ? 'stepOne' : 'steps', { count })
}

function callSummary(records: readonly TrajectoryRecord[]): string {
  const names = [...new Set(records.map(record => record.summary.split(' · ')[0]).filter(Boolean))]
  const base = callCount(records.length)
  return names.length === 0 ? base : `${base} · ${names.join(', ')}`
}

function collapseAssistantRows(
  records: readonly (TrajectoryRecord | SummaryRow)[],
): (TrajectoryRecord | SummaryRow)[] {
  if (props.collapsedAssistants.size === 0 || searchMatchIds.value !== null) return [...records]
  const output: (TrajectoryRecord | SummaryRow)[] = []
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === undefined) continue
    output.push(record)
    if (!('kind' in record)) continue
    if (record.kind !== 'assistant' || !props.collapsedAssistants.has(record.id)) continue
    const calls: TrajectoryRecord[] = []
    for (let cursor = index + 1; cursor < records.length; cursor += 1) {
      const candidate = records[cursor]
      if (candidate === undefined) break
      if (!('kind' in candidate)) break
      if (candidate.kind !== 'tool' && candidate.kind !== 'subtool') break
      calls.push(candidate)
    }
    if (calls.length === 0) continue
    output.push({
      key: `assistant-summary:${record.id}`,
      type: 'summary',
      record,
      height: 20,
      summary: callSummary(calls),
      summaryKind: 'assistant',
    })
    index += calls.length
  }
  return output
}

function collapseTurnRows(
  rows: readonly (TrajectoryRecord | SummaryRow)[],
): (TrajectoryRecord | SummaryRow)[] {
  if (props.collapsedTurns.size === 0 || searchMatchIds.value !== null) return [...rows]
  const byTurn = new Map<number, (TrajectoryRecord | SummaryRow)[]>()
  for (const row of rows) {
    if ('kind' in row && row.kind === 'system') continue
    const turn = 'kind' in row ? row.turn : row.record.turn
    if (turn == null) continue
    const bucket = byTurn.get(turn) ?? []
    bucket.push(row)
    byTurn.set(turn, bucket)
  }
  const emitted = new Set<number>()
  const output: (TrajectoryRecord | SummaryRow)[] = []
  for (const row of rows) {
    const record = 'kind' in row ? row : row.record
    if (record.kind === 'system') {
      output.push(row)
      continue
    }
    const turn = record.turn
    if (turn == null || !props.collapsedTurns.has(turn)) {
      output.push(row)
      continue
    }
    if (emitted.has(turn)) continue
    emitted.add(turn)
    const turnRows = byTurn.get(turn) ?? [row]
    const first = turnRows.find(candidate => 'kind' in candidate && candidate.kind !== 'system') as TrajectoryRecord | undefined
    if (first === undefined) continue
    const records = turnRows.filter((candidate): candidate is TrajectoryRecord => (
      'kind' in candidate && candidate.kind !== 'system'
    ))
    if (records.length <= 1) {
      output.push(row)
      continue
    }
    output.push(first)
    const folded = records.slice(1)
    const steps = new Set(folded.map(candidate => candidate.step).filter(step => step !== undefined)).size
    const calls = folded.filter(candidate => candidate.kind === 'tool' || candidate.kind === 'subtool').length
    output.push({
      key: `turn-summary:${turn}`,
      type: 'summary',
      record: first,
      height: 20,
      summary: [stepCount(steps), callCount(calls)].join(' · '),
      summaryKind: 'turn',
    })
  }
  return output
}

const displayRows = computed<readonly DisplayRow[]>(() => {
  const folded = collapseAssistantRows(collapseTurnRows(filteredRecords.value))
  const seenTurns = new Set<number | null>()
  return folded.map((item) => {
    if (!('kind' in item)) return item
    const turn = item.turn ?? null
    const turnStart = item.kind !== 'system'
      && (item.kind !== 'compacted' || item.turn === null)
      && !seenTurns.has(turn)
    if (item.kind !== 'system') seenTurns.add(turn)
    const requestStart = item.requestId !== undefined && requestBoundaryIds.value.has(item.id)
    const requestNumber = item.requestId === undefined
      ? undefined
      : requestNumbers.value.get(item.requestId)
    return {
      key: `record:${item.id}`,
      type: 'record',
      record: item,
      height: 30,
      turnStart,
      requestStart,
      ...(requestNumber === undefined ? {} : { requestNumber }),
    }
  })
})

const positionedRows = computed<readonly PositionedRow[]>(() => {
  let top = 0
  return displayRows.value.map((row) => {
    const position = { row, top, bottom: top + row.height }
    top += row.height
    return position
  })
})
const totalHeight = computed(() => positionedRows.value.at(-1)?.bottom ?? 0)
const virtualizationEnabled = computed(() => displayRows.value.length > 120 || props.hasEarlierRecords)
const visibleWindow = computed(() => {
  if (!virtualizationEnabled.value) {
    return { rows: positionedRows.value, top: 0, bottom: 0 }
  }
  const minimum = Math.max(0, scrollTop.value - 12 * 30)
  const maximum = scrollTop.value + viewportHeight.value + 12 * 30
  const rows = positionedRows.value.filter(position => position.bottom >= minimum && position.top <= maximum)
  return {
    rows,
    top: rows[0]?.top ?? 0,
    bottom: Math.max(0, totalHeight.value - (rows.at(-1)?.bottom ?? 0)),
  }
})

const selectedRecord = computed(() => props.records.find(record => record.id === props.selectedId))
const selectedRequestRecord = computed(() => props.records.find(record => (
  record.requestId === props.selectedRequestId
)))
const selectedTurn = computed(() => (
  selectedRecord.value?.turn ?? selectedRequestRecord.value?.turn ?? null
))
const timelineFocusIds = computed(() => trajectoryTimelineFocusIds(
  props.records,
  props.timelineRange,
  props.timelineMode ?? 'actual',
))
const timelineFocusSignature = computed(() => timelineFocusIds.value === null
  ? null
  : [...timelineFocusIds.value].join('\u0000'))

function kindLabel(record: TrajectoryRecord): string {
  return props.t(record.steering ? 'steering' : record.kind)
}

function resultPreview(record: TrajectoryRecord): string | null {
  if (record.error) return [record.error.name, record.error.code, record.error.reason].filter(Boolean).join(' · ')
  if (record.interrupted) return props.t('interrupted')
  if (record.output === undefined || (record.kind !== 'tool' && record.kind !== 'subtool')) return null
  const value = formatValue(trajectoryResultValue(record)).replace(/\s+/g, ' ').trim()
  return value === '' ? null : value
}

function isToolCallOnly(record: TrajectoryRecord): boolean {
  return record.kind === 'assistant'
    && (record.output === undefined || record.output === '')
    && !record.reasoning
    && (
      record.sourceBlocks?.some(block => block.type === 'tool-call') === true
      || props.records.some(candidate => (
        candidate.kind === 'tool'
        && (
          candidate.parentId === record.id
          || (
            candidate.parentId === undefined
            && candidate.turn === record.turn
            && candidate.step === record.step
          )
        )
      ))
    )
}

function recordDisplayText(record: TrajectoryRecord): string {
  const notice = toolChangeSummary(record, props.t)
  if (notice !== undefined) return notice
  if (record.kind !== 'assistant') {
    const { images, files } = attachmentCounts(record.sourceBlocks)
    const counts = [images ? props.t('imageCount', { count: images }) : '', files ? props.t('fileCount', { count: files }) : ''].filter(Boolean)
    return [record.summary, ...counts].filter(Boolean).join(' · ') || '—'
  }
  const source = typeof record.output === 'string' && record.output !== ''
    ? record.output
    : record.reasoning || record.summary
  const text = source.replace(/\s+/g, ' ').trim()
  if (text) return text
  const { images } = attachmentCounts(record.sourceBlocks)
  return images ? props.t('imageCount', { count: images })
    : record.sourceBlocks?.some(block => block.original !== undefined) ? props.t('unsupportedContent') : '—'
}

function summaryParts(record: TrajectoryRecord): { name: string; payload: string | null } | null {
  if (record.kind !== 'tool' && record.kind !== 'subtool') return null
  const program = trajectoryCodeProgram(record)
  if (program) return { name: record.toolName ?? 'run_code', payload: program.description }
  const separator = record.summary.indexOf(' · ')
  return separator === -1
    ? { name: record.summary, payload: null }
    : { name: record.summary.slice(0, separator), payload: record.summary.slice(separator + 3) }
}

function rowInRange(record: TrajectoryRecord): boolean {
  return timelineFocusIds.value === null || timelineFocusIds.value.has(record.id)
}

function rowSelectable(record: TrajectoryRecord): boolean {
  return !record.requestOnly && (!record.toolChanges || record.toolChanges.added.length + record.toolChanges.removed.length !== 1)
}

function selectRow(row: DisplayRow) {
  if (row.type === 'summary') {
    if (row.summaryKind === 'turn' && row.record.turn != null) emit('toggleTurn', row.record.turn)
    else emit('toggleAssistant', row.record.id)
    return
  }
  if (rowSelectable(row.record)) emit('select', row.record)
}

function doubleClickRow(row: DisplayRow) {
  if (row.type !== 'record' || !rowSelectable(row.record)) return
  const record = row.record
  const at = props.records.findIndex(candidate => candidate.id === record.id)
  const next = props.records[at + 1]
  if (record.kind === 'assistant' && next !== undefined && (
    next.kind === 'tool' || next.kind === 'subtool'
  )) {
    emit('toggleAssistant', record.id)
    return
  }
  if (!row.turnStart || record.turn == null) return
  const turnRecords = props.records.filter(candidate => (
    candidate.turn === record.turn && candidate.kind !== 'system'
  ))
  if (turnRecords.length > 1) emit('toggleTurn', record.turn)
}

function onScroll() {
  const element = pane.value
  if (element === null) return
  scrollTop.value = element.scrollTop
  viewportHeight.value = element.clientHeight
  followsTail.value = element.scrollHeight - element.clientHeight - element.scrollTop <= 2
  if (element.scrollTop <= 48 && props.hasEarlierRecords && !props.loadingEarlier) {
    emit('loadEarlier')
  }
}

function scrollToTail(behavior: ScrollBehavior = 'auto') {
  const element = pane.value
  if (element === null) return
  followsTail.value = true
  element.scrollTo({ top: element.scrollHeight, behavior })
  scrollTop.value = element.scrollTop
}

function initializeTail() {
  if (tailInitialized || props.loadingInitial || displayRows.value.length === 0) return
  tailInitialized = true
  tailReady.value = false
  const targetId = props.selectedId ?? selectedRequestRecord.value?.id
  nextTick(() => {
    if (targetId === undefined || targetId === null) scrollToTail()
    else scrollToRecord(targetId)
    tailReady.value = true
  })
}

function scrollToRecord(id: string) {
  const element = pane.value
  const position = positionedRows.value.find(item => item.row.record.id === id)
  if (element === null || position === undefined) return
  const top = position.top
  const bottom = position.bottom
  if (top < element.scrollTop || bottom > element.scrollTop + element.clientHeight) {
    followsTail.value = false
    element.scrollTop = Math.max(0, top - element.clientHeight / 2 + 15)
  }
}

function scrollToTimelineFocus(ids: ReadonlySet<string>) {
  const element = pane.value
  if (element === null || ids.size === 0) return
  const focused = positionedRows.value.filter(position => (
    position.row.type === 'record' && ids.has(position.row.record.id)
  ))
  const first = focused[0]
  const last = focused.at(-1)
  if (first === undefined || last === undefined) return
  const focusHeight = last.bottom - first.top
  const target = focusHeight > element.clientHeight
    ? first.top
    : (first.top + last.bottom - element.clientHeight) / 2
  const maximum = Math.max(0, element.scrollHeight - element.clientHeight)
  followsTail.value = false
  element.scrollTo({
    top: Math.min(maximum, Math.max(0, target)),
    behavior: 'smooth',
  })
}

watch(() => props.selectedId, id => { if (id !== null) nextTick(() => { scrollToRecord(id) }) })
watch(() => props.selectedRequestId, () => {
  const id = selectedRequestRecord.value?.id
  if (id !== undefined) nextTick(() => { scrollToRecord(id) })
})
watch(timelineFocusSignature, signature => {
  const ids = timelineFocusIds.value
  if (signature !== null && ids !== null) nextTick(() => { scrollToTimelineFocus(ids) })
})
watch(
  () => displayRows.value.map(row => row.key),
  (_next, previous) => {
    const element = pane.value
    if (element === null) return
    if (!tailInitialized) {
      initializeTail()
      return
    }
    if (previous.length === 0) {
      firstSourceRecordId = props.records[0]?.id
      if (followsTail.value) nextTick(() => { scrollToTail() })
      return
    }
    const oldHeight = element.scrollHeight
    const oldTop = element.scrollTop
    const nextFirstSourceRecordId = props.records[0]?.id
    const prepended = firstSourceRecordId === undefined
      ? -1
      : props.records.findIndex(record => record.id === firstSourceRecordId)
    firstSourceRecordId = nextFirstSourceRecordId
    nextTick(() => {
      if (prepended > 0) {
        element.scrollTop = oldTop + element.scrollHeight - oldHeight
        followsTail.value = false
      } else if (followsTail.value) scrollToTail()
    })
  },
)
watch(() => props.loadingInitial, () => { initializeTail() })

onMounted(() => {
  const element = pane.value
  if (element === null) return
  resizeObserver = new ResizeObserver(() => {
    viewportHeight.value = element.clientHeight
  })
  resizeObserver.observe(element)
  viewportHeight.value = element.clientHeight
  if (!props.loadingInitial && displayRows.value.length === 0) tailReady.value = true
  initializeTail()
})

onBeforeUnmount(() => { resizeObserver?.disconnect() })

defineExpose({ scrollToRecord, scrollToTail, searchMatchIds })
</script>

<template>
  <div
    ref="pane"
    class="tui-ledger"
    data-trajectory-scroll
    @scroll="onScroll"
    @click.self="emit('clear')"
  >
    <div v-if="loadingInitial || !tailReady" class="tui-history-status" role="status">
      <span class="tui-history-status__bar">
        <span class="tui-spinner" aria-hidden="true" />
        {{ t('loadingTrajectory') }}
      </span>
    </div>
    <table class="tui-table" :class="{ 'is-scroll-ready': tailReady }" :aria-rowcount="displayRows.length + (hasEarlierRecords ? 1 : 0)">
      <colgroup>
        <col class="tui-table__event-column" />
        <col />
      </colgroup>
      <tbody>
        <tr v-if="hasEarlierRecords" class="tui-history-row">
          <td colspan="2">
            <button
              type="button"
              class="tui-history-button"
              :disabled="loadingEarlier"
              @click="emit('loadEarlier')"
            >
              <span v-if="loadingEarlier" class="tui-spinner" aria-hidden="true" />
              <span>{{ t(loadingEarlier ? 'loadingEarlier' : 'loadEarlier') }}</span>
            </button>
          </td>
        </tr>
        <tr v-if="visibleWindow.top > 0" class="tui-spacer" aria-hidden="true">
          <td colspan="2" :style="{ height: `${visibleWindow.top}px` }" />
        </tr>
        <template v-for="position in visibleWindow.rows" :key="position.row.key">
          <tr
            class="tui-row"
            :class="{
              'is-selected': position.row.type === 'record' && position.row.record.id === selectedId,
              'is-error': recordStatus(position.row.record) === 'error',
              'is-running': recordStatus(position.row.record) === 'running',
              'is-range-muted': !rowInRange(position.row.record),
              'is-summary': position.row.type === 'summary',
            }"
            :data-kind="position.row.record.kind"
            :data-turn-start="position.row.type === 'record' && position.row.turnStart || undefined"
            :tabindex="position.row.type === 'summary' || rowSelectable(position.row.record) ? 0 : -1"
            @click="selectRow(position.row)"
            @dblclick="doubleClickRow(position.row)"
            @keydown.enter.prevent="selectRow(position.row)"
            @keydown.space.prevent="selectRow(position.row)"
          >
            <td class="tui-row__event">
              <button
                v-if="position.row.type === 'record' && position.row.requestStart && position.row.requestNumber !== undefined"
                type="button"
                class="tui-request-dot"
                :class="{
                  'is-active': position.row.record.requestId === selectedRequestId,
                  'is-error': recordStatus(position.row.record) === 'error'
                    || (position.row.record.requestId !== undefined && requestErrorIds?.has(position.row.record.requestId)),
                }"
                :data-label="t('request', { request: position.row.requestNumber })"
                :aria-label="t('request', { request: position.row.requestNumber })"
                :aria-pressed="position.row.record.requestId === selectedRequestId"
                @click.stop="emit('selectRequest', position.row.record)"
                @dblclick.stop
              />
              <span
                v-if="position.row.record.turn != null && selectedTurn === position.row.record.turn"
                class="tui-turn-rail"
                aria-hidden="true"
              />
              <span
                v-if="position.row.type === 'record' && position.row.record.id === selectedId"
                class="tui-selection-rail"
                aria-hidden="true"
              />
              <span
                v-if="position.row.type === 'record' && position.row.turnStart"
                class="tui-turn-label"
                :class="{ 'is-active': selectedTurn === position.row.record.turn }"
              >
                <span class="tui-turn-label__full">
                  {{ position.row.record.turn == null ? t('betweenTurns') : t('turn', { turn: position.row.record.turn }) }}
                </span>
                <span class="tui-turn-label__compact">
                  {{ position.row.record.turn == null ? '—' : `#${position.row.record.turn}` }}
                </span>
              </span>
              <div v-if="position.row.type === 'record' && !position.row.record.requestOnly" class="tui-kind-slot">
                <span class="tui-kind" :class="`tui-kind--${position.row.record.kind}`" :title="kindLabel(position.row.record)">
                  <span class="tui-kind__icon" aria-hidden="true">
                    <TrajectoryRoleIcon :kind="position.row.record.kind" />
                  </span>
                  <span class="tui-kind__label">{{ kindLabel(position.row.record) }}</span>
                </span>
              </div>
            </td>
            <td class="tui-row__content" :class="{ 'tui-row__content--subtool': position.row.record.kind === 'subtool' }">
              <span v-if="position.row.type === 'summary'" class="tui-summary-row">
                <strong aria-hidden="true">…</strong>
                <span>{{ position.row.summary }}</span>
              </span>
              <span v-else-if="!position.row.record.requestOnly" class="tui-content-grid" :class="{ 'has-result': resultPreview(position.row.record) !== null }">
                <span class="tui-content-grid__request">
                  <span v-if="isToolCallOnly(position.row.record)" class="tui-tool-call-only">
                    {{ t('toolCallOnly') }}
                  </span>
                  <template v-else-if="summaryParts(position.row.record)">
                    <strong class="tui-tool-name">{{ summaryParts(position.row.record)?.name || '—' }}</strong>
                    <span v-if="summaryParts(position.row.record)?.payload" class="tui-tool-payload">
                      {{ summaryParts(position.row.record)?.payload }}
                    </span>
                  </template>
                  <template v-else>{{ recordDisplayText(position.row.record) }}</template>
                </span>
                <span v-if="resultPreview(position.row.record) !== null" class="tui-inline-result">
                  <span class="tui-inline-result__arrow">→</span>
                  <span>{{ resultPreview(position.row.record) }}</span>
                </span>
              </span>
            </td>
          </tr>
        </template>
        <tr v-if="visibleWindow.bottom > 0" class="tui-spacer" aria-hidden="true">
          <td colspan="2" :style="{ height: `${visibleWindow.bottom}px` }" />
        </tr>
      </tbody>
    </table>
    <div v-if="!loadingInitial && displayRows.length === 0" class="tui-empty">{{ t('noRecords') }}</div>
  </div>
</template>
