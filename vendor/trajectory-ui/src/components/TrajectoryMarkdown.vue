<script setup lang="ts">
import 'katex/dist/katex.min.css'
import MarkdownIt from 'markdown-it'
import markdownItFootnote from 'markdown-it-footnote'
import markdownItKatex from 'markdown-it-katex'
import { codeToHtml } from 'shiki'
import { onBeforeUnmount, ref, watch } from 'vue'
import type { MessageKey } from '../i18n'

const props = defineProps<{
  value: string
  preview: boolean
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()

const highlighted = new Map<string, string>()
const rendered = ref('')
let generation = 0
let copiedTimer: ReturnType<typeof setTimeout> | undefined

function fenceKey(code: string, language: string): string {
  return `${language}\u0000${code}`
}

const markdown = new MarkdownIt({
  breaks: false,
  html: false,
  linkify: true,
  typographer: false,
})
  .use(markdownItFootnote)
  .use(markdownItKatex, { throwOnError: false, strict: 'ignore' })

function linkProtocol(url: string): string | undefined {
  // Files belong to the owning workspace. This standalone view has no file opener.
  if (/^(?:[\\/]|\.{1,2}[\\/]|[a-z]:[\\/])/i.test(url)) return undefined
  try {
    const protocol = new URL(url).protocol
    return ['javascript:', 'vbscript:', 'data:', 'blob:'].includes(protocol) ? undefined : protocol
  } catch {
    return undefined
  }
}

// Parse labels even for unavailable destinations, then render those labels inert.
markdown.validateLink = () => true
markdown.core.ruler.push('trajectory_links', state => {
  for (const block of state.tokens) {
    const links: boolean[] = []
    for (const token of block.children ?? []) {
      if (token.type === 'link_open') {
        const protocol = linkProtocol(token.attrGet('href') ?? '')
        token.hidden = protocol === undefined
        links.push(token.hidden)
        if (protocol === 'http:' || protocol === 'https:') {
          token.attrSet('target', '_blank')
          token.attrSet('rel', 'noopener noreferrer')
        }
      } else if (token.type === 'link_close') token.hidden = links.pop() ?? true
    }
  }
})
const renderImage = markdown.renderer.rules.image!
markdown.renderer.rules.image = (tokens, index, options, env, self) => {
  const token = tokens[index]!
  const protocol = linkProtocol(token.attrGet('src') ?? '')
  return protocol === 'http:' || protocol === 'https:'
    ? renderImage(tokens, index, options, env, self)
    : markdown.utils.escapeHtml(self.renderInlineAsText(token.children ?? [], options, env))
}

markdown.renderer.rules.footnote_block_open = () => (
  `<section class="footnotes"><h2 class="tui-visually-hidden">${markdown.utils.escapeHtml(props.t('footnotes'))}</h2><ol class="footnotes-list">`
)

markdown.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]
  if (token === undefined) return ''
  const language = token.info.trim().split(/\s+/, 1)[0] ?? ''
  const code = token.content.replace(/\n$/, '')
  const fallbackClass = language === '' ? '' : ` class="language-${markdown.utils.escapeHtml(language)}"`
  const body = highlighted.get(fenceKey(code, language))
    ?? `<pre class="shiki tui-code-plain"><code${fallbackClass}>${markdown.utils.escapeHtml(code)}</code></pre>`
  const languageLabel = markdown.utils.escapeHtml(language || 'text')
  return `<figure class="tui-code-block"><figcaption><span>${languageLabel}</span><button type="button" data-copy-code aria-label="${markdown.utils.escapeHtml(props.t('copy'))}">${markdown.utils.escapeHtml(props.t('copy'))}</button></figcaption>${body}</figure>`
}

function render() {
  rendered.value = markdown.render(props.value)
}

watch([() => props.value, () => props.t], async ([value]) => {
  const current = ++generation
  render()
  const tokens = markdown.parse(value, {})
  const fences = tokens.flatMap(token => token.type === 'fence' && token.content !== ''
    ? [{ code: token.content.replace(/\n$/, ''), language: token.info.trim().split(/\s+/, 1)[0] ?? '' }]
    : [])
  await Promise.all(fences.map(async ({ code, language }) => {
    const key = fenceKey(code, language)
    if (highlighted.has(key)) return
    try {
      const html = await codeToHtml(code, {
        lang: language || 'text',
        themes: { light: 'github-light', dark: 'github-dark' },
      })
      highlighted.set(key, html)
    } catch {
      highlighted.set(key, `<pre class="shiki tui-code-plain"><code>${markdown.utils.escapeHtml(code)}</code></pre>`)
    }
  }))
  if (current === generation) render()
}, { immediate: true })

function copyCode(event: MouseEvent) {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLButtonElement>('[data-copy-code]')
    : null
  if (target === null) return
  const code = target.closest('figure')?.querySelector('code')?.textContent ?? ''
  void navigator.clipboard.writeText(code).then(() => {
    target.textContent = props.t('copied')
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => { target.textContent = props.t('copy') }, 1_500)
  }).catch(() => undefined)
}

onBeforeUnmount(() => { clearTimeout(copiedTimer) })
</script>

<template>
  <div
    class="tui-markdown"
    :class="preview ? 'tui-markdown--preview' : 'tui-markdown--payload'"
    v-html="rendered"
    @click="copyCode"
  />
</template>
