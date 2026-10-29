import type { TrajectoryMutation } from './types'

/** Parse an NDJSON byte stream into trajectory mutations. */
export async function* readTrajectoryNdjson(
  source: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<TrajectoryMutation> {
  const reader = source.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const abort = () => { void reader.cancel(signal?.reason) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    while (!signal?.aborted) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let newline = buffer.indexOf('\n')
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        if (line !== '') yield JSON.parse(line) as TrajectoryMutation
        newline = buffer.indexOf('\n')
      }
    }
    buffer += decoder.decode()
    const finalLine = buffer.trim()
    if (finalLine !== '') yield JSON.parse(finalLine) as TrajectoryMutation
  } finally {
    signal?.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}
