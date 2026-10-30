/** MQTT relay packets are capped at 512 KiB including encryption/base64 overhead.
 * Long reconnect snapshots are sent in ordered pieces; ordinary moves stay unchanged. */
const CHARS = 24_000
export interface SnapshotChunk { t: 'snapshot-chunk'; id: string; index: number; count: number; text: string }
export function snapshotChunks(message: unknown): SnapshotChunk[] | null {
  const text = JSON.stringify(message)
  if (text.length <= CHARS) return null
  const id = crypto.randomUUID(), count = Math.ceil(text.length / CHARS)
  return Array.from({ length: count }, (_, index) => ({ t: 'snapshot-chunk', id, index, count, text: text.slice(index * CHARS, (index + 1) * CHARS) }))
}
export class SnapshotReceiver {
  private pending: { id: string; count: number; parts: string[]; at: number } | null = null
  clear() { this.pending = null }
  receive(chunk: SnapshotChunk): unknown {
    if (typeof chunk.id !== 'string' || chunk.id.length > 64 || !Number.isInteger(chunk.count) || chunk.count < 1 || chunk.count > 2048 ||
      !Number.isInteger(chunk.index) || chunk.index < 0 || chunk.index >= chunk.count || typeof chunk.text !== 'string' || chunk.text.length > CHARS) return
    if (chunk.index === 0) this.pending = { id: chunk.id, count: chunk.count, parts: [], at: Date.now() }
    const pending = this.pending
    if (!pending || Date.now() - pending.at > 120_000 || chunk.id !== pending.id || chunk.count !== pending.count || chunk.index !== pending.parts.length) { this.clear(); return }
    pending.parts.push(chunk.text)
    if (pending.parts.length !== pending.count) return
    this.clear()
    return JSON.parse(pending.parts.join(''))
  }
}
