import assert from 'node:assert/strict'
import { edgeOf, PALETTE, simulate, type BoardState, type Dir, type Home } from '../src/game'
import { applyRemote, applySnapshot, board, dispatch, serialize, startLocal, state, toLobby } from '../src/store'

// 光先被己方斜镜分成右/上两束：右侧的第三家吸收直行光，只有上方边界反射能命中下方目标。
for (let colorIndex = 0; colorIndex < PALETTE.length; colorIndex++) {
  for (let turns = 0; turns < 4; turns++) {
    const color = PALETTE[colorIndex].id
    const target = PALETTE[(colorIndex + 1) % PALETTE.length].id
    const stopper = PALETTE[(colorIndex + 2) % PALETTE.length].id
    const rotate = (home: Home): Home => {
      let { x, y, dir } = home
      for (let i = 0; i < turns; i++) [x, y, dir] = [5 - y, x, ((dir + 1) % 4) as Dir]
      return { x, y, dir }
    }
    const b: BoardState = {
      size: 6, boundaryReflects: false,
      homes: {
        [color]: rotate({ x: 1, y: 1, dir: 0 }),
        [target]: rotate({ x: 3, y: 3, dir: 3 }),
        [stopper]: rotate({ x: 5, y: 1, dir: 2 }),
      },
      edges: new Map(), diags: new Map(),
    }
    for (const owner of [color, target, stopper]) {
      const home = b.homes[owner]!
      for (const d of [0, 1, 2, 3] as Dir[]) {
        if (d !== home.dir) b.edges.set(edgeOf(home.x, home.y, d), { color: owner })
      }
    }
    const mirror = rotate({ x: 3, y: 1, dir: 0 })
    b.diags.set(`${mirror.x},${mirror.y}`, { color, ori: turns % 2 ? '\\' : '/' })
    assert(!simulate(b, color).hits.includes(target), `关闭边界：${color} 旋转 ${turns} 不命中目标`)
    b.boundaryReflects = true
    assert(simulate(b, color).hits.includes(target), `开启边界：${color} 旋转 ${turns} 反射后命中目标`)
  }
}
console.log('ok: 四条边界对四种颜色均全反射，关闭后出界终止')

// 开启边界后会出现往返环路，仍必须终止；获胜路径包含真实的边界反射点。
const reflected: BoardState = {
  size: 6, boundaryReflects: true,
  homes: { blue: { x: 1, y: 1, dir: 0 }, red: { x: 3, y: 3, dir: 3 } },
  edges: new Map(), diags: new Map([['3,1', { color: 'blue', ori: '/' }]]),
}
const before = Date.now()
const result = simulate(reflected, 'blue')
assert(result.hitPath?.some(p => p.x === 0 || p.y === 0 || p.x === 6 || p.y === 6))
assert(Date.now() - before < 1000, '边界往返环路必须终止')
console.log('ok: 反射路径包含边界折点，循环光路正常终止')

assert.equal(state.boundaryReflects, true, '新对局默认开启')
for (const enabled of [false, true]) {
  startLocal(2)
  dispatch({ kind: 'boundary-setting', color: 'blue', enabled })
  assert.equal(board.boundaryReflects, enabled, '模拟器读取当前规则')
  dispatch({ kind: 'setup', color: 'blue', home: { x: 1, y: 1, dir: 0 } })
  dispatch({ kind: 'setup', color: 'red', home: { x: 3, y: 3, dir: 3 } })
  dispatch({ kind: 'boundary-setting', color: 'blue', enabled: !enabled })
  assert.equal(state.boundaryReflects, enabled, '开局后禁止修改规则')
  dispatch({ kind: 'diag', color: 'blue', x: 3, y: 1, ori: '/' })
  assert.equal(state.phase, 'play', '命中仍延迟到下一回合结算')
  dispatch({ kind: 'edge', color: 'red', id: 'h:25:25' })
  assert.equal(state.dead.includes('red'), enabled, '边界反射必须参与实际胜负结算')
}
console.log('ok: 开局后规则锁定，实际结算使用所选边界规则')

const saved = serialize()
assert.equal(saved.boundaryReflects, true)
applySnapshot({ ...saved, boundaryReflects: false })
assert.equal(state.boundaryReflects, false)
applySnapshot(saved)
assert.equal(state.boundaryReflects, true)
const { boundaryReflects: _, ...oldSave } = saved
applySnapshot(oldSave)
assert.equal(state.boundaryReflects, false, '旧存档保留不反射的规则')
dispatch({ kind: 'restart', color: 'blue' })
dispatch({ kind: 'boundary-setting', color: 'blue', enabled: true })
assert.equal(state.boundaryReflects, true, '重新开始后允许设置')
console.log('ok: 开关随存档恢复，旧存档兼容，重新开始后可改')

startLocal(2)
state.mode = 'online'
state.myColor = 'red'
assert(!applyRemote({ kind: 'boundary-setting', color: 'red', enabled: false }), '客人无权改规则')
dispatch({ kind: 'boundary-setting', color: 'blue', enabled: false })
assert.equal(state.boundaryReflects, true, '客人不能冒充房主改规则')
assert(applyRemote({ kind: 'boundary-setting', color: 'blue', enabled: false }), '接受房主同步的规则')
assert.equal(state.boundaryReflects, false)
toLobby()
assert.equal(state.boundaryReflects, true, '回大厅后新局恢复默认开启')
console.log('ok: 联机只接受房主设置，新局默认开启')
