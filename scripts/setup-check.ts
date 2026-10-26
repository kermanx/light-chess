import assert from 'node:assert/strict'
import { edgeOf, simulate, type Dir, type Home } from '../src/game'
import { applyRemote, applySnapshot, board, dispatch, isValidHomeSetup, serialize, startLocal, state } from '../src/store'

for (const boundaryReflects of [false, true]) {
  for (let turns = 0; turns < 4; turns++) {
    const rotate = (home: Home): Home => {
      let { x, y, dir } = home
      for (let i = 0; i < turns; i++) [x, y, dir] = [35 - y, x, ((dir + 1) % 4) as Dir]
      return { x, y, dir }
    }
    startLocal(2)
    dispatch({ kind: 'boundary-setting', color: 'blue', enabled: boundaryReflects })
    dispatch({ kind: 'setup', color: 'blue', home: rotate({ x: 4, y: 4, dir: 0 }) })
    const before = serialize()
    const losing = rotate({ x: 4, y: 8, dir: 3 })
    assert(!isValidHomeSetup(losing, 'red'), '己方开口暴露在敌方家镜穿出的光路上')
    dispatch({ kind: 'setup', color: 'red', home: losing })
    assert(!applyRemote({ kind: 'setup', color: 'red', home: losing }), '远端非法方向同样拒绝')
    const immediate = rotate({ x: 8, y: 4, dir: 2 })
    assert(!isValidHomeSetup(immediate, 'red'), '开口朝向先手的光线时，仍禁止开局立即出局')
    dispatch({ kind: 'setup', color: 'red', home: immediate })
    // 检查预览及被拒绝动作没有污染基地、镜子、回合、结果和棋钟。
    const after = serialize()
    assert.deepEqual({ ...after, clock: { ...after.clock, at: 0 } }, { ...before, clock: { ...before.clock, at: 0 } })
    // 同排的后手已经瞄准先手，但先手尚有一次行动机会，不能提前判负。
    for (const dir of [0, 1, 3] as Dir[]) {
      assert(isValidHomeSetup(rotate({ x: 8, y: 4, dir }), 'red'), '同排的安全开口允许放置')
    }
    dispatch({ kind: 'setup', color: 'red', home: rotate({ x: 8, y: 4, dir: 0 }) })
    assert.equal(state.phase, 'play')
    assert.equal(state.dead.length, 0)
    assert.equal(state.winner, null)
    assert(!simulate(board, 'blue').hit && simulate(board, 'red').hit)
    const block = rotate({ x: 5, y: 4, dir: 0 })
    dispatch({ kind: 'edge', color: 'blue', id: edgeOf(block.x, block.y, block.dir) })
    assert.equal(state.current, 'red')
    assert.equal(state.phase, 'play', '先手合法放镜后成功自救，正常轮转')
    assert.equal(state.dead.length, 0)
    assert(!simulate(board, 'red').hit)
    applySnapshot(before)
    const safe = rotate({ x: 4, y: 8, dir: 0 })
    assert(isValidHomeSetup(safe, 'red'), '同一位置改开口方向后安全，不能直接封禁整格')
    dispatch({ kind: 'setup', color: 'red', home: safe })
    assert.equal(state.phase, 'play')
    assert(!simulate(board, 'blue').hit && !simulate(board, 'red').hit)
    assert.equal(state.dead.length, 0)
    assert(state.clock.runningSince !== null)
  }
}
console.log('ok: 四个方向、两种边界规则下允许同排/同列；先手可放镜自救，开局直接淘汰仍被拒绝')

// 联机允许任意布置顺序；以真正的先手为准，不能改用最后布置者的颜色。
startLocal(2)
dispatch({ kind: 'setup', color: 'red', home: { x: 4, y: 4, dir: 0 } })
assert(applyRemote({ kind: 'setup', color: 'blue', home: { x: 4, y: 8, dir: 3 } }), '后放先手基地，允许可自救的威胁')
assert.equal(state.phase, 'play')
assert.equal(state.dead.length, 0)
startLocal(2)
dispatch({ kind: 'setup', color: 'red', home: { x: 4, y: 4, dir: 1 } })
assert(!applyRemote({ kind: 'setup', color: 'blue', home: { x: 4, y: 8, dir: 0 } }), '后放先手基地，仍拒绝先手立即击杀对方')
assert(applyRemote({ kind: 'setup', color: 'blue', home: { x: 8, y: 8, dir: 0 } }))
assert.equal(state.phase, 'play')

startLocal(4)
dispatch({ kind: 'setup', color: 'blue', home: { x: 4, y: 4, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 4, y: 8, dir: 0 } })
dispatch({ kind: 'setup', color: 'yellow', home: { x: 4, y: 2, dir: 1 } })
assert(!state.homes.yellow, '多人局仍不能被先手在开局立即击中')
dispatch({ kind: 'setup', color: 'yellow', home: { x: 8, y: 8, dir: 3 } })
assert(state.homes.yellow, '后手之间存在光路威胁，允许同排布置')
dispatch({ kind: 'setup', color: 'green', home: { x: 18, y: 20, dir: 1 } })
assert.equal(state.phase, 'play')
assert.equal(state.dead.length, 0)
assert(!simulate(board, 'blue').hit && simulate(board, 'yellow').hits.includes('red'))
console.log('ok: 任意布置顺序与远端操作按实际先手校验，多人局不提前结算后手威胁')
