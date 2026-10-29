import assert from 'node:assert/strict'
import { createsEnclosure, edgeOf, seatColors, simulate, type Dir } from '../src/game'
import { generateOpening, maxOpeningMirrors, normalizeOpeningSettings, validOpening, type OpeningPosition } from '../src/opening'
import { applyRemote, applySnapshot, board, dispatch, dispatchAi, serialize, startLocal, startOnline, state, toLobby, topUndoFrame, undoDepth, wouldEncloseDiag } from '../src/store'

function position(size = 16, count = 24, seed = 123, players = seatColors(2), boundaryReflects = true): OpeningPosition {
  const generated = generateOpening(size, players, boundaryReflects, count, seed)
  const result = { size, players, boundaryReflects, mirrorsPerPlayer: count, seed,
    homes: generated.homes, edges: [...generated.edges], diags: [...generated.diags] }
  assert(validOpening(result, size, players, boundaryReflects))
  for (const color of players) {
    assert.equal(simulate(generated, color).hit, false, `${size}/${players.length}/${seed}: initial hit`)
    assert.equal(createsEnclosure(generated.edges, color, generated.homes, size, generated.diags), false)
    assert.equal([...generated.edges.values(), ...generated.diags.values()].filter(m => m.color === color).length, count + 3)
  }
  return result
}
let cases = 0
for (const size of [16, 17, 36, 48]) for (const n of [2, 3, 4]) for (const boundary of [true, false]) {
  position(size, 24, 100 + cases++, seatColors(n), boundary)
}
for (const n of [2, 3, 4]) for (const seed of [0, 1, 0xffffffff]) {
  position(16, maxOpeningMirrors(16, n), seed, seatColors(n)); cases++
}
position(48, maxOpeningMirrors(48, 4), 123, seatColors(4)); cases++
console.log(`ok: ${cases} safe openings across sizes 16/17/36/48, 2–4 players, both boundary rules and maximum densities`)
const initial = position()
assert.deepEqual(position(), initial)
assert.notDeepEqual(position(16, 24, 124), initial)
assert.deepEqual(normalizeOpeningSettings({ enabled: true, mirrorsPerPlayer: 99999 }, 16, 4), { enabled: true, mirrorsPerPlayer: 32 })
assert.throws(() => generateOpening(16, seatColors(2), true, 0, 1))
assert.throws(() => generateOpening(16, seatColors(2), true, 65, 1))
for (const corrupt of [
  (p: OpeningPosition) => { p.seed = -1 },
  (p: OpeningPosition) => { p.mirrorsPerPlayer++ },
  (p: OpeningPosition) => { p.edges.push(p.edges[0]!) },
  (p: OpeningPosition) => { p.edges[0]![1].color = 'red' },
  (p: OpeningPosition) => { p.homes.red = { ...p.homes.blue! } },
  (p: OpeningPosition) => { p.homes.red!.dir = 4 as Dir },
  (p: OpeningPosition) => { p.edges[0]![0] = 'h:01:0' },
  (p: OpeningPosition) => { p.diags[0]![0] = `${p.homes.blue!.x},${p.homes.blue!.y}` },
  (p: OpeningPosition) => { p.diags[0]![0] = '16,0' },
]) {
  const broken = structuredClone(initial)
  corrupt(broken)
  assert.equal(validOpening(broken, 16, seatColors(2), true), false)
}
// A geometrically legal board with an active winning beam must still be rejected.
const unsafe: OpeningPosition = { size: 16, players: seatColors(2), boundaryReflects: true, mirrorsPerPlayer: 1, seed: 1,
  homes: { blue: { x: 2, y: 2, dir: 0 }, red: { x: 10, y: 2, dir: 2 } }, edges: [],
  diags: [['0,0', { color: 'blue', ori: '/' }], ['15,15', { color: 'red', ori: '/' }]] }
for (const color of unsafe.players) {
  const h = unsafe.homes[color]!
  for (const d of [0, 1, 2, 3] as Dir[]) if (d !== h.dir) unsafe.edges.push([edgeOf(h.x, h.y, d), { color }])
}
assert.equal(validOpening(unsafe, 16, seatColors(2), true), false)
console.log('ok: seeded reproducibility, settings bounds and rejection of malformed / unsafe layouts')

