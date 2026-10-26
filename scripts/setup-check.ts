import assert from 'node:assert/strict'
import { simulate, type Dir, type Home } from '../src/game'
import { applyRemote, board, dispatch, isValidHomeSetup, serialize, startLocal, state } from '../src/store'

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
    for (const dir of [0, 1, 2, 3] as Dir[]) {
      const winning = rotate({ x: 8, y: 4, dir })
      assert(!isValidHomeSetup(winning, 'red'), '所有方向都能立刻打中对方时，整个格子不可选')
      dispatch({ kind: 'setup', color: 'red', home: winning })
    }
    // 检查预览及被拒绝动作没有污染基地、镜子、回合、结果和棋钟。
    const after = serialize()
    assert.deepEqual({ ...after, clock: { ...after.clock, at: 0 } }, { ...before, clock: { ...before.clock, at: 0 } })
    const safe = rotate({ x: 4, y: 8, dir: 0 })
    assert(isValidHomeSetup(safe, 'red'), '同一位置改开口方向后安全，不能直接封禁整格')
    dispatch({ kind: 'setup', color: 'red', home: safe })
    assert.equal(state.phase, 'play')
    assert(!simulate(board, 'blue').hit && !simulate(board, 'red').hit)
    assert.equal(state.dead.length, 0)
    assert(state.clock.runningSince !== null)
  }
}
console.log('ok: 四个方向、两种边界规则下检查位置与开口，拒绝自杀/秒杀且允许同格安全方向')

// 联机允许任意布置顺序；校验不能只看最后落家的人或者先手的光。
startLocal(2)
dispatch({ kind: 'setup', color: 'red', home: { x: 4, y: 4, dir: 0 } })
assert(!applyRemote({ kind: 'setup', color: 'blue', home: { x: 4, y: 8, dir: 3 } }))
assert(applyRemote({ kind: 'setup', color: 'blue', home: { x: 4, y: 8, dir: 0 } }))
assert.equal(state.phase, 'play')

startLocal(4)
dispatch({ kind: 'setup', color: 'blue', home: { x: 4, y: 4, dir: 0 } })
dispatch({ kind: 'setup', color: 'red', home: { x: 4, y: 8, dir: 0 } })
dispatch({ kind: 'setup', color: 'yellow', home: { x: 8, y: 8, dir: 3 } })
assert(!state.homes.yellow, '尚未全员布置时，也不能击中先手以外的基地')
dispatch({ kind: 'setup', color: 'yellow', home: { x: 4, y: 12, dir: 3 } })
assert(!state.homes.yellow, '多人局中非先手玩家的光同样参与检查')
dispatch({ kind: 'setup', color: 'yellow', home: { x: 12, y: 12, dir: 0 } })
dispatch({ kind: 'setup', color: 'green', home: { x: 18, y: 20, dir: 1 } })
assert.equal(state.phase, 'play')
assert(state.players.every(color => !simulate(board, color).hit))
console.log('ok: 任意布置顺序、多人局及远端校验，安全初始局面正常开启棋钟')
