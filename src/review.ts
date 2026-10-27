/** 独立复盘页：把本局 homes + moves 提交给推理服务 /api/analyze，
 * 逐行消费流式 NDJSON（meta / ply / final），驱动复盘页的逐步骤打分播放。
 *
 * value/q 约定：相对该 ply 行棋方；前端一律翻成蓝方视角展示（红方行棋取负）。
 * 端点无状态，人人本地对局同样由前端持有 homes+moves 直接提交。
 */
import { reactive, watch } from 'vue'
import type { Color, Home, Ori } from './game'
import { state } from './store'
import { ai, defaultModelId, modelList, refreshCkpts } from './ai'

export type ReviewMove = { kind: 'edge'; id: string } | { kind: 'diag'; x: number; y: number; ori: Ori }

export const sameMove = (a: ReviewMove, b: ReviewMove): boolean =>
  a.kind !== b.kind ? false : a.kind === 'edge' ? a.id === (b as { id: string }).id
    : a.x === (b as { x: number }).x && a.y === (b as { y: number }).y && a.ori === (b as { ori: Ori }).ori

export const moveText = (m: ReviewMove): string =>
  m.kind === 'edge' ? `边镜 ${m.id}` : `斜镜 (${m.x},${m.y}) ${m.ori}`

export interface TopMove {
  move: ReviewMove
  prob: number
  q: number
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
  second: { move: ReviewMove; q: number } | null
  progress: { done: number; total: number }
}

export interface FinalLine {
  type: 'final'
  blunders: { ply: number; mover: number; drop: number }[]
  result: unknown
  ms?: number
  elapsed_ms?: number
}

/** 行棋方颜色：复盘仅支持双人局，players[0] 蓝先行 */
export const moverColor = (mover: number): Color => (mover === 0 ? 'blue' : 'red')

/** ply 估值翻成蓝方视角 */
export const blueValue = (p: PlyLine): number => (p.mover === 0 ? p.value : -p.value)

/** 分析端点只支持 6×6 / 8×8 棋盘 */
export const reviewSizeOk = (size: number) => size === 6 || size === 8

export const review = reactive({
  active: false,
  size: 6,
  boundaryReflects: true,
  homes: {} as Partial<Record<Color, Home>>,
  moves: [] as ReviewMove[],
  coach: '',
  /** 第二意见模型 id；空串为不启用 */
  second: '',
  sims: 100,
  meta: null as MetaLine | null,
  plies: [] as PlyLine[],
  final: null as FinalLine | null,
  progress: { done: 0, total: 0 },
  loading: false,
  error: '',
  /** 当前展示的步数（0 = 初始局面） */
  cursor: 0,
  playing: false,
  /** 已展开的僵持段起始 ply（步进条/曲线默认折叠 dead 连续段） */
  expandedRuns: [] as number[],
})

let aborter: AbortController | null = null

function handleLine(line: MetaLine | PlyLine | FinalLine) {
  if (line.type === 'meta') {
    review.meta = line
    review.progress = { done: 0, total: line.total_plies }
  } else if (line.type === 'ply') {
    review.plies.push(line)
    review.progress = line.progress
    schedulePlay()
  } else {
    review.final = line
  }
}

export async function runAnalysis() {
  aborter?.abort()
  const ac = (aborter = new AbortController())
  review.loading = true
  review.error = ''
  review.meta = null
  review.plies = []
  review.final = null
  review.progress = { done: 0, total: 0 }
  review.cursor = 0
  review.expandedRuns = []
  try {
    const r = await fetch(`${ai.baseUrl}/api/analyze`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ac.signal,
      body: JSON.stringify({
        size: review.size,
        homes: review.homes,
        moves: review.moves,
        coach: review.coach,
        sims: review.sims,
        ...(review.second ? { second: review.second } : {}),
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
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim()
        buf = buf.slice(i + 1)
        if (line) handleLine(JSON.parse(line))
      }
    }
    if (buf.trim()) handleLine(JSON.parse(buf.trim()))
    if (!review.final) review.error = '分析流提前结束（未收到 final）'
  } catch (e) {
    if ((e as Error).name !== 'AbortError') {
      review.error = (e as Error).message
      review.playing = false
    }
  } finally {
    // 播放可能还没追上已加载的 ply，交给 schedulePlay 在播完且 final 到达后自行停止
    if (aborter === ac) review.loading = false
  }
}

/** 打开复盘页：从当前对局快照 homes + moves，并开始流式分析 */
export function openReview() {
  review.size = state.size
  review.boundaryReflects = state.boundaryReflects
  review.homes = JSON.parse(JSON.stringify(state.homes)) as Partial<Record<Color, Home>>
  review.moves = state.moves.map((m): ReviewMove =>
    m.kind === 'edge' ? { kind: 'edge', id: m.id } : { kind: 'diag', x: m.x, y: m.y, ori: m.ori },
  )
  review.active = true
  review.playing = true
  if (!modelList.loaded && !modelList.error) void refreshCkpts()
  const sized = modelList.list.filter((m) => m.size === review.size)
  const fit = (id: string) => sized.some((m) => m.id === id || m.gens.some((g) => g.id === id))
  if (!review.coach || (sized.length && !fit(review.coach))) review.coach = defaultModelId(review.size)
  if (review.second && sized.length && !fit(review.second)) review.second = ''
  void runAnalysis()
}

export function closeReview() {
  aborter?.abort()
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

// 对局结束自动展开复盘（人机 / AI vs AI / 人人本地统一；仅 6×6、8×8 支持分析端点）
watch(
  () => state.phase,
  (p, prev) => {
    if (
      p === 'over' &&
      prev !== 'over' &&
      state.mode === 'local' &&
      state.moves.length > 0 &&
      reviewSizeOk(state.size)
    ) {
      openReview()
    }
  },
)