const layout = () => JSON.parse(JSON.stringify({ homes: state.homes, edges: [...state.edges], diags: [...state.diags], seed: state.openingSeed }))
toLobby()
state.size = 16
state.clockSettings.enabled = false
startLocal(2, ['red'], {}, {}, initial)
assert.equal(state.phase, 'play')
assert.equal(state.current, 'blue')
assert.equal(state.winner, null)
assert.deepEqual(state.dead, [])
assert.equal(state.clock.runningSince, null)
assert.equal(undoDepth.value, 0)
assert.equal(topUndoFrame(), null)
assert.equal(state.openingSettings.mirrorsPerPlayer, 24)
assert.equal(board.diags.size, initial.diags.length, 'live board references must not be replaced')
const original = layout()
let moved = false
for (let y = 0; y < 16 && !moved; y++) for (let x = 0; x < 16 && !moved; x++) {
  if (state.diags.has(`${x},${y}`) || Object.values(state.homes).some(h => h.x === x && h.y === y) || wouldEncloseDiag(x, y, '/', 'blue')) continue
  dispatch({ kind: 'diag', x, y, ori: '/', color: 'blue' })
  moved = undoDepth.value === 1
}
assert(moved)
assert.equal(state.current, 'red')
// AI acts on a generated board through the same validated action interface.
let aiMoved = false
for (let y = 0; y < 16 && !aiMoved; y++) for (let x = 0; x < 16 && !aiMoved; x++) {
  aiMoved = dispatchAi({ kind: 'diag', x, y, ori: '/', color: 'red' })
}
assert(aiMoved)
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
assert.deepEqual(layout(), original)
assert.equal(undoDepth.value, 0)
assert.equal(state.phase, 'play')
const saved = serialize()
toLobby()
applySnapshot(saved)
assert.deepEqual(layout(), original)
assert.equal(state.openingSettings.enabled, true)
const second = position(16, 24, 124)
assert.equal(applyRemote({ kind: 'restart', color: 'blue' }), false, 'cannot discard generated opening on restart')
assert.equal(applyRemote({ kind: 'restart', color: 'blue', opening: position(16, 25) }), false)
assert.deepEqual(layout(), original)
dispatch({ kind: 'restart', color: 'blue', opening: second })
assert.equal(state.phase, 'play')
assert.equal(state.openingSeed, 124)
assert.equal(state.aiPaused, false)
console.log('ok: direct play, human + AI moves, undo floor, save/restore and fresh restart with equal counts')

state.clockSettings.enabled = true
startOnline('blue', '3001', seatColors(2), [], {}, {}, initial)
assert.equal(state.clock.runningSince === null, false)
const host = serialize()
startOnline('red', '3001', seatColors(2))
const guestSession = state.sessionId
applySnapshot(host, true)
assert.equal(state.myColor, 'red')
assert.equal(state.sessionId, guestSession)
assert.deepEqual(layout(), original)
assert.equal(applyRemote({ kind: 'restart', color: 'red', opening: second }), false)
assert.equal(applyRemote({ kind: 'restart', color: 'blue', opening: second }), true)
assert.equal(state.openingSeed, 124)
assert.equal(state.myColor, 'red')
assert.equal(state.phase, 'play')
assert.deepEqual(state.dead, [])
// Older saves and ordinary starts retain the manual base-placement flow.
const legacy = { ...saved }
delete legacy.openingSettings
delete legacy.openingSeed
applySnapshot(legacy)
assert.equal(state.openingSettings.enabled, false)
startLocal(2)
assert.equal(state.phase, 'setup')
assert.equal(state.edges.size + state.diags.size, 0)
assert.equal(state.clock.runningSince, null)
assert.throws(() => startLocal(2, [], {}, {}, unsafe))
assert.equal(state.phase, 'setup', 'failed generation validation cannot replace live game')
assert.equal(state.edges.size, 0)
toLobby()
console.log('ok: clock start, authoritative peer snapshot, restart authorization and legacy/manual opening compatibility')
