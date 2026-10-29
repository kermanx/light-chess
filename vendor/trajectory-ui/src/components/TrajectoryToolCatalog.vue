<script setup lang="ts">
import { formatValue } from '../format'
import type { MessageKey } from '../i18n'
import type { TrajectoryToolDefinition } from '../types'

defineProps<{
  tools: readonly TrajectoryToolDefinition[]
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()
</script>

<template>
  <div v-if="tools.length > 0" class="tui-tool-catalog">
    <details v-for="(tool, index) in tools" :key="`${tool.name}:${index}`">
      <summary>
        <span class="i-codicon-chevron-right tui-tool-catalog__chevron" aria-hidden="true" />
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
        <span class="tui-tool-catalog__name">{{ tool.name }}</span>
        <span class="tui-tool-catalog__description">{{ tool.description }}</span>
      </summary>
      <div class="tui-tool-catalog__definition">
        <p v-if="tool.description">{{ tool.description }}</p>
        <pre class="tui-payload">{{ formatValue(tool.parameters) }}</pre>
      </div>
    </details>
  </div>
  <p v-else class="tui-no-payload">{{ t('toolsMissing') }}</p>
</template>
