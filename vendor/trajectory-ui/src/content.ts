import type { MessageKey } from './i18n'
import type { TrajectoryContentBlock, TrajectoryRecord } from './types'

/** Resolve only explicitly supplied web or caller-owned blob URLs. Durable IDs are not URLs. */
export function attachmentUrl(block: TrajectoryContentBlock): string | undefined {
  if (block.url === undefined) return undefined
  try {
    return ['https:', 'http:', 'blob:'].includes(new URL(block.url).protocol) ? block.url : undefined
  } catch { return undefined }
}

/** Count durable files and images without depending on the Harness attachment service. */
export function attachmentCounts(blocks: readonly TrajectoryContentBlock[] = []) {
  let images = 0
  let files = 0
  for (const block of blocks) {
    if (block.type === 'image') images++
    if (typeof block.original === 'object' && block.original !== null && 'type' in block.original && block.original.type === 'file') files++
  }
  return { images, files }
}

/** Read display text from result blocks while preserving the public output value. */
export function trajectoryResultValue(record: TrajectoryRecord): unknown {
  const blocks = record.outputBlocks
  return blocks?.length && blocks.every(block => block.type === 'text' && block.original === undefined || isAttachmentBlock(block))
    ? blocks.filter(block => !isAttachmentBlock(block)).map(block => block.content ?? '').join('\n') : record.output
}

/** Identify supported attachment blocks, retaining the existing fallback block representation. */
export function isAttachmentBlock(block: TrajectoryContentBlock): boolean {
  return block.type === 'image' || typeof block.original === 'object' && block.original !== null
    && 'type' in block.original && block.original.type === 'file'
}

/** Localized compact wording for tool-only developer notices. */
export function toolChangeSummary(record: TrajectoryRecord, t: (key: MessageKey, values?: Readonly<Record<string, string | number>>) => string): string | undefined {
  const changes = record.toolChanges
  if (changes === undefined) return undefined
  if (changes.added.length + changes.removed.length === 1) {
    return t(changes.added.length ? 'toolAdded' : 'toolRemoved', { name: (changes.added[0] ?? changes.removed[0])! })
  }
  return t('toolsChanged', { added: changes.added.length, removed: changes.removed.length })
}
