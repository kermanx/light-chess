// Independent TypeScript rules verify strategic/tactical regressions from actual games.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { simulate, createsEnclosure, PALETTE } from '../src/game.ts'

const colors = PALETTE.map(p => p.id)
const fixture = name => JSON.parse(readFileSync(new URL(`../ai/fixtures/${name}.json`, import.meta.url)))
const { instance } = await WebAssembly.instantiate(readFileSync(new URL('../src/ai/engine.wasm', import.meta.url)), { env: { now_ms: () => performance.now() } })
const wasm = instance.exports
function choose(request) {
  const bytes = new TextEncoder().encode(JSON.stringify(request)), ptr = wasm.alloc(bytes.length)
  let output = 0, len = 0
  try {
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes)
    output = wasm.choose_action(ptr, bytes.length); len = wasm.result_len()
    const result = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, output, len)))
    assert(!result.error, JSON.stringify(result))
    return result
  } finally { wasm.dealloc(ptr, bytes.length); if (output) wasm.dealloc(output, len) }
}
function boardOf(r) {
  const n = r.size, b = { size: n, boundaryReflects: true, homes: {}, edges: new Map(), diags: new Map() }
  r.homes.forEach((h, c) => { if (h) b.homes[colors[c]] = h })
  r.horizontal.forEach((v, i) => { if (v) b.edges.set(`h:${i % n}:${Math.floor(i / n)}`, { color: colors[v - 1] }) })
  r.vertical.forEach((v, i) => { if (v) b.edges.set(`v:${i % (n + 1)}:${Math.floor(i / (n + 1))}`, { color: colors[v - 1] }) })
  r.diagonals.forEach((v, i) => { if (v) b.diags.set(`${i % n},${Math.floor(i / n)}`, { color: colors[Math.floor((v - 1) / 2)], ori: (v - 1) % 2 ? '\\' : '/' }) })
  return b
}
function options(b) {
  const moves = [], n = b.size
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!b.diags.has(`${x},${y}`) && !Object.values(b.homes).some(h => h.x === x && h.y === y)) {
      for (const ori of ['/', '\\']) moves.push({ kind: 'diag', x, y, ori })
    }
    if (x + 1 < n && !b.edges.has(`v:${x + 1}:${y}`)) moves.push({ kind: 'edge', id: `v:${x + 1}:${y}` })
    if (y + 1 < n && !b.edges.has(`h:${x}:${y + 1}`)) moves.push({ kind: 'edge', id: `h:${x}:${y + 1}` })
  }
  return moves
}
function apply(b, a, color) {
  if (a.kind === 'diag') b.diags.set(`${a.x},${a.y}`, { color, ori: a.ori })
  else b.edges.set(a.id, { color })
}
function undo(b, a) { if (a.kind === 'diag') b.diags.delete(`${a.x},${a.y}`); else b.edges.delete(a.id) }
const available = (b, a) => options(b).some(m => JSON.stringify(m) === JSON.stringify(a))
function legal(b, a, color) {
  if (!available(b, a)) return false
  apply(b, a, color)
  const ok = !createsEnclosure(b.edges, color, b.homes, b.size, b.diags)
  undo(b, a); return ok
}
function defenses(b, attacker, defender) {
  return options(b).filter(a => {
    if (!legal(b, a, defender)) return false
    apply(b, a, defender)
    const safe = !simulate(b, attacker).hits.includes(defender)
    undo(b, a); return safe
  })
}
function unanswerable(b, a, attacker, defender) {
  if (!legal(b, a, attacker)) return false
  apply(b, a, attacker)
  const wins = simulate(b, attacker).hits.includes(defender) && !simulate(b, defender).hits.includes(attacker) && defenses(b, attacker, defender).length === 0
  undo(b, a); return wins
}
function attacks(b, color, target) {
  return options(b).filter(a => {
    if (!legal(b, a, color)) return false
    apply(b, a, color); const hits = simulate(b, color).hits.includes(target); undo(b, a); return hits
  })
}

