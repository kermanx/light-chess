<script setup lang="ts">
import { computed, ref, useSlots, watch } from 'vue'
import { formatDuration, formatValue, recordStatus } from '../format'
import type { MessageKey } from '../i18n'
import type {
  TrajectoryContentBlock,
  TrajectoryWatchToolResult,
  TrajectoryDetailTab as DetailTab,
  TrajectoryRecord,
  TrajectoryRequestDetails,
  TrajectoryToolDefinition,
} from '../types'
import TrajectoryMarkdown from './TrajectoryMarkdown.vue'
import TrajectoryCode from './TrajectoryCode.vue'
import TrajectoryValue from './TrajectoryValue.vue'
import TrajectoryAttachments from './TrajectoryAttachments.vue'
import { useLiveToolResult } from '../live-tool-result'
import { trajectoryCodeProgram } from '../code-program'
import { isAttachmentBlock, trajectoryResultValue } from '../content'
import TrajectoryPromptDiff from './TrajectoryPromptDiff.vue'
import TrajectoryRecordPreview from './TrajectoryRecordPreview.vue'
import TrajectoryToolCatalog from './TrajectoryToolCatalog.vue'
import TrajectoryToolSchema from './TrajectoryToolSchema.vue'
import TrajectoryTimestamp from './TrajectoryTimestamp.vue'
import TrajectoryTimingEstimate from './TrajectoryTimingEstimate.vue'
import { estimateTrajectoryTimings } from '../timing-estimates'
import TrajectoryUsage from './TrajectoryUsage.vue'

const props = withDefaults(defineProps<{
  record: TrajectoryRecord
  records?: readonly TrajectoryRecord[]
  requests?: readonly TrajectoryRequestDetails[]
  request?: boolean
  requestDetails?: TrajectoryRequestDetails
  initialTab?: 'summary' | 'timing'
  activeTab?: DetailTab | null
  watchToolResult?: TrajectoryWatchToolResult
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>(), {
  records: () => [],
  requests: () => [],
  request: false,
})

const emit = defineEmits<{
  'update:activeTab': [tab: DetailTab]
  close: []
  select: [record: TrajectoryRecord]
  selectRequest: [requestId: string, tab?: 'summary' | 'timing']
}>()

const slots = useSlots()
const activeTab = ref<DetailTab>('summary')
const tabHistory = ref<DetailTab[]>(['summary'])
const thinkingExpanded = ref(false)
const width = ref<number | null>(null)
const resize = ref<{ pointerId: number; x: number; width: number; splitWidth: number } | null>(null)

function isMarkdownRecord(record: TrajectoryRecord): boolean {
  return record.kind === 'user' || record.kind === 'context' || record.kind === 'assistant'
}

function isToolRecord(record: TrajectoryRecord): boolean {
  return record.kind === 'tool' || record.kind === 'subtool'
}

function hasDetail(value: unknown): boolean {
  return value !== undefined && (typeof value !== 'string' || value !== '')
}

const resultValue = computed(() => trajectoryResultValue(props.record))

const liveResult = useLiveToolResult(() => ({
  recordId: props.record.id,
  resultSeq: props.record.resultSeq,
  active: !props.request && activeTab.value === 'result' && isToolRecord(props.record),
  observe: props.watchToolResult,
}))

const program = computed(() => trajectoryCodeProgram(props.record))

const tabs = computed<readonly DetailTab[]>(() => {
  const record = props.record
  if (props.request) return [
    'summary',
    ...(props.requestDetails?.options === undefined ? [] : ['options'] as const),
    'usage',
    'timing',
  ]
  if (record.kind === 'system') return [
    ...(record.previousInput === undefined && record.previousTools === undefined ? [] : ['diff'] as const),
    'systemPrompt',
    'tools',
  ]
  if (record.kind === 'compacted') return ['summary', 'raw']
  if (isMarkdownRecord(record)) {
    return [
      'summary',
      'preview',
      'raw',
      ...(record.source === undefined ? [] : ['source'] as const),
    ]
  }
  return [
    'summary',
    ...(program.value ? ['code'] as const : hasDetail(record.input) ? ['payload'] as const : []),
    ...(isToolRecord(record) || hasDetail(record.output) ? ['result'] as const : []),
    'schema',
    'timing',
  ]
})

const promptTools = computed<readonly TrajectoryToolDefinition[]>(() => {
  if (props.record.tools !== undefined) return props.record.tools
  let value = props.record.schema
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  return value.flatMap((candidate): TrajectoryToolDefinition[] => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) return []
    const tool = candidate as Record<string, unknown>
    if (typeof tool.name !== 'string') return []
    return [{
      name: tool.name,
      ...(typeof tool.description === 'string' ? { description: tool.description } : {}),
      ...(tool.parameters === undefined ? {} : { parameters: tool.parameters }),
    }]
  })
})

const requestRecords = computed(() => props.request && props.record.requestId !== undefined
  ? props.records.filter(record => record.requestId === props.record.requestId)
  : [])
const linkedRequestDetails = computed(() => props.record.requestId === undefined
  ? undefined
  : props.requests.find(request => request.id === props.record.requestId))
