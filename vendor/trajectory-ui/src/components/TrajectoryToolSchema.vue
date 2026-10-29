<script setup lang="ts">
import { computed } from 'vue'
import { formatValue } from '../format'
import type { MessageKey } from '../i18n'

interface ParsedToolSchema {
  name: string
  description: string
  parameters: unknown
}

const props = defineProps<{
  schema: unknown
  preview?: boolean
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const parsed = computed<ParsedToolSchema | undefined>(() => {
  let value = props.schema
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const candidate = value as Record<string, unknown>
  if (typeof candidate.name !== 'string' || typeof candidate.description !== 'string') return undefined
  if (typeof candidate.parameters !== 'object' || candidate.parameters === null) return undefined
  return {
    name: candidate.name,
    description: candidate.description,
    parameters: candidate.parameters,
  }
})
</script>

<template>
  <div v-if="parsed" class="tui-schema" :class="{ 'is-preview': preview }">
    <header class="tui-schema__intro">
      <h3>{{ parsed.name }}</h3>
      <p>{{ parsed.description }}</p>
    </header>
    <section class="tui-schema__parameters">
      <h4>{{ t('parameters') }}</h4>
      <pre class="tui-payload" :class="{ 'tui-payload--preview': preview }">{{ formatValue(parsed.parameters) }}</pre>
    </section>
  </div>
  <pre v-else class="tui-payload" :class="{ 'tui-payload--preview': preview }">{{ formatValue(schema) }}</pre>
</template>