const opening = fixture('screenshot'), before = boardOf(opening.request)
const oldOpportunities = attacks(before, 'blue', 'red').length
const result = choose({ ...opening.request, budgetMs: 10_000 })
assert(legal(before, result.action, 'red'))
apply(before, result.action, 'red')
assert(!simulate(before, 'blue').hits.includes('red'), 'opening move is safe')
const limitsAttack = attacks(before, 'blue', 'red').length < oldOpportunities
// A source-column mirror can be completed around the right-hand home entrance.
let developsRoute = false
if (result.action.kind === 'diag' && result.action.x === 0 && result.action.y !== 8) {
  const rest = [{ kind: 'diag', x: 9, y: result.action.y, ori: '/' }, { kind: 'diag', x: 9, y: 8, ori: '/' }]
  if (rest.every(a => { if (!legal(before, a, 'red')) return false; apply(before, a, 'red'); return true })) developsRoute = simulate(before, 'red').hits.includes('blue')
}
assert(limitsAttack || developsRoute, 'the opening should develop a real route or reduce direct enemy connections')
assert(['stable', 'time-limit', 'node-limit', 'depth-limit'].includes(result.stats.stopReason))
assert(result.stats.depth >= 4, 'ambiguous openings must not stop at depth three because candidates are close')
assert(result.stats.plans > 0 && result.stats.candidates <= 24)
assert(result.stats.reason.length > 0)
console.log(`ok: screenshot regression ${result.stats.elapsedMs.toFixed(0)} ms, ${result.stats.nodes} nodes, ${result.stats.stopReason}; useful legal move`)

const firstMove = fixture('test-first-move'), firstBoard = boardOf(firstMove.request)
const firstAttackCount = attacks(firstBoard, 'blue', 'red').length
apply(firstBoard, firstMove.oldMove, 'red')
assert.equal(attacks(firstBoard, 'blue', 'red').length, firstAttackCount, 'old remote move leaves both immediate blue connections available')
undo(firstBoard, firstMove.oldMove)
// High ceiling keeps the regression independent of machine speed; maxDepth
// bounds work. An old "close alternatives" stop would still quit at depth 3.
const improved = choose({ ...firstMove.request, budgetMs: 120_000, minDepth: 6, maxDepth: 6 })
assert.equal(improved.stats.depth, 6, 'compare the recorded opening at a fixed complete depth, independent of wall-clock load')
assert(legal(firstBoard, improved.action, 'red'))
apply(firstBoard, improved.action, 'red')
assert(!simulate(firstBoard, 'blue').hits.includes('red'), 'occupy the connecting cell with a safe diagonal orientation')
// Reducing the opponent's attack count alone is NOT a strength test: it would
// incorrectly reject an active attack just because a countercheck still exists.
assert(simulate(firstBoard, 'red').hits.includes('blue') || attacks(firstBoard, 'blue', 'red').length < firstAttackCount,
  'the selected move should create pressure or disrupt an immediate connection')
assert.equal(improved.stats.iterations.length, improved.stats.depth)
for (const iteration of improved.stats.iterations) {
  assert(iteration.candidates.every(c => Number.isFinite(c.score) && Number.isFinite(c.orderingScore)))
  for (const candidate of iteration.candidates) {
    assert.deepEqual(candidate.line[0], candidate.action)
    const b = boardOf(firstMove.request)
    let color = 'red'
    for (const [index, action] of candidate.line.entries()) {
      assert(legal(b, action, color), `invalid recorded continuation: ${JSON.stringify(candidate.line)}`)
      apply(b, action, color)
      const next = color === 'red' ? 'blue' : 'red'
      if (simulate(b, next).hits.includes(color)) assert.equal(index, candidate.line.length - 1, 'line ends at elimination')
      color = next
    }
  }
}
const direct = { kind: 'diag', x: 13, y: 2, ori: '/' }
const passiveBlock = { kind: 'edge', id: 'v:13:2' }
const directBoard = boardOf(firstMove.request)
assert(legal(directBoard, direct, 'red')); apply(directBoard, direct, 'red')
assert(simulate(directBoard, 'red').hits.includes('blue'), 'the suggested right-hand mirror really attacks')
assert(legal(directBoard, passiveBlock, 'blue')); apply(directBoard, passiveBlock, 'blue')
assert(!simulate(directBoard, 'red').hits.includes('blue'), 'the passive edge really blocks the suggested attack')
const comparison = improved.stats.iterations[0].candidates.find(c => JSON.stringify(c.action) === JSON.stringify(direct))
assert(comparison, 'the suggested attack must be considered')
assert.deepEqual(comparison.line[1], passiveBlock, 'even the first tactical search must include the passive block')
console.log(`ok: recorded first-move regression, depth ${improved.stats.depth}, ${JSON.stringify(improved.action)}; passive block retained and all logged continuations independently legal`)

