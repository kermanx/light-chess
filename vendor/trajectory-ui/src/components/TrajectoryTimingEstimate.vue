<script setup lang="ts">
import { formatClock, formatDuration } from '../format'
import type { MessageKey } from '../i18n'
import type { TrajectoryTimingEstimate } from '../timing-estimates'

defineProps<{
  estimate: TrajectoryTimingEstimate | undefined
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()
</script>

<template>
  <template v-if="estimate !== undefined">
    <div><dt>{{ t('estimatedDuration') }}</dt><dd :title="`${formatClock(estimate.start)} → ${formatClock(estimate.end)}`">≈ {{ formatDuration(estimate.end - estimate.start) }}</dd></div>
    <div><dt>{{ t('estimateBasis') }}</dt><dd :title="t('estimateTimingHint')">{{ t(estimate.basis === 'call-result' ? 'estimateCallResult' : 'estimatePrecedingEvent') }}</dd></div>
  </template>
</template>
