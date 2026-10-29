import { openSync, readSync, closeSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { replayFrames, replaySummary, type DuelColor, type ReplayBoard, type ReplayDocument, type ReplayMove, type ReplaySummary } from '../../src/replay/model.ts'

interface ArenaState extends ReplayBoard {
  id: string; createdAt: string; ply: number; winner: DuelColor | null; engineSha256: string; aiBudgetMs: number
  dshRuntime?: string
  moves: (ReplayMove & { stats?: { elapsedMs: number; nodes: number; depth: number; mode: string; stopReason: string } })[]
}

function initialState(directory: string): ArenaState {
  // The first complete event is immutable. Do not load the potentially large tool transcript.
  const fd = openSync(join(directory, 'events.jsonl'), 'r'), buffer = Buffer.alloc(65536)
  let text = ''
  try {
    while (!text.includes('\n')) {
      const size = readSync(fd, buffer)
      if (!size) throw new Error('Missing game-start event')
      text += buffer.toString('utf8', 0, size)
    }
  } finally { closeSync(fd) }
  const event = JSON.parse(text.slice(0, text.indexOf('\n')))
  if (event.type !== 'game-start') throw new Error('Missing initial board')
  return event.detail.state
}

export function arenaReplay(directory: string): ReplayDocument {
  const initial = initialState(directory)
  const state: ArenaState = JSON.parse(readFileSync(join(directory, 'state.json'), 'utf8'))
  const document: ReplayDocument = {
    format: 'light-chess-replay', version: 1, id: state.id,
    title: 'DSH vs 规则 AI', createdAt: state.createdAt,
    players: { blue: 'DSH', red: '规则 AI · Rust / WASM' },
    initial: { size: initial.size, boundaryReflects: true, homes: initial.homes,
      edges: initial.edges, diags: initial.diags, current: initial.current },
    moves: state.moves.map(({ color, action, actor, rationale, stats }) => ({
      color, action, actor, rationale,
      ...(stats ? { thinkingMs: stats.elapsedMs, search: {
        nodes: stats.nodes, depth: stats.depth, mode: stats.mode, stopReason: stats.stopReason,
      } } : {}),
    })),
    winner: state.winner,
    provenance: { engineSha256: state.engineSha256, aiBudgetMs: state.aiBudgetMs, source: state.dshRuntime ?? 'DSH headless / MCP' },
  }
  const last = replayFrames(document).at(-1)!
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
  if (state.id !== initial.id || document.moves.length !== state.ply || last.current !== state.current ||
    !same([...last.board.edges], state.edges) || !same([...last.board.diags], state.diags) ||
    !same(last.board.homes, state.homes) || last.board.size !== state.size) throw new Error('Replay does not match authoritative state')
  return document
}

export function publishReplay(directory: string, destination: string) {
  const game = arenaReplay(directory)
  if (!game.winner) throw new Error('Game is still in progress; only completed games may be published')
  if (!/^[a-f0-9-]{36}$/.test(game.id)) throw new Error('Invalid game ID')
  mkdirSync(destination, { recursive: true })
  let index: ReplaySummary[] = []
  try { index = JSON.parse(readFileSync(join(destination, 'index.json'), 'utf8')) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const atomic = (name: string, data: unknown) => {
    const temporary = join(destination, `${name}.${process.pid}.tmp`)
    writeFileSync(temporary, JSON.stringify(data, null, 2) + '\n')
    renameSync(temporary, join(destination, name))
  }
  atomic(`${game.id}.json`, game)
  atomic('index.json', [replaySummary(game), ...index.filter(item => item.id !== game.id)])
  return game
}
