// Undo pause/resume must preserve the clock and use the host-authoritative action channel.
import assert from 'node:assert/strict'
import { cancelAi, retryAi } from '../src/ai/controller'
import {
  applyRemote, applySnapshot, dispatch, dispatchAi, remainingTime, serialize, serializeClock,
  setSender, startLocal, startOnline, state, tickClock, toLobby, topUndoFrame, type Action,
} from '../src/store'

const realNow = Date.now
let now = realNow()
Date.now = () => now
const left = (color: 'blue' | 'red' | 'yellow') => remainingTime(color, now)
const edge = (color: 'blue' | 'red' | 'yellow', x: number): Action => ({ kind: 'edge', color, id: `h:${x}:0` })
const undo = () => dispatch({ kind: 'undo', color: state.mode === 'online' ? 'blue' : state.current, frame: topUndoFrame()! })
try {
  state.size = 16
  startLocal(2, ['red'])
  dispatch({ kind: 'clock-setting', color: 'blue', settings: { enabled: true, initialMs: 10000, incrementMs: 1000 } })
  dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
  assert(dispatchAi({ kind: 'setup', color: 'red', home: { x: 10, y: 8, dir: 2 } }))
  now += 1000
  dispatch(edge('blue', 0))
  now += 2000
  assert(dispatchAi(edge('red', 1)))
  undo()
  assert.equal(state.current, 'red')
  assert.equal(state.aiPaused, true)
  assert.equal(state.clock.runningSince, null)
  assert.equal(left('red'), 8000)
  const turn = state.clock.turn
  now += 100000
  assert.equal(tickClock(now), false)
  assert.equal(left('red'), 8000)
  state.peerLeft = true
  state.peerLeft = false
  assert.equal(state.clock.runningSince, null, '重连不能自动恢复主动暂停的 AI')
  const paused = serialize()
  now += 100000
  applySnapshot(paused)
  assert.equal(left('red'), 8000, '存档恢复保留暂停时的剩余时间')
  assert.equal(state.clock.runningSince, null)
  retryAi()
  assert.equal(state.aiPaused, false)
  assert.equal(state.clock.turn, turn, '恢复不新增回合')
  assert.equal(state.clock.runningSince, now)
  assert.equal(left('red'), 8000, '恢复不加秒')
  now += 500
  assert.equal(left('red'), 7500)
  assert(dispatchAi(edge('red', 1)))
  undo()
  assert.equal(state.clock.runningSince, null)
  // Snapshot restoration clears old undo history. Rebuild a two-move history for human-turn undo.
  retryAi()
  assert(dispatchAi(edge('red', 1)))
  now += 1000
  dispatch(edge('blue', 2))
  undo()
  assert.equal(state.current, 'blue')
  assert.equal(state.aiPaused, true)
  assert.equal(state.clock.runningSince, now, '撤回到真人回合仍计时')
  const humanLeft = left('blue')
  now += 500
  assert.equal(left('blue'), humanLeft - 500)
  dispatch(edge('blue', 2))
  assert.equal(state.aiPaused, false, '真人继续落子解除暂停')
  assert.equal(state.current, 'red')
  assert.equal(state.clock.runningSince, now)
  console.log('ok: AI-turn undo pauses clock; restore/reconnect preserve it; explicit resume keeps turn/time; human-turn undo keeps clock running')

  now += 200
  const beforeCancel = left('red')
  cancelAi()
  assert.equal(state.aiPaused, true)
  assert.equal(state.clock.runningSince, null)
  now += 100000
  assert.equal(tickClock(now), false)
  assert.equal(left('red'), beforeCancel)
  retryAi()
  assert.equal(left('red'), beforeCancel)
  now += beforeCancel + 1
  cancelAi()
  assert.equal(state.phase, 'over', '取消不能抢在超时结算之前冻结已用完的棋钟')
  assert.equal(state.aiPaused, false)
  console.log('ok: explicit cancellation pauses the AI clock, resumes remaining time and cannot prevent an expired timeout')

  toLobby()
  state.size = 16
  startOnline('blue', '3001', ['blue', 'red', 'yellow'], ['yellow'])
  dispatch({ kind: 'clock-setting', color: 'blue', settings: { enabled: true, initialMs: 10000, incrementMs: 1000 } })
  dispatch({ kind: 'undo-setting', color: 'blue', allow: true, floor: 0 })
  dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
  assert(applyRemote({ kind: 'setup', color: 'red', home: { x: 10, y: 8, dir: 2 } }))
  assert(dispatchAi({ kind: 'setup', color: 'yellow', home: { x: 5, y: 12, dir: 3 } }))
  dispatch(edge('blue', 0))
  assert(applyRemote(edge('red', 1)))
  now += 1000
  assert(dispatchAi(edge('yellow', 2)))
  undo()
  assert.equal(state.current, 'yellow')
  assert.equal(state.clock.runningSince, null)
  const onlinePaused = serialize()
  const messages: Action[] = []
  setSender(action => messages.push(action), true)
  state.myColor = 'red'
  retryAi()
  dispatch({ kind: 'ai-resume', color: 'red' })
  dispatch({ kind: 'ai-resume', color: 'blue' })
  assert.equal(state.aiPaused, true)
  assert.equal(messages.length, 0, '客人不能本地恢复或冒充房主发送恢复')
  state.myColor = 'blue'
  setSender(action => messages.push(action))
  assert.equal(applyRemote({ kind: 'ai-resume', color: 'red' }), false, '房主拒绝客人的恢复动作')
  const pausedLeft = left('yellow')
  now += 100000
  retryAi()
  assert.deepEqual(messages, [{ kind: 'ai-resume', color: 'blue' }])
  assert.equal(state.aiPaused, false)
  assert.equal(left('yellow'), pausedLeft)
  const authoritativeClock = serializeClock()
  const resumedTurn = state.clock.turn
  applySnapshot(onlinePaused)
  state.myColor = 'red'
  assert(applyRemote(messages[0], authoritativeClock))
  assert.equal(state.aiPaused, false, '客人收到权威动作立即解除暂停')
  assert.equal(state.clock.turn, resumedTurn)
  assert.equal(state.clock.runningSince, authoritativeClock.at)
  now += 500
  assert.equal(left('yellow'), pausedLeft - 500, '客人同步恢复原回合棋钟')
  console.log('ok: only host can resume online AI; explicit action broadcasts pause state and synchronizes the unchanged turn clock')
} finally {
  setSender(null)
  toLobby()
  Date.now = realNow
}
