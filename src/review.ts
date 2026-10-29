/** 独立复盘页：把本局 homes + moves 交给选定的 ReviewSource（云端 / 本机 NN / 本机内置引擎），
 * 逐条消费统一的 PlyLine 流，驱动复盘页的逐步骤打分播放。
 *
 * value/q 约定：相对该 ply 行棋方；前端一律翻成蓝方视角展示（红方行棋取负）。
 * 云端服务地址由构建期 VITE_REVIEW_SERVICE_URL 注入；未定义时复盘页完全无云端入口。
 */
import { reactive, watch } from 'vue'
import type { Color, Home, Ori } from './game'
import { isAiPlayer, state } from './store'
import type { NnModelInfo } from './nn/models'
import {
  NnReviewSource,
  nnReviewModel,
  RemoteReviewSource,
  remoteReviewEnabled,
  REMOTE_REVIEW_URL,
  WasmReviewSource,
  moverColor,
  type FinalLine,
  type MetaLine,
  type PlyLine,
  type ReviewGameInput,
  type ReviewMove,
  type ReviewSource,
  type TopMove,
} from './review/source'

export { moverColor, remoteReviewEnabled }
export type { FinalLine, MetaLine, PlyLine, ReviewMove, TopMove }

// ---------- 云端模型目录（仅 remote 数据源使用；对局 AI 用本地座位模型） ----------

export interface ModelGen {
  gen: number
  id: string
  eval: number | null
}

export interface ModelInfo {
  id: string // run/genN（最新代）
  run: string
  gen: number
  name: string
  recipe: string
  size: number | null
  eval_random: number | null
  eval_vs_prev: number | null
  recommended: boolean
  gens: ModelGen[]
}

export const modelList = reactive<{ list: ModelInfo[]; error: string; loaded: boolean }>({
  list: [],
  error: '',
  loaded: false,
})

