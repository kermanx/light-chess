/**
 * 复盘数据源抽象：远端分析服务 / 本机 NN MCTS / 内置 WASM alpha-beta 三个后端
 * 暴露同一个流式接口（meta → ply… → final），复盘页只消费 PlyLine。
 *
 * value/q 口径：一律相对该 ply 行棋方，[-1,1]（前端再翻蓝方视角）。
 *
 * 三后端字段映射：
 * | PlyLine 字段    | remote              | nn（本机）              | wasm（本机）                |
 * | value           | 服务端搜索根值      | MCTS 根 Q（value 头经搜索修正） | score 换算（见 wasmScoreToValue） |
 * | top[].move      | top-5 候选          | 根候选按 visits 排序    | 最终迭代层候选              |
 * | top[].q         | 子节点 Q            | 子节点均值 Q            | score 换算                  |
 * | top[].prob      | policy 概率         | 根先验（合法着上归一化）| —（缺省，UI 不显示概率）    |
 * | top[].orderingScore | —               | 子节点 visits           | 引擎 orderingScore          |
 * | second          | 第二意见模型        | —（null）               | —（null）                   |
 * | dead            | 服务端僵持判定      | 必平核一阶判定          | 必平核一阶判定              |
 */
import { edgeOf, type BoardState, type Color, type Dir, type Home, type Ori } from '../game'
import { isDeadDraw } from '../ai/nn-mcts'
import { makeAiRequest, type AiRequest, type AiResponse, type AiStats } from '../ai/protocol'
import { loadNnModels, MODELS_BASE, nnModelsForSize, type NnModelInfo } from '../nn/models'
import type { NnWorkerMessage } from '../ai/nn-worker'

// ---------- 流式行类型（与远端 NDJSON 协议一致） ----------

export type ReviewMove = { kind: 'edge'; id: string } | { kind: 'diag'; x: number; y: number; ori: Ori }

export interface TopMove {
  move: ReviewMove
  /** policy/先验概率；wasm 后端无此概念，缺省 */
  prob?: number
  /** 相对行棋方的 Q/估值 [-1,1] */
  q: number
  /** 后端原始的排序分（nn = visits，wasm = 引擎 orderingScore）；仅诊断用 */
  orderingScore?: number
}

export interface MetaLine {
  type: 'meta'
  coach: string
  second: string | null
  sims: number
  size: number
  total_plies: number
  value_convention?: string
}

export interface PlyLine {
  type: 'ply'
  ply: number
  mover: 0 | 1
  move: ReviewMove
  /** 相对行棋方的局面估值 [-1,1] */
  value: number
  top: TopMove[]
  dead: boolean
  /** 第二意见：value 相对行棋方（与 coach 同约定），top 至多 3 条；仅 remote 可提供 */
  second: { value: number; top: TopMove[] } | null
  progress: { done: number; total: number }
}

export interface FinalLine {
  type: 'final'
  blunders: { ply: number; mover: number; drop: number }[]
  result: unknown
  ms?: number
  elapsed_ms?: number
}

// ---------- 数据源接口 ----------

/** 复盘输入：对局快照（homes + 全部 moves），与服务端 /api/analyze 的请求体一致 */
export interface ReviewGameInput {
  size: number
  boundaryReflects: boolean
  homes: Partial<Record<Color, Home>>
  moves: ReviewMove[]
}

export interface ReviewCallbacks {
  onMeta?(m: MetaLine): void
  onLine(l: PlyLine): void
  onDone(s: FinalLine): void
  onError(e: Error): void
}

export interface ReviewSource {
  readonly kind: 'wasm' | 'nn' | 'remote'
  start(game: ReviewGameInput, cb: ReviewCallbacks): Promise<void>
  cancel(): void
}

/** 行棋方颜色：复盘仅支持双人局，players[0] 蓝先行 */
export const moverColor = (mover: number): Color => (mover === 0 ? 'blue' : 'red')

/** 复盘假设的双人局座位序 */
const REVIEW_PLAYERS: Color[] = ['blue', 'red']

/** ply 估值翻成蓝方视角 */
export const blueValueOf = (mover: number, value: number): number => (mover === 0 ? value : -value)

/** 取消信号：start 内部每个 ply 边界检查 */
class Cancelled extends Error {
  constructor() {
    super('分析已取消')
    this.name = 'Cancelled'
  }
}