const activeRequestDetails = computed(() => props.request ? props.requestDetails : linkedRequestDetails.value)
const requestOptions = computed<Record<string, unknown> | undefined>(() => {
  const value = activeRequestDetails.value?.options
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
})
const requestAnchor = computed(() => requestRecords.value.find(record => (
  record.kind === 'assistant' || record.kind === 'compacted'
)) ?? props.record)
const timingEstimates = computed(() => estimateTrajectoryTimings(props.records.length ? props.records : [props.record]))
const requestTimingEstimate = computed(() => activeRequestDetails.value?.durationMs != null
  ? undefined : timingEstimates.value.get(requestAnchor.value.id))
const requestNumber = computed(() => props.requestDetails?.number ?? requestRecords.value.find(record => (
  record.requestNumber !== undefined
))?.requestNumber ?? props.record.requestNumber)
const requestProvider = computed(() => props.requestDetails?.provider ?? requestRecords.value.find(record => (
  record.provider !== undefined
))?.provider ?? props.record.provider ?? (
  typeof requestOptions.value?.provider === 'string' ? requestOptions.value.provider : undefined
))
const requestModel = computed(() => props.requestDetails?.model ?? requestRecords.value.find(record => (
  record.model !== undefined
))?.model ?? props.record.model ?? (
  typeof requestOptions.value?.model === 'string' ? requestOptions.value.model : undefined
))
const requestUsage = computed(() => activeRequestDetails.value?.usage ?? requestRecords.value.find(record => (
  record.usage !== undefined
))?.usage ?? props.record.usage)
const requestCumulativeUsage = computed(() => activeRequestDetails.value?.cumulativeUsage ?? requestUsage.value)
const requestToolCalls = computed(() => requestRecords.value.filter(record => record.kind === 'tool').length)
const requestSubtoolCalls = computed(() => requestRecords.value.filter(record => record.kind === 'subtool').length)
const requestResult = computed(() => (
  props.requestDetails?.resultId === undefined
    ? undefined
    : props.records.find(record => record.id === props.requestDetails?.resultId && !record.requestOnly)
) ?? requestRecords.value.find(record => (
  (record.kind === 'assistant' && !record.requestOnly) || record.kind === 'compacted'
)))

const childTools = computed(() => props.records.filter(candidate => (
  candidate.kind === 'tool'
  && (
    candidate.parentId === props.record.id
    || (
      candidate.parentId === undefined
      && candidate.turn === props.record.turn
      && candidate.step === props.record.step
    )
  )
)))

const parentTool = computed(() => {
  if (props.record.kind !== 'subtool') return undefined
  const byId = props.record.parentId === undefined
    ? undefined
    : props.records.find(candidate => (
        candidate.id === props.record.parentId && (candidate.kind === 'tool' || candidate.kind === 'subtool')
      ))
  if (byId !== undefined) return byId
  const at = props.records.findIndex(candidate => candidate.id === props.record.id)
  return [...props.records.slice(0, at === -1 ? props.records.length : at)].reverse().find(candidate => (
    candidate.kind === 'tool'
    && candidate.turn === props.record.turn
    && candidate.step === props.record.step
  ))
})

const parentAssistant = computed(() => {
  if (!isToolRecord(props.record)) return undefined
  const parentId = parentTool.value?.parentId ?? props.record.parentId
  const byId = parentId === undefined
    ? undefined
    : props.records.find(candidate => candidate.id === parentId && candidate.kind === 'assistant')
  if (byId !== undefined) return byId
  const at = props.records.findIndex(candidate => candidate.id === props.record.id)
  return [...props.records.slice(0, at === -1 ? props.records.length : at)].reverse().find(candidate => (
    candidate.kind === 'assistant'
    && candidate.turn === props.record.turn
    && candidate.step === props.record.step
  ))
})

const rawContent = computed(() => {
  const record = props.record
  if (record.kind === 'assistant') {
    return [record.reasoning, record.output === undefined ? undefined : formatValue(record.output)]
      .filter((value): value is string => value !== undefined && value !== '')
      .join('\n\n')
  }
  if (record.kind === 'user' || record.kind === 'context' || record.kind === 'system') {
    return formatValue(record.input)
  }
  if (record.kind === 'compacted') return formatValue(record.rawOutput ?? record.output)
  return formatValue(record)
})
const rawBlocks = computed<readonly TrajectoryContentBlock[]>(() => {
  if (props.record.kind === 'compacted') return []
  if (props.record.sourceBlocks !== undefined) return props.record.sourceBlocks
  return childTools.value.map(tool => ({
    type: 'tool-call' as const,
    ...(tool.callId === undefined ? {} : { callId: tool.callId }),
    toolName: tool.toolName ?? tool.summary.split(' · ')[0] ?? props.t('toolCall'),
    ...(tool.input === undefined ? {} : { input: tool.input }),
  }))
})

const contentTokens = computed(() => {
  const output = props.record.usage?.output
  const reasoning = props.record.usage?.reasoning
  return output === undefined || reasoning === undefined
    ? undefined
    : Math.max(0, output - reasoning)
})

