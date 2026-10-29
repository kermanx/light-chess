<script setup lang="ts">
import { ref } from 'vue'
import { formatClock } from '../format'
import type { MessageKey } from '../i18n'

const props = defineProps<{
  timestamp: number | null | undefined
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const showUnix = ref(false)
</script>

<template>
  <dd v-if="timestamp == null || !Number.isFinite(timestamp)">{{ t('notAvailable') }}</dd>
  <dd v-else>
    <button
      type="button"
      class="tui-timestamp-toggle"
      :title="showUnix ? t('showLocalTime') : t('showUnixTimestamp')"
      @click="showUnix = !showUnix"
    >{{ showUnix ? (timestamp / 1_000).toFixed(3) : formatClock(timestamp) }}</button>
  </dd>
</template>
