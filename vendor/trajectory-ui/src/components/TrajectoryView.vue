<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useSlots, watch } from 'vue'
import { recordMatchesSearch } from '../format'
import { createTranslator, type MessageOverrides } from '../i18n'
import { createTrajectoryStore } from '../store'
import type {
  TrajectoryDetailTab,
  TrajectoryWatchToolResult,
  TrajectoryDurationMode,
  TrajectoryLocale,
  TrajectoryOlderLoader,
  TrajectoryRecord,
  TrajectoryRequestDetails,
  TrajectoryStore,
  TrajectoryStreamSource,
  TrajectoryTheme,
  TrajectoryTimeRange,
} from '../types'
import TrajectoryInspector from './TrajectoryInspector.vue'
import TrajectoryLedger from './TrajectoryLedger.vue'
import TrajectoryTimeline from './TrajectoryTimeline.vue'
import TrajectoryToolbar from './TrajectoryToolbar.vue'

const props = withDefaults(defineProps<{
  store?: TrajectoryStore
  records?: readonly TrajectoryRecord[]
  requests?: readonly TrajectoryRequestDetails[]
  watchToolResult?: TrajectoryWatchToolResult
  stream?: TrajectoryStreamSource
  hasMore?: boolean
  loadOlder?: TrajectoryOlderLoader
  loading?: boolean
  selectedId?: string | null
  initialSelectedId?: string | null
  selectedRequestId?: string | null
  initialSelectedRequestId?: string | null
  searchQuery?: string
  inspectorTab?: TrajectoryDetailTab | null
  locale?: TrajectoryLocale
  messages?: MessageOverrides
  theme?: TrajectoryTheme
  durationMode?: TrajectoryDurationMode
}>(), {
  records: () => [],
  requests: () => [],
  hasMore: false,
  loading: false,
  initialSelectedId: null,
  initialSelectedRequestId: null,
  locale: 'en',
  messages: () => ({}),
  theme: 'light',
  durationMode: 'actual',
})

const emit = defineEmits<{
  'update:selectedId': [id: string | null]
  'update:selectedRequestId': [id: string | null]
  'update:searchQuery': [query: string]
  'update:inspectorTab': [tab: TrajectoryDetailTab | null]
  select: [record: TrajectoryRecord | null]
  selectRequest: [requestId: string | null, records: readonly TrajectoryRecord[]]
  loadEarlier: [loaded: boolean]
}>()

const slots = useSlots()
const internalStore = createTrajectoryStore({
  records: props.records,
  hasMore: props.hasMore,
  ...(props.loadOlder === undefined ? {} : { loadOlder: props.loadOlder }),
})
const activeStore = computed(() => props.store ?? internalStore)
const records = computed(() => activeStore.value.records.value)
const hasMore = computed(() => activeStore.value.hasMore.value)
const loadingEarlier = computed(() => activeStore.value.loadingOlder.value)
const translator = computed(() => createTranslator(props.locale, props.messages))
const internalSelectedId = ref<string | null>(props.initialSelectedId)
const internalSelectedRequestId = ref<string | null>(props.initialSelectedRequestId)
const internalSearchQuery = ref('')
const internalInspectorTab = ref<TrajectoryDetailTab | null>(null)
const collapsedTurns = ref<ReadonlySet<number>>(new Set())
const collapsedAssistants = ref<ReadonlySet<string>>(new Set())
const timelineRange = ref<TrajectoryTimeRange | null>(null)
const actualDuration = ref(props.durationMode === 'actual')
const ledger = ref<InstanceType<typeof TrajectoryLedger> | null>(null)
let streamController: AbortController | null = null

const searchQuery = computed({
  get: () => props.searchQuery ?? internalSearchQuery.value,
  set: (value: string) => {
    internalSearchQuery.value = value
    emit('update:searchQuery', value)
  },
})
const inspectorTab = computed({
  get: () => props.inspectorTab === undefined ? internalInspectorTab.value : props.inspectorTab,
  set: (value: TrajectoryDetailTab | null) => {
    internalInspectorTab.value = value
    emit('update:inspectorTab', value)
  },
})
const selectedId = computed({
  get: () => props.selectedId === undefined ? internalSelectedId.value : props.selectedId,
  set: (value: string | null) => {
    internalSelectedId.value = value
    emit('update:selectedId', value)
    emit('select', records.value.find(record => record.id === value) ?? null)
  },
})
const selectedRequestId = computed({
  get: () => props.selectedRequestId === undefined
    ? internalSelectedRequestId.value
    : props.selectedRequestId,
  set: (value: string | null) => {
    internalSelectedRequestId.value = value
    emit('update:selectedRequestId', value)
    emit(
      'selectRequest',
      value,
      value === null ? [] : records.value.filter(record => record.requestId === value),
    )
  },
})
const activeSelectedId = computed(() => selectedRequestId.value === null ? selectedId.value : null)
const selectedRecord = computed(() => records.value.find(record => record.id === activeSelectedId.value))
const selectedRequestRecord = computed(() => {
  const requestId = selectedRequestId.value
  if (requestId === null) return undefined
  return records.value.find(record => (
    record.requestId === requestId && record.requestNumber !== undefined
  )) ?? records.value.find(record => record.requestId === requestId)
})
const selectedRequestDetails = computed(() => {
  const requestId = selectedRequestId.value
  if (requestId === null) return undefined
  return props.requests.find(request => request.id === requestId)
})
const inspectorRecord = computed(() => selectedRequestRecord.value ?? selectedRecord.value)

