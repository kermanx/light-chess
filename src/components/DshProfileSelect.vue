<script setup lang="ts">
import { defaultDshProfileId, dshProfiles, findDshProfile } from '../ai/config'
defineProps<{ modelValue?: string; label: string }>()
defineEmits<{ 'update:modelValue': [id: string] }>()
</script>

<template>
  <label class="llm-select">
    <span>{{ label }}</span>
    <select :value="modelValue || defaultDshProfileId()" :aria-label="label" @change="$emit('update:modelValue', ($event.target as HTMLSelectElement).value)">
      <option v-if="!dshProfiles.length" value="" disabled>请先添加 LLM 配置</option>
      <option v-else-if="modelValue && !findDshProfile(modelValue)" :value="modelValue" disabled>原配置已删除，请重新选择</option>
      <option v-for="profile in dshProfiles" :key="profile.id" :value="profile.id">{{ profile.name }} · {{ profile.model }}{{ profile.apiKey ? '' : '（需填写 Key）' }}</option>
    </select>
  </label>
</template>

<style scoped>
.llm-select { display: flex; flex-direction: column; gap: 5px; min-width: 0; font-size: 12px; color: #756952; }
select { width: 100%; min-width: 0; max-width: 100%; padding: 8px 9px; border: 1px solid #b5a98f; border-radius: 7px; background: #fffdf7; font: inherit; color: #35301f; text-overflow: ellipsis; }
select:focus-visible { outline: 2px solid #2f6fed; outline-offset: 2px; }
</style>
