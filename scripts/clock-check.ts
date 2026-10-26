import assert from 'node:assert/strict'
import { applyClockSync, applySnapshot, dispatch, remainingTime, serialize, startLocal, state, tickClock, topUndoFrame } from '../src/store'

const realNow = Date.now
let now = realNow()
Date.now = () => now
const left = (c: 'blue' | 'red' | 'yellow') => remainingTime(c, now)
function setup(count = 2, initialMs = 120000, incrementMs = 10000) {
  startLocal(count)
  dispatch({ kind: 'clock-setting', color: 'blue', settings: { enabled: true, initialMs, incrementMs } })
  dispatch({ kind: 'setup', color: 'blue', home: { x: 6, y: 6, dir: 0 } })
  now += 5000
  assert.equal(left('blue'), initialMs, '布置阶段不计时')
  dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 8, dir: 1 } })
  if (count === 3) dispatch({ kind: 'setup', color: 'yellow', home: { x: 13, y: 20, dir: 3 } })
}
try {
  setup()
  now += 5000
  dispatch({ kind: 'edge', color: 'blue', id: 'v:7:6' })
  assert.equal(left('blue'), 115000, '非法落子不加秒也不停止计时')
  dispatch({ kind: 'edge', color: 'blue', id: 'h:25:25' })
  assert.equal(left('blue'), 125000, '扣 5 秒，加 10 秒')
  assert.equal(left('red'), 120000)
  now += 2000
  dispatch({ kind: 'edge', color: 'red', id: 'h:26:25' })
  assert.equal(left('red'), 128000)
  dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
  assert.equal(left('red'), 118000, '撤回恢复加秒前的剩余时间')
  assert.equal(state.current, 'red')
  const save = serialize()
  now += 1000
  applySnapshot(save)
  assert.equal(left('red'), 117000, '单机刷新不会补回已经用掉的时间')
  console.log('ok: 布置不计时、只扣行动者、合法落子加秒、非法落子不加秒、撤回和存档恢复')

  setup(2, 1000, 10000)
  now += 1001
  dispatch({ kind: 'edge', color: 'blue', id: 'h:25:25' })
  assert.equal(state.winner, 'red', '截止后到达的落子不能抢救超时')
  assert(!state.edges.has('h:25:25'))
  assert.deepEqual([...state.timedOut], ['blue'])
  assert.equal(tickClock(now), false, '超时不重复结算')
  setup(3, 1000, 0)
  now += 1100
  tickClock(now)
  assert.equal(state.phase, 'play')
  assert.equal(state.current, 'red')
  assert.equal(left('red'), 900)
  now += 1000
  tickClock(now)
  assert.equal(state.winner, 'yellow')
  console.log('ok: 双人超时判负，多人淘汰后继续，后台延迟按真实截止时刻结算')

  setup(2, 10000, 0)
  now += 1000
  state.peerLeft = true
  const paused = left('blue')
  now += 20000
  tickClock(now)
  assert.equal(left('blue'), paused)
  state.peerLeft = false
  now += 1000
  assert.equal(left('blue'), paused - 1000)
  const sync = { ...serialize().clock!, at: now - 300000, runningSince: now - 300000 }
  state.mode = 'online'
  state.myColor = 'red'
  applyClockSync(sync, true)
  assert.equal(left('blue'), sync.remaining.blue, '客人设备时间偏差不影响显示')
  now += 1000
  assert.equal(left('blue'), sync.remaining.blue - 1000)
  assert.equal(tickClock(now + 600000), false, '客人不会自行判超时')
  console.log('ok: 掉线暂停、重连继续、校准客人时钟偏差、客人不自行判负')
} finally { Date.now = realNow }
