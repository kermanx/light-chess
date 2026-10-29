import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createsEnclosure, edgeOf, simulate, seatColors, type BoardState, type Color, type Dir } from '../src/game'
import { generateOpening, type OpeningPosition } from '../src/opening'
import { openingThreat, type OpeningMove } from '../src/opening-tactics'

// Captured from the reported UI; its random seed was not exposed.
const fixture: Omit<OpeningPosition, 'seed'> = JSON.parse(readFileSync(new URL('./fixtures/opening-mate-in-one.json', import.meta.url), 'utf8'))
const board = (): BoardState => ({ ...fixture, homes: structuredClone(fixture.homes), edges: new Map(fixture.edges), diags: new Map(fixture.diags) })
const fingerprint = (b: BoardState) => JSON.stringify({ homes: b.homes, edges: [...b.edges], diags: [...b.diags] })
function put(b: BoardState, m: OpeningMove, color: Color) {
  if (m.kind === 'diag') b.diags.set(`${m.x},${m.y}`, { color, ori: m.ori })
  else b.edges.set(m.id, { color })
}
function remove(b: BoardState, m: OpeningMove) {
  if (m.kind === 'diag') b.diags.delete(`${m.x},${m.y}`)
  else b.edges.delete(m.id)
}
// Independent exhaustive oracle: no path-based candidate pruning, includes every
// border edge accepted by the live store and both diagonal orientations.
function allMoves(b: BoardState): OpeningMove[] {
  const moves: OpeningMove[] = []
  for (let y = 0; y < b.size; y++) for (let x = 0; x < b.size; x++) {
    if (!b.diags.has(`${x},${y}`) && !Object.values(b.homes).some(h => h.x === x && h.y === y)) {
      for (const ori of ['/', '\\'] as const) moves.push({ kind: 'diag', x, y, ori })
    }
  }
  for (const axis of ['h', 'v']) for (let y = 0; y < b.size + Number(axis === 'h'); y++) {
    for (let x = 0; x < b.size + Number(axis === 'v'); x++) {
      const id = `${axis}:${x}:${y}`
      if (!b.edges.has(id)) moves.push({ kind: 'edge', id })
    }
  }
  return moves
}
const legal = (b: BoardState, color: Color) => !createsEnclosure(b.edges, color, b.homes, b.size, b.diags)
function exhaustiveThreat(b: BoardState, players: Color[]): boolean {
  for (const attacker of players) {
    if (simulate(b, attacker).hit) return true
    for (const move of allMoves(b)) {
      put(b, move, attacker)
      try {
        const hits = simulate(b, attacker).hits
        if (!hits.length || !legal(b, attacker)) continue
        for (const target of hits) {
          if (players.length === 2 && simulate(b, target).hits.includes(attacker)) continue
          let safe = false
          for (const reply of allMoves(b)) {
            put(b, reply, target)
            safe = legal(b, target) && !simulate(b, attacker).hits.includes(target)
            remove(b, reply)
            if (safe) break
          }
          if (!safe) return true
        }
      } finally { remove(b, move) }
    }
  }
  return false
}

const b = board(), before = fingerprint(b)
assert(!simulate(b, 'blue').hit && !simulate(b, 'red').hit)
const attack: OpeningMove = { kind: 'diag', x: 6, y: 12, ori: '/' }
assert.deepEqual(openingThreat(b, ['blue', 'red']), { attacker: 'blue', target: 'red', action: attack })
assert.equal(fingerprint(b), before, 'early rejection must restore the trial attack and replies')
put(b, attack, 'blue')
assert(legal(b, 'blue'))
let legalReplies = 0, safeReplies = 0, illegalBlocks = 0
for (const reply of allMoves(b)) {
  put(b, reply, 'red')
  const ok = legal(b, 'red'), blocks = !simulate(b, 'blue').hits.includes('red')
  if (ok) { legalReplies++; if (blocks) safeReplies++ }
  else if (blocks) illegalBlocks++
  remove(b, reply)
}
assert.equal(legalReplies, 810)
assert.equal(safeReplies, 0)
assert.equal(illegalBlocks, 1, 'the only optical block illegally closes the red base')
remove(b, attack)
assert.equal(fingerprint(b), before)
const swapped = board()
swapped.homes = { blue: swapped.homes.red, red: swapped.homes.blue }
for (const [id, m] of swapped.edges) swapped.edges.set(id, { color: m.color === 'blue' ? 'red' : 'blue' })
for (const [id, m] of swapped.diags) swapped.diags.set(id, { ...m, color: m.color === 'blue' ? 'red' : 'blue' })
assert.equal(openingThreat(swapped, ['blue', 'red'])?.attacker, 'red', 'both seats must be screened, not only first player')
console.log('ok: reported 16×16/64 opening rejected; 810 legal replies, zero saves; color-swapped threat rejected too')

let rng = 371
const random = () => ((rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0) / 2 ** 32)
for (let test = 0; test < 24; test++) {
  const players = seatColors(test % 3 === 0 ? 3 : 2), n = 4
  const sample: BoardState = { size: n, boundaryReflects: test % 2 === 0, homes: {}, edges: new Map(), diags: new Map() }
  const homes = [{ x: 0, y: 0, dir: players.length === 3 ? 1 : 0 }, { x: 3, y: 3, dir: 2 }, { x: 3, y: 0, dir: 1 }]
  for (let i = 0; i < players.length; i++) {
    const h = { ...homes[i]!, dir: homes[i]!.dir as Dir }, color = players[i]!
    sample.homes[color] = h
    for (const d of [0, 1, 2, 3] as const) if (d !== h.dir) sample.edges.set(edgeOf(h.x, h.y, d), { color })
  }
  for (let i = 0; i < 10; i++) {
    const moves = allMoves(sample), move = moves[Math.floor(random() * moves.length)]!, color = players[i % players.length]!
    put(sample, move, color)
    if (!legal(sample, color) || players.some(c => simulate(sample, c).hit)) remove(sample, move)
  }
  const snapshot = fingerprint(sample)
  assert.equal(Boolean(openingThreat(sample, players)), exhaustiveThreat(sample, players), `exhaustive oracle ${test}`)
  assert.equal(fingerprint(sample), snapshot)
  for (const c of players) {
    const full = simulate(sample, c)
    assert.deepEqual(simulate(sample, c, { geometry: false }).hits, full.hits)
    for (const t of players) assert.equal(simulate(sample, c, { geometry: false, stopAt: t }).hits.includes(t), full.hits.includes(t))
  }
}
console.log('ok: path-based screening agrees with exhaustive attack/reply enumeration on 24 small boards, including multiplayer and both boundary rules')

// A plain attack is allowed when an actual legal response exists.
const defendable = generateOpening(16, ['blue', 'red'], true, 1, 9)
assert.equal(openingThreat(defendable, ['blue', 'red']), null)
let attempted = 0, checked = 0, total = 0
const generated = generateOpening(16, ['blue', 'red'], true, 64, 1, p => {
  attempted = Math.max(attempted, p.attempt)
  if (p.stage === 'tactics') { checked = p.completed; total = p.total }
})
assert.equal(openingThreat(generated, ['blue', 'red']), null)
assert.equal(attempted, 2, 'seed 1 is unsafe on the first attempt and must be regenerated')
assert.equal(checked, total, 'accepted board must finish the full finite check')
assert(total > 0)
console.log(`ok: generated dense opening finishes full tactical verification (${attempted} attempt(s)); checks never mutate it`)
