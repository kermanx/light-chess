/**
 * 复盘数据源（本机 NN）node 侧检查：
 * 用 store 全规则校验生成一局 8 ply 短对局，注入 onnxruntime-node 的直连搜索跑
 * NnReviewSource 复盘，断言每个 ply 都产出合法 PlyLine（候选合法、value/q ∈ [-1,1]、
 * prob 归一化），且 final 行带失误表。
 * 由 scripts/review-source-check.mjs 启动（保持与仓库其他 .mjs 检查脚本一致的入口形态）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import { chooseNnMctsAction, type BatchEvaluator } from '../src/ai/nn-mcts'
import { actionToIndex, boardFromRequest, legalActionIndices } from '../src/ai/nn-core'
import { makeAiRequest } from '../src/ai/protocol'
import { PALETTE, type Color } from '../src/game'
import { board, dispatchAi, setGamePersistenceEnabled, startLocal, state } from '../src/store'
import type { NnModelInfo } from '../src/nn/models'
import {
  NnReviewSource,
  moverColor,
  reviewBoardAt,
  type FinalLine,
  type MetaLine,
  type PlyLine,
  type ReviewGameInput,
} from '../src/review/source'

const ROOT = join(import.meta.dirname, '..')
const models = JSON.parse(readFileSync(join(ROOT, 'public/models/models.json'), 'utf8')) as NnModelInfo[]
const model = models.find((m) => m.boardSize === 6)!
assert.ok(model, 'models.json 需包含 6×6 模型')

setGamePersistenceEnabled(false)

// ---------- 生成 8 ply 短对局（4 手固定开局 + NN 补 4 手，全部经 store 校验） ----------
const session = await ort.InferenceSession.create(join(ROOT, 'public/models', model.file))
const evaluate: BatchEvaluator = async (boards) => {
  const b0 = boards[0]
  const merged = new Float32Array(boards.length * b0.length)
  for (let i = 0; i < boards.length; i++) merged.set(boards[i], i * b0.length)
  const input = new ort.Tensor('float32', merged, [boards.length, model.channels, model.boardSize, model.boardSize])
  const out = await session.run({ x: input })
  const policy = out.policy.data as Float32Array
  const value = out.value.data as Float32Array
  const na = policy.length / boards.length
  return boards.map((_, i) => ({ policy: policy.slice(i * na, (i + 1) * na), value: value[i] }))
}

state.size = 6
const nn = { modelId: model.id }
startLocal(2, ['blue', 'red'], { blue: 'nn', red: 'nn' }, {}, undefined, { blue: nn, red: nn })
dispatchAi({ kind: 'setup', color: 'blue', home: { x: 1, y: 1, dir: 0 } } as never)
dispatchAi({ kind: 'setup', color: 'red', home: { x: 4, y: 4, dir: 2 } } as never)
dispatchAi({ kind: 'edge', color: 'blue', id: 'h:2:2' } as never)
dispatchAi({ kind: 'diag', color: 'red', x: 3, y: 3, ori: '/' } as never)
dispatchAi({ kind: 'edge', color: 'blue', id: 'v:2:3' } as never)
dispatchAi({ kind: 'diag', color: 'red', x: 2, y: 4, ori: '\\' } as never)
assert.equal(state.moves.length, 4, '固定开局 4 手全部合法')

while (state.moves.length < 8 && state.phase === 'play') {
  const color: Color = state.current
  const req = makeAiRequest(board, { phase: 'play', players: state.players, current: color, dead: state.dead, budgetMs: 1000 })
  const res = await chooseNnMctsAction(evaluate, req, { featureVersion: model.featureVersion, budgetMs: 1000, sims: 20 })
  assert.ok(res.action && !res.error, `补手搜索失败：${res.error}`)
  assert.ok(dispatchAi({ ...res.action, color } as never), '补手被 store 拒绝')
}
assert.equal(state.moves.length, 8, '对局补足到 8 ply')

const game: ReviewGameInput = {
  size: state.size,
  boundaryReflects: state.boundaryReflects,
  homes: JSON.parse(JSON.stringify(state.homes)),
  moves: state.moves.map((m) =>
    m.kind === 'edge' ? { kind: 'edge' as const, id: m.id } : { kind: 'diag' as const, x: m.x, y: m.y, ori: m.ori },
  ),
}

// ---------- NnReviewSource 复盘（定额 40 sims/ply，直连 node 推理） ----------
const SIMS = 40
const src = new NnReviewSource({
  modelId: model.id,
  modelName: model.name,
  sims: SIMS,
  search: (req) =>
    chooseNnMctsAction(evaluate, req, { featureVersion: model.featureVersion, budgetMs: 60_000, sims: SIMS }),
})

let meta: MetaLine | null = null
const plies: PlyLine[] = []
let fin: FinalLine | null = null
let error: Error | null = null
await src.start(game, {
  onMeta: (m) => (meta = m),
  onLine: (l) => plies.push(l),
  onDone: (f) => (fin = f),
  onError: (e) => (error = e),
})

assert.equal(error, null, `复盘无错误：${error?.message ?? ''}`)
assert.ok(meta, '收到 meta')
assert.equal((meta as unknown as MetaLine).total_plies, 8)
assert.equal(plies.length, 8, '8 个 ply 全部产出')
assert.ok(fin, '收到 final')
assert.ok(Array.isArray((fin as unknown as FinalLine).blunders), 'final 带失误表')

for (const [k, p] of plies.entries()) {
  assert.equal(p.ply, k)
  assert.equal(p.mover, k % 2)
  assert.ok(p.value >= -1 && p.value <= 1, `ply ${k} value 越界：${p.value}`)
  assert.ok(p.top.length >= 1 && p.top.length <= 5, `ply ${k} top 数量异常：${p.top.length}`)
  assert.equal(p.second, null, 'NN 后端无第二意见')
  assert.equal(p.progress.done, k + 1)
  assert.equal(p.progress.total, 8)
  // 候选合法性：在 ply k 的行棋前局面上必须合法
  const b = boardFromRequest(
    makeAiRequest(reviewBoardAt(game, k), {
      phase: 'play',
      players: ['blue', 'red'],
      current: moverColor(p.mover),
      dead: [],
      budgetMs: 1,
    }),
  )
  const legal = legalActionIndices(b, moverColor(p.mover), [...PALETTE.slice(0, 2).map((x) => x.id)])
  for (const t of p.top) {
    assert.ok(t.q >= -1 && t.q <= 1, `ply ${k} 候选 q 越界：${t.q}`)
    assert.ok(typeof t.prob === 'number' && t.prob > 0 && t.prob <= 1, `ply ${k} 候选 prob 异常：${t.prob}`)
    assert.ok(typeof t.orderingScore === 'number' && t.orderingScore >= 0, `ply ${k} 候选 visits 异常`)
    assert.ok(
      legal.includes(actionToIndex(t.move, game.size)),
      `ply ${k} 候选非法：${JSON.stringify(t.move)}`,
    )
  }
}
console.log(`ok: NnReviewSource 8 ply 复盘，候选全部合法，value ∈ [-1,1]，sims=${SIMS}`)
console.log(`    values = ${JSON.stringify(plies.map((p) => Number(p.value.toFixed(3))))}`)
console.log(`    blunders = ${JSON.stringify((fin as unknown as FinalLine).blunders)}`)
console.log('复盘数据源检查通过')
process.exit(0)
