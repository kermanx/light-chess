/**
 * 端到端对拍：TS encoder → onnxruntime-node → 真实权重 ONNX。
 * 输入 fixture 局面，用 TS encoder 现场编码特征（不是直接喂 fixture 张量），
 * masked softmax 后的 policy 与 fixture policy 对拍（max diff < 1e-4），
 * value 同样 < 1e-4。证明「TS encoder → ONNX」链路与 Python 完全等价。
 * 用法：npx tsx scripts/onnx-e2e-check.ts
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as ort from 'onnxruntime-node'
import { encodeState, flagsForVersion, type EncoderState } from '../src/nn/encoder'
import type { BoardState, Color, Diag, Mirror } from '../src/game'

const RL_EXPORT = join(import.meta.dirname, '../../rl/export')
const FIXTURE_DIR = join(import.meta.dirname, '../test/fixtures')

interface FixtureCase {
  board: {
    size: number
    boundaryReflects: boolean
    homes: Record<string, { x: number; y: number; dir: 0 | 1 | 2 | 3 }>
    edges: [string, Mirror][]
    diags: [string, Diag][]
  }
  current: Color
  players: Color[]
  ply: number
  maxPlies: number
  phase: 'setup' | 'play' | 'over'
  features_shape: [number, number, number]
  policy: number[]
  value: number
  legal: number[]
}
interface Fixture {
  feature_version: string
  channels: number
  size: number
  cases: FixtureCase[]
}

const JOBS = [
  { fixture: 'parity_6x6.json', onnx: 'lightchess_6x6_vitm_pt_dd_gen32.onnx' },
  { fixture: 'parity_8x8.json', onnx: 'lightchess_8x8_transfer_gen16.onnx' },
]

let failed = false
for (const job of JOBS) {
  const fixture: Fixture = JSON.parse(readFileSync(join(FIXTURE_DIR, job.fixture), 'utf8'))
  const flags = flagsForVersion(fixture.feature_version)
  const session = await ort.InferenceSession.create(join(RL_EXPORT, job.onnx))
  const [ch, s] = [fixture.channels, fixture.size]

  let worstP = 0
  let worstV = 0
  for (const c of fixture.cases) {
    const board: BoardState = {
      size: c.board.size,
      boundaryReflects: c.board.boundaryReflects,
      homes: c.board.homes,
      edges: new Map(c.board.edges),
      diags: new Map(c.board.diags),
    }
    const st: EncoderState = {
      board, current: c.current, players: c.players,
      ply: c.ply, maxPlies: c.maxPlies, phase: c.phase,
    }
    const feats = encodeState(st, fixture.feature_version as never)
    const input = new ort.Tensor('float32', feats, [1, ch, s, s])
    const out = await session.run({ x: input })
    const logits = (out.policy.data as Float32Array).slice()
    const value = (out.value.data as Float32Array)[0]

    // masked softmax（与 Python predict 一致：非法动作填 -1e9）
    const legal = new Set(c.legal)
    for (let i = 0; i < logits.length; i++) if (!legal.has(i)) logits[i] = -1e9
    const mx = Math.max(...logits)
    const exps = logits.map((v) => Math.exp(v - mx))
    const sum = exps.reduce((a, b) => a + b, 0)
    for (let i = 0; i < exps.length; i++) {
      worstP = Math.max(worstP, Math.abs(exps[i] / sum - c.policy[i]))
    }
    worstV = Math.max(worstV, Math.abs(value - c.value))
  }
  const ok = worstP < 1e-4 && worstV < 1e-4
  if (!ok) failed = true
  console.log(
    `${job.onnx} (${flags.channels}ch, ${fixture.cases.length} cases): ` +
      `policy max diff = ${worstP.toExponential(3)}, value max diff = ${worstV.toExponential(3)} ` +
      (ok ? 'OK' : 'FAIL'),
  )
}
process.exit(failed ? 1 : 0)
