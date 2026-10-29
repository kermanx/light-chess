<script setup lang="ts">
import type { MessageKey } from '../i18n'

defineProps<{
  actualDuration: boolean
  allTurnsCollapsed: boolean
  allCallsCollapsed: boolean
  searchQuery: string
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const emit = defineEmits<{
  'update:actualDuration': [value: boolean]
  'update:searchQuery': [value: string]
  toggleTurns: []
  toggleCalls: []
}>()
</script>

<template>
  <div class="tui-toolbar" role="toolbar" :aria-label="t('trajectoryToolbar')">
    <div class="tui-toolbar__actions">
      <button
        type="button"
        class="tui-toolbar__button"
        :aria-label="t('useActualDuration')"
        :aria-pressed="actualDuration"
        :title="t(actualDuration ? 'useEqualDuration' : 'useActualDuration')"
        @click="emit('update:actualDuration', !actualDuration)"
      >
        <svg class="tui-toolbar__icon tui-toolbar__clock" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="5.25" />
          <path d="M8 4.75V8l2.25 1.5" />
        </svg>
        {{ t('duration') }}
      </button>
      <button
        type="button"
        class="tui-toolbar__button"
        :aria-label="t(allTurnsCollapsed ? 'expandTurns' : 'collapseTurns')"
        :aria-pressed="allTurnsCollapsed"
        :title="t(allTurnsCollapsed ? 'expandTurns' : 'collapseTurns')"
        @click="emit('toggleTurns')"
      >
        <span class="tui-toolbar__fold" aria-hidden="true">{{ allTurnsCollapsed ? '⊞' : '⊟' }}</span>
        {{ t('turns') }}
      </button>
      <button
        type="button"
        class="tui-toolbar__button"
        :aria-label="t(allCallsCollapsed ? 'expandCalls' : 'collapseCalls')"
        :aria-pressed="allCallsCollapsed"
        :title="t(allCallsCollapsed ? 'expandCalls' : 'collapseCalls')"
        @click="emit('toggleCalls')"
      >
        <span class="tui-toolbar__fold" aria-hidden="true">{{ allCallsCollapsed ? '⊞' : '⊟' }}</span>
        {{ t('calls') }}
      </button>
    </div>
    <label class="tui-search">
      <span class="i-codicon-search tui-search__icon" aria-hidden="true" />
      <input
        type="search"
        class="tui-search__input"
        :aria-label="t('searchTrajectory')"
        :placeholder="t('search')"
        :value="searchQuery"
        @input="emit('update:searchQuery', ($event.currentTarget as HTMLInputElement).value)"
      />
    </label>
  </div>
</template>
