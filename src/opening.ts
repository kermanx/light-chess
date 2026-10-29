import { openingThreat } from './opening-tactics'
import { createsEnclosure, DX, DY, edgeOf, simulate, type BoardState, type Color, type Dir, type Ori, type Home, type Mirror, type Diag } from './game'

export interface OpeningProgress { stage: 'mirrors' | 'tactics'; completed: number; total: number; attempt: number }
export interface OpeningSettings { enabled: boolean; mirrorsPerPlayer: number }
export const defaultOpeningSettings = (): OpeningSettings => ({ enabled: false, mirrorsPerPlayer: 24 })
/** Keep ample empty space even in four-player games; base mirrors are separate. */
export const maxOpeningMirrors = (size: number, players: number) => Math.max(1, Math.floor(size * size / (2 * players)))
export function normalizeOpeningSettings(value: Partial<OpeningSettings> | undefined, size: number, players: number): OpeningSettings {
  const count = Number(value?.mirrorsPerPlayer ?? 24)
  return { enabled: value?.enabled === true,
    mirrorsPerPlayer: Math.max(1, Math.min(maxOpeningMirrors(size, players), Number.isFinite(count) ? Math.round(count) : 24)) }
}
export const newOpeningSeed = () => crypto.getRandomValues(new Uint32Array(1))[0]!
export interface OpeningPosition {
  size: number; players: Color[]; boundaryReflects: boolean; mirrorsPerPlayer: number; seed: number
  homes: Partial<Record<Color, Home>>; edges: [string, Mirror][]; diags: [string, Diag][]
}

type Placement = { kind: 'diag'; x: number; y: number; ori: Ori } | { kind: 'edge'; id: string }
function randomSource(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0
    let x = Math.imul(seed ^ (seed >>> 15), seed | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}
function shuffle<T>(items: T[], random: () => number) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[items[i], items[j]] = [items[j]!, items[i]!]
  }
  return items
}

/** Seeded, rules-checked initial position. No model, search budget or wall-clock
 * cutoffs: identical settings/seed produce identical boards on every peer. */
export function generateOpening(size: number, players: Color[], boundaryReflects: boolean, mirrorsPerPlayer: number, seed: number,
  progress: (status: OpeningProgress) => void = () => {}): BoardState {
  if (!Number.isInteger(size) || size < 4 || players.length < 2 || players.length > 4 || new Set(players).size !== players.length ||
    !Number.isInteger(mirrorsPerPlayer) || mirrorsPerPlayer < 1 || mirrorsPerPlayer > maxOpeningMirrors(size, players.length)) {
    throw new Error('预设局面的棋盘、人数或镜子数量无效')
  }
  const random = randomSource(seed)
  for (let attempt = 0; attempt < 8; attempt++) {
    progress({ stage: 'mirrors', completed: 0, total: mirrorsPerPlayer, attempt: attempt + 1 })
    const board: BoardState = { size, boundaryReflects, homes: {}, edges: new Map(), diags: new Map() }
    const cells = shuffle(Array.from({ length: size * size }, (_, i) => ({ x: i % size, y: Math.floor(i / size) })), random)
    for (const color of players) {
      // Distinct rows/columns avoid initial beam contact before mirrors exist.
      const cell = cells.find(p => Object.values(board.homes).every(h => p.x !== h.x && p.y !== h.y &&
        Math.max(Math.abs(p.x - h.x), Math.abs(p.y - h.y)) >= Math.max(2, Math.floor(size / 3))))
      if (!cell) break
      const directions = ([0, 1, 2, 3] as Dir[]).filter(d => cell.x + DX[d] >= 0 && cell.x + DX[d] < size && cell.y + DY[d] >= 0 && cell.y + DY[d] < size)
      const home = { ...cell, dir: directions[Math.floor(random() * directions.length)]! }
      board.homes[color] = home
      for (const d of [0, 1, 2, 3] as Dir[]) if (d !== home.dir) board.edges.set(edgeOf(home.x, home.y, d), { color })
    }
    if (Object.keys(board.homes).length !== players.length) continue
    const diagonals: Placement[] = [], edges: Placement[] = []
    for (const { x, y } of cells) {
      if (!Object.values(board.homes).some(h => h.x === x && h.y === y)) {
        for (const ori of ['/', '\\'] as Ori[]) diagonals.push({ kind: 'diag', x, y, ori })
      }
      if (x + 1 < size && !board.edges.has(`v:${x + 1}:${y}`)) edges.push({ kind: 'edge', id: `v:${x + 1}:${y}` })
      if (y + 1 < size && !board.edges.has(`h:${x}:${y + 1}`)) edges.push({ kind: 'edge', id: `h:${x}:${y + 1}` })
    }
    // Each color gets its own proposal order and the same number of accepted
    // mirrors. Rejected proposals never enter the game or its undo history.
    const proposals = players.map(() => ({ diagonals: shuffle([...diagonals], random), edges: shuffle([...edges], random) }))
    let complete = true
    rounds: for (let round = 0; round < mirrorsPerPlayer; round++) {
      for (let seat = 0; seat < players.length; seat++) {
        const color = players[seat]!, pool = proposals[seat]!
        let placed = false
        while (pool.diagonals.length || pool.edges.length) {
          const diagonal = pool.diagonals.length && (!pool.edges.length || random() < .8)
          const move = (diagonal ? pool.diagonals : pool.edges).pop()!
          if (move.kind === 'diag') {
            const key = `${move.x},${move.y}`
            if (board.diags.has(key)) continue
            board.diags.set(key, { color, ori: move.ori })
          } else {
            if (board.edges.has(move.id)) continue
            board.edges.set(move.id, { color })
          }
          if (!createsEnclosure(board.edges, color, board.homes, size, board.diags) && players.every(c => !simulate(board, c, { geometry: false }).hit)) {
            placed = true
            break
          }
          if (move.kind === 'diag') board.diags.delete(`${move.x},${move.y}`)
          else board.edges.delete(move.id)
        }
        if (!placed) { complete = false; break rounds }
      }
      progress({ stage: 'mirrors', completed: round + 1, total: mirrorsPerPlayer, attempt: attempt + 1 })
    }
    if (!complete || players.some(c => createsEnclosure(board.edges, c, board.homes, size, board.diags))) continue
    // Zero current hits is not sufficient: a single added mirror can create an
    // attack with no legal defense. Never publish such a seed for any seat.
    if (!openingThreat(board, players, (completed, total) => {
      progress({ stage: 'tactics', completed, total, attempt: attempt + 1 })
    })) return board
  }
  // Never return a partially filled or unchecked position.
  throw new Error('未能生成满足条件的预设局面，请重试或减少镜子数量')
}

