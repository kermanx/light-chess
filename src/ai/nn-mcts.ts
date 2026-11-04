/**
 * NN 引擎的浏览器/node 双端 PUCT MCTS（不依赖 DOM）。
 *
 * 移植 rl/lightchess/mcts.py 的语义：
 * - value 从「该节点当前行动方」视角，回溯逐层取负；终局 ±1，必平/僵局/手数上限 0。
 * - 状态推进对应 store.ts：落子 → 下一存活玩家回合开头结算其激光（命中即淘汰，
 *   只剩一名存活玩家时其获胜）；ply 达到 maxPlies（= 4·s²，与 nn-core 编码一致）判平。
 * - 必平核 isDeadDraw 移植 rl/lightchess/env.py 的一阶精确判定（双方各自全部合法着
 *   都不改变任何一方的激光命中集合 → 必平），含两个声音剪枝：边界反射下的边界边
 *   恒 no-op；双方激光都未触及的格恒 no-op。
 *
 * 与训练侧的三点工程差异：
 * - 批量叶子评估：每波收集 batch（8→32 自适应）个待评估叶子，拼成一批过 ONNX。
 * - 虚拟损失（virtual loss）：同波内先给选中路径临时记一次负分，避免重复选同一叶子，
 *   评估返回后撤销再做真实回溯。
 * - 时间预算驱动：不固定 sims，跑到 budget 用完（每次选叶子/每波评估后检查）。
 *
 * evaluate 由调用方注入：worker 侧把 boards 拼 batch 过一次 ONNX session。
 */
import { PALETTE, type BoardState, type Color } from '../game'
import { encodeState, traceLaser, type FeatureVersion } from '../nn/encoder'
import {
  boardFromRequest,
  indexToAction,
  legalActionIndices,
  legalSetupHomes,
  numActions,
} from './nn-core'
import type { AiRequest, AiResponse, AiStats } from './protocol'

/** 一批已编码局面 → 一批 policy/value（policy 为未掩码 logits，长度 numActions） */
export type BatchEvaluator = (boards: Float32Array[]) => Promise<{ policy: Float32Array; value: number }[]>

export interface NnMctsOptions {
  featureVersion: FeatureVersion
  budgetMs: number
  /** 模拟数定额模式：跑满 N 个模拟（终局/必平叶子与 Python 口径一致计数，最后一波截断不超发）。
   *  缺省 = 时间模式（budgetMs 预算驱动）。 */
  sims?: number
  /** true = 按 visit 分布温度 0.5 采样；false（默认）= 最大 visit */
  stochastic?: boolean
  rng?: () => number
  modelName?: string
  /** PUCT 探索常数（默认 1.5，与训练侧一致） */
  cPuct?: number
  /** 必平核检测（默认开）；关闭后退化为「无合法着/手数上限」的保守平局规则 */
  deadDraw?: boolean
}

/** 搜索内部推进的局态（2 人局与 env.py 同构；多人局按 store.ts 结算语义推广） */
interface SimState {
  board: BoardState
  players: Color[]
  alive: Color[]
  current: Color
  ply: number
  maxPlies: number
  over: boolean
  winner: Color | null
  draw: boolean
}

interface MctsNode {
  prior: number
  n: number
  w: number
  /** 终局/必平 value（本节点当前行动方视角）；非 null 时不再扩展 */
  tv: number | null
  children: Map<number, MctsNode> | null
  /** 展开时算出的合法着（评估完成后即失去意义，但保留无害） */
  legal: number[] | null
}

const cloneState = (st: SimState): SimState => ({
  ...st,
  board: { ...st.board, edges: new Map(st.board.edges), diags: new Map(st.board.diags) },
  alive: [...st.alive],
})

/** 动作索引落子 + 回合结算（对应 env.step / store applyAction+settleTurn） */
function applyIdx(st: SimState, idx: number) {
  const s = st.board.size
  const color = st.current
  const eh = s * (s + 1)
  if (idx < eh) {
    st.board.edges.set(`h:${idx % s}:${Math.floor(idx / s)}`, { color })
  } else if (idx < 2 * eh) {
    const k = idx - eh
    st.board.edges.set(`v:${k % (s + 1)}:${Math.floor(k / (s + 1))}`, { color })
  } else {
    const k = idx - 2 * eh
    const cell = Math.floor(k / 2)
    st.board.diags.set(`${cell % s},${Math.floor(cell / s)}`, { color, ori: (k % 2 === 0 ? '/' : '\\') as '/' | '\\' })
  }
  st.ply++
  // 换手到下一存活玩家，并结算其回合开头的激光（store.ts nextAlive + settleTurn）
  const i = st.players.indexOf(color)
  let j = i
  do { j = (j + 1) % st.players.length } while (!st.alive.includes(st.players[j]))
  st.current = st.players[j]
  const { hits } = traceLaser(st.board, st.current)
  const eliminated = [...hits].filter((c) => st.alive.includes(c))
  if (eliminated.length) {
    st.alive = st.alive.filter((c) => !eliminated.includes(c))
    if (st.alive.length === 1) {
      st.over = true
      st.winner = st.alive[0]
      return
    }
  }
  if (st.ply >= st.maxPlies) {
    st.over = true
    st.draw = true
  }
}

