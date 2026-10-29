import assert from 'node:assert/strict'
import { edgeOf, type BoardState, type Color, type Dir } from '../src/game.ts'
import { makeAiRequest } from '../src/ai/protocol.ts'
import { createGameTools, decode, describePosition, type AnalysisRequest } from './dsh-browser/tools.ts'

function fixture(n = 16, players: Color[] = ['blue', 'red']) {
  const b: BoardState = { size: n, boundaryReflects: true, homes: {}, edges: new Map(), diags: new Map() }
  const positions = [[2, 2], [n - 3, n - 3], [2, n - 3], [n - 3, 2]]
  players.forEach((c, i) => {
    const [x, y] = positions[i], dir = (i % 2 ? 2 : 0) as Dir
    b.homes[c] = { x, y, dir }
    for (const d of [0, 1, 2, 3] as Dir[]) if (d !== dir) b.edges.set(edgeOf(x, y, d), { color: c })
  })
  return makeAiRequest(b, { phase: 'play', players, current: 'blue', dead: [], budgetMs: 10000 })
}
const request = fixture(), selected: unknown[] = []
const tools = createGameTools(request, (action, rationale) => selected.push({ action, rationale }))
function valid(result: ReturnType<typeof tools.analyze>) {
  assert(result.valid, 'expected a legal analysis')
  return result
}
const inspect = (args: AnalysisRequest = {}) => valid(tools.analyze(args))
const before = inspect(), original = structuredClone(request)
assert.deepEqual(Object.keys(tools), ['analyze', 'play'])
assert(!('light' in before) && !('edges' in before.position!) && !('hitPaths' in before.position!), 'default analysis omits the board and light paths')
assert.deepEqual(decode(request).board.homes, { blue: { x: 2, y: 2, dir: 0 }, red: { x: 13, y: 13, dir: 2 } })
assert.deepEqual(inspect({ light: { color: 'blue', target: { x: 2, y: 13 } } }).light?.pathToTarget, [{ x: 2.5, y: 2.5 }, { x: 2.5, y: 13.5 }])
assert.equal(inspect({ light: { color: 'blue', target: { x: 5, y: 5 } } }).light?.pathToTarget, null)
const attacks = before.moves!.attack
assert.equal(attacks.total, 2)
assert(attacks.candidates.every(c => c.action.kind === 'diag' && c.action.x === 2 && c.action.y === 13 && c.safe && c.attacks.includes('red')))
const page = inspect({ limit: 1 }).moves!.attack
assert.equal(page.nextOffset, 1)
assert.notDeepEqual(page.candidates, inspect({ limit: 1, offset: 1 }).moves!.attack.candidates)
assert.throws(() => tools.analyze({ offset: -1 }), /offset/)
assert.throws(() => tools.analyze({ limit: 21 }), /limit/)
assert.throws(() => tools.analyze({ sequence: Array(9).fill({}) }), /0..8/)
assert.equal(tools.analyze({ sequence: [{ kind: 'diag', x: 2, y: 2, ori: '/' }] }).valid, false)
assert.throws(() => tools.play({ action: { kind: 'edge', id: 'v:3:2' }, rationale: 'close the exit' }), /enclosure/)
assert.throws(() => tools.play({ action: { kind: 'edge', id: 'h:1:0' }, rationale: 'boundary' }), /boundary/)
assert.throws(() => tools.play({ action: { kind: 'diag', x: 2, y: 2, ori: '/' }, rationale: 'base' }), /base cell/)
assert.throws(() => tools.play({ action: { kind: 'edge', id: 'd:2:13:/' }, rationale: 'wrong type' }), /Invalid action/)
const action = { kind: 'diag', x: 2, y: 13, ori: '/' }
const checked = inspect({ sequence: [action], light: { color: 'blue' } })
assert.equal(checked.position!.current, 'red')
assert.deepEqual(checked.position!.threats, ['blue'])
assert(checked.light?.hits.includes('red'))
assert(checked.moves!.defend.total > 0, 'enumerate defenses on the hypothetical board, not the real board')
assert.equal(before.moves!.defend.total, 0)
for (const defense of checked.moves!.defend.candidates) {
  const defended = inspect({ sequence: [action, defense.action] })
  assert.equal(defended.position!.current, 'blue')
  assert.equal(defended.position!.winner, null)
  assert(!defended.position!.hits.blue.includes('red'), 'each advertised save must actually stop the attack')
}
const line = inspect({ sequence: [action, { kind: 'diag', x: 8, y: 8, ori: '/' }] })
assert(line.valid && line.position)
assert.equal(line.steps[0].winner, null)
assert.equal(line.steps[1].winner, 'blue')
assert(!('moves' in line), 'terminal analysis does not enumerate further moves')
assert.deepEqual(tools.analyze(), before, 'Queries must leave the board unchanged')
assert.deepEqual(request, original)
assert.deepEqual(tools.play({ action, rationale: 'direct attack' }), { ok: true })
assert.equal(selected.length, 1)
assert.throws(() => tools.play({ action: { kind: 'diag', x: 0, y: 0, ori: '/' }, rationale: 'second selection' }), /already been selected/)
assert.equal(selected.length, 1, 'one request can select only one move')
assert.deepEqual(tools.analyze(), before, 'Selection must be committed by the controller, not tools')
for (const n of [8, 23]) assert.equal(valid(createGameTools(fixture(n), () => {}).analyze()).position.size, n)
const multi = createGameTools(fixture(16, ['blue', 'red', 'yellow', 'green']), () => {})
assert.equal(valid(multi.analyze()).position.alive.length, 4)
assert(valid(multi.analyze({ light: { color: 'green', target: { x: 13, y: 8 } } })).light?.pathToTarget)
const setupRequest = fixture()
setupRequest.phase = 'setup'; setupRequest.current = 1; setupRequest.homes[1] = null
setupRequest.horizontal = setupRequest.horizontal.map(c => c === 2 ? 0 : c)
setupRequest.vertical = setupRequest.vertical.map(c => c === 2 ? 0 : c)
const setup = createGameTools(setupRequest, () => {})
assert.equal(valid(setup.analyze()).position.phase, 'setup')
assert(!('moves' in setup.analyze()))
assert.throws(() => setup.play({ action: { kind: 'setup', home: { x: 3, y: 3, dir: 0 } }, rationale: 'near' }), /too close/)
assert.throws(() => setup.play({ action: { kind: 'setup', home: { x: 15, y: 13, dir: 0 } }, rationale: 'outside' }), /boundary/)
setup.play({ action: { kind: 'setup', home: { x: 13, y: 13, dir: 2 } }, rationale: 'legal base' })
assert.equal(describePosition(request).diags.length, 0)
console.log('ok: two DSH tools; exact hypothetical defenses and turn settlement, optional paths, compact replies, pagination, sizes, multiplayer, setup, query isolation and one selection per turn')
