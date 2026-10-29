<script setup lang="ts">
import { computed } from 'vue'
import { formatValue } from '../format'
import type { MessageKey } from '../i18n'

type DiffKind = 'context' | 'added' | 'removed'
interface DiffLine { kind: DiffKind; text: string }

const props = defineProps<{
  before: unknown
  after: unknown
  beforeTools?: unknown
  afterTools?: unknown
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

function diffLines(beforeValue: unknown, afterValue: unknown): readonly DiffLine[] {
  const before = formatValue(beforeValue).split('\n')
  const after = formatValue(afterValue).split('\n')
  let prefix = 0
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++
  let suffix = 0
  while (
    suffix < before.length - prefix
    && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) suffix++
  const leading = before.slice(Math.max(0, prefix - 3), prefix)
  const trailing = suffix === 0 ? [] : before.slice(before.length - Math.min(3, suffix))
  return [
    ...leading.map(text => ({ kind: 'context' as const, text: ` ${text}` })),
    ...before.slice(prefix, before.length - suffix).map(text => ({ kind: 'removed' as const, text: `-${text}` })),
    ...after.slice(prefix, after.length - suffix).map(text => ({ kind: 'added' as const, text: `+${text}` })),
    ...trailing.map(text => ({ kind: 'context' as const, text: ` ${text}` })),
  ]
}

const sections = computed(() => [
  ...(props.before === undefined || formatValue(props.before) === formatValue(props.after) ? [] : [{
    title: props.t('systemPrompt'),
    lines: diffLines(props.before, props.after),
  }]),
  ...(props.beforeTools === undefined || formatValue(props.beforeTools) === formatValue(props.afterTools) ? [] : [{
    title: props.t('tools'),
    lines: diffLines(props.beforeTools, props.afterTools),
  }]),
])
</script>

<template>
  <div class="tui-prompt-diff">
    <section v-for="section in sections" :key="section.title">
      <h3>{{ section.title }}</h3>
      <pre><span class="is-meta">@@</span><span v-for="(line, index) in section.lines" :key="index" :class="`is-${line.kind}`">{{ line.text }}
</span></pre>
    </section>
  </div>
</template>
