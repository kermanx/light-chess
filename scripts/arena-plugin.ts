import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { Plugin, Connect } from 'vite'
import { arenaReplay } from './arena/replay.ts'

/** Read-only local matches. Static deployments use committed public/replays instead. */
export function arenaReplays(): Plugin {
  let root = ''
  const cache = new Map<string, { stamp: string; json: string }>()
  const middleware: Connect.NextHandleFunction = (req, res, next) => {
    const match = (req.url ?? '').split('?')[0]?.match(/\/__arena\/replays(?:\/([a-f0-9-]{36}))?\/?$/)
    if (!match) return next()
    const reply = (status: number, value: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(value))
    }
    if (req.method !== 'GET') return reply(405, { error: 'GET required' })
    void (async () => {
      const entries = await readdir(root, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      const games = []
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const directory = join(root, entry.name)
        let state
        try { state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error }
        if (match[1]) {
          if (state.id !== match[1]) continue
          const info = await stat(join(directory, 'state.json')), stamp = `${info.mtimeMs}:${info.size}`
          if (cache.get(directory)?.stamp !== stamp) cache.set(directory, { stamp, json: JSON.stringify(arenaReplay(directory)) })
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
          res.end(cache.get(directory)!.json)
          return
        }
        games.push({ id: state.id, title: 'DSH vs 规则 AI', createdAt: state.createdAt, plies: state.ply, winner: state.winner })
      }
      if (match[1]) reply(404, { error: '未找到这局回放' })
      else reply(200, games.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
    })().catch(error => reply(500, { error: error instanceof Error ? error.message : '读取回放失败' }))
  }
  return {
    name: 'local-arena-replays',
    configResolved(config) { root = resolve(process.env.LIGHT_CHESS_ARENA_DIR ?? join(config.root, 'debug/dsh-games')) },
    configureServer(server) { server.middlewares.use(middleware) },
    configurePreviewServer(server) { server.middlewares.use(middleware) },
  }
}
