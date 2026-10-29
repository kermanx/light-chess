<script setup lang="ts">
import { computed } from 'vue'
import { toolChangeSummary } from '../content'
import { formatValue } from '../format'
import type { MessageKey } from '../i18n'
import type { TrajectoryRecord } from '../types'
import TrajectoryMarkdown from './TrajectoryMarkdown.vue'
import TrajectoryAttachments from './TrajectoryAttachments.vue'

const props = defineProps<{
  record: TrajectoryRecord
  childTools: readonly TrajectoryRecord[]
  preview: boolean
  thinkingExpanded: boolean
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const emit = defineEmits<{
  'update:thinkingExpanded': [expanded: boolean]
  select: [record: TrajectoryRecord]
}>()

const proseValue = computed(() => props.record.kind === 'compacted'
  ? props.record.output
  : props.record.input)

const toolCalls = computed(() => {
  const blocks = (props.record.sourceBlocks ?? []).filter(block => block.type === 'tool-call')
  if (blocks.length > 0) {
    return blocks.map((block, index) => ({
      key: block.callId ?? `${block.toolName ?? 'tool'}:${index}`,
      name: block.toolName ?? props.t('toolCall'),
      payload: block.content || (block.input === undefined ? null : formatValue(block.input)),
      record: block.callId === undefined
        ? undefined
        : props.childTools.find(tool => tool.callId === block.callId),
    }))
  }
  return props.childTools.map(tool => ({
    key: tool.id,
    ...toolParts(tool),
    record: tool,
  }))
})

function toolParts(record: TrajectoryRecord): { name: string; payload: string | null } {
  const separator = record.summary.indexOf(' · ')
  const fallbackName = separator === -1 ? record.summary : record.summary.slice(0, separator)
  const payload = record.input === undefined
    ? (separator === -1 ? null : record.summary.slice(separator + 3))
    : formatValue(record.input)
  return { name: record.toolName ?? fallbackName, payload: payload === '' ? null : payload }
}

function hasValue(value: unknown): boolean {
  return value !== undefined && (typeof value !== 'string' || value !== '')
}
</script>

<template>
  <div
    v-if="record.kind === 'assistant'"
    class="tui-assistant-content"
    :class="{ 'is-preview': preview }"
  >
    <div
      v-if="record.reasoning"
      class="tui-thinking-quote"
      :class="{ 'is-only-preview': preview && !hasValue(record.output) }"
    >
      <button
        type="button"
        class="tui-thinking-toggle"
        :aria-expanded="thinkingExpanded"
        @click="emit('update:thinkingExpanded', !thinkingExpanded)"
      >
        {{ t('thinking') }}
        <span class="i-codicon-chevron-right tui-thinking-chevron" aria-hidden="true" />
      </button>
      <div v-if="thinkingExpanded" class="tui-thinking-content">
        <slot name="reasoning" :record="record" :value="record.reasoning">
          <TrajectoryMarkdown :value="record.reasoning" :preview="preview" :t="t" />
        </slot>
      </div>
    </div>

    <div v-if="hasValue(record.output)" class="tui-assistant-output">
      <slot name="output" :record="record" :value="record.output">
        <TrajectoryMarkdown
          v-if="typeof record.output === 'string'"
          :value="record.output"
          :preview="preview"
          :t="t"
        />
        <pre
          v-else
          class="tui-payload"
          :class="{ 'tui-payload--preview': preview }"
        >{{ formatValue(record.output) }}</pre>
      </slot>
    </div>

    <ul
      v-if="toolCalls.length > 0"
      class="tui-assistant-tools"
      :class="{ 'is-preview': preview }"
    >
      <li v-for="tool in toolCalls" :key="tool.key">
        <button type="button" :class="{ 'is-static': tool.record === undefined }" @click="tool.record && emit('select', tool.record)">
          <svg
            class="tui-assistant-tools__icon"
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          <span class="tui-assistant-tools__text">
            <span class="tui-assistant-tools__name">{{ tool.name || t('toolCall') }}</span>
            <span v-if="tool.payload" class="tui-assistant-tools__payload">
              {{ tool.payload }}
            </span>
          </span>
        </button>
      </li>
    </ul>

    <TrajectoryAttachments :blocks="record.toolChanges ? undefined : record.sourceBlocks" :t="t" />

    <p
      v-if="!record.reasoning && !hasValue(record.output) && toolCalls.length === 0 && !(record.sourceBlocks?.some(block => block.type === 'image' || block.original !== undefined)) && record.summary"
      class="tui-no-payload"
    >{{ record.summary }}</p>
    <p
      v-else-if="!record.reasoning && !hasValue(record.output) && toolCalls.length === 0 && !(record.sourceBlocks?.some(block => block.type === 'image' || block.original !== undefined))"
      class="tui-no-payload"
    >{{ t('noContent') }}</p>
  </div>

  <div v-else class="tui-message-content">
    <slot
      v-if="record.kind === 'user' || record.kind === 'context'"
      name="input"
      :record="record"
      :value="record.input"
    >
      <div v-if="record.toolChanges" class="tui-tool-changes">
        <p>{{ toolChangeSummary(record, t) }}</p>
        <template v-if="record.toolChanges.added.length + record.toolChanges.removed.length > 1">
          <p v-if="record.toolChanges.added.length">{{ t('toolsAdded', { names: record.toolChanges.added.join(', ') }) }}</p>
          <p v-if="record.toolChanges.removed.length">{{ t('toolsRemoved', { names: record.toolChanges.removed.join(', ') }) }}</p>
        </template>
      </div>
      <TrajectoryMarkdown
        v-else-if="typeof proseValue === 'string' && proseValue !== ''"
        :value="proseValue"
        :preview="preview"
        :t="t"
      />
      <pre
        v-else-if="hasValue(proseValue)"
        class="tui-payload"
        :class="{ 'tui-payload--preview': preview }"
      >{{ formatValue(proseValue) }}</pre>
      <p v-else-if="!(record.sourceBlocks?.some(block => block.type === 'image' || block.original !== undefined))" class="tui-no-payload">{{ record.summary || t('noContent') }}</p>
    </slot>

    <slot
      v-if="record.kind !== 'user' && record.kind !== 'context'"
      name="output"
      :record="record"
      :value="record.output"
    >
      <TrajectoryMarkdown
        v-if="typeof proseValue === 'string' && proseValue !== ''"
        :value="proseValue"
        :preview="preview"
        :t="t"
      />
      <pre
        v-else-if="hasValue(proseValue)"
        class="tui-payload"
        :class="{ 'tui-payload--preview': preview }"
      >{{ formatValue(proseValue) }}</pre>
      <p v-else class="tui-no-payload">{{ record.summary || t('noContent') }}</p>
    </slot>
    <TrajectoryAttachments :blocks="record.toolChanges ? undefined : record.sourceBlocks" :t="t" />
  </div>
</template>
