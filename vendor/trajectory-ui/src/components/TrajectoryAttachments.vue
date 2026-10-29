<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { TrajectoryContentBlock } from '../types'
import type { MessageKey } from '../i18n'
import { formatValue } from '../format'
import { attachmentUrl, isAttachmentBlock } from '../content'
const props = defineProps<{
  blocks?: readonly TrajectoryContentBlock[]
  t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string
}>()
const entries = computed(() => {
  let images = 0
  let files = 0
  return (props.blocks ?? []).flatMap((block, index) => {
    if (!isAttachmentBlock(block)) return []
    const image = block.type === 'image'
    const number = image ? ++images : ++files
    const ref = block.attachment
    const name = typeof ref?.name === 'string' ? ref.name : props.t(image ? 'imageName' : 'fileName', { index: number })
    const bytes = typeof ref?.bytes === 'number' ? ref.bytes : undefined
    const size = bytes === undefined ? undefined : bytes < 1024 ? `${bytes} B`
      : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`
    const type = typeof ref?.mediaType === 'string' ? ref.mediaType : name.split('.').length > 1 ? name.split('.').at(-1)?.toUpperCase() : undefined
    const dimensions = image && typeof ref?.width === 'number' && typeof ref?.height === 'number' ? `${ref.width} × ${ref.height}` : undefined
    return [{ block, index, image, name, url: attachmentUrl(block), metadata: [type, size, dimensions].filter(Boolean).join(' · ') }]
  })
})
const unknown = computed(() => (props.blocks ?? []).filter(block => block.original !== undefined && !isAttachmentBlock(block)))
const lightbox = ref<HTMLDialogElement | null>(null)
const selected = ref<{ name: string; url: string }>()
async function openImage(name: string, url: string) {
  selected.value = { name, url }
  await nextTick()
  lightbox.value?.showModal()
}
</script>

<template>
  <ul v-if="entries.length" class="tui-message-attachments" :aria-label="t('attachments')">
    <li v-for="entry in entries" :key="entry.index" class="tui-attachment-row">
      <button v-if="entry.image && entry.url" class="tui-attachment-thumbnail" type="button" :aria-label="entry.name" @click="openImage(entry.name, entry.url)">
        <img :src="entry.url" :alt="entry.block.alt ?? entry.name" />
      </button>
      <span v-else :class="entry.image ? 'i-codicon-file-media' : 'i-codicon-file'" aria-hidden="true" />
      <div class="tui-attachment-info">
        <span class="tui-attachment-name" :title="entry.name">{{ entry.name }}</span>
        <span v-if="entry.metadata" class="tui-attachment-metadata">{{ entry.metadata }}</span>
        <details v-if="!entry.url">
          <summary>{{ t(entry.image ? 'imageUnavailable' : 'fileAttachment') }}</summary>
          <pre class="tui-payload">{{ formatValue(entry.block.original ?? entry.block) }}</pre>
        </details>
      </div>
    </li>
  </ul>
  <div v-for="(block, index) in unknown" :key="index" class="tui-message-attachments">
    <details><summary>{{ t('unsupportedContent') }}</summary><pre class="tui-payload">{{ formatValue(block.original) }}</pre></details>
  </div>
  <dialog ref="lightbox" class="tui-image-lightbox" :aria-label="selected?.name" @click="lightbox?.close()">
    <button type="button" :aria-label="t('closeDetails')" @click="lightbox?.close()">×</button>
    <img v-if="selected" :src="selected.url" :alt="selected.name" />
  </dialog>
</template>