// Force an interruption by node count, independent of machine speed. The old
// choice must also have a finished score at this depth before replacing it.
const limited = choose({ ...firstMove.request, budgetMs: 120_000, minDepth: 8, maxDepth: 8, maxNodes: 20_000 })
assert.equal(limited.stats.stopReason, 'node-limit')
const partial = limited.stats.partialIteration
assert(partial?.candidates.length, 'retain completed comparisons from the interrupted iteration')
const incumbent = limited.stats.iterations.at(-1).candidates[0].action
assert(partial.candidates.some(c => JSON.stringify(c.action) === JSON.stringify(incumbent)), 'incumbent was searched first at the deeper depth')
assert.equal(limited.stats.selectionDepth, partial.depth)
assert.equal(limited.stats.depth + 1, partial.depth, 'do not label an interrupted iteration as complete')
assert.deepEqual(limited.action, partial.candidates[0].action)
assert.equal(limited.stats.score, partial.candidates[0].score)
console.log('ok: interrupted search keeps a completed same-depth comparison without claiming the entire iteration finished')

const initiative = fixture('attack-initiative'), initiativeBoard = boardOf(initiative.request)
assert(!simulate(initiativeBoard, 'blue').hits.includes('red'), 'recorded position needs no immediate defense')
apply(initiativeBoard, initiative.oldMove, 'red')
assert(!simulate(initiativeBoard, 'red').hits.includes('blue'), 'old move postpones the attack')
undo(initiativeBoard, initiative.oldMove)
const attackNow = choose({ ...initiative.request, budgetMs: 120_000, minDepth: 4, maxDepth: 4 })
assert.equal(attackNow.stats.depth, 4)
assert(legal(initiativeBoard, attackNow.action, 'red'))
apply(initiativeBoard, attackNow.action, 'red')
assert(!simulate(initiativeBoard, 'blue').hits.includes('red'))
assert(simulate(initiativeBoard, 'red').hits.includes('blue'), 'without a current threat, attack immediately instead of developing a remote route')
const rankedAttack = attackNow.stats.iterations.at(-1).candidates
assert(rankedAttack[0].directAttack && rankedAttack[0].selectionPriority === 4)
assert(rankedAttack.every(c => c.selectionPriority <= rankedAttack[0].selectionPriority))
assert(rankedAttack.some(c => !c.directAttack), 'still search quiet alternatives to detect tactical exceptions')
// A strong passive block can require fresh preparation; do not invent an attack.
assert(legal(initiativeBoard, passiveBlock, 'blue'))
apply(initiativeBoard, passiveBlock, 'blue')
assert(!simulate(initiativeBoard, 'red').hits.includes('blue'))
assert(!simulate(initiativeBoard, 'blue').hits.includes('red'))
assert.equal(attacks(initiativeBoard, 'red', 'blue').length, 0)
const followupRequest = structuredClone(initiative.request)
assert.equal(attackNow.action.kind, 'diag')
followupRequest.diagonals[attackNow.action.y * 16 + attackNow.action.x] = attackNow.action.ori === '/' ? 3 : 4
followupRequest.vertical[2 * 17 + 13] = 1
const prepareAgain = choose({ ...followupRequest, budgetMs: 120_000, minDepth: 1, maxDepth: 1 })
assert(legal(initiativeBoard, prepareAgain.action, 'red'))
apply(initiativeBoard, prepareAgain.action, 'red')
assert(!simulate(initiativeBoard, 'blue').hits.includes('red'))
assert(prepareAgain.stats.iterations[0].candidates.every(c => !c.directAttack && c.selectionPriority < 3))
console.log(`ok: recorded quiet turn attacks with ${JSON.stringify(attackNow.action)}; a real block can still require preparation, not a fictitious follow-up check`)

const varied = fixture('defense-diversity'), variedBoard = boardOf(varied.request)
assert.equal(defenses(variedBoard, 'blue', 'red').filter(a => a.kind === 'diag').length, 40)
const variedChoice = choose({ ...varied.request, budgetMs: 120_000, minDepth: 1, maxDepth: 1 })
const variedCandidates = variedChoice.stats.iterations[0].candidates
assert(variedCandidates.some(c => c.action.kind === 'diag' && c.action.x === 2))
assert(variedCandidates.some(c => c.action.kind === 'diag' && c.action.y === 13))
for (const { action } of variedCandidates) {
  assert(legal(variedBoard, action, 'red')); apply(variedBoard, action, 'red')
  assert(!simulate(variedBoard, 'blue').hits.includes('red'), 'every defensive candidate must really save the base')
  undo(variedBoard, action)
}
console.log('ok: 40 independently verified diagonal saves; root search compares blocks on both rays')

