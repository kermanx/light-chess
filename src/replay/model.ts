import { createsEnclosure, simulate, type BoardState, type Diag, type Home, type Mirror } from '../game.ts'

export type DuelColor = 'blue' | 'red'
export type ReplayAction = { kind: 'diag'; x: number; y: number; ori: '/' | '\\' } | { kind: 'edge'; id: string }
export interface ReplayMove {
  color: DuelColor
  action: ReplayAction
  actor: string
  rationale: string
  at?: string
  thinkingMs?: number
  search?: { nodes: number; depth: number; mode: string; stopReason: string }
}
export interface ReplayBoard {
  size: number
  boundaryReflects: boolean
  homes: Record<DuelColor, Home>
  edges: [string, Mirror][]
  diags: [string, Diag][]
  current: DuelColor
}
/** Portable, public game record. Never includes credentials or model transcripts. */
export interface ReplayDocument {
  format: 'light-chess-replay'
  version: 1
  id: string
  title: string
  createdAt: string
  players: Record<DuelColor, string>
  initial: ReplayBoard
  moves: ReplayMove[]
  winner: DuelColor | null
  provenance?: { engineSha256?: string; aiBudgetMs?: number; source?: string }
}
export interface ReplaySummary {
  id: string; title: string; createdAt: string; plies: number; winner: DuelColor | null
}
export interface ReplayFrame {
  board: BoardState
  current: DuelColor
  winner: DuelColor | null
  move: ReplayMove | null
}
export const replaySummary = (game: ReplayDocument): ReplaySummary => ({
  id: game.id, title: game.title, createdAt: game.createdAt, plies: game.moves.length, winner: game.winner,
})
export const other = (color: DuelColor): DuelColor => color === 'blue' ? 'red' : 'blue'
export function describeMove(action: ReplayAction) {
  if (action.kind === 'diag') return `斜镜 (${action.x}, ${action.y}) ${action.ori}`
  const [axis, x, y] = action.id.split(':')
  return `${axis === 'h' ? '横镜' : '竖镜'} (${x}, ${y})`
}

/** Rebuild every frame using the app's optics and enclosure rules, including turn-start settlement. */
export function replayFrames(game: ReplayDocument): ReplayFrame[] {
  if (game?.format !== 'light-chess-replay' || game.version !== 1 || !Array.isArray(game.moves)) throw new Error('不支持的回放格式')
  const initial = game.initial
  const n = initial?.size
  if (!Number.isInteger(n) || n < 2 || !['blue', 'red'].includes(initial.current)) throw new Error('无效的初始棋盘')
  if (Object.keys(initial.homes).sort().join(',') !== 'blue,red') throw new Error('目前支持双人对局回放')
  for (const home of Object.values(initial.homes)) {
    if (![home.x, home.y].every(v => Number.isInteger(v) && v >= 0 && v < n) || ![0, 1, 2, 3].includes(home.dir)) throw new Error('无效的基地')
  }
  let board: BoardState = { ...initial, homes: structuredClone(initial.homes), edges: new Map(initial.edges), diags: new Map(initial.diags) }
  let current = initial.current, winner: DuelColor | null = null
  const frames: ReplayFrame[] = [{ board, current, winner, move: null }]
  for (const [index, move] of game.moves.entries()) {
    const fail = (reason: string): never => { throw new Error(`第 ${index + 1} 手记录无效：${reason}`) }
    if (winner || move.color !== current) fail('落子顺序与回合不符')
    board = { ...board, edges: new Map(board.edges), diags: new Map(board.diags) }
    const action = move.action
    if (action?.kind === 'diag') {
      const { x, y, ori } = action
      if (![x, y].every(v => Number.isInteger(v) && v >= 0 && v < n) || !['/', '\\'].includes(ori)) fail('斜镜坐标或方向')
      if (board.diags.has(`${x},${y}`) || Object.values(board.homes).some(h => h.x === x && h.y === y)) fail('位置已占用')
      board.diags.set(`${x},${y}`, { color: current, ori })
    } else if (action?.kind === 'edge') {
      if (!/^[hv]:\d+:\d+$/.test(action.id)) fail('边镜坐标')
      const [axis, xs, ys] = action.id.split(':'), x = Number(xs), y = Number(ys)
      if (axis === 'h' ? x >= n || y <= 0 || y >= n : x <= 0 || x >= n || y >= n) fail('边镜超出范围')
      if (board.edges.has(action.id)) fail('位置已占用')
      board.edges.set(action.id, { color: current })
    } else fail('未知落子')
    if (createsEnclosure(board.edges, current, board.homes, n, board.diags)) fail('违反禁围规则')
    const next = other(current)
    winner = simulate(board, next).hits.includes(current) ? next : null
    current = next
    frames.push({ board, current, winner, move })
  }
  if (winner !== game.winner) throw new Error('记录结果与实际光路结算不一致')
  return frames
}
