// Store/Worker integration checks; no browser or compiled WASM required.
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import { makeAiRequest, type AiRequest, type AiResponse } from '../src/ai/protocol'
import { aiStatus, retryAi, startAiController } from '../src/ai/controller'
import {
  applySnapshot, board, canAct, dispatch, dispatchAi, lastAiAnalysis, serialize, setupColor, startLocal,
  startOnline, state, tickClock, toLobby, topUndoFrame,
} from '../src/store'

const encoded = makeAiRequest({
  size: 7, homes: { blue: { x: 1, y: 1, dir: 0 } },
  edges: new Map([['h:6:7', { color: 'green' }], ['v:7:6', { color: 'red' }]]),
  diags: new Map([['2,3', { color: 'yellow', ori: '\\' }]]),
}, { phase: 'play', players: ['blue', 'red', 'yellow', 'green'], current: 'yellow', dead: ['red'], budgetMs: 30 })
assert.equal(encoded.horizontal.length, 56)
assert.equal(encoded.vertical.length, 56)
assert.equal(encoded.horizontal[55], 4)
assert.equal(encoded.vertical[55], 2)
assert.equal(encoded.diagonals[23], 6)
assert.equal(encoded.aliveMask, 13)
assert.equal(encoded.current, 2)
assert.equal(encoded.homes.length, 4)
console.log('ok: arbitrary board size, row-major arrays, colors and alive mask')

