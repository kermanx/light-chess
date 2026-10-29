<script setup lang="ts">
import { codeToHtml } from 'shiki'
import { computed, ref, watch } from 'vue'
import type { TrajectoryCodeProgram } from '../code-program'
import type { MessageKey } from '../i18n'

const props = defineProps<{
  program: TrajectoryCodeProgram
  preview?: boolean
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()
const raw = ref(false)
const wrapping = ref(readWrapping())
const copied = ref(false)
const copyFailed = ref(false)
const html = ref('')
const text = computed(() => raw.value ? props.program.rawInput : props.program.source)
let generation = 0
function readWrapping(): boolean {
  try { return globalThis.localStorage?.getItem('trajectory-ui.codeWrapping') === 'true' } catch { return false }
}
function toggleWrapping() {
  wrapping.value = !wrapping.value
  try { globalThis.localStorage?.setItem('trajectory-ui.codeWrapping', String(wrapping.value)) } catch { /* Viewing still works without storage. */ }
}
watch([text, () => props.program.language], async () => {
  const current = ++generation
  html.value = ''; copied.value = false; copyFailed.value = false
  try {
    const result = await codeToHtml(text.value, { lang: raw.value ? 'json' : props.program.language ?? 'text', themes: { light: 'github-light', dark: 'github-dark' } })
    if (generation === current) html.value = result
  } catch { /* Keep the exact plain source when highlighting is unavailable. */ }
}, { immediate: true })
async function copy() {
  try { await navigator.clipboard.writeText(text.value); copied.value = true; copyFailed.value = false }
  catch { copyFailed.value = true }
}
</script>

<template>
  <div class="tui-program" :class="{ 'is-wrapped': preview || wrapping, 'is-preview': preview }">
    <div v-if="!preview" class="tui-program__toolbar">
      <span>{{ raw ? t('rawArguments') : program.language ?? t('code') }}</span>
      <button type="button" :aria-pressed="wrapping" @click="toggleWrapping">{{ t('wrapLines') }}</button>
      <button type="button" :aria-label="t('rawArguments')" :title="t('rawArguments')" :aria-pressed="raw" @click="raw = !raw">{}</button>
      <button type="button" @click="copy">{{ copied ? t('copied') : t('copy') }}</button>
      <span v-if="copyFailed" role="status">{{ t('copyFailed') }}</span>
    </div>
    <div v-if="html" class="tui-program__source" v-html="html" />
    <pre v-else class="tui-program__plain">{{ text }}</pre>
  </div>
</template>