/** Cheap structural/zero-hit validation at the game boundary and on remote
 * restarts. The generator additionally certifies all first attacks off-thread;
 * do not repeat that expensive tactical scan on the rendering thread. */
export function validOpening(position: OpeningPosition, size: number, players: Color[], boundaryReflects: boolean, count = position?.mirrorsPerPlayer): boolean {
  try {
    if (position.size !== size || position.boundaryReflects !== boundaryReflects || position.players.join(',') !== players.join(',') ||
      position.mirrorsPerPlayer !== count || !Number.isInteger(count) || count < 1 || count > maxOpeningMirrors(size, players.length) ||
      !Number.isInteger(position.seed) || position.seed < 0 || position.seed > 0xffffffff || Object.keys(position.homes).length !== players.length) return false
    const board: BoardState = { size, boundaryReflects, homes: position.homes, edges: new Map(position.edges), diags: new Map(position.diags) }
    if (board.edges.size !== position.edges.length || board.diags.size !== position.diags.length) return false
    const inside = (x: number, y: number) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < size && y < size
    const bases = new Set<string>()
    for (const color of players) {
      const home = board.homes[color]
      if (!home || !inside(home.x, home.y) || !Number.isInteger(home.dir) || home.dir < 0 || home.dir > 3 ||
        !inside(home.x + DX[home.dir]!, home.y + DY[home.dir]!)) return false
      if (players.some(c => c !== color && board.homes[c] && Math.max(Math.abs(home.x - board.homes[c]!.x), Math.abs(home.y - board.homes[c]!.y)) < 2)) return false
      for (const d of [0, 1, 2, 3] as Dir[]) if (d !== home.dir) {
        const edge = edgeOf(home.x, home.y, d)
        if (board.edges.get(edge)?.color !== color) return false
        bases.add(edge)
      }
    }
    const counts = Object.fromEntries(players.map(c => [c, 0])) as Record<Color, number>
    for (const [id, mirror] of board.edges) {
      const match = /^(h|v):(\d+):(\d+)$/.exec(id)
      if (!match || !players.includes(mirror.color)) return false
      const x = Number(match[2]), y = Number(match[3]), horizontal = match[1] === 'h'
      if (id !== `${match[1]}:${x}:${y}` || x > size || y > size || (horizontal ? x === size : y === size)) return false
      if (!bases.has(id) && (horizontal ? y === 0 || y === size : x === 0 || x === size)) return false
      counts[mirror.color]++
    }
    for (const [key, mirror] of board.diags) {
      const match = /^(\d+),(\d+)$/.exec(key)
      if (!match || !players.includes(mirror.color) || !['/', '\\'].includes(mirror.ori)) return false
      const x = Number(match[1]), y = Number(match[2])
      if (key !== `${x},${y}` || !inside(x, y) || Object.values(board.homes).some(h => h.x === x && h.y === y)) return false
      counts[mirror.color]++
    }
    return players.every(c => counts[c] === count + 3 && !createsEnclosure(board.edges, c, board.homes, size, board.diags) && !simulate(board, c, { geometry: false }).hit)
  } catch { return false }
}
