<script setup lang="ts">
import { computed, ref } from 'vue'
import type { MessageKey } from '../i18n'
const props = withDefaults(defineProps<{
  value: unknown
  label?: string
  depth?: number
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>(), { depth: 0 })
const entries = computed(() => typeof props.value === 'object' && props.value !== null ? Object.entries(props.value) : null)
const wrapping = ref(false)
const expanded = ref(false)
const stringPreview = computed(() => typeof props.value === 'string' ? props.value.split('\n').slice(0, 12).join('\n') : '')
const encoded = computed(() => JSON.stringify(props.value))
function toggle(event: Event) {
  const open = (event.target as HTMLDetailsElement).open
  if (open && !expanded.value) {
    try { wrapping.value = globalThis.localStorage?.getItem('trajectory-ui.jsonStringWrapping') === 'true' } catch { wrapping.value = false }
  }
  expanded.value = open
}
function toggleWrapping() {
  wrapping.value = !wrapping.value
  try { globalThis.localStorage?.setItem('trajectory-ui.jsonStringWrapping', String(wrapping.value)) } catch { /* Keep the local viewing preference. */ }
}
</script>

<template>
  <details v-if="entries && depth < 64" class="tui-json-node" :open="depth === 0">
    <summary><span v-if="label !== undefined">{{ label }}: </span>{{ Array.isArray(value) ? '[' : '{' }} {{ entries.length }} {{ Array.isArray(value) ? ']' : '}' }}</summary>
    <div class="tui-json-node__children">
      <TrajectoryJsonNode v-for="[key, item] in entries" :key="key" :label="key" :value="item" :depth="depth + 1" :t="t" />
    </div>
  </details>
  <details v-else-if="typeof value === 'string'" class="tui-json-node" @toggle="toggle">
    <summary class="tui-json-string-preview"><span v-if="label !== undefined">{{ label }}: </span>{{ stringPreview }}</summary>
    <button type="button" :aria-pressed="wrapping" @click="toggleWrapping">{{ t('wrapLines') }}</button>
    <pre :class="{ 'is-wrapped': wrapping }">{{ value }}</pre>
  </details>
  <div v-else class="tui-json-node"><span v-if="label !== undefined">{{ label }}: </span>{{ encoded }}</div>
</template>
