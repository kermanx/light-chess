<script setup lang="ts">
import { computed, ref } from 'vue'
import { formatValue } from '../format'
import type { MessageKey } from '../i18n'
import TrajectoryJsonNode from './TrajectoryJsonNode.vue'
const props = defineProps<{
  value: unknown
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()
const raw = ref(false)
const structured = computed(() => {
  let value = props.value
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return undefined }
  }
  return typeof value === 'object' && value !== null ? value : undefined
})
</script>

<template>
  <div v-if="structured !== undefined" class="tui-json-value">
    <button type="button" class="tui-json-value__raw" :aria-pressed="raw" @click="raw = !raw">{{ t('raw') }}</button>
    <pre v-if="raw" class="tui-payload">{{ formatValue(value) }}</pre>
    <TrajectoryJsonNode v-else :value="structured" :t="t" />
  </div>
  <pre v-else class="tui-payload">{{ formatValue(value) }}</pre>
</template>