/** 终局 value（st.current 视角）；未终局返回 null */
const terminalValue = (st: SimState): number | null => {
  if (!st.over) return null
  if (st.draw || !st.winner) return 0
  return st.winner === st.current ? 1 : -1
}

const hitsKey = (hits: Set<Color>) => [...hits].sort().join(',')

/**
 * 必平核检测（移植 env.is_dead_draw，一阶精确版）：双方各自的全部合法着法中，
 * 是否存在任何一手能改变任意一方的激光命中集合；不存在 → 必平。
 * presetLegal：当前行动方的合法着已在外层算过时传入，避免重复枚举。
 */
export function isDeadDraw(st: Pick<SimState, 'board' | 'alive' | 'current'>, presetLegal?: number[]): boolean {
  const board = st.board
  const s = board.size
  const movers = st.alive.filter((c) => board.homes[c])
  if (movers.length < 2) return false
  const baseHits = new Map<Color, string>()
  const touched = new Uint8Array(s * s)
  for (const c of movers) {
    const { hits, visited } = traceLaser(board, c)
    baseHits.set(c, hitsKey(hits))
    for (let cell = 0; cell < s * s; cell++) {
      const b = cell * 4
      if (visited[b] || visited[b + 1] || visited[b + 2] || visited[b + 3]) touched[cell] = 1
    }
  }
  const off = s * (s + 1)
  const nEid = 2 * off
  const boundaryReflects = board.boundaryReflects ?? false
  const changedAfterProbe = () => {
    for (const c of movers) {
      if (hitsKey(traceLaser(board, c).hits) !== baseHits.get(c)) return true
    }
    return false
  }
  for (const mover of movers) {
    const legal = mover === st.current && presetLegal ? presetLegal : legalActionIndices(board, mover, movers)
    for (const idx of legal) {
      if (idx < nEid) {
        // 边镜：相邻格（边界边只有一侧）
        let c0 = -1
        let c1 = -1
        let id: string
        if (idx < off) {
          const x = idx % s
          const y = Math.floor(idx / s)
          if (y > 0) c0 = (y - 1) * s + x
          if (y < s) c1 = y * s + x
          id = `h:${x}:${y}`
        } else {
          const k = idx - off
          const x = k % (s + 1)
          const y = Math.floor(k / (s + 1))
          if (x > 0) c0 = y * s + x - 1
          if (x < s) c1 = y * s + x
          id = `v:${x}:${y}`
        }
        if ((c0 < 0 || c1 < 0) && boundaryReflects) continue // 边界优先于镜子：恒 no-op
        if (!((c0 >= 0 && touched[c0]) || (c1 >= 0 && touched[c1]))) continue // 双侧均无激光触及：恒 no-op
        board.edges.set(id, { color: mover })
        const changed = changedAfterProbe()
        board.edges.delete(id)
        if (changed) return false
      } else {
        const cell = (idx - nEid) >> 1
        if (!touched[cell]) continue
        const key = `${cell % s},${Math.floor(cell / s)}`
        board.diags.set(key, { color: mover, ori: ((idx - nEid) % 2 === 0 ? '/' : '\\') as '/' | '\\' })
        const changed = changedAfterProbe()
        board.diags.delete(key)
        if (changed) return false
      }
    }
  }
  return true
}

/** masked softmax 先验展开子节点 */
function expandWithPriors(node: MctsNode, legal: number[], policy: Float32Array) {
  let mx = -Infinity
  for (const i of legal) mx = Math.max(mx, policy[i])
  let sum = 0
  const exps = legal.map((i) => {
    const e = Math.exp(policy[i] - mx)
    sum += e
    return e
  })
  node.children = new Map()
  legal.forEach((idx, k) => {
    node.children!.set(idx, { prior: exps[k] / sum, n: 0, w: 0, tv: null, children: null, legal: null })
  })
}

const encode = (st: SimState, fv: FeatureVersion) =>
  encodeState({ board: st.board, current: st.current, players: st.players, ply: st.ply, maxPlies: st.maxPlies, phase: 'play' }, fv)