watch([
  () => `${props.request ? 'request' : 'record'}:${props.record.id}`,
  () => props.activeTab,
  () => props.initialTab,
  tabs,
], () => {
  const requested = props.activeTab ?? (props.request ? props.initialTab : undefined)
  const recent = [...tabHistory.value].reverse().find(tab => tabs.value.includes(tab))
  activeTab.value = requested !== undefined && tabs.value.includes(requested)
    ? requested
    : recent ?? tabs.value[0] ?? 'summary'
  if (props.activeTab !== activeTab.value) emit('update:activeTab', activeTab.value)
}, { immediate: true })

function activateTab(tab: DetailTab) {
  activeTab.value = tab
  tabHistory.value = [...tabHistory.value.filter(candidate => candidate !== tab), tab]
  emit('update:activeTab', tab)
}

function tabLabel(tab: DetailTab): string {
  if (tab === 'systemPrompt') return props.t('systemPrompt')
  if (tab === 'tools') return props.t('tools')
  if (tab === 'raw' && props.record.kind === 'compacted') return props.t('rawOutput')
  return props.t(tab)
}

function kindLabel(record: TrajectoryRecord): string {
  return props.t(record.steering ? 'steering' : record.kind)
}

function statusLabel(record: TrajectoryRecord): string {
  const status = recordStatus(record)
  if (record.interrupted) return props.t('interrupted')
  return props.t(status === 'complete' ? 'completed' : status === 'running' ? 'running' : 'failed')
}

function requestStatusLabel(): string {
  const status = props.requestDetails?.status ?? recordStatus(requestAnchor.value)
  return props.t(status === 'complete' ? 'completed' : status === 'running' ? 'running' : 'failed')
}

function sourceLabel(value: unknown): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return props.t('unknownSource')
  const source = value as Record<string, unknown>
  if (source.kind === 'user') return props.t('userSource')
  if (source.kind === 'plugin') {
    return typeof source.plugin === 'string' && source.plugin !== ''
      ? props.t('pluginNamedSource', { plugin: source.plugin })
      : props.t('pluginSource')
  }
  if (source.kind === 'goal') {
    return typeof source.round === 'number'
      ? props.t('goalRoundSource', { round: source.round })
      : props.t('goalSource')
  }
  if (typeof source.kind !== 'string' || source.kind === '') return props.t('unknownSource')
  return `${source.kind[0]?.toLocaleUpperCase() ?? ''}${source.kind.slice(1)}`
}

function tokenValue(value: number): string {
  return props.t('tokenValue', { value: value.toLocaleString() })
}

function requestStartedAt(): number | null | undefined {
  return activeRequestDetails.value?.startedAt ?? (
    requestAnchor.value.timestampKind === 'observation' || activeRequestDetails.value?.timingRecorded === false
      ? undefined : requestAnchor.value.startedAt
  )
}

function requestDuration(): number | null | undefined {
  return activeRequestDetails.value?.durationMs ?? requestAnchor.value.durationMs
}

function requestTtft(): number | null | undefined {
  return activeRequestDetails.value?.ttftMs ?? requestAnchor.value.ttftMs
}

function requestGeneration(): number | null | undefined {
  const explicit = activeRequestDetails.value?.generationMs
  if (explicit !== undefined) return explicit
  const duration = requestDuration()
  const ttft = requestTtft()
  return duration == null || ttft == null ? undefined : Math.max(0, duration - ttft)
}

function requestThroughput(): number | null | undefined {
  if (activeRequestDetails.value?.throughput !== undefined) return activeRequestDetails.value.throughput
  const generation = requestGeneration()
  const output = requestUsage.value?.output
  return generation == null || generation <= 0 || output === undefined
    ? undefined
    : output / generation * 1_000
}

function requestTotalLabel(): string {
  const value = activeRequestDetails.value?.totalDurationMs ?? requestDuration()
  if (value == null && activeRequestDetails.value?.status === 'running') return props.t('running')
  if (value == null && activeRequestDetails.value?.timingRecorded === false) return props.t('notRecorded')
  if (value === null) return props.t('running')
  return value === undefined ? props.t('notAvailable') : formatDuration(value)
}

function requestTtftLabel(): string {
  const value = requestTtft()
  if (value == null && activeRequestDetails.value?.timingRecorded === false) return props.t('notRecorded')
  return value == null ? props.t('firstTokenUnavailable') : formatDuration(value)
}

function requestGenerationLabel(): string {
  if (requestTtft() == null) {
    return props.t('firstTokenUnavailable')
  }
  const value = requestGeneration()
  if (value == null && activeRequestDetails.value?.status === 'running') return props.t('running')
  return value == null ? props.t('notAvailable') : formatDuration(value)
}

function requestThroughputLabel(): string {
  if (requestUsage.value?.output === undefined) return props.t('outputTokensUnavailable')
  const generation = requestGeneration()
  if (requestTtft() == null) {
    return props.t('firstTokenUnavailable')
  }
  if (generation == null && activeRequestDetails.value?.status === 'running') return props.t('running')
  if (generation == null) return props.t('notAvailable')
  if (generation <= 0) return props.t('durationTooShort')
  const value = requestThroughput()
  return value == null
    ? props.t('notAvailable')
    : props.t('tokensPerSecond', { value: value.toFixed(1) })
}

