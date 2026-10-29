/**
 * NN 引擎核心（运行时无关）：onnxruntime-web（浏览器 worker）与 onnxruntime-node
 * （scripts/nn-engine-check）共用同一套 action 映射、合法掩码、masked softmax 与选子逻辑。
 *
 * action 索引约定与 rl/lightchess/moves.py 完全一致（s = 棋盘格数）：
 *   h 边 x∈[0,s),y∈[0,s] → idx = y*s + x
 *   v 边 x∈[0,s],y∈[0,s) → idx = s(s+1) + y*(s+1) + x
 *   斜镜 idx = 2s(s+1) + (y*s+x)*2 + oi（oi: 0='/', 1='\\'）
 * 总计 num_actions = 4s² + 2s（6×6=156，8×8=272）。setup 选家不走该索引。
 * 合法掩码用 game.ts 的规则函数现算，已与 parity fixture 的 legal 字段逐位对拍
 * （见 scripts/nn-engine-check.ts）。
 */
import { createsEnclosure, DX, DY, edgeOf, PALETTE, simulate, type BoardState, type Color, type Dir, type Home, type Ori } from '../game'
import { encodeState, flagsForVersion, type FeatureVersion } from '../nn/encoder'
import type { AiAction, AiRequest, AiResponse, AiStats } from './protocol'

export const numActions = (size: number) => 4 * size * size + 2 * size

export function indexToAction(idx: number, size: number): AiAction {
  const s = size
  const eh = s * (s + 1)
  if (idx < eh) return { kind: 'edge', id: `h:${idx % s}:${Math.floor(idx / s)}` }
  if (idx < 2 * eh) {
    const k = idx - eh
    return { kind: 'edge', id: `v:${k % (s + 1)}:${Math.floor(k / (s + 1))}` }
  }
  const k = idx - 2 * eh
  const cell = Math.floor(k / 2)
  const oi = k % 2
  return { kind: 'diag', x: cell % s, y: Math.floor(cell / s), ori: (oi === 0 ? '/' : '\\') as Ori }
}

export function actionToIndex(action: AiAction, size: number): number {
  const s = size
  if (action.kind === 'edge') {
    const [t, a, b] = action.id.split(':')
    const x = Number(a)
    const y = Number(b)
    return t === 'h' ? y * s + x : s * (s + 1) + y * (s + 1) + x
  }
  if (action.kind === 'diag') {
    return 2 * s * (s + 1) + (action.y * s + action.x) * 2 + (action.ori === '/' ? 0 : 1)
  }
  throw new Error('setup 动作不在 play 动作空间内')
}

/** AiRequest 的稠密数组还原成 BoardState（颜色按下标回到 PALETTE id） */
export function boardFromRequest(req: AiRequest): BoardState {
  const n = req.size
  const colorAt = (i: number) => PALETTE[i].id
  const edges = new Map<string, { color: Color }>()
  for (let y = 0; y <= n; y++) {
    for (let x = 0; x < n; x++) {
      const v = req.horizontal[y * n + x]
      if (v) edges.set(`h:${x}:${y}`, { color: colorAt(v - 1) })
    }
  }
  for (let y = 0; y < n; y++) {
    for (let x = 0; x <= n; x++) {
      const v = req.vertical[y * (n + 1) + x]
      if (v) edges.set(`v:${x}:${y}`, { color: colorAt(v - 1) })
    }
  }
  const diags = new Map<string, { color: Color; ori: Ori }>()
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const v = req.diagonals[y * n + x]
      if (v) diags.set(`${x},${y}`, { color: colorAt((v - 1) >> 1), ori: ((v - 1) & 1 ? '\\' : '/') as Ori })
    }
  }
  const homes: Partial<Record<Color, Home>> = {}
  for (let i = 0; i < req.homes.length; i++) {
    if (req.homes[i]) homes[colorAt(i)] = { ...req.homes[i]! }
  }
  // AI 座位强制边界反射（store.setAiPlayers / dispatchAi 保证），NN 模型也只在此规则下训练
  return { homes, edges, diags, size: n, boundaryReflects: true }
}

/** 存活颜色（aliveMask 按 PALETTE 下标取位） */
export const aliveColors = (req: AiRequest): Color[] =>
  req.players.map((i) => PALETTE[i].id).filter((c) => req.aliveMask & (1 << PALETTE.findIndex((p) => p.id === c)))

const aliveHomesOf = (board: BoardState, alive: Color[]) => {
  const homes: Partial<Record<Color, Home>> = {}
  for (const c of alive) if (board.homes[c]) homes[c] = board.homes[c]
  return homes
}

const isHomeCellOf = (board: BoardState, x: number, y: number) =>
  Object.values(board.homes).some((h) => h.x === x && h.y === y)

/**
 * 当前行动方的合法 play 动作索引，与 store.ts validate 的逐条规则一致：
 * 边镜——界内、未占用、不围死；斜镜——界内、非家格、未占用、不围死。
 */
