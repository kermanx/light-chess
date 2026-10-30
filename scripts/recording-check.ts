import assert from 'node:assert/strict'
import { PALETTE, seatColors } from '../src/game'
import { generateOpening } from '../src/opening'
import { appendRecording, newRecording, playback, recordedPosition } from '../src/replay/recording'
import { recordingFromTest } from '../src/replay/archive'
import { applyRemote, applySnapshot, dispatch, dispatchAi, serialize, setSender, startLocal, startOnline, state, tickClock, toLobby, topUndoFrame, type Action, type Snapshot } from '../src/store'
import type { TestEvent } from '../src/ai/test-records'
import { snapshotChunks, SnapshotReceiver } from '../src/replay/transport'

const frozen = <T>(v: T): T => JSON.parse(JSON.stringify(v))
function matches(snapshot = serialize()) {
  const game = frozen(state.recording!)
  const last = playback(game).frames.at(-1)!
  const p = recordedPosition(snapshot)
  assert.deepEqual([...last.board.edges].sort(), p.edges.sort())
  assert.deepEqual([...last.board.diags].sort(), p.diags.sort())
  assert.deepEqual(last.board.homes, p.homes)
  for (const key of ['current', 'phase', 'winner', 'dead', 'timedOut', 'actors'] as const) assert.deepEqual(last[key], p[key], key)
  assert.equal(last.board.size, p.size)
  assert.equal(last.board.boundaryReflects, p.boundaryReflects)
  return game
}
const realNow = Date.now
let now = realNow()
Date.now = () => now
try {
  state.size = 16
  startLocal(2, ['red'])
  const firstId = state.recording!.id
  assert.equal(playback(state.recording!).frames.length, 1)
  dispatch({ kind: 'board-size', color: 'blue', size: 17 })
  matches()
  dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
  assert(dispatchAi({ kind: 'setup', color: 'red', home: { x: 10, y: 8, dir: 2 } }))
  matches()
  const count = state.recording!.events.length
  dispatch({ kind: 'diag', color: 'red', x: 1, y: 1, ori: '/' })
  assert.equal(state.recording!.events.length, count, 'rejected human move on AI seat is never recorded')
  dispatch({ kind: 'diag', color: 'blue', x: 0, y: 0, ori: '/' })
  const snapshot = frozen(serialize())
  applySnapshot(snapshot)
  assert.equal(state.recording!.id, firstId, 'reload retains round and prior timeline')
  assert(dispatchAi({ kind: 'diag', color: 'red', x: 15, y: 15, ori: '\\', aiAnalysis: { elapsedMs: 123, reason: '保存实际落子说明' } }))
  assert.equal(state.recording!.events.at(-1)!.rationale, '保存实际落子说明')
  const beforeUndo = matches()
  dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
  const undone = matches()
  assert.equal(undone.events.at(-1)!.kind, 'undo')
  assert.equal(playback(beforeUndo).frames.at(-1)!.board.diags.has('15,15'), true)
  assert.equal(playback(undone).frames.at(-1)!.board.diags.has('15,15'), false)
  assert.equal(playback(undone).frames.at(-2)!.board.diags.has('15,15'), true, 'undo does not erase historical actions')
  dispatch({ kind: 'restart', color: 'blue' })
  assert.notEqual(state.recording!.id, firstId)
  assert.equal(state.recording!.events.length, 0)
  matches()
  console.log('ok: setup, resizing, human/AI moves, rejected actions, analysis, reload, undo and separate restarted rounds')

  for (const n of [3, 4]) {
    toLobby()
    state.size = 16
    state.clockSettings = { enabled: true, initialMs: 1000, incrementMs: 0 }
    const players = seatColors(n), board = generateOpening(16, players, true, 4, 123 + n)
    const opening = { size: 16, players, boundaryReflects: true, mirrorsPerPlayer: 4, seed: 123 + n, homes: board.homes, edges: [...board.edges], diags: [...board.diags] }
    startLocal(n, [], {}, {}, opening)
    assert.equal(state.recording!.initial.diags.length, board.diags.size, 'preset mirrors are part of initial state')
    for (let i = 0; i < n - 1; i++) {
      now += 1001
      assert(tickClock(now))
      matches()
    }
    const game = matches(), frames = playback(game).frames
    assert.equal(game.winner, players.at(-1))
    assert.deepEqual(frames.at(-1)!.timedOut, players.slice(0, -1))
    assert.equal(frames.length, n)
    assert.equal(frames[1].clock!.remaining.blue, 0)
  }
  console.log('ok: 3/4-player preset openings, clocks, multiple eliminations and final winner')

  toLobby(); state.size = 16
  startOnline('blue', '3001', ['blue', 'red'])
  const hostInitial = frozen(serialize())
  dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
  const action: Action = { kind: 'setup', color: 'red', home: { x: 10, y: 8, dir: 2 } }
  assert(applyRemote(action))
  dispatch({ kind: 'diag', color: 'blue', x: 0, y: 0, ori: '/' })
  const host = frozen(serialize())
  startOnline('red', '3001', ['blue', 'red'])
  const guestSession = state.sessionId
  applySnapshot(hostInitial, true)
  assert.equal(state.recording!.id, hostInitial.recording!.id)
  applySnapshot(host, true)
  assert.equal(state.sessionId, guestSession)
  assert.equal(state.myColor, 'red')
  assert.deepEqual(matches(), host.recording, 'reconnection restores the host timeline, not just its last board')
  applySnapshot(host)
  const sent: Action[] = []
  setSender(a => sent.push(a))
  dispatch({ kind: 'restart', color: 'blue' })
  const hostRestartId = state.recording!.id
  applySnapshot({ ...host, myColor: 'red' })
  assert(applyRemote(sent.at(-1)!))
  assert.equal(state.recording!.id, hostRestartId, 'restart broadcasts one shared round ID')
  console.log('ok: online identity preservation, shared round IDs, full reconnect history and restart')

  const legacy = frozen(snapshot); delete legacy.recording
  applySnapshot(legacy)
  assert.equal(state.recording!.historyComplete, false, 'legacy final snapshots do not claim a complete history')
  const base = newRecording(legacy, { id: crypto.randomUUID() })
  const later = frozen(legacy); later.diags.push(['3,3', { color: 'red', ori: '/' }]); later.current = 'blue'
  const restored = appendRecording(base, legacy, later)
  assert.equal(restored.historyComplete, false)
  const events: TestEvent[] = [
    { v: 1, id: 'a', gameId: base.id, parentId: null, sequence: 1, tabId: 'tab', at: base.createdAt, type: 'game-start', detail: { snapshot: legacy } },
    { v: 1, id: 'b', gameId: base.id, parentId: 'a', sequence: 2, tabId: 'tab', at: base.createdAt, type: 'action', detail: { before: legacy, after: later, action: { kind: 'diag', color: 'red', x: 3, y: 3, ori: '/' } } },
    { v: 1, id: 'branch', gameId: base.id, parentId: 'a', sequence: 2, tabId: 'other', at: base.createdAt, type: 'action', detail: { before: legacy, after: legacy } },
  ]
  const imported = recordingFromTest({ id: base.id, createdAt: base.createdAt, headId: 'b', sequence: 2, moveCount: 1, snapshot: later }, events)
  assert.equal(imported.historyComplete, true)
  assert.equal(imported.events.length, 1)
  assert.equal(playback(imported).frames.at(-1)!.board.diags.has('3,3'), true)
  assert(!JSON.stringify(imported).includes('roomCode'))
  assert(!JSON.stringify(imported).includes('aiProfileIds'))
  assert.equal(PALETTE.length, 4)
  console.log('ok: honest partial legacy records, AI-test lineage migration, no private settings in portable records')
  const large = { t: 'sync', snap: host, history: '光路说明\\\\\n'.repeat(100_000) }
  const chunks = snapshotChunks(large)!, receiver = new SnapshotReceiver()
  assert(chunks.length > 1)
  let received: unknown
  for (const chunk of chunks) {
    assert(Buffer.byteLength(JSON.stringify(chunk)) * 4 / 3 + 1024 < 512 * 1024)
    received = receiver.receive(chunk)
  }
  assert.deepEqual(received, large)
  assert.equal(snapshotChunks({ t: 'act', act: action }), null)
  assert.equal(receiver.receive(chunks.at(-1)!), undefined, 'incomplete history is never applied')
  console.log('ok: long reconnect snapshots fit encrypted relay limits and reassemble without truncation')
} finally {
  Date.now = realNow
  setSender(null)
  toLobby()
}