class FakeWorker {
  onmessage: ((event: MessageEvent<AiResponse>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request: AiRequest | null = null
  terminated = false
  postMessage(request: AiRequest) { this.request = request }
  terminate() { this.terminated = true }
  answer(response: AiResponse) { this.onmessage?.({ data: response } as MessageEvent<AiResponse>) }
}
const workers: FakeWorker[] = []
const stop = startAiController(() => {
  const worker = new FakeWorker()
  workers.push(worker)
  return worker as unknown as Worker
})
const latest = () => workers.at(-1)!

state.size = 16
state.boundaryReflects = false
startLocal(3, ['red', 'yellow'])
await nextTick()
assert.equal(state.boundaryReflects, true)
assert.equal(workers.length, 0)
assert.equal(setupColor.value, 'blue')
dispatch({ kind: 'setup', color: 'red', home: { x: 10, y: 8, dir: 2 } })
assert.equal(state.homes.red, undefined)
dispatch({ kind: 'boundary-setting', color: 'blue', enabled: false })
assert.equal(state.boundaryReflects, true)
dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
await nextTick()
assert.equal(canAct.value, false)
assert.equal(latest().request?.current, 1)
latest().answer({ action: { kind: 'setup', home: { x: 10, y: 8, dir: 2 } } })
await nextTick()
assert.equal(latest().request?.current, 2)
latest().answer({ action: { kind: 'setup', home: { x: 5, y: 12, dir: 3 } } })
await nextTick()
assert.equal(state.phase, 'play')
assert.equal(state.current, 'blue')
assert.equal(canAct.value, true)
assert.equal(workers.length, 2)
console.log('ok: human-first setup, sequential AI homes, enforced reflection and seat permissions')

dispatch({ kind: 'edge', color: 'blue', id: 'h:13:14' })
await nextTick()
assert.equal(aiStatus.status, 'thinking')
assert.equal(latest().request?.phase, 'play')
const thinking = latest()
const workerCount = workers.length
for (let i = 0; i < 5; i++) { tickClock(Date.now()); await nextTick() }
assert.equal(workers.length, workerCount)
dispatch({ kind: 'edge', color: 'red', id: 'h:12:14' })
assert.equal(state.edges.has('h:12:14'), false)
dispatch({ kind: 'undo', color: 'red', frame: topUndoFrame()! })
await nextTick()
assert.equal(thinking.terminated, true)
assert.equal(state.aiPaused, true)
thinking.answer({ action: { kind: 'edge', id: 'h:12:14' } })
assert.equal(state.edges.has('h:12:14'), false)
assert.equal(state.current, 'blue')
console.log('ok: clock ticks preserve searches; undo terminates searches and rejects stale replies')

dispatch({ kind: 'edge', color: 'blue', id: 'h:13:14' })
await nextTick()
const failedWorker = latest()
failedWorker.onerror?.({ message: '', filename: '', lineno: 0, colno: 0 } as ErrorEvent)
assert.equal(aiStatus.status, 'error')
assert.match(aiStatus.error, /刷新页面/)
assert.equal(failedWorker.terminated, true)
assert.equal(state.current, 'red')
retryAi()
await nextTick()
assert.notEqual(latest(), failedWorker)
assert.deepEqual(latest().request, failedWorker.request)
failedWorker.onerror?.({ message: 'late error' } as ErrorEvent)
assert.equal(aiStatus.status, 'thinking')
assert.equal(aiStatus.error, '')
console.log('ok: Worker startup failure preserves position, offers recovery and ignores stale errors')
latest().answer({ action: { kind: 'diag', x: 100, y: 100, ori: '/' } })
assert.equal(aiStatus.status, 'error')
assert.equal(state.current, 'red')
assert.equal(state.diags.size, 0)
retryAi()
await nextTick()
latest().answer({ action: { kind: 'diag', x: 12, y: 12, ori: '/' }, stats: { nodes: 50, depth: 2, elapsedMs: 12.5, score: 10, mode: 'attack', candidates: 3, plans: 2, stopReason: 'stable', reason: '连接光路。' } })
await nextTick()
assert.equal(state.diags.get('12,12')?.color, 'red')
assert.deepEqual(lastAiAnalysis.value, { color: 'red', elapsedMs: 12.5, reason: '连接光路。' })
assert.equal(state.current, 'yellow')
const stale = latest()
dispatch({ kind: 'restart', color: 'blue' })
await nextTick()
stale.answer({ action: { kind: 'diag', x: 11, y: 12, ori: '/' } })
assert.equal(state.diags.size, 0)
assert.equal(lastAiAnalysis.value, null)
assert.deepEqual([...state.aiPlayers], ['red', 'yellow'])
console.log('ok: illegal results fail visibly; retry succeeds; restart preserves seats and rejects stale replies')

startLocal(2, ['blue', 'red'])
await nextTick()
assert.equal(latest().request?.current, 0)
const beforeSnapshot = latest()
const snapshot = serialize()
applySnapshot(snapshot)
await nextTick()
assert.equal(beforeSnapshot.terminated, true)
assert.deepEqual([...state.aiPlayers], ['blue', 'red'])
assert.equal(latest().request?.current, 0)
state.peerLeft = true
await nextTick()
assert.equal(latest().terminated, true)
state.peerLeft = false
await nextTick()
const beforeLobby = latest()
toLobby()
await nextTick()
assert.equal(beforeLobby.terminated, true)
assert.equal(aiStatus.status, 'idle')
console.log('ok: all-AI seats, snapshot restore, disconnect and lobby cancellation')

startOnline('red', '3001', ['blue', 'red', 'yellow'], ['yellow'])
state.homes.blue = { x: 2, y: 2, dir: 0 }
state.homes.red = { x: 10, y: 8, dir: 2 }
const guestWorkers = workers.length
await nextTick()
assert.equal(workers.length, guestWorkers)
assert.equal(dispatchAi({ kind: 'setup', color: 'yellow', home: { x: 5, y: 12, dir: 3 } }), false)
state.myColor = 'blue'
await nextTick()
assert.equal(latest().request?.current, 2)
const beforeSettings = latest()
dispatch({ kind: 'laser-setting', color: 'blue', allow: true })
dispatch({ kind: 'undo-setting', color: 'blue', allow: true })
await nextTick()
assert.equal(latest(), beforeSettings)
assert.equal(beforeSettings.terminated, false)
assert.equal(makeAiRequest(board, { phase: 'setup', players: state.players, current: 'yellow', dead: [], budgetMs: 30 }).homes[1]?.x, 10)
console.log('ok: online guests never run AI; host alone controls AI seats')

toLobby()
startLocal(2, ['red'])
dispatch({ kind: 'clock-setting', color: 'blue', settings: { enabled: true, initialMs: 10_000, incrementMs: 0 } })
dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
await nextTick()
latest().answer({ action: { kind: 'setup', home: { x: 10, y: 8, dir: 2 } } })
await nextTick()
dispatch({ kind: 'edge', color: 'blue', id: 'h:13:14' })
await nextTick()
const timedOutWorker = latest()
state.clock.remaining.red = 1
state.clock.runningSince = Date.now() - 10
assert.equal(tickClock(), true)
await nextTick()
assert.equal(timedOutWorker.terminated, true)
assert.equal(state.phase, 'over')
assert.equal(state.winner, 'blue')
timedOutWorker.answer({ action: { kind: 'edge', id: 'h:12:14' } })
assert.equal(state.edges.has('h:12:14'), false)
console.log('ok: clock timeout cancels AI and rejects an otherwise legal late move')

toLobby()
stop()
console.log('AI integration checks passed')