function locationLabel(record: TrajectoryRecord): string {
  const section = record.turn == null ? props.t('betweenTurns') : props.t('turn', { turn: record.turn })
  if (record.kind === 'compacted') return section
  const group = record.group ?? (record.step === undefined ? undefined : props.t('step', { step: record.step }))
  return group === undefined ? section : `${section} · ${group}`
}

function inspectorLocation(): string {
  if (!props.request) return props.record.kind === 'system'
    ? props.record.summary
    : locationLabel(props.record)
  const section = requestAnchor.value.turn == null
    ? props.t('betweenTurns')
    : props.t('turn', { turn: requestAnchor.value.turn })
  return props.requestDetails?.purpose === 'compaction'
    ? props.t('compactionLocation', { section })
    : section
}

function sourceBlockLabel(block: TrajectoryContentBlock, index: number): string {
  const type = block.type !== 'image' && isAttachmentBlock(block) ? props.t('fileBlock') : block.type === 'thinking'
    ? props.t('thinking')
    : block.type === 'image'
      ? props.t('imageBlock')
      : block.type === 'text'
        ? props.t('textBlock')
        : 'tool-call'
  return props.t('blockLabel', { index: index + 1, type })
}

function sourceBlockTool(block: TrajectoryContentBlock): TrajectoryRecord | undefined {
  if (block.type !== 'tool-call') return undefined
  return props.records.find(record => (
    (block.callId !== undefined && record.callId === block.callId)
    || (
      block.callId === undefined
      && record.kind === 'tool'
      && (record.toolName ?? record.summary.split(' · ')[0]) === block.toolName
    )
  ))
}

function openSourceBlock(block: TrajectoryContentBlock) {
  const tool = sourceBlockTool(block)
  if (tool !== undefined) openRecordSummary(tool)
}

function openRecordSummary(record: TrajectoryRecord) {
  activateTab('summary')
  emit('select', record)
}

function beginResize(event: PointerEvent) {
  if (event.button !== 0) return
  const aside = (event.currentTarget as HTMLElement).parentElement
  const split = aside?.parentElement
  if (aside === null || aside === undefined || split === null || split === undefined) return
  resize.value = {
    pointerId: event.pointerId,
    x: event.clientX,
    width: aside.getBoundingClientRect().width,
    splitWidth: split.getBoundingClientRect().width,
  }
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  event.preventDefault()
}

function moveResize(event: PointerEvent) {
  const state = resize.value
  if (state === null || state.pointerId !== event.pointerId) return
  const maximum = Math.max(320, Math.min(720, state.splitWidth - 280))
  width.value = Math.round(Math.min(maximum, Math.max(320, state.width + state.x - event.clientX)))
}

function endResize(event: PointerEvent) {
  if (resize.value?.pointerId !== event.pointerId) return
  resize.value = null
  ;(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId)
}

function adjustWidth(direction: number, target: HTMLElement) {
  const aside = target.parentElement
  const split = aside?.parentElement
  if (aside === null || aside === undefined || split === null || split === undefined) return
  const splitWidth = split.getBoundingClientRect().width
  const maximum = Math.max(320, Math.min(720, splitWidth - 280))
  width.value = Math.round(Math.min(maximum, Math.max(320, aside.getBoundingClientRect().width + direction * 16)))
}
</script>