const diagonalDefense = fixture('diagonal-defense'), defenseBoard = boardOf(diagonalDefense.request)
const savingMoves = defenses(defenseBoard, 'blue', 'red')
assert.equal(savingMoves.filter(a => a.kind === 'diag').length, 37, 'the recorded position has many real diagonal defenses')
for (const action of [diagonalDefense.oldMove, diagonalDefense.alternative]) {
  assert(legal(defenseBoard, action, 'red')); apply(defenseBoard, action, 'red')
  assert(!simulate(defenseBoard, 'blue').hits.includes('red'))
  assert.equal(attacks(defenseBoard, 'blue', 'red').length, 0, 'both defenses deny all one-move blue connections')
  undo(defenseBoard, action)
}
const preferred = choose({ ...diagonalDefense.request, budgetMs: 120_000, minDepth: 5, maxDepth: 5 })
assert.equal(preferred.stats.depth, 5)
assert.equal(preferred.action.kind, 'diag', 'tiny coverage gains must not override the diagonal preference in the final choice')
assert(legal(defenseBoard, preferred.action, 'red')); apply(defenseBoard, preferred.action, 'red')
assert(!simulate(defenseBoard, 'blue').hits.includes('red'))
const comparisonAtDepth = preferred.stats.iterations.at(-1).candidates
assert(comparisonAtDepth.some(c => JSON.stringify(c.action) === JSON.stringify(diagonalDefense.oldMove)), 'keep the edge available for a real tactical advantage')
assert(comparisonAtDepth.every(c => Number.isFinite(c.selectionScore)), 'log final preference separately from raw evaluation')
assert.deepEqual(preferred.action, comparisonAtDepth[0].action)
assert(comparisonAtDepth.every(c => c.selectionPriority < comparisonAtDepth[0].selectionPriority
  || (c.selectionPriority === comparisonAtDepth[0].selectionPriority && c.selectionScore <= comparisonAtDepth[0].selectionScore)))
console.log(`ok: 37 independently verified diagonal saves; final choice ${JSON.stringify(preferred.action)} respects the preference`)

const single = fixture('single-defense'), singleBoard = boardOf(single.request)
const only = defenses(singleBoard, 'blue', 'red')
assert.equal(only.length, 1, 'fixture has exactly one legal save under independent rules')
const saved = choose({ ...single.request, budgetMs: 10_000 })
assert.deepEqual(saved.action, only[0]); assert.equal(saved.stats.stopReason, 'single-defense'); assert.equal(saved.stats.depth, 0)
assert(saved.stats.defenseComplete)
console.log('ok: sole saving edge is proved and played without iterative deepening')

const forced = fixture('forced-win'), forcedBoard = boardOf(forced.request)
const won = choose({ ...forced.request, budgetMs: 3000 })
assert(unanswerable(forcedBoard, won.action, 'blue', 'red'), 'forced-win label must survive exhaustive independent defense enumeration')
assert.equal(won.stats.stopReason, 'forced-win')
console.log('ok: immediate unanswerable attack survives exhaustive TypeScript validation')

const danger = fixture('quiet-threat'), dangerBoard = boardOf(danger.request)
assert(!simulate(dangerBoard, 'blue').hits.includes('red'), 'danger is a future threat, not a current hit')
apply(dangerBoard, danger.badMove, 'red')
assert(unanswerable(dangerBoard, danger.winningReply, 'blue', 'red'), 'previous strategic move permits a fatal reply')
undo(dangerBoard, danger.badMove)
const defended = choose({ ...danger.request, budgetMs: 3000 })
assert(legal(dangerBoard, defended.action, 'red'))
apply(dangerBoard, defended.action, 'red')
assert(!unanswerable(dangerBoard, danger.winningReply, 'blue', 'red'), 'must account for the known fatal reply before choosing a quiet move')
// This fixture may still be lost to another route: no claim of global safety.
console.log('ok: quiet-position search anticipates and disrupts the known unanswerable reply')