/**
 * 一条 play 阶段 AiRequest → MCTS AiResponse。setup 阶段保持 policy-only 版行为
 * （均匀随机合法选家，模型不参与）。
 */
export async function chooseNnMctsAction(evaluate: BatchEvaluator, req: AiRequest, opts: NnMctsOptions): Promise<AiResponse> {
  const t0 = Date.now()
  const board = boardFromRequest(req)
  const players = req.players.map((i) => PALETTE[i].id)
  const current = PALETTE[req.current].id
  const alive = players.filter((c) => req.aliveMask & (1 << PALETTE.findIndex((p) => p.id === c)))
  const size = req.size
  const rng = opts.rng ?? Math.random
  const cPuct = opts.cPuct ?? 1.5
  const mode = `nn-mcts:${opts.modelName ?? opts.featureVersion}`

  if (req.phase === 'setup') {
    const homes = legalSetupHomes(board, players, current)
    if (!homes.length) return { action: null, error: 'NN 引擎在布置阶段无合法选家' }
    const home = homes[Math.floor(rng() * homes.length)]
    const stats: AiStats = {
      nodes: 0, depth: 0, mode, elapsedMs: Date.now() - t0, score: 0,
      reason: '布置阶段：随机合法选家（NN 模型不参与选家）',
    }
    return { action: { kind: 'setup', home }, stats }
  }

  const ply0 = Math.max(0, board.edges.size + board.diags.size - 3 * Object.keys(board.homes).length)
  const rootState: SimState = {
    board, players, alive, current,
    ply: ply0, maxPlies: Math.max(4 * size * size, ply0),
    over: false, winner: null, draw: false,
  }
  const budgetMs = Math.max(60, opts.budgetMs)
  const targetSims = opts.sims && opts.sims > 0 ? Math.floor(opts.sims) : null
  // sims 定额模式以模拟数为准；墙钟只作兜底，避免异常局面卡死 worker
  const deadline = t0 + (targetSims ? Math.max(budgetMs, 60_000) : budgetMs)
  const root: MctsNode = { prior: 0, n: 0, w: 0, tv: null, children: null, legal: null }

  // ---- 根节点展开（终局/必平/僵局优先，否则网络先验）----
  let rootLegal = legalActionIndices(board, current, alive)
  if (!rootLegal.length) return { action: null, error: 'NN 引擎未找到合法落子' }
  if (opts.deadDraw !== false && isDeadDraw(rootState, rootLegal)) root.tv = 0
  const rootEval = await evaluate([encode(rootState, opts.featureVersion)])
  if (rootEval[0].policy.length < numActions(size)) {
    return { action: null, error: `policy 维度不符：期望 ${numActions(size)}，实际 ${rootEval[0].policy.length}` }
  }
  expandWithPriors(root, rootLegal, rootEval[0].policy)
  let rootValue = rootEval[0].value

  // ---- 预算驱动的批量模拟（必平根 value 已知为 0，跳过 sims）----
  let sims = 0
  let maxDepth = 0
  let batch = 8
  if (root.tv === null) {
    while (Date.now() < deadline && (targetSims === null || sims < targetSims)) {
      const pending: { node: MctsNode; path: MctsNode[]; st: SimState }[] = []
      const direct: { path: MctsNode[]; v: number }[] = []
      // 收集一波叶子（虚拟损失防止同波撞车；每次迭代检查预算，远严于 100ms 上限）。
      // 终局/必平叶子命中即回溯、不占网络评估；选择数上限只是全终止树的兜底，
      // 正常局面每波都能凑满 batch 个待评估叶子。
      let selections = 0
      while (pending.length < batch && selections < 4096 && Date.now() < deadline &&
        // sims 定额：每次选择恰好贡献一次回溯，截断最后一波保证总数不超发
        (targetSims === null || sims + selections < targetSims)) {
        selections++
        let node = root
        const st = cloneState(rootState)
        const path = [node]
        while (node.children && node.tv === null) {
          const total = Math.sqrt(Math.max(node.n, 1))
          let bestA = -1
          let bestU = -Infinity
          for (const [a, ch] of node.children) {
            const q = ch.n ? ch.w / ch.n : 0
            const u = -q + cPuct * ch.prior * total / (1 + ch.n)
            if (u > bestU) {
              bestU = u
              bestA = a
            }
          }
          const child = node.children.get(bestA)!
          child.n += 1 // 虚拟损失：先记一次负分
          child.w -= 1
          applyIdx(st, bestA)
          node = child
          path.push(node)
        }
        if (node.tv === null) {
          // 未展开叶子：先查终局/僵局/必平，都不行才排队等网络评估
          const tv = terminalValue(st)
          if (tv !== null) {
            node.tv = tv
            direct.push({ path, v: tv })
          } else {
            const legal = legalActionIndices(st.board, st.current, st.alive)
            if (!legal.length) {
              node.tv = 0 // 无合法着 = 平局
              direct.push({ path, v: 0 })
            } else if (opts.deadDraw !== false && isDeadDraw(st, legal)) {
              node.tv = 0
              direct.push({ path, v: 0 })
            } else {
              node.legal = legal
              pending.push({ node, path, st })
            }
          }
        } else {
          direct.push({ path, v: node.tv })
        }
        maxDepth = Math.max(maxDepth, path.length - 1)
      }

      const undoVirtualLoss = (path: MctsNode[]) => {
        for (let i = 1; i < path.length; i++) {
          path[i].n -= 1
          path[i].w += 1
        }
      }
      const backup = (path: MctsNode[], v: number) => {
        let sign = 1
        for (let i = path.length - 1; i >= 0; i--) {
          path[i].n += 1
          path[i].w += sign * v
          sign = -sign
        }
      }
      for (const d of direct) {
        undoVirtualLoss(d.path)
        backup(d.path, d.v)
        sims++
      }
      if (!pending.length) {
        if (!direct.length) break // 预算刚好在一波收集前用完
        continue // 本波全是终局/必平回溯，无网络评估
      }
      const waveT = Date.now()
      const results = await evaluate(pending.map((p) => encode(p.st, opts.featureVersion)))
      const waveMs = Date.now() - waveT
      for (let i = 0; i < pending.length; i++) {
        const { node, path } = pending[i]
        undoVirtualLoss(path)
        expandWithPriors(node, node.legal!, results[i].policy)
        backup(path, results[i].value)
        sims++
      }
      // 自适应批量：单波评估很快说明推理远快于选择，加大批量摊薄调度开销
      if (waveMs < 30 && batch < 32) batch = Math.min(32, batch * 2)
      else if (waveMs > 200 && batch > 8) batch = Math.max(8, batch >> 1)
    }
  }
  if (root.n > 0) rootValue = root.w / root.n

  // ---- 选最终着法：最大 visit；随机开关下按 visit^(1/0.5) 温度采样 ----
  const entries = [...root.children!.entries()]
  let pickIdx = 0
  if (opts.stochastic && entries.some(([, ch]) => ch.n > 0)) {
    const weights = entries.map(([, ch]) => ch.n ** 2) // T=0.5
    const sum = weights.reduce((a, b) => a + b, 0)
    let r = rng() * sum
    for (let k = 0; k < weights.length; k++) {
      r -= weights[k]
      if (r <= 0) {
        pickIdx = k
        break
      }
    }
  } else {
    for (let k = 1; k < entries.length; k++) {
      const better = entries[k][1].n > entries[pickIdx][1].n ||
        // 必平根无 visit：退化为最大先验
        (entries[k][1].n === entries[pickIdx][1].n && entries[k][1].prior > entries[pickIdx][1].prior)
      if (better) pickIdx = k
    }
  }
  const [bestA, bestChild] = entries[pickIdx]
  const action = indexToAction(bestA, size)
  const elapsedMs = Date.now() - t0

  const candidates = entries
    .map(([a, ch]) => ({
      action: indexToAction(a, size),
      score: ch.n ? -ch.w / ch.n : 0, // 子节点 Q 是对手视角，取负回根视角
      selectionScore: ch.prior,
      orderingScore: ch.n,
    }))
    .sort((x, y) => y.orderingScore - x.orderingScore || y.selectionScore - x.selectionScore)
    .slice(0, 8)
  const stats: AiStats = {
    nodes: sims,
    depth: maxDepth,
    elapsedMs,
    score: root.tv ?? (bestChild.n ? -bestChild.w / bestChild.n : rootValue),
    mode,
    stopReason: targetSims ? 'node-limit' : 'time-limit',
    reason: root.tv === 0
      ? `MCTS 判定必平（${rootLegal.length} 个合法着），按网络先验落子`
      : targetSims
        ? `MCTS ${sims}/${targetSims} sims（PUCT c=${cPuct}，最深 ${maxDepth} 层），根估值 ${(rootValue * 100).toFixed(0)}%`
        : `MCTS ≈${sims} sims（PUCT c=${cPuct}，批量≤${batch}，最深 ${maxDepth} 层），根估值 ${(rootValue * 100).toFixed(0)}%`,
    iterations: [{ depth: Math.max(maxDepth, 1), candidates }],
  }
  return { action, stats }
}