// ---------- RemoteReviewSource：现有 /api/analyze 流式消费，行为不变 ----------

export class RemoteReviewSource implements ReviewSource {
  readonly kind = 'remote' as const
  private baseUrl: string
  private coach: string
  private second: string
  private sims: number
  private aborter: AbortController | null = null

  constructor(opts: { baseUrl: string; coach: string; second: string; sims: number }) {
    this.baseUrl = opts.baseUrl
    this.coach = opts.coach
    this.second = opts.second
    this.sims = opts.sims
  }

  cancel() {
    this.aborter?.abort()
  }

  async start(game: ReviewGameInput, cb: ReviewCallbacks): Promise<void> {
    const ac = (this.aborter = new AbortController())
    try {
      const r = await fetch(`${this.baseUrl}/api/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ac.signal,
        body: JSON.stringify({
          size: game.size,
          homes: game.homes,
          moves: game.moves,
          coach: this.coach,
          sims: this.sims,
          ...(this.second ? { second: this.second } : {}),
        }),
      })
      if (!r.ok) {
        let msg = `HTTP ${r.status}`
        try {
          msg = ((await r.json()) as { error?: string }).error || msg
        } catch { /* 非 JSON 错误体 */ }
        throw new Error(msg)
      }
      if (!r.body) throw new Error('响应无正文')
      const reader = r.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let done: FinalLine | null = null
      const handle = (line: MetaLine | PlyLine | FinalLine) => {
        if (line.type === 'meta') cb.onMeta?.(line)
        else if (line.type === 'ply') cb.onLine(line)
        else done = line
      }
      for (;;) {
        const { done: eof, value } = await reader.read()
        if (eof) break
        buf += dec.decode(value, { stream: true })
        let i: number
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim()
          buf = buf.slice(i + 1)
          if (line) handle(JSON.parse(line))
        }
      }
      if (buf.trim()) handle(JSON.parse(buf.trim()))
      if (done) cb.onDone(done)
      else cb.onError(new Error('分析流提前结束（未收到 final）'))
    } catch (e) {
      if ((e as Error).name !== 'AbortError') cb.onError(e as Error)
    }
  }
}

// ---------- 本机后端共用：逐 ply 重放 + 搜索 → PlyLine ----------

/** 一次局面搜索（worker/直连均可），收 AiRequest 回 AiResponse */
export type ReviewSearchFn = (req: AiRequest) => Promise<AiResponse>

/** 重建第 k 手之前的局面（homes 的三面家镜 + 前 k 手落子） */
export function reviewBoardAt(game: ReviewGameInput, k: number): BoardState {
  const edges = new Map<string, { color: Color }>()
  const diags = new Map<string, { color: Color; ori: Ori }>()
  for (const [c, h] of Object.entries(game.homes)) {
    if (!h) continue
    for (const d of [0, 1, 2, 3] as Dir[]) {
      if (d !== h.dir) edges.set(edgeOf(h.x, h.y, d), { color: c as Color })
    }
  }
  for (let i = 0; i < k && i < game.moves.length; i++) {
    const m = game.moves[i]
    const color = moverColor(i % 2)
    if (m.kind === 'edge') edges.set(m.id, { color })
    else diags.set(`${m.x},${m.y}`, { color, ori: m.ori })
  }
  return { homes: game.homes, edges, diags, size: game.size, boundaryReflects: game.boundaryReflects }
}

/** 从搜索统计里取最终（最深）一层候选；被打断的迭代用 partialIteration 兜底 */
function finalCandidates(stats: AiStats): NonNullable<NonNullable<AiStats['iterations']>[number]['candidates']> {
  const it = stats.iterations
  if (it?.length) return it[it.length - 1].candidates
  return stats.partialIteration?.candidates ?? []
}

export interface LocalReviewMapping {
  /** meta.coach 展示标签 */
  label: string
  /** 报告给 meta 的 sims（wasm 无此概念，填 0） */
  sims: number
  /** true = 候选带 prob（nn 的归一化先验）；false = prob 缺省（wasm） */
  includeProb: boolean
  /** 引擎 score → [-1,1] 行棋方估值；nn 直接截断，wasm 做量级换算 */
  scoreToValue(score: number): number
  /** 传给引擎的 budgetMs */
  budgetMs: number
}

/**
 * 本机后端的复盘主循环：逐 ply 重放 moves，每个历史局面发一次搜索，
 * 把根候选映射成 top-5。最后从相邻 ply 估值差合成失误表（drop > 0.3 记失误）。
 */
export async function runLocalReview(
  game: ReviewGameInput,
  search: ReviewSearchFn,
  map: LocalReviewMapping,
  cb: ReviewCallbacks,
  isCancelled: () => boolean,
): Promise<void> {
  const t0 = Date.now()
  const total = game.moves.length
  cb.onMeta?.({
    type: 'meta',
    coach: map.label,
    second: null,
    sims: map.sims,
    size: game.size,
    total_plies: total,
    value_convention: 'mover',
  })
  const plies: PlyLine[] = []
  for (let k = 0; k < total; k++) {
    if (isCancelled()) throw new Cancelled()
    const mover = (k % 2) as 0 | 1
    const current = moverColor(mover)
    const board = reviewBoardAt(game, k)
    const req = makeAiRequest(board, {
      phase: 'play',
      players: REVIEW_PLAYERS,
      current,
      dead: [],
      budgetMs: map.budgetMs,
    })
    const res = await search(req)
    if (isCancelled()) throw new Cancelled()
    if (res.error || !res.stats) throw new Error(res.error || '引擎未返回统计')
    const cands = finalCandidates(res.stats)
    const top: TopMove[] = cands
      .filter((c) => c.action.kind !== 'setup')
      .slice(0, 5)
      .map((c) => ({
        move: c.action.kind === 'edge'
          ? { kind: 'edge', id: c.action.id }
          : { kind: 'diag', x: (c.action as { x: number }).x, y: (c.action as { y: number }).y, ori: (c.action as { ori: Ori }).ori },
        q: map.scoreToValue(c.score),
        ...(map.includeProb && typeof c.selectionScore === 'number' ? { prob: c.selectionScore } : {}),
        orderingScore: c.orderingScore,
      }))
    const line: PlyLine = {
      type: 'ply',
      ply: k,
      mover,
      move: game.moves[k],
      value: map.scoreToValue(res.stats.score),
      top,
      dead: isDeadDraw({ board, alive: [...REVIEW_PLAYERS], current }),
      second: null,
      progress: { done: k + 1, total },
    }
    plies.push(line)
    cb.onLine(line)
  }
  // 失误表：本手落子后（= 下一 ply 的行棋前估值）相对本手行棋前估值的跌幅（行棋方视角）
  const blunders: { ply: number; mover: number; drop: number }[] = []
  for (let k = 1; k < plies.length; k++) {
    const before = blueValueOf(plies[k - 1].mover, plies[k - 1].value)
    const after = blueValueOf(plies[k].mover, plies[k].value)
    const drop = plies[k - 1].mover === 0 ? before - after : after - before
    if (drop > 0.3) blunders.push({ ply: k - 1, mover: plies[k - 1].mover, drop })
  }
  cb.onDone({ type: 'final', blunders, result: null, ms: Date.now() - t0 })
}

// ---------- NnReviewSource：nn-worker（PUCT MCTS，定额 sims） ----------

/** NN 复盘默认定额：150 sims/ply（训练/评测标准档），可配置 */
export const NN_REVIEW_SIMS = 150

export class NnReviewSource implements ReviewSource {
  readonly kind = 'nn' as const
  private modelId: string
  private label: string
  private sims: number
  private budgetMs: number
  /** node/测试注入的直连搜索；缺省走 nn-worker */
  private search: ReviewSearchFn | null
  private worker: Worker | null = null
  private cancelled = false

  constructor(opts: { modelId: string; modelName?: string; sims?: number; budgetMs?: number; search?: ReviewSearchFn }) {
    this.modelId = opts.modelId
    this.label = opts.modelName ? `NN（本机）${opts.modelName}` : 'NN（本机）'
    this.sims = opts.sims && opts.sims > 0 ? Math.floor(opts.sims) : NN_REVIEW_SIMS
    this.budgetMs = opts.budgetMs ?? 60_000
    this.search = opts.search ?? null
  }

  cancel() {
    this.cancelled = true
    this.worker?.terminate()
    this.worker = null
  }

  private workerSearch(): ReviewSearchFn {
    this.worker = new Worker(new URL('../ai/nn-worker.ts', import.meta.url), { type: 'module' })
    const worker = this.worker
    let chain = Promise.resolve()
    return (req) => {
      // worker 一次只处理一条消息：串行化逐 ply 请求
      const next = chain.then(
        () =>
          new Promise<AiResponse>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<AiResponse>) => resolve(event.data)
            worker.onerror = (event) => reject(new Error(event.message || 'NN worker 运行失败'))
            const message: NnWorkerMessage = {
              request: req,
              nn: { modelId: this.modelId, modelsBase: MODELS_BASE, limit: { type: 'sims', sims: this.sims } },
            }
            worker.postMessage(message)
          }),
      )
      chain = next.then(() => undefined, () => undefined)
      return next
    }
  }

  async start(game: ReviewGameInput, cb: ReviewCallbacks): Promise<void> {
    this.cancelled = false
    try {
      const search = this.search ?? this.workerSearch()
      await runLocalReview(
        game,
        search,
        {
          label: this.label,
          sims: this.sims,
          includeProb: true,
          // MCTS score 已是行棋方视角 [-1,1]（根 Q），只截断
          scoreToValue: (s) => Math.max(-1, Math.min(1, s)),
          budgetMs: this.budgetMs,
        },
        cb,
        () => this.cancelled,
      )
    } catch (e) {
      if (!(e instanceof Cancelled)) cb.onError(e as Error)
    }
  }
}

// ---------- WasmReviewSource：内置 Rust alpha-beta 引擎 ----------

/** WASM 复盘默认搜索预算：3s/ply，可配置 */
export const WASM_REVIEW_BUDGET_MS = 3000

/**
 * WASM 引擎的 score 是 i32 量级分（±1_000_000 为必杀/必败，启发项量级数千~数万），
 * 换算到 [-1,1]：|score| ≥ WIN/2 直接取 ±1（必胜/必败），其余 tanh(score/20000) 平滑压缩。
 */
export function wasmScoreToValue(score: number): number {
  const WIN = 1_000_000
  if (score >= WIN / 2) return 1
  if (score <= -WIN / 2) return -1
  return Math.tanh(score / 20_000)
}

export class WasmReviewSource implements ReviewSource {
  readonly kind = 'wasm' as const
  private budgetMs: number
  private search: ReviewSearchFn | null
  private worker: Worker | null = null
  private cancelled = false

  constructor(opts: { budgetMs?: number; search?: ReviewSearchFn } = {}) {
    this.budgetMs = opts.budgetMs ?? WASM_REVIEW_BUDGET_MS
    this.search = opts.search ?? null
  }

  cancel() {
    this.cancelled = true
    this.worker?.terminate()
    this.worker = null
  }

  private workerSearch(): ReviewSearchFn {
    this.worker = new Worker(new URL('../ai/worker.ts', import.meta.url), { type: 'module' })
    const worker = this.worker
    let chain = Promise.resolve()
    return (req) => {
      const next = chain.then(
        () =>
          new Promise<AiResponse>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<AiResponse>) => resolve(event.data)
            worker.onerror = (event) => reject(new Error(event.message || 'AI 引擎 worker 运行失败'))
            worker.postMessage(req)
          }),
      )
      chain = next.then(() => undefined, () => undefined)
      return next
    }
  }

  async start(game: ReviewGameInput, cb: ReviewCallbacks): Promise<void> {
    this.cancelled = false
    try {
      const search = this.search ?? this.workerSearch()
      await runLocalReview(
        game,
        search,
        {
          label: '内置引擎（本机）',
          sims: 0,
          includeProb: false,
          scoreToValue: wasmScoreToValue,
          budgetMs: this.budgetMs,
        },
        cb,
        () => this.cancelled,
      )
    } catch (e) {
      if (!(e instanceof Cancelled)) cb.onError(e as Error)
    }
  }
}

// ---------- 可用性探测 ----------

/** 云端复盘服务地址：构建期 VITE_REVIEW_SERVICE_URL 注入；未定义 = 无云端 */
export const REMOTE_REVIEW_URL = ((import.meta.env?.VITE_REVIEW_SERVICE_URL as string | undefined) ?? '').trim()

export const remoteReviewEnabled = REMOTE_REVIEW_URL.length > 0

/** 指定尺寸下的本机 NN 复盘模型（推荐者优先；无匹配 = null）。models.json 读取失败按不可用处理。 */
export async function nnReviewModel(size: number): Promise<NnModelInfo | null> {
  try {
    const sized = nnModelsForSize(await loadNnModels(), size)
    return (sized.find((m) => m.recommended) ?? sized[0]) ?? null
  } catch {
    return null
  }
}
