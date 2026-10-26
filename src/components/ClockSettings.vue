<script setup lang="ts">
import { normalizeClockSettings, type ClockSettings } from '../clock'
const props = defineProps<{ settings: ClockSettings; disabled?: boolean }>()
const emit = defineEmits<{ change: [settings: ClockSettings] }>()
function change(field: keyof ClockSettings, event: Event) {
  const input = event.target as HTMLInputElement
  if (field !== 'enabled' && !Number.isFinite(input.valueAsNumber)) return
  emit('change', normalizeClockSettings({
    ...props.settings,
    [field]: field === 'enabled' ? input.checked : input.valueAsNumber * (field === 'initialMs' ? 60_000 : 1000),
  }))
}
</script>

<template>
  <fieldset class="clock-settings" :disabled="disabled">
    <label class="clock-enable">
      <input type="checkbox" :checked="settings.enabled" @change="change('enabled', $event)" />
      棋钟（开局前设置）
    </label>
    <div v-if="settings.enabled" class="clock-options">
      <label>每人
        <input aria-label="每人用时（分钟）" type="number" min="0.5" max="180" step="0.5"
          :value="settings.initialMs / 60000" @change="change('initialMs', $event)" /> 分钟
      </label>
      <label>每步加
        <input aria-label="每步加秒" type="number" min="0" max="120" step="1"
          :value="settings.incrementMs / 1000" @change="change('incrementMs', $event)" /> 秒
      </label>
    </div>
  </fieldset>
</template>

<style scoped>
.clock-settings { border: 0; margin: 0; padding: 0; min-width: 0; font: inherit; }
.clock-enable { display: flex; align-items: center; gap: 7px; cursor: pointer; }
.clock-options { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; margin-top: 7px; font-size: 13px; }
.clock-options label { display: flex; align-items: center; gap: 4px; }
.clock-options input { width: 51px; padding: 2px 3px; border: 1px solid #9e9278; border-radius: 4px; background: #fffaf0; font: inherit; color: inherit; }
.clock-settings:disabled input { opacity: .75; }
</style>