const turns = computed(() => {
  const counts = new Map<number, number>()
  for (const record of records.value) {
    if (record.turn == null || record.kind === 'system' || record.kind === 'compacted') continue
    counts.set(record.turn, (counts.get(record.turn) ?? 0) + 1)
  }
  return [...counts].filter(([, count]) => count > 1).map(([turn]) => turn)
})
const assistants = computed(() => records.value.flatMap((record, index) => {
  if (record.kind !== 'assistant') return []
  const next = records.value[index + 1]
  return next !== undefined && (next.kind === 'tool' || next.kind === 'subtool')
    ? [record.id]
    : []
}))
const allTurnsCollapsed = computed(() => turns.value.length > 0
  && turns.value.every(turn => collapsedTurns.value.has(turn)))
const allCallsCollapsed = computed(() => assistants.value.length > 0
  && assistants.value.every(id => collapsedAssistants.value.has(id)))
const searchMatchIds = computed<ReadonlySet<string> | null>(() => {
  const query = searchQuery.value.trim()
  if (query === '') return null
  return new Set(records.value
    .filter(record => recordMatchesSearch(record, query))
    .map(record => record.id))
})
const requestErrorIds = computed<ReadonlySet<string>>(() => new Set(
  props.requests.filter(request => request.status === 'error').map(request => request.id),
))

function setSelection(record: TrajectoryRecord) {
  if (selectedRequestId.value !== null) selectedRequestId.value = null
  selectedId.value = record.id
}

function revealRecord(record: TrajectoryRecord) {
  if (record.turn != null && collapsedTurns.value.has(record.turn)) {
    const next = new Set(collapsedTurns.value)
    next.delete(record.turn)
    collapsedTurns.value = next
  }
  if (record.kind === 'tool' || record.kind === 'subtool') {
    const recordAt = records.value.findIndex(candidate => candidate.id === record.id)
    const parent = records.value.find(candidate => candidate.id === record.parentId)
    const parentAssistantId = parent?.kind === 'assistant'
      ? parent.id
      : parent?.kind === 'tool'
        ? parent.parentId
        : [...records.value.slice(0, recordAt === -1 ? records.value.length : recordAt)]
            .reverse()
            .find(candidate => (
              candidate.kind === 'assistant'
              && candidate.turn === record.turn
              && candidate.step === record.step
            ))?.id
    if (parentAssistantId !== undefined && collapsedAssistants.value.has(parentAssistantId)) {
      const next = new Set(collapsedAssistants.value)
      next.delete(parentAssistantId)
      collapsedAssistants.value = next
    }
  }
}

function openRecord(record: TrajectoryRecord) {
  revealRecord(record)
  setSelection(record)
}

function focusRecord(record: TrajectoryRecord) {
  revealRecord(record)
  nextTick(() => { ledger.value?.scrollToRecord(record.id) })
}

function setRequestSelection(record: TrajectoryRecord) {
  if (record.requestId === undefined) return
  inspectorTab.value = 'summary'
  if (selectedId.value !== null) selectedId.value = null
  selectedRequestId.value = record.requestId
}

function openRequest(requestId: string, tab: 'summary' | 'timing' = 'summary') {
  inspectorTab.value = tab
  if (selectedId.value !== null) selectedId.value = null
  selectedRequestId.value = requestId
}

function clearSelection() {
  if (selectedRequestId.value !== null) selectedRequestId.value = null
  if (selectedId.value !== null) selectedId.value = null
  inspectorTab.value = null
}

function toggleTurn(turn: number) {
  const next = new Set(collapsedTurns.value)
  if (next.has(turn)) next.delete(turn)
  else next.add(turn)
  collapsedTurns.value = next
}