export function legalActionIndices(board: BoardState, current: Color, alive: Color[]): number[] {
  const s = board.size
  const homes = aliveHomesOf(board, alive)
  const out: number[] = []
  for (let y = 0; y <= s; y++) {
    for (let x = 0; x < s; x++) {
      const id = `h:${x}:${y}`
      if (board.edges.has(id)) continue
      const trial = new Map(board.edges)
      trial.set(id, { color: current })
      if (!createsEnclosure(trial, current, homes, s, board.diags)) out.push(y * s + x)
    }
  }
  for (let y = 0; y < s; y++) {
    for (let x = 0; x <= s; x++) {
      const id = `v:${x}:${y}`
      if (board.edges.has(id)) continue
      const trial = new Map(board.edges)
      trial.set(id, { color: current })
      if (!createsEnclosure(trial, current, homes, s, board.diags)) out.push(s * (s + 1) + y * (s + 1) + x)
    }
  }
  const off = 2 * s * (s + 1)
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (isHomeCellOf(board, x, y) || board.diags.has(`${x},${y}`)) continue
      for (const oi of [0, 1]) {
        const ori = (oi === 0 ? '/' : '\\') as Ori
        const trial = new Map(board.diags)
        trial.set(`${x},${y}`, { color: current, ori })
        if (!createsEnclosure(board.edges, current, homes, s, trial)) out.push(off + (y * s + x) * 2 + oi)
      }
    }
  }
  return out
}

/**
 * setup 阶段 color 的全部合法选家（与 store.isValidHomeSetup 一致）：
 * 不落家、不与任何家相邻、出口不朝界外、且不让先手开局立即命中。
 */
export function legalSetupHomes(board: BoardState, players: Color[], color: Color): Home[] {
  const s = board.size
  const homes = Object.values(board.homes)
  const out: Home[] = []
  for (let y = 0; y < s; y++) {
    for (let x = 0; x < s; x++) {
      if (homes.some((h) => Math.max(Math.abs(h.x - x), Math.abs(h.y - y)) < 2)) continue
      for (const dir of [0, 1, 2, 3] as Dir[]) {
        const nx = x + DX[dir]
        const ny = y + DY[dir]
        if (nx < 0 || ny < 0 || nx >= s || ny >= s) continue
        const trial: BoardState = {
          homes: { ...board.homes, [color]: { x, y, dir } },
          edges: new Map(board.edges),
          diags: board.diags,
          size: s,
          boundaryReflects: board.boundaryReflects,
        }
        for (const d of [0, 1, 2, 3] as Dir[]) {
          if (d !== dir) trial.edges.set(edgeOf(x, y, d), { color })
        }
        if (!simulate(trial, players[0]).hit) out.push({ x, y, dir })
      }
    }
  }
  return out
}

/** 推理后端抽象：web/node 各自的 session.run 收敛成这个签名 */
export interface NnBackend {
  run(features: Float32Array, channels: number, size: number): Promise<{ policy: Float32Array; value: number }>
}

export interface NnChooseOptions {
  featureVersion: FeatureVersion
  /** true = 温度 0.5 采样；false（默认）= argmax 确定性选子 */
  stochastic?: boolean
  rng?: () => number
  modelName?: string
}

/**
 * 一条 AiRequest → AiResponse。
 * setup 阶段模型无 policy 头，均匀随机选合法家（与 rl 冒烟管线的 random_setup 同策略）；
 * play 阶段编码 → 前向 → 合法掩码 → masked softmax → argmax/采样。
 */
export async function chooseNnAction(backend: NnBackend, req: AiRequest, opts: NnChooseOptions): Promise<AiResponse> {
  const t0 = Date.now()
  const board = boardFromRequest(req)
  const players = req.players.map((i) => PALETTE[i].id)
  const current = PALETTE[req.current].id
  const alive = aliveColors(req)
  const flags = flagsForVersion(opts.featureVersion)
  const base = { nodes: 0, depth: 0, mode: `nn:${opts.modelName ?? opts.featureVersion}` }

  if (req.phase === 'setup') {
    const homes = legalSetupHomes(board, players, current)
    if (!homes.length) return { action: null, error: 'NN 引擎在布置阶段无合法选家' }
    const home = homes[Math.floor((opts.rng ?? Math.random)() * homes.length)]
    const stats: AiStats = { ...base, elapsedMs: Date.now() - t0, score: 0, reason: '布置阶段：随机合法选家（NN 模型不参与选家）' }
    return { action: { kind: 'setup', home }, stats }
  }

  const legal = legalActionIndices(board, current, alive)
  if (!legal.length) return { action: null, error: 'NN 引擎未找到合法落子' }
  const ply = board.edges.size + board.diags.size - 3 * Object.keys(board.homes).length
  const features = encodeState(
    { board, current, players, ply: Math.max(0, ply), maxPlies: Math.max(4 * req.size * req.size, ply), phase: 'play' },
    opts.featureVersion,
  )
  const { policy, value } = await backend.run(features, flags.channels, req.size)
  if (policy.length < numActions(req.size)) {
    return { action: null, error: `policy 维度不符：期望 ${numActions(req.size)}，实际 ${policy.length}` }
  }

  // masked softmax：非法动作填 -inf 后按温度取 softmax
  const T = opts.stochastic ? 0.5 : 1
  let mx = -Infinity
  for (const i of legal) mx = Math.max(mx, policy[i])
  const exps = legal.map((i) => Math.exp((policy[i] - mx) / T))
  const sum = exps.reduce((a, b) => a + b, 0)
  let pick = 0
  if (opts.stochastic) {
    let r = (opts.rng ?? Math.random)() * sum
    for (let k = 0; k < exps.length; k++) {
      r -= exps[k]
      if (r <= 0) { pick = k; break }
    }
  } else {
    for (let k = 1; k < exps.length; k++) if (exps[k] > exps[pick]) pick = k
  }
  const idx = legal[pick]
  const action = indexToAction(idx, req.size)
  const prob = exps[pick] / sum
  const stats: AiStats = {
    ...base,
    elapsedMs: Date.now() - t0,
    score: value,
    reason: `神经网路评估 ${(value * 100).toFixed(0)}%，本手概率 ${(prob * 100).toFixed(1)}%（${legal.length} 个合法着）`,
  }
  return { action, stats }
}
