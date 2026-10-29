<script setup lang="ts">
import { computed } from 'vue'
import type { MessageKey } from '../i18n'
import type { TrajectoryUsage } from '../types'

const props = defineProps<{
  usage?: TrajectoryUsage
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const inputTotal = computed(() => {
  if (props.usage === undefined) return undefined
  const values = [props.usage.input, props.usage.cacheRead, props.usage.cacheWrite]
    .filter((value): value is number => value !== undefined)
  return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0)
})
const content = computed(() => props.usage?.output === undefined
  ? undefined
  : Math.max(0, props.usage.output - (props.usage.reasoning ?? 0)))

function tokens(value: number | undefined): string {
  return value === undefined
    ? '—'
    : props.t('tokenValue', { value: value.toLocaleString() })
}
</script>

<template>
  <p v-if="usage === undefined" class="tui-no-payload">{{ t('usageNotReported') }}</p>
  <dl v-else class="tui-overview tui-usage-rows">
    <div v-if="inputTotal !== undefined"><dt>{{ t('inputTokens') }}</dt><dd>{{ tokens(inputTotal) }}</dd></div>
    <div v-if="usage.cacheRead !== undefined" class="tui-overview__detail">
      <dt>{{ t('cachedTokens') }}</dt><dd>{{ tokens(usage.cacheRead) }}</dd>
    </div>
    <div v-if="usage.cacheWrite !== undefined" class="tui-overview__detail">
      <dt>{{ t('cacheCreatedTokens') }}</dt><dd>{{ tokens(usage.cacheWrite) }}</dd>
    </div>
    <div v-if="usage.input !== undefined" class="tui-overview__detail">
      <dt>{{ t('otherTokens') }}</dt><dd>{{ tokens(usage.input) }}</dd>
    </div>
    <div v-if="usage.output !== undefined"><dt>{{ t('outputTokens') }}</dt><dd>{{ tokens(usage.output) }}</dd></div>
    <div v-if="usage.reasoning !== undefined" class="tui-overview__detail">
      <dt>{{ t('reasoningTokens') }}</dt><dd>{{ tokens(usage.reasoning) }}</dd>
    </div>
    <div v-if="content !== undefined" class="tui-overview__detail">
      <dt>{{ t('contentTokens') }}</dt><dd>{{ tokens(content) }}</dd>
    </div>
  </dl>
</template>
