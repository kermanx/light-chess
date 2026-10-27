/** AI 对战驱动：把当前局面发给远端推理服务（fdusc-cpu-133），拿回着法并落到本地棋盘。
 *
 * 模式：
 *  - human：人对 AI（人选先手/后手，AI 接管另一方的 setup 选家与 play 落子）
 *  - aivai：AI vs AI（两个 checkpoint 互下，逐步播放）
 * 对局本身仍是本地 2 人局（startLocal(2)），AI 只是代替某方调用 dispatch。
 */
import { reactive, watch } from 'vue'
import type { Color, Dir, Ori } from './game'
import { dispatch, setupColor, startLocal, state } from './store'

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

export type AiAction =
  | { kind: 'setup'; home: { x: number; y: number; dir: Dir } }
  | { kind: 'edge'; id: string }
  | { kind: 'diag'; x: number; y: number; ori: Ori }

export const ai = reactive({
  /** null = 普通对人/联机模式 */
  mode: null as null | 'human' | 'aivai',
  baseUrl: localStorage.getItem('light-chess:ai-url') || 'http://10.176.52.133:8931',
  /** 各颜色使用的 checkpoint id（如 main6x6_v1/gen19） */
  ckpts: { blue: 'main6x6_v1/gen19', red: 'main6x6_v1/gen19' } as Record<string, string>,
  /** 人执的颜色（human 模式）；另一方由 AI 接管 */
  humanColor: 'blue' as Color,
  sims: 150,
  /** aivai 每手之间的播放间隔 ms */
  stepDelay: 700,
  thinking: false,
  /** aivai 暂停 */
  paused: false,
  error: '',
})

/** play 阶段已落子数 = 现有镜子数 − 每个家自动生成的 3 面家镜 */
export const currentPly = () =>
  state.edges.size + state.diags.size - 3 * Object.keys(state.homes).length

/** color 这一方是否由 AI 接管 */
export function aiControls(color: Color | null | undefined): boolean {
  if (!ai.mode || !color) return false
  if (ai.mode === 'aivai') return true
  return color !== ai.humanColor
}

/** 当前是否轮到真人操作（AI 模式下轮到 AI 时屏蔽人类输入） */
export function humanTurn(): boolean {
  if (!ai.mode) return true
  if (state.phase === 'setup') return !aiControls(setupColor.value)
  if (state.phase === 'play') return !aiControls(state.current)
  return false
}

export const modelList = reactive<{ list: ModelInfo[]; error: string; loaded: boolean }>({
  list: [],
  error: '',
  loaded: false,
})

export async function refreshCkpts() {
  localStorage.setItem('light-chess:ai-url', ai.baseUrl)
  modelList.error = ''
  try {
    const r = await fetch(`${ai.baseUrl}/api/models`)
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

// ---------- 对局生命周期 ----------

interface AiSave {
  mode: 'human' | 'aivai'
  ckpts: Record<string, string>
  humanColor: Color
  sims: number
}

const aiSaveKey = (sid: string) => `light-chess:ai:${sid}`

export function startAiGame(mode: 'human' | 'aivai', size: number) {
  ai.mode = mode
  ai.error = ''
  ai.thinking = false
  ai.paused = false
  gen++ // 让上一局迟到的 AI 响应失效
  state.size = size
  startLocal(2)
  persistAi()
}

function persistAi() {
  if (!ai.mode || !state.sessionId) return
  const s: AiSave = { mode: ai.mode, ckpts: { ...ai.ckpts }, humanColor: ai.humanColor, sims: ai.sims }
  try {
    sessionStorage.setItem(aiSaveKey(state.sessionId), JSON.stringify(s))
  } catch {
    /* 存储不可用则刷新后退化为人对人 */
  }
}

/** 刷新恢复：存档恢复对局后重新挂上 AI 配置（main.ts restore 后由 watcher 触发） */
function tryRestoreAi() {
  if (ai.mode || state.phase === 'lobby' || !state.sessionId) return
  try {
    const raw = sessionStorage.getItem(aiSaveKey(state.sessionId))
    if (!raw) return
    const s = JSON.parse(raw) as AiSave
    ai.mode = s.mode
    ai.ckpts = { ...s.ckpts }
    ai.humanColor = s.humanColor
    ai.sims = s.sims
  } catch {
    /* 忽略损坏的 AI 存档 */
  }
}

export function stopAi() {
  ai.mode = null
  ai.thinking = false
  ai.error = ''
  gen++
}

// ---------- AI 应手驱动 ----------

let gen = 0 // 代际计数：新局/停止后丢弃迟到的响应

function boardPayload() {
  return {
    size: state.size,
    phase: state.phase,
    homes: { ...state.homes },
    edges: [...state.edges],
    diags: [...state.diags],
    current: state.current,
    ply: Math.max(0, currentPly()),
    boundary_reflects: state.boundaryReflects,
    sims: ai.sims,
    ckpts: { ...ai.ckpts },
  }
}

async function requestMove(g: number, actor: Color) {
  ai.thinking = true
  ai.error = ''
  try {
    const r = await fetch(`${ai.baseUrl}/api/move`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(boardPayload()),
    })
    const data = await r.json()
    if (g !== gen || !ai.mode) return // 局面已变/已停止
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
    // 响应到达时局面可能已被人类/重启改变，校验行动方仍然吻合再落子
    const nowActor = state.phase === 'setup' ? setupColor.value : state.phase === 'play' ? state.current : null
    if (nowActor !== actor) return
    const a = data.action as AiAction
    if (a.kind === 'setup') dispatch({ kind: 'setup', color: actor, home: a.home })
    else if (a.kind === 'edge') dispatch({ kind: 'edge', color: actor, id: a.id })
    else dispatch({ kind: 'diag', color: actor, x: a.x, y: a.y, ori: a.ori })
  } catch (e) {
    if (g === gen) ai.error = (e as Error).message
  } finally {
    if (g === gen) ai.thinking = false
  }
}

/** 局面变化后检查是否轮到 AI；aivai 模式加播放间隔 */
function maybeAct() {
  if (!ai.mode || ai.thinking || ai.paused || ai.error) return
  if (state.mode !== 'local') return
  const actor = state.phase === 'setup' ? setupColor.value : state.phase === 'play' ? state.current : null
  if (!actor || !aiControls(actor)) return
  const g = gen
  const delay = ai.mode === 'aivai' ? ai.stepDelay : 0
  setTimeout(() => {
    if (g === gen && ai.mode && !ai.paused && !ai.thinking) void requestMove(g, actor)
  }, delay)
}

/** aivai 暂停/继续 */
export function togglePause() {
  ai.paused = !ai.paused
  if (!ai.paused) maybeAct()
}

watch(
  () => [state.phase, state.current, state.edges.size, state.diags.size, Object.keys(state.homes).length, state.sessionId],
  () => {
    if (state.phase === 'lobby') {
      if (ai.mode) stopAi()
      gen++
      return
    }
    tryRestoreAi()
    maybeAct()
  },
)

/** 出错后由 UI「重试」按钮调用 */
export function retryAi() {
  ai.error = ''
  maybeAct()
}
