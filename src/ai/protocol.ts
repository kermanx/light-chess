import { PALETTE, type BoardState, type Color, type Home, type Ori } from '../game.ts'

/** Versioned JSON ABI; dense row-major arrays keep the Rust board independent of JS Maps. */
export interface AiRequest {
  version: 1
  phase: 'setup' | 'play'
  size: number
  players: number[]
  current: number
  aliveMask: number
  homes: (Home | null)[]
  horizontal: number[]
  vertical: number[]
  diagonals: number[]
  budgetMs: number
  maxDepth?: number
  /** Diagnostic minimum before adaptive stopping; time/node limits still apply. */
  minDepth?: number
  maxNodes?: number
}
export type AiAction =
  | { kind: 'setup'; home: Home }
  | { kind: 'diag'; x: number; y: number; ori: Ori }
  | { kind: 'edge'; id: string }
export interface AiStats {
  nodes: number; depth: number; elapsedMs: number; score: number; mode: string
  selectionDepth?: number
  safe?: boolean; defenseComplete?: boolean
  candidates?: number
  plans?: number
  stopReason?: 'single-defense' | 'no-defense' | 'stable' | 'close-alternatives' | 'forced-win' | 'forcing-win' | 'depth-limit' | 'time-limit' | 'node-limit'
  reason?: string
  forcing?: {
    nodes: number; elapsedMs: number; completedDepth: number; attemptedDepth: number
    status: 'unknown' | 'budget' | 'proven'; winningTurns: number | null; proof?: AiForcingProof
  }
  iterations?: {
    depth: number
    /** Selected continuations from the searched tree, not a forced-win proof. */
    candidates: { action: AiAction; score: number; selectionScore?: number; selectionPriority?: number; directAttack?: boolean; orderingScore: number; line?: AiAction[] }[]
  }[]
  /** Finished root candidates in an interrupted iteration; other replies remain unsearched. */
  partialIteration?: {
    depth: number
    candidates: { action: AiAction; score: number; selectionScore?: number; selectionPriority?: number; directAttack?: boolean; orderingScore: number; line?: AiAction[] }[]
  }
}
export interface AiForcingProof {
  action: AiAction
  replies: { action: AiAction; continuation: AiForcingProof }[]
}
export interface AiResponse { action: AiAction | null; stats?: AiStats; error?: string }

/** Only the explanation for the accepted move is shared with other players and saved. */
export interface AiMoveAnalysis { elapsedMs: number; reason?: string }
export function toAiMoveAnalysis(value: unknown): AiMoveAnalysis | undefined {
  if (!value || typeof value !== 'object') return
  const stats = value as Record<string, unknown>
  if (typeof stats.elapsedMs !== 'number' || !Number.isFinite(stats.elapsedMs) || stats.elapsedMs < 0) return
  const reason = typeof stats.reason === 'string' ? stats.reason.trim().slice(0, 280) : ''
  return { elapsedMs: stats.elapsedMs, ...(reason ? { reason } : {}) }
}

export const colorIndex = (color: Color) => PALETTE.findIndex(p => p.id === color)

export function makeAiRequest(board: BoardState, options: {
  phase: 'setup' | 'play'; players: Color[]; current: Color; dead: Color[]; budgetMs: number
}): AiRequest {
  const n = board.size
  const horizontal = new Array<number>(n * (n + 1)).fill(0)
  const vertical = new Array<number>((n + 1) * n).fill(0)
  const diagonals = new Array<number>(n * n).fill(0)
  for (const [id, mirror] of board.edges) {
    const [axis, sx, sy] = id.split(':')
    const x = Number(sx), y = Number(sy)
    const array = axis === 'h' ? horizontal : vertical
    array[y * (axis === 'h' ? n : n + 1) + x] = colorIndex(mirror.color) + 1
  }
  for (const [key, mirror] of board.diags) {
    const [x, y] = key.split(',').map(Number)
    diagonals[y * n + x] = 1 + 2 * colorIndex(mirror.color) + (mirror.ori === '\\' ? 1 : 0)
  }
  return {
    version: 1, phase: options.phase, size: n,
    players: options.players.map(colorIndex), current: colorIndex(options.current),
    aliveMask: options.players.reduce((mask, c) => options.dead.includes(c) ? mask : mask | (1 << colorIndex(c)), 0),
    homes: PALETTE.map(p => board.homes[p.id] ? { ...board.homes[p.id]! } : null),
    horizontal, vertical, diagonals, budgetMs: options.budgetMs,
  }
}

/** Treat WASM responses as data; malformed actions never reach store mutation. */
export function isAiAction(value: unknown): value is AiAction {
  if (!value || typeof value !== 'object') return false
  const a = value as Record<string, unknown>
  if (a.kind === 'edge') return typeof a.id === 'string' && /^[hv]:\d+:\d+$/.test(a.id)
  if (a.kind === 'diag') return Number.isInteger(a.x) && Number.isInteger(a.y) && (a.ori === '/' || a.ori === '\\')
  if (a.kind === 'setup' && a.home && typeof a.home === 'object') {
    const h = a.home as Record<string, unknown>
    return Number.isInteger(h.x) && Number.isInteger(h.y) && Number.isInteger(h.dir)
  }
  return false
}