<template>
  <aside class="tui-inspector" :style="width === null ? undefined : { width: `${width}px` }" :aria-label="t('eventDetails')">
    <div
      class="tui-inspector__resize"
      role="separator"
      tabindex="0"
      :aria-label="t('resizeDetails')"
      @dblclick="width = null"
      @pointerdown="beginResize"
      @pointermove="moveResize"
      @pointerup="endResize"
      @pointercancel="resize = null"
      @keydown.left.prevent="adjustWidth(1, $event.currentTarget as HTMLElement)"
      @keydown.right.prevent="adjustWidth(-1, $event.currentTarget as HTMLElement)"
    />
    <header class="tui-inspector__header">
      <div class="tui-inspector__title">
        <template v-if="request">
          <span class="tui-request-detail-dot" aria-hidden="true" />
          <strong class="tui-request-detail-name">
            {{ t('request', { request: requestNumber ?? '—' }) }}
          </strong>
        </template>
        <span v-else class="tui-kind" :class="`tui-kind--${record.kind}`">{{ kindLabel(record) }}</span>
        <span class="tui-inspector__location">
          {{ inspectorLocation() }}
        </span>
      </div>
      <button type="button" class="tui-icon-button" :aria-label="t('closeDetails')" @click="emit('close')">
        <span aria-hidden="true">×</span>
      </button>
    </header>

    <div class="tui-inspector__tabs" role="tablist" :aria-label="t('eventDetails')">
      <button
        v-for="tab in tabs"
        :key="tab"
        type="button"
        role="tab"
        class="tui-inspector__tab"
        :class="{ 'is-active': activeTab === tab }"
        :aria-selected="activeTab === tab"
        @click="activateTab(tab)"
      >{{ tabLabel(tab) }}</button>
    </div>

    <div
      class="tui-inspector__body"
      :class="{ 'is-summary': activeTab === 'summary' }"
      role="tabpanel"
    >
      <template v-if="activeTab === 'summary'">
        <template v-if="request">
          <dl class="tui-overview tui-summary-scroll">
            <div>
              <dt>{{ t('status') }}</dt>
              <dd :class="{ 'is-error': (requestDetails?.status ?? recordStatus(requestAnchor)) === 'error' }">
                {{ requestStatusLabel() }}
              </dd>
            </div>
            <div v-if="requestDetails?.purpose === 'compaction'">
              <dt>{{ t('purpose') }}</dt><dd>{{ t('compactionPurpose') }}</dd>
            </div>
            <div v-if="requestProvider !== undefined">
              <dt>{{ t('provider') }}</dt><dd>{{ requestProvider }}</dd>
            </div>
            <div v-if="requestModel !== undefined">
              <dt>{{ t('model') }}</dt><dd>{{ requestModel }}</dd>
            </div>
            <div><dt>{{ t('toolCallsLabel') }}</dt><dd>{{ requestToolCalls }}</dd></div>
            <div v-if="requestSubtoolCalls > 0">
              <dt>{{ t('subtoolCalls') }}</dt><dd>{{ requestSubtoolCalls }}</dd>
            </div>
            <div v-if="requestDetails?.error !== undefined">
              <dt>{{ t(requestDetails.status !== 'error' && requestDetails.retry !== undefined ? 'lastAttemptError' : 'error') }}</dt><dd :class="{ 'is-error': requestDetails.status === 'error' }">{{ formatValue(requestDetails.error) }}</dd>
            </div>
            <div v-if="requestDetails?.retry !== undefined">
              <dt>{{ t('retry') }}</dt>
              <dd>
                {{ t('retryProgress', {
                  retry: requestDetails.retry,
                  maximum: requestDetails.maxRetries ?? requestDetails.retry,
                }) }}
              </dd>
            </div>
            <div v-if="requestDetails?.retryDelayMs !== undefined">
              <dt>{{ t('retryDelay') }}</dt><dd>{{ formatDuration(requestDetails.retryDelayMs) }}</dd>
            </div>
            <div v-if="requestResult">
              <dt>{{ t('result') }}</dt>
              <dd class="tui-overview-links">
                <button type="button" @click="openRecordSummary(requestResult)">
                  <span>{{ requestResult.kind === 'compacted' ? t('compacted') : t('assistantMessage') }}</span>
                  <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
              </dd>
            </div>
          </dl>
          <div class="tui-overview-sections">
            <section v-if="requestDetails?.options !== undefined" class="tui-overview-section">
              <h3>
                <button type="button" @click="activateTab('options')">
                  {{ t('options') }} <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
              </h3>
              <div class="tui-preview tui-summary-scroll">
                <pre class="tui-payload tui-payload--preview">{{ formatValue(requestDetails.options) }}</pre>
              </div>
            </section>
            <section class="tui-overview-section">
              <h3>
                <button type="button" @click="activateTab('usage')">
                  {{ t('usage') }} <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
              </h3>
              <div class="tui-preview tui-summary-scroll">
                <TrajectoryUsage :usage="requestUsage" :t="t" />
              </div>
            </section>
            <section class="tui-overview-section">
              <h3>
                <button type="button" @click="activateTab('timing')">
                  {{ t('timing') }} <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
              </h3>
              <div class="tui-preview tui-summary-scroll">
                <dl class="tui-overview">
                  <div><dt>{{ t('started') }}</dt><TrajectoryTimestamp :timestamp="requestStartedAt()" :t="t" /></div>
                  <div v-if="requestAnchor.timestampKind === 'observation'"><dt>{{ t('recordedAt') }}</dt><TrajectoryTimestamp :timestamp="requestAnchor.startedAt" :t="t" /></div>
                  <div><dt>{{ t('totalDuration') }}</dt><dd>{{ requestTotalLabel() }}</dd></div>
                  <TrajectoryTimingEstimate :estimate="requestTimingEstimate" :t="t" />
                  <div><dt>{{ t('ttft') }}</dt><dd>{{ requestTtftLabel() }}</dd></div>
                  <div><dt>{{ t('generation') }}</dt><dd>{{ requestGenerationLabel() }}</dd></div>
                  <div><dt>{{ t('throughput') }}</dt><dd>{{ requestThroughputLabel() }}</dd></div>
                </dl>
              </div>
            </section>
          </div>
        </template>

        <template v-else-if="record.kind === 'compacted'">
          <dl class="tui-overview tui-summary-scroll">
            <div><dt>{{ t('status') }}</dt><dd :class="{ 'is-error': recordStatus(record) === 'error' }">{{ statusLabel(record) }}</dd></div>
            <div v-if="record.error"><dt>{{ t('error') }}</dt><dd class="is-error">{{ [record.error.name, record.error.code, record.error.reason].filter(Boolean).join(' · ') }}</dd></div>
            <div><dt>{{ t('durationValue') }}</dt><dd>{{ record.timestampKind === 'observation' && record.durationMs == null ? t('notRecorded') : formatDuration(record.durationMs) }}</dd></div>
            <div><dt>{{ t('tokens') }}</dt><dd>{{ record.usage?.output === undefined ? '—' : tokenValue(record.usage.output) }}</dd></div>
          </dl>
          <div v-if="hasDetail(record.output)" class="tui-compacted-summary tui-summary-scroll">
            <TrajectoryRecordPreview
              :record="record"
              :child-tools="[]"
              :preview="false"
              :thinking-expanded="thinkingExpanded"
              :t="t"
              @update:thinking-expanded="thinkingExpanded = $event"
            >
              <template v-if="slots.output" #output="scope">
                <slot name="output" v-bind="scope" />
              </template>
            </TrajectoryRecordPreview>
          </div>
        </template>

        <template v-else>
          <dl class="tui-overview tui-summary-scroll">
            <div v-if="record.kind === 'assistant' && record.requestId !== undefined">
              <dt>{{ t('source') }}</dt>
              <dd class="tui-overview-links">
                <button type="button" @click="emit('selectRequest', record.requestId)">
                  <span>{{ t('request', { request: record.requestNumber ?? linkedRequestDetails?.number ?? '—' }) }}</span>
                  <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
              </dd>
            </div>
            <div v-if="isMarkdownRecord(record) && record.source !== undefined">
              <dt>{{ t('source') }}</dt>
              <dd class="tui-overview-links">
                <button type="button" @click="activateTab('source')">
                  <span>{{ sourceLabel(record.source) }}</span>
                  <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
              </dd>
            </div>
            <div v-if="parentAssistant || parentTool">
              <dt>{{ t('hierarchy') }}</dt>
              <dd class="tui-overview-links">
                <button v-if="parentAssistant" type="button" @click="openRecordSummary(parentAssistant)">
                  <span>{{ t('assistantMessage') }}</span>
                  <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
                <button v-if="parentTool" type="button" @click="openRecordSummary(parentTool)">
                  <span>{{ t('toolCall') }}</span>
                  <span class="i-codicon-chevron-right" aria-hidden="true" />
                </button>
              </dd>
            </div>
            <div><dt>{{ t('status') }}</dt><dd :class="{ 'is-error': recordStatus(record) === 'error' }">{{ statusLabel(record) }}</dd></div>
            <div v-if="record.error"><dt>{{ t('error') }}</dt><dd class="is-error">{{ [record.error.name, record.error.code, record.error.reason].filter(Boolean).join(' · ') }}</dd></div>
            <template v-if="record.kind === 'assistant'">
              <div><dt>{{ t('tokens') }}</dt><dd>{{ record.usage?.output === undefined ? '—' : tokenValue(record.usage.output) }}</dd></div>
              <div v-if="record.usage?.reasoning !== undefined" class="tui-overview__detail">
                <dt>{{ t('reasoningTokens') }}</dt><dd>{{ tokenValue(record.usage.reasoning) }}</dd>
              </div>
              <div v-if="contentTokens !== undefined" class="tui-overview__detail">
                <dt>{{ t('contentTokens') }}</dt><dd>{{ tokenValue(contentTokens) }}</dd>
              </div>
            </template>
            <div v-if="record.kind === 'user' || record.kind === 'context'">
              <dt>{{ t('durationValue') }}</dt><dd>{{ record.timestampKind === 'observation' && record.durationMs == null ? t('notRecorded') : formatDuration(record.durationMs) }}</dd>
            </div>
          </dl>

          <div class="tui-overview-sections">
            <template v-if="isMarkdownRecord(record)">
              <section class="tui-overview-section">
                <h3>
                  <button type="button" @click="activateTab('preview')">
                    {{ t('preview') }} <span class="i-codicon-chevron-right" aria-hidden="true" />
                  </button>
                </h3>
                <div class="tui-preview tui-summary-scroll">
                  <TrajectoryRecordPreview
                    :record="record"
                    :child-tools="childTools"
                    :preview="true"
                    :thinking-expanded="thinkingExpanded"
                    :t="t"
                    @update:thinking-expanded="thinkingExpanded = $event"
                    @select="openRecordSummary"
                  >
                    <template v-if="slots.input" #input="scope"><slot name="input" v-bind="scope" /></template>
                    <template v-if="slots.output" #output="scope"><slot name="output" v-bind="scope" /></template>
                    <template v-if="slots.reasoning" #reasoning="scope"><slot name="reasoning" v-bind="scope" /></template>
                  </TrajectoryRecordPreview>
                </div>
              </section>

              <section
                v-if="record.kind === 'assistant' && record.requestId !== undefined"
                class="tui-overview-section"
              >
                <h3>
                  <button type="button" @click="emit('selectRequest', record.requestId, 'timing')">
                    {{ t('requestTiming') }} <span class="i-codicon-chevron-right" aria-hidden="true" />
                  </button>
                </h3>
                <div class="tui-preview tui-summary-scroll">
                  <dl class="tui-overview">
                    <div><dt>{{ t('started') }}</dt><TrajectoryTimestamp :timestamp="requestStartedAt()" :t="t" /></div>
                  <div v-if="requestAnchor.timestampKind === 'observation'"><dt>{{ t('recordedAt') }}</dt><TrajectoryTimestamp :timestamp="requestAnchor.startedAt" :t="t" /></div>
                    <div><dt>{{ t('totalDuration') }}</dt><dd>{{ requestTotalLabel() }}</dd></div>
                    <div><dt>{{ t('ttft') }}</dt><dd>{{ requestTtftLabel() }}</dd></div>
                    <div><dt>{{ t('generation') }}</dt><dd>{{ requestGenerationLabel() }}</dd></div>
                    <div><dt>{{ t('throughput') }}</dt><dd>{{ requestThroughputLabel() }}</dd></div>
                  </dl>
                </div>
              </section>
            </template>

            <template v-else>
              <section v-if="program || hasDetail(record.input)" class="tui-overview-section">
                <h3><button type="button" @click="activateTab(program ? 'code' : 'payload')">{{ program ? t('code') : t('payload') }} <span class="i-codicon-chevron-right" aria-hidden="true" /></button></h3>
                <div class="tui-preview tui-summary-scroll">
                  <slot name="input" :record="record" :value="record.input">
                    <TrajectoryCode v-if="program" :key="record.id" :program="program" preview :t="t" />
                    <pre v-else class="tui-payload tui-payload--preview">{{ formatValue(record.input) }}</pre>
                  </slot>
                </div>
              </section>
              <section v-if="hasDetail(record.output)" class="tui-overview-section">
                <h3><button type="button" @click="activateTab('result')">{{ t('result') }} <span class="i-codicon-chevron-right" aria-hidden="true" /></button></h3>
                <div class="tui-preview tui-summary-scroll" :class="{ 'is-error': recordStatus(record) === 'error' }">
                  <slot name="output" :record="record" :value="record.output">
                    <pre class="tui-payload tui-payload--preview">{{ formatValue(resultValue) }}</pre>
                  </slot>
                </div>
              </section>
              <section class="tui-overview-section">
                <h3><button type="button" @click="activateTab('schema')">{{ t('schema') }} <span class="i-codicon-chevron-right" aria-hidden="true" /></button></h3>
                <div class="tui-preview tui-summary-scroll">
                  <TrajectoryToolSchema v-if="record.schema !== undefined" :schema="record.schema" preview :t="t" />
                  <p v-else class="tui-no-payload">{{ t('schemaUnavailable') }}</p>
                </div>
              </section>
              <section class="tui-overview-section">
                <h3><button type="button" @click="activateTab('timing')">{{ t('timing') }} <span class="i-codicon-chevron-right" aria-hidden="true" /></button></h3>
                <div class="tui-preview tui-summary-scroll">
                  <dl class="tui-overview">
                    <div><dt>{{ t(record.timestampKind === 'observation' ? 'recordedAt' : 'started') }}</dt><TrajectoryTimestamp :timestamp="record.startedAt" :t="t" /></div>
                    <div v-if="record.resultObservedAt != null"><dt>{{ t('resultRecordedAt') }}</dt><TrajectoryTimestamp :timestamp="record.resultObservedAt" :t="t" /></div>
                    <TrajectoryTimingEstimate :estimate="timingEstimates.get(record.id)" :t="t" />
                    <div><dt>{{ t('durationValue') }}</dt><dd>{{ record.timestampKind === 'observation' && record.durationMs == null ? t('notRecorded') : formatDuration(record.durationMs) }}</dd></div>
                    <div><dt>{{ t('timingSource') }}</dt><dd>{{ record.timestampKind === 'observation' ? t('observationTimestamps') : record.durationMs == null ? t('notAvailable') : t('sessionTimestamps') }}</dd></div>
                  </dl>
                </div>
              </section>
            </template>
          </div>
        </template>
      </template>

      <TrajectoryCode v-else-if="activeTab === 'code' && program" :key="record.id" :program="program" :t="t" />
      <TrajectoryValue v-else-if="activeTab === 'options'" :value="requestDetails?.options" :t="t" />
      <div v-else-if="activeTab === 'usage'" class="tui-usage-panel">
        <section>
          <h3>{{ t('thisRequest') }}</h3>
          <TrajectoryUsage :usage="requestUsage" :t="t" />
        </section>
        <section>
          <h3>{{ t('sessionCumulative') }}</h3>
          <TrajectoryUsage :usage="requestCumulativeUsage" :t="t" />
        </section>
      </div>
      <template v-else-if="activeTab === 'preview'">
        <TrajectoryRecordPreview
          :record="record"
          :child-tools="childTools"
          :preview="false"
          :thinking-expanded="thinkingExpanded"
          :t="t"
          @update:thinking-expanded="thinkingExpanded = $event"
          @select="openRecordSummary"
        >
          <template v-if="slots.input" #input="scope"><slot name="input" v-bind="scope" /></template>
          <template v-if="slots.output" #output="scope"><slot name="output" v-bind="scope" /></template>
          <template v-if="slots.reasoning" #reasoning="scope"><slot name="reasoning" v-bind="scope" /></template>
        </TrajectoryRecordPreview>
      </template>
      <div v-else-if="activeTab === 'raw' && rawBlocks.length > 0" class="tui-source-blocks">
        <template v-for="(block, index) in rawBlocks" :key="`${block.type}:${block.callId ?? index}`">
          <details v-if="isAttachmentBlock(block)" class="tui-attachment-disclosure">
            <summary>{{ sourceBlockLabel(block, index) }}<span v-if="block.attachment?.name" :title="String(block.attachment.name)"> · {{ block.attachment.name }}</span></summary>
            <pre>{{ formatValue(block.original ?? block) }}</pre>
          </details>
          <section v-else>
            <header>
              <button v-if="sourceBlockTool(block)" type="button" :title="t('openToolCallSummary')" @click="openSourceBlock(block)">
                {{ sourceBlockLabel(block, index) }}<span class="i-codicon-chevron-right" aria-hidden="true" />
              </button>
              <span v-else>{{ sourceBlockLabel(block, index) }}</span>
            </header>
            <pre>{{ block.content ?? formatValue(block.input ?? block.original) }}</pre>
          </section>
        </template>
      </div>
      <pre v-else-if="activeTab === 'raw'" class="tui-payload">{{ rawContent || t('noContent') }}</pre>
      <pre v-else-if="activeTab === 'source'" class="tui-payload">{{ formatValue(record.source) || t('noSource') }}</pre>
      <pre v-else-if="activeTab === 'payload'" class="tui-payload">{{ record.inputRaw ?? (formatValue(record.input) || t('noPayload')) }}</pre>
      <div v-else-if="activeTab === 'result'" class="tui-result-content">
        <section v-if="isToolRecord(record)">
          <h3>{{ t('rawResult') }}</h3>
          <TrajectoryValue v-if="liveResult !== undefined" :key="`live:${record.id}`" :value="liveResult" :t="t" />
          <p v-else class="tui-no-payload">{{ t(recordStatus(record) === 'running' ? 'toolRunning' : 'rawResultUnavailable') }}</p>
        </section>
        <section>
          <h3 v-if="isToolRecord(record)">{{ t('renderedResult') }}</h3>
          <TrajectoryValue :key="record.id" :value="resultValue === undefined ? t('noResult') : resultValue" :t="t" :class="{ 'is-error': recordStatus(record) === 'error' }" />
          <TrajectoryAttachments :blocks="record.outputBlocks" :t="t" />
        </section>
      </div>
      <template v-else-if="activeTab === 'schema'">
        <TrajectoryToolSchema v-if="record.schema !== undefined" :schema="record.schema" :t="t" />
        <p v-else class="tui-no-payload">{{ t('schemaUnavailable') }}</p>
      </template>
      <dl v-else-if="activeTab === 'timing'" class="tui-overview tui-overview--standalone">
        <div><dt>{{ t(!request && record.timestampKind === 'observation' ? 'recordedAt' : 'started') }}</dt><TrajectoryTimestamp :timestamp="request ? requestStartedAt() : record.startedAt" :t="t" /></div>
        <div v-if="request && requestAnchor.timestampKind === 'observation'"><dt>{{ t('recordedAt') }}</dt><TrajectoryTimestamp :timestamp="requestAnchor.startedAt" :t="t" /></div>
        <div v-if="!request && record.resultObservedAt != null"><dt>{{ t('resultRecordedAt') }}</dt><TrajectoryTimestamp :timestamp="record.resultObservedAt" :t="t" /></div>
        <TrajectoryTimingEstimate :estimate="request ? requestTimingEstimate : timingEstimates.get(record.id)" :t="t" />
        <template v-if="request">
          <div><dt>{{ t('totalDuration') }}</dt><dd>{{ requestTotalLabel() }}</dd></div>
          <div><dt>{{ t('ttft') }}</dt><dd>{{ requestTtftLabel() }}</dd></div>
          <div><dt>{{ t('generation') }}</dt><dd>{{ requestGenerationLabel() }}</dd></div>
          <div><dt>{{ t('throughput') }}</dt><dd>{{ requestThroughputLabel() }}</dd></div>
        </template>
        <template v-else>
          <div><dt>{{ t('durationValue') }}</dt><dd>{{ record.timestampKind === 'observation' && record.durationMs == null ? t('notRecorded') : formatDuration(record.durationMs) }}</dd></div>
          <div><dt>{{ t('timingSource') }}</dt><dd>{{ record.timestampKind === 'observation' ? t('observationTimestamps') : record.durationMs == null ? t('notAvailable') : t('sessionTimestamps') }}</dd></div>
        </template>
      </dl>
      <TrajectoryPromptDiff
        v-else-if="activeTab === 'diff'"
        :before="record.previousInput"
        :after="record.input"
        :before-tools="record.previousTools"
        :after-tools="record.tools"
        :t="t"
      />
      <template v-else-if="activeTab === 'systemPrompt'">
        <TrajectoryMarkdown v-if="typeof record.input === 'string' && record.input !== ''" :value="record.input" :preview="false" :t="t" />
        <pre v-else-if="hasDetail(record.input)" class="tui-payload">{{ formatValue(record.input) }}</pre>
        <p v-else class="tui-no-payload">{{ t('systemPromptMissing') }}</p>
      </template>
      <template v-else-if="activeTab === 'tools'">
        <TrajectoryToolCatalog :tools="promptTools" :t="t" />
      </template>
    </div>
  </aside>
</template>
