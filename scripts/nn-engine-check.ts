/**
 * NN 引擎端到端检查（node + onnxruntime-node，与 src/ai/nn-core.ts 同一套逻辑）：
 *  1. 合法掩码对拍：parity fixture 的 legal 字段 vs legalActionIndices（逐例全等）。
 *  2. policy/value 对拍：TS encoder → ONNX → masked softmax vs fixture（max diff < 1e-4）。
 *  3. 自对弈：NN vs NN 打 2 局 6×6 + 1 局 8×8（经 store.dispatchAi 全规则校验），
 *     断言每步合法、对局在上限手数内终止或分出胜负。
 * 由 scripts/nn-engine-check.mjs 启动（保持与仓库其他 .mjs 检查脚本一致的入口形态）。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import {
  actionToIndex,
  boardFromRequest,
  chooseNnAction,
  indexToAction,
  legalActionIndices,
  legalSetupHomes,
  numActions,
  type NnBackend,
} from '../src/ai/nn-core'
import { makeAiRequest } from '../src/ai/protocol'
import { PALETTE, type BoardState, type Color } from '../src/game'
import { board, dispatchAi, setGamePersistenceEnabled, state, startLocal } from '../src/store'
import { encodeState } from '../src/nn/encoder'
import type { NnModelInfo } from '../src/nn/models'

const ROOT = join(import.meta.dirname, '..')
const FIXTURE_DIR = join(ROOT, 'test/fixtures')
const MODELS_DIR = join(ROOT, 'public/models')

const models = JSON.parse(readFileSync(join(MODELS_DIR, 'models.json'), 'utf8')) as NnModelInfo[]
const bySize = new Map(models.map((m) => [m.boardSize, m]))
assert.ok(bySize.has(6) && bySize.has(8), 'models.json 需包含 6×6 与 8×8 模型')

function makeBackend(model: NnModelInfo, session: ort.InferenceSession): NnBackend {
  return {
    async run(features, channels, size) {
      const input = new ort.Tensor('float32', features, [1, channels, size, size])
      const out = await session.run({ x: input })
      return { policy: out.policy.data as Float32Array, value: (out.value.data as Float32Array)[0] }
    },
  }
}

// 可种子化的 rng（自对弈复现用）
const mulberry32 = (seed: number) => () => {
  seed |= 0; seed = (seed + 0x6d2b79f5) | 0
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}

// ---------- 1+2. fixture 对拍 ----------
for (const [fixtureName, size] of [['parity_6x6.json', 6], ['parity_8x8.json', 8]] as const) {
  const fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, fixtureName), 'utf8'))
  const model = bySize.get(size)!
  assert.equal(model.featureVersion, fixture.feature_version, `${fixtureName} 特征版本与模型不符`)
  const session = await ort.InferenceSession.create(join(MODELS_DIR, model.file))
  const backend = makeBackend(model, session)
  let worstP = 0, worstV = 0, checked = 0
  for (const c of fixture.cases) {
    if (c.phase !== 'play') continue
    checked++
    const b: BoardState = {
      size: c.board.size, boundaryReflects: c.board.boundaryReflects,
      homes: c.board.homes, edges: new Map(c.board.edges), diags: new Map(c.board.diags),
    }
    const req = makeAiRequest(b, { phase: 'play', players: c.players, current: c.current, dead: [], budgetMs: 1 })
    const b2 = boardFromRequest(req)
    // 合法掩码逐位对拍
    assert.deepEqual(
      [...legalActionIndices(b2, c.current, c.players)].sort((x, y) => x - y),
      [...(c.legal as number[])].sort((x, y) => x - y),
      `${fixtureName} ply=${c.ply} 合法掩码不一致`,
    )
    const { policy, value } = await backend.run(
      // 经 chooseNnAction 同款编码路径现场编码
      encodeState(
        { board: b2, current: c.current, players: c.players, ply: c.ply, maxPlies: c.maxPlies, phase: 'play' },
        model.featureVersion,
      ), fixture.channels, size)
    const logits = policy.slice()
    const legal = new Set(c.legal as number[])
    for (let i = 0; i < logits.length; i++) if (!legal.has(i)) logits[i] = -1e9
    const mx = Math.max(...logits)
    const exps = logits.map((v) => Math.exp(v - mx))
    const sum = exps.reduce((a, bb) => a + bb, 0)
    for (let i = 0; i < exps.length; i++) worstP = Math.max(worstP, Math.abs(exps[i] / sum - c.policy[i]))
    worstV = Math.max(worstV, Math.abs(value - c.value))
  }
  assert.ok(worstP < 1e-4 && worstV < 1e-4, `${fixtureName} policy/value 对拍失败`)
  console.log(`${model.id} (${fixture.cases.length} 例): 掩码全等；policy max diff = ${worstP.toExponential(3)}, value max diff = ${worstV.toExponential(3)} OK`)
}

// ---------- 3. NN 自对弈（走 store 全规则校验） ----------
setGamePersistenceEnabled(false)

async function selfPlay(size: 6 | 8, seed: number, stochastic: boolean) {
  const model = bySize.get(size)!
  const session = await ort.InferenceSession.create(join(MODELS_DIR, model.file))
  const backend = makeBackend(model, session)
  const rng = mulberry32(seed)
  state.size = size
  const engines = { kind: 'nn' as const, modelId: model.id, stochastic }
  startLocal(2, ['blue', 'red'], { blue: engines, red: engines })
  const cap = numActions(size) // 上限手数：动作空间大小（远超正常对局长度）
  let plies = 0
  while (state.phase !== 'over' && plies < cap) {
    const phase = state.phase as 'setup' | 'play'
    const color: Color = phase === 'setup'
      ? state.players.find((c) => !state.homes[c])!
      : state.current
    const req = makeAiRequest(board, { phase, players: state.players, current: color, dead: state.dead, budgetMs: 1000 })
    const res = await chooseNnAction(backend, req, { featureVersion: model.featureVersion, stochastic, rng, modelName: model.name })
    assert.ok(res.action && !res.error, `NN 引擎报错：${res.error}`)
    // 每步合法性独立断言（不只依赖 dispatchAi 拒绝）
    const b2 = boardFromRequest(req)
    const alive = state.players.filter((c) => !state.dead.includes(c))
    if (phase === 'setup') {
      assert.equal(res.action.kind, 'setup')
      const homes = legalSetupHomes(b2, state.players, color)
      assert.ok(
        homes.some((h) => h.x === res.action!.home.x && h.y === res.action!.home.y && h.dir === res.action!.home.dir),
        `setup 落子非法：${JSON.stringify(res.action)}`,
      )
    } else {
      assert.notEqual(res.action.kind, 'setup')
      const idx = actionToIndex(res.action, size)
      assert.ok(legalActionIndices(b2, color, alive).includes(idx), `play 落子非法：idx=${idx} ${JSON.stringify(res.action)}`)
      assert.equal(indexToAction(idx, size).kind, res.action.kind)
    }
    const accepted = dispatchAi({ ...res.action, color } as never)
    assert.ok(accepted, `dispatchAi 拒绝了 NN 落子：${JSON.stringify(res.action)}`)
    plies++
  }
  const result = state.phase === 'over' ? `${state.winner} 胜` : `达到上限手数 ${cap}`
  assert.ok(plies >= 2, '对局手数异常')
  console.log(`自对弈 ${size}×${size}（seed=${seed}${stochastic ? '，随机采样' : ''}）: ${plies} 手，${result}，全部落子合法 OK`)
  return state.phase
}

const r1 = await selfPlay(6, 20241029, false)
const r2 = await selfPlay(6, 777, true)
const r3 = await selfPlay(8, 20241029, false)
assert.ok([r1, r2, r3].includes('over'), '三局自对弈至少一局应分出胜负')
console.log('NN 引擎检查全部通过')
process.exit(0)
