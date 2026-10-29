import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, Connect } from 'vite'

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
interface Event { v: number; id: string; gameId: string; parentId: string | null; at: string; type: string }

/** Local dev/preview recorder. Static hosting keeps the IndexedDB/export fallback. */
export function aiTestRecorder(): Plugin {
  let directory = ''
  let queue = Promise.resolve()
  const seenByGame = new Map<string, Set<string>>()
  async function save(events: Event[]) {
    await mkdir(directory, { recursive: true })
    for (const event of events) {
      const file = join(directory, `${event.gameId}.jsonl`)
      let seen = seenByGame.get(event.gameId)
      if (!seen) {
        seen = new Set<string>()
        try {
          for (const line of (await readFile(file, 'utf8')).split('\n').filter(Boolean)) seen.add(JSON.parse(line).id)
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        seenByGame.set(event.gameId, seen)
      }
      if (seen.has(event.id)) continue
      // One complete line per event; never rewrite a previous game or undone move.
      await appendFile(file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', flush: true })
      seen.add(event.id)
    }
  }
  function reply(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(body))
  }
  async function handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') return reply(res, 405, { error: 'POST required' })
    // Same-origin browser writes only. Payload IDs never become arbitrary paths.
    if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) return reply(res, 403, { error: 'Origin rejected' })
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(res, 415, { error: 'JSON required' })
    let body = ''
    for await (const chunk of req) {
      body += chunk.toString()
      if (Buffer.byteLength(body) > 2_000_000) return reply(res, 413, { error: 'Batch too large' })
    }
    let payload
    try { payload = JSON.parse(body) } catch { return reply(res, 400, { error: 'Invalid JSON' }) }
    const events: Event[] = payload.events
    if (payload.version !== 1 || !Array.isArray(events) || !events.length || events.length > 64 || !events.every(e =>
      e && e.v === 1 && uuid.test(e.id) && uuid.test(e.gameId) &&
      (e.parentId === null || uuid.test(e.parentId)) && typeof e.type === 'string' && e.type.length < 80 &&
      typeof e.at === 'string' && Number.isFinite(Date.parse(e.at)))) return reply(res, 400, { error: 'Invalid event batch' })
    // Serialize requests, including beacon/retry races, and survive failed writes.
    const write = queue.then(() => save(events))
    queue = write.catch(() => {})
    await write
    reply(res, 200, { ok: true, saved: events.map(e => e.id), directory })
  }
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    if (!(req.url ?? '').split('?')[0]?.endsWith('/__ai-test/record')) return next()
    void handle(req, res).catch(error => reply(res, 500, { error: error instanceof Error ? error.message : 'Recording failed' }))
  }
  return {
    name: 'local-ai-test-recorder',
    configResolved(config) { directory = resolve(process.env.LIGHT_CHESS_AI_LOG_DIR ?? join(config.root, 'debug/ai-games')) },
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