function toggleAssistant(id: string) {
  const next = new Set(collapsedAssistants.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsedAssistants.value = next
}

function toggleAllTurns() {
  collapsedTurns.value = allTurnsCollapsed.value ? new Set() : new Set(turns.value)
}

function toggleAllCalls() {
  collapsedAssistants.value = allCallsCollapsed.value ? new Set() : new Set(assistants.value)
}

async function loadEarlier() {
  const loaded = await activeStore.value.loadEarlier()
  emit('loadEarlier', loaded)
}

watch(() => props.records, (next) => {
  if (props.store === undefined) internalStore.replace(next, props.hasMore)
})
watch(() => props.hasMore, (next) => {
  if (props.store === undefined) internalStore.hasMore.value = next
})
watch([() => props.store, () => props.loadOlder], ([, loader]) => {
  if (loader !== undefined || props.store === undefined) {
    activeStore.value.setOlderLoader(loader)
  }
}, { immediate: true })
watch(() => props.durationMode, mode => { actualDuration.value = mode === 'actual' })
watch(actualDuration, () => { timelineRange.value = null })
watch(() => props.selectedId, (id) => {
  const record = id == null ? undefined : records.value.find(candidate => candidate.id === id)
  if (record !== undefined) revealRecord(record)
  if (id != null && props.selectedRequestId === undefined && selectedRequestId.value !== null) {
    selectedRequestId.value = null
  }
})
watch(selectedRequestId, (id) => {
  const record = id === null ? undefined : records.value.find(candidate => candidate.requestId === id)
  if (record !== undefined) revealRecord(record)
})
watch([activeStore, () => props.stream], ([store, source]) => {
  streamController?.abort()
  streamController = null
  if (source === undefined) return
  const controller = new AbortController()
  streamController = controller
  void store.consume(source, { signal: controller.signal }).catch(() => undefined)
}, { immediate: true })
watch(records, (next) => {
  if (selectedId.value !== null && !next.some(record => record.id === selectedId.value)) {
    selectedId.value = null
  }
  if (
    selectedRequestId.value !== null
    && !next.some(record => record.requestId === selectedRequestId.value)
  ) {
    selectedRequestId.value = null
  }
})

onBeforeUnmount(() => {
  streamController?.abort()
  if (props.store === undefined) internalStore.dispose()
})

defineExpose({ store: activeStore, select: openRecord, selectRequest: setRequestSelection, clearSelection })
</script>

<template>
  <div class="trajectory-ui" :data-theme="theme">
    <TrajectoryToolbar
      :actual-duration="actualDuration"
      :all-turns-collapsed="allTurnsCollapsed"
      :all-calls-collapsed="allCallsCollapsed"
      :search-query="searchQuery"
      :t="translator"
      @update:actual-duration="actualDuration = $event"
      @update:search-query="searchQuery = $event"
      @toggle-turns="toggleAllTurns"
      @toggle-calls="toggleAllCalls"
    />
    <TrajectoryTimeline
      :records="records"
      :mode="actualDuration ? 'actual' : 'equal'"
      :range="timelineRange"
      :selected-id="activeSelectedId"
      :search-match-ids="searchMatchIds"
      :has-earlier-records="hasMore"
      :loading-earlier="loadingEarlier"
      :t="translator"
      @update:range="timelineRange = $event"
      @select="openRecord"
      @focus="focusRecord"
      @load-earlier="loadEarlier"
    />
    <div class="tui-split">
      <TrajectoryLedger
        ref="ledger"
        :records="records"
        :selected-id="activeSelectedId"
        :selected-request-id="selectedRequestId"
        :request-error-ids="requestErrorIds"
        :search-query="searchQuery"
        :timeline-range="timelineRange"
        :timeline-mode="actualDuration ? 'actual' : 'equal'"
        :collapsed-turns="collapsedTurns"
        :collapsed-assistants="collapsedAssistants"
        :loading-initial="loading && records.length === 0"
        :loading-earlier="loadingEarlier"
        :has-earlier-records="hasMore"
        :t="translator"
        @select="setSelection"
        @select-request="setRequestSelection"
        @clear="clearSelection"
        @load-earlier="loadEarlier"
        @toggle-turn="toggleTurn"
        @toggle-assistant="toggleAssistant"
      />
      <TrajectoryInspector
        :watch-tool-result="watchToolResult"
        v-if="inspectorRecord"
        :record="inspectorRecord"
        :records="records"
        :requests="requests"
        :request="selectedRequestRecord !== undefined"
        :request-details="selectedRequestDetails"
        v-model:active-tab="inspectorTab"
        :t="translator"
        @close="clearSelection"
        @select="openRecord"
        @select-request="openRequest"
      >
        <template v-if="slots.input" #input="slotProps">
          <slot name="input" v-bind="slotProps" />
        </template>
        <template v-if="slots.output" #output="slotProps">
          <slot name="output" v-bind="slotProps" />
        </template>
        <template v-if="slots.reasoning" #reasoning="slotProps">
          <slot name="reasoning" v-bind="slotProps" />
        </template>
      </TrajectoryInspector>
    </div>
  </div>
</template>
