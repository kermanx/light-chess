// AI explanations must describe the accepted move, never a pending, rejected or undone result.
import assert from 'node:assert/strict'
import { toAiMoveAnalysis, type AiStats } from '../src/ai/protocol'
import {
  applySnapshot, dispatch, dispatchAi, lastAiAnalysis, serialize, startLocal, state,
  toLobby, topUndoFrame,
} from '../src/store'

const stats: AiStats = {
  nodes: 50, depth: 2, elapsedMs: 42.5, score: 30, mode: 'attack',
  candidates: 5, plans: 2, stopReason: 'stable', reason: '连接己方光路，同时限制对手转向。',
}
const analysis = toAiMoveAnalysis(stats)!
assert.deepEqual(analysis, { elapsedMs: 42.5, reason: stats.reason })
assert.deepEqual(toAiMoveAnalysis({ elapsedMs: 8 }), { elapsedMs: 8 }, '兼容缺少新字段的旧引擎')
assert.equal(toAiMoveAnalysis({ elapsedMs: Infinity, reason: '无效时间' }), undefined)
assert.equal(toAiMoveAnalysis({ elapsedMs: -1 }), undefined)
assert.equal(toAiMoveAnalysis(undefined), undefined)

state.size = 16
startLocal(2, ['red'])
dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
assert(dispatchAi({ kind: 'setup', color: 'red', home: { x: 10, y: 8, dir: 2 } }))
assert.equal(lastAiAnalysis.value, null)
dispatch({ kind: 'edge', color: 'blue', id: 'h:0:0', aiAnalysis: analysis })
assert.equal(lastAiAnalysis.value, null, '真人不能附带 AI 决策说明')
assert(dispatchAi({ kind: 'edge', color: 'red', id: 'h:1:0', aiAnalysis: analysis }))
assert.deepEqual(lastAiAnalysis.value, { color: 'red', ...analysis })
const accepted = serialize()
dispatch({ kind: 'edge', color: 'blue', id: 'h:2:0' })
assert.equal(lastAiAnalysis.value, null, '下一手后隐藏旧 AI 说明')
dispatch({ kind: 'undo', color: 'red', frame: topUndoFrame()! })
assert.deepEqual(lastAiAnalysis.value, { color: 'red', ...analysis }, '撤回真人落子恢复上一手 AI 的对应说明')
dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
assert.equal(lastAiAnalysis.value, null, '撤回 AI 落子不再显示该说明')
dispatch({ kind: 'ai-resume', color: 'blue' })
assert.equal(dispatchAi({ kind: 'diag', color: 'red', x: 20, y: 20, ori: '/', aiAnalysis: analysis }), false)
assert.equal(lastAiAnalysis.value, null, '被拒绝的动作不能更新说明')
assert(dispatchAi({ kind: 'edge', color: 'red', id: 'h:1:0' }))
assert.equal(lastAiAnalysis.value, null, '新落子没有分析时不能沿用上次结果')
console.log('ok: explanations follow accepted AI moves; human moves, rejected moves and undo cannot reuse stale analysis')

applySnapshot(accepted)
assert.deepEqual(lastAiAnalysis.value, { color: 'red', ...analysis }, '快照恢复对应落子说明')
const old = { ...accepted, lastMove: { kind: 'edge' as const, color: 'red' as const, id: 'h:1:0' } }
applySnapshot(old)
assert.equal(lastAiAnalysis.value, null, '旧存档缺少说明字段时保持隐藏')
applySnapshot({ ...accepted, edges: accepted.edges.filter(([id]) => id !== 'h:1:0') })
assert.equal(lastAiAnalysis.value, null, '说明对应的镜子不存在时隐藏')
applySnapshot(accepted)
dispatch({ kind: 'restart', color: 'blue' })
assert.equal(lastAiAnalysis.value, null, '重开清空说明')
assert.equal(state.lastMove, null)
toLobby()
assert.equal(lastAiAnalysis.value, null)
console.log('ok: snapshots preserve matching analysis, while legacy/mismatched records and restart stay clear')