export async function refreshCkpts() {
  if (!remoteReviewEnabled) return
  modelList.error = ''
  try {
    const r = await fetch(`${REMOTE_REVIEW_URL}/api/models`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    modelList.list = ((await r.json()).models as ModelInfo[]) ?? []
    modelList.loaded = true
  } catch (e) {
    modelList.error = (e as Error).message
    modelList.loaded = false
  }
}

/** 指定尺寸下的推荐模型 id（无推荐则取 eval 最高者） */
export function defaultModelId(size: number): string {
  const list = modelList.list.filter((m) => m.size === size || (m.size === null && size === 6))
  return (list.find((m) => m.recommended) ?? list[0])?.id ?? ''
}

export const sameMove = (a: ReviewMove, b: ReviewMove): boolean =>
  a.kind !== b.kind ? false : a.kind === 'edge' ? a.id === (b as { id: string }).id
    : a.x === (b as { x: number }).x && a.y === (b as { y: number }).y && a.ori === (b as { ori: Ori }).ori

export const moveText = (m: ReviewMove): string =>
  m.kind === 'edge' ? `边镜 ${m.id}` : `斜镜 (${m.x},${m.y}) ${m.ori}`

/** ply 估值翻成蓝方视角 */
export const blueValue = (p: PlyLine): number => (p.mover === 0 ? p.value : -p.value)

/** 第二意见估值翻成蓝方视角（无第二意见时为 null） */
export const blueSecond = (p: PlyLine): number | null =>
  p.second ? (p.mover === 0 ? p.second.value : -p.second.value) : null

export type ReviewSourceKind = ReviewSource['kind']

export const review = reactive({
  active: false,
  size: 6,
  boundaryReflects: true,
  homes: {} as Partial<Record<Color, Home>>,
  moves: [] as ReviewMove[],
  /** 当前数据源；用户在设置里切换后置 sourceChosen，否则 openReview 按可用性挑默认 */
  source: 'wasm' as ReviewSourceKind,
  sourceChosen: false,
  /** 本机 NN 复盘可用（当前尺寸有匹配模型）；openReview 时探测 */
  nnOk: false,
  coach: '',
  /** 第二意见模型 id；空串为不启用（仅 remote） */
  second: '',
  sims: 100,
  meta: null as MetaLine | null,
  plies: [] as PlyLine[],
  final: null as FinalLine | null,
  progress: { done: 0, total: 0 },
  loading: false,
  error: '',
  /** 复盘视角：我坐在蓝方/红方，或旁观（中性展示） */
  perspective: 'spec' as Color | 'spec',
  /** 当前展示的步数（0 = 初始局面） */
  cursor: 0,
  playing: false,
  /** 已展开的僵持段起始 ply（步进条/曲线默认折叠 dead 连续段） */
  expandedRuns: [] as number[],
})

/** 复盘页数据源选择器的可选项（云端只在构建期定义了服务地址时出现） */
export function reviewSourceOptions(): { kind: ReviewSourceKind; label: string }[] {
  const opts: { kind: ReviewSourceKind; label: string }[] = []
  if (remoteReviewEnabled) opts.push({ kind: 'remote', label: '云端' })
  if (review.nnOk) opts.push({ kind: 'nn', label: 'NN（本机）' })
  opts.push({ kind: 'wasm', label: '内置引擎（本机）' })
  return opts
}

/** 本机 NN 复盘模型（openReview 探测后缓存；null = 不可用） */
let nnModel: NnModelInfo | null = null

let activeSource: ReviewSource | null = null

function createSource(): ReviewSource {
  if (review.source === 'remote' && remoteReviewEnabled) {
    return new RemoteReviewSource({
      baseUrl: REMOTE_REVIEW_URL,
      coach: review.coach,
      second: review.second,
      sims: review.sims,
    })
  }
  if (review.source === 'nn' && nnModel) {
    return new NnReviewSource({ modelId: nnModel.id, modelName: nnModel.name, sims: review.sims })
  }
  return new WasmReviewSource()
}

function gameInput(): ReviewGameInput {
  return {
    size: review.size,
    boundaryReflects: review.boundaryReflects,
    homes: review.homes,
    moves: review.moves,
  }
}

export async function runAnalysis() {
  activeSource?.cancel()
  review.loading = true
  review.error = ''
  review.meta = null
  review.plies = []
  review.final = null
  review.progress = { done: 0, total: 0 }
  review.cursor = 0
  review.expandedRuns = []
  const src = (activeSource = createSource())
  await src.start(gameInput(), {
    onMeta(m) {
      review.meta = m
      review.progress = { done: 0, total: m.total_plies }
    },
    onLine(l) {
      review.plies.push(l)
      review.progress = l.progress
      schedulePlay()
    },
    onDone(f) {
      review.final = f
    },
    onError(e) {
      review.error = e.message
      review.playing = false
    },
  })
  // 播放可能还没追上已加载的 ply，交给 schedulePlay 在播完且 final 到达后自行停止
  if (activeSource === src) review.loading = false
}

/** 打开复盘页：从当前对局快照 homes + moves，探测可用数据源并开始分析 */
export function openReview() {
  review.size = state.size
  review.boundaryReflects = state.boundaryReflects
  review.homes = JSON.parse(JSON.stringify(state.homes)) as Partial<Record<Color, Home>>
  review.moves = state.moves.map((m): ReviewMove =>
    m.kind === 'edge' ? { kind: 'edge', id: m.id } : { kind: 'diag', x: m.x, y: m.y, ori: m.ori },
  )
  review.active = true
  review.playing = true
  // 视角默认按对局来源推断：双人局恰有一个 AI 座位时站人类一方，否则旁观
  const humanSeats = state.players.filter((c) => !isAiPlayer(c))
  review.perspective = state.players.length === 2 && humanSeats.length === 1 ? humanSeats[0] : 'spec'

  if (remoteReviewEnabled) {
    if (!modelList.loaded && !modelList.error) void refreshCkpts()
    const sized = modelList.list.filter((m) => m.size === review.size)
    const fit = (id: string) => sized.some((m) => m.id === id || m.gens.some((g) => g.id === id))
    if (!review.coach || (sized.length && !fit(review.coach))) review.coach = defaultModelId(review.size)
    if (review.second && sized.length && !fit(review.second)) review.second = ''
  }
  void prepareAndRun()
}

/** 探测本机 NN 可用性，按优先级挑默认数据源（remote > nn > wasm）后开跑 */
async function prepareAndRun() {
  nnModel = await nnReviewModel(review.size)
  review.nnOk = nnModel !== null
  const usable = reviewSourceOptions().some((o) => o.kind === review.source)
  if (!usable || !review.sourceChosen) {
    review.source = remoteReviewEnabled ? 'remote' : review.nnOk ? 'nn' : 'wasm'
  }
  if (review.active) void runAnalysis()
}

/** 设置里手动切换数据源：记住选择并重新分析 */
export function chooseReviewSource(kind: ReviewSourceKind) {
  review.source = kind
  review.sourceChosen = true
  void runAnalysis()
}

export function closeReview() {
  activeSource?.cancel()
  review.active = false
  review.playing = false
}

export function setCursor(n: number) {
  review.cursor = Math.max(0, Math.min(review.plies.length, Math.round(n)))
}

export function togglePlay() {
  review.playing = !review.playing
  if (review.playing) {
    // 已播完再点播放：从头再来
    if (review.cursor >= review.plies.length) review.cursor = 0
    schedulePlay()
  }
}

/** 展开/收起步进条上的一段「僵持 ×N」 */
export function toggleDeadRun(start: number) {
  const i = review.expandedRuns.indexOf(start)
  if (i >= 0) review.expandedRuns.splice(i, 1)
  else review.expandedRuns.push(start)
}

let playTimer: ReturnType<typeof setTimeout> | undefined

function schedulePlay() {
  clearTimeout(playTimer)
  if (!review.playing || !review.active) return
  if (review.cursor < review.plies.length) {
    // 死步快速掠过，普通步稍慢形成逐步打分动画
    const dead = review.plies[review.cursor]?.dead
    playTimer = setTimeout(() => {
      review.cursor++
      schedulePlay()
    }, dead ? 150 : 600)
  } else if (review.final) {
    review.playing = false
  } else {
    // 已追平已加载的 ply，等流继续
    playTimer = setTimeout(schedulePlay, 300)
  }
}

watch(
  () => review.playing,
  () => schedulePlay(),
)
