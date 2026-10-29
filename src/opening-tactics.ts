import { createsEnclosure, edgeOf, simulate, type BoardState, type Color, type Ori, type Pt } from './game'

export type OpeningMove = { kind: 'diag'; x: number; y: number; ori: Ori } | { kind: 'edge'; id: string }
export interface OpeningThreat { attacker: Color; target: Color; action: OpeningMove | null }

/** Any move that changes a beam must touch its current path. For attacks use
 * every segment; for defenses a single witness path is sufficient: every save
 * must cut that path, then must pass a fresh trace of ALL branches. */
function pathMoves(board: BoardState, segments: [Pt, Pt][]): OpeningMove[] {
  const moves = new Map<string, OpeningMove>()
  const cell = (p: Pt) => {
    if (!Number.isInteger(p.x - .5) || !Number.isInteger(p.y - .5)) return
    const x = p.x - .5, y = p.y - .5
    if (board.diags.has(`${x},${y}`) || Object.values(board.homes).some(h => h.x === x && h.y === y)) return
    for (const ori of ['/', '\\'] as Ori[]) moves.set(`${x},${y},${ori}`, { kind: 'diag', x, y, ori })
  }
  for (const [p, q] of segments) {
    cell(p); cell(q)
    // Every segment is center→center or center→edge midpoint. Occupied edges
    // cannot be changed. Include empty boundary edges for non-reflecting games.
    const center = Number.isInteger(p.x - .5) && Number.isInteger(p.y - .5) ? p : q
    const other = center === p ? q : p
    const dir = other.x > center.x ? 0 : other.y > center.y ? 1 : other.x < center.x ? 2 : 3
    const id = edgeOf(center.x - .5, center.y - .5, dir)
    if (!board.edges.has(id)) moves.set(id, { kind: 'edge', id })
  }
  // Edge cuts often stop a whole beam; try these first without omitting either
  // diagonal orientation or relying on a heuristic search width.
  return [...moves.values()].sort((a, b) => Number(a.kind === 'diag') - Number(b.kind === 'diag'))
}
function put(board: BoardState, move: OpeningMove, color: Color) {
  if (move.kind === 'edge') board.edges.set(move.id, { color })
  else board.diags.set(`${move.x},${move.y}`, { color, ori: move.ori })
}
function remove(board: BoardState, move: OpeningMove) {
  if (move.kind === 'edge') board.edges.delete(move.id)
  else board.diags.delete(`${move.x},${move.y}`)
}

/** Reject starts with an existing hit or an unanswerable first attack, for ANY
 * seat. This is a bounded tactical guarantee, not an evaluation of long-term
 * balance or a proof that neither side can force a win many moves later.
 * Multiplayer uses the stronger pairwise test (no reliance on third-party help).
 * Never uses a clock deadline or treats an interrupted search as safe. */
export function openingThreat(board: BoardState, players: Color[], progress: (completed: number, total: number) => void = () => {}): OpeningThreat | null {
  const plans = players.map(attacker => ({ attacker, beam: simulate(board, attacker) }))
  for (const { attacker, beam } of plans) {
    const hit = beam.hits.find(c => players.includes(c))
    if (hit) return { attacker, target: hit, action: null }
  }
  const candidates = plans.map(({ attacker, beam }) => ({ attacker, actions: pathMoves(board, beam.segments) }))
  const total = candidates.reduce((sum, plan) => sum + plan.actions.length, 0)
  let completed = 0
  progress(0, total)
  for (const { attacker, actions } of candidates) {
    for (const action of actions) {
      put(board, action, attacker)
      try {
        if (!simulate(board, attacker, { geometry: false }).hit || createsEnclosure(board.edges, attacker, board.homes, board.size, board.diags)) continue
        const beam = simulate(board, attacker)
        for (const target of beam.hits.filter(c => players.includes(c))) {
          // In a duel the defender's beam settles BEFORE their move. A move
          // that kills its own attacker at that point cannot be a winning attack.
          if (players.length === 2 && simulate(board, target, { geometry: false, stopAt: attacker }).hits.includes(attacker)) continue
          const path = beam.hitPaths[target]!
          const segments = path.slice(1).map((q, i) => [path[i]!, q] as [Pt, Pt])
          let defended = false
          for (const reply of pathMoves(board, segments)) {
            put(board, reply, target)
            try {
              if (!simulate(board, attacker, { geometry: false, stopAt: target }).hits.includes(target) &&
                !createsEnclosure(board.edges, target, board.homes, board.size, board.diags)) {
                defended = true
                break
              }
            } finally { remove(board, reply) }
          }
          if (!defended) return { attacker, target, action }
        }
      } finally {
        remove(board, action)
        if (++completed % 16 === 0 || completed === total) progress(completed, total)
      }
    }
  }
  return null
}
