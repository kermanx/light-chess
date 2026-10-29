import { computed, reactive, ref, watch } from 'vue'
import { aiAuthority, board, dispatch, dispatchAi, isAiPlayer, remainingTime, state } from '../store'
import type { Color } from '../game'
import { isAiAction, makeAiRequest, toAiMoveAnalysis, type AiResponse, type AiStats } from './protocol'
import { emitAiSearch, type AiSearchEvent } from './telemetry'

export const aiStatus = reactive({
  status: 'idle' as 'idle' | 'thinking' | 'error',
  color: null as Color | null,
  error: '',
  stats: null as AiStats | null,
})
const retry = ref(0)
export function retryAi() {
  if (!aiAuthority() || state.peerLeft) return
  if (state.aiPaused) dispatch({ kind: 'ai-resume', color: state.players[0] })
  else retry.value++
}

/** All human homes are chosen before AI homes, so setup search sees a stable position. */
export const aiTurnColor = computed<Color | null>(() => {
  if (state.phase === 'play') return isAiPlayer(state.current) ? state.current : null
  if (state.phase !== 'setup' || state.players.some(c => !isAiPlayer(c) && !state.homes[c])) return null
  return state.players.find(c => isAiPlayer(c) && !state.homes[c]) ?? null
})

/** Keep the worker off the main thread; termination also cancels synchronous WASM searches. */
export function startAiController(createWorker: () => Worker = () =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })) {
  let active: Worker | null = null
  let timeout: ReturnType<typeof setTimeout> | null = null
  let generation = 0
  let search: { searchId: string; gameId: string; revision: number } | null = null
  const report = (type: AiSearchEvent['type'], detail: unknown) => {
    if (search) emitAiSearch({ ...search, type, detail })
  }
  const cancel = (completed = false) => {
    if (!completed) report('search-cancel', { reason: 'position-or-settings-changed' })
    search = null
    generation++
    active?.terminate()
    active = null
    if (timeout !== null) clearTimeout(timeout)
    timeout = null
  }
  const stop = watch(() => [
    state.positionRevision, state.mode, state.myColor, state.phase, state.current,
    state.peerLeft, state.aiPaused, state.boundaryReflects, state.aiBudgetMs,
    state.aiPlayers.join(','), aiTurnColor.value, retry.value,
  ], () => {
    cancel()
    aiStatus.status = 'idle'
    aiStatus.error = ''
    aiStatus.color = aiTurnColor.value
    const color = aiTurnColor.value
    if (!color || !aiAuthority() || state.peerLeft || state.aiPaused) return
    const fail = (message: string, context?: Record<string, unknown>) => {
      report('search-error', { message, ...context })
      cancel(true)
      aiStatus.status = 'error'
      aiStatus.error = message
    }
    if (!state.boundaryReflects) return fail('AI 需要开启边界反射')
    let budgetMs = state.aiBudgetMs
    if (state.phase === 'play' && state.clockSettings.enabled) {
      budgetMs = Math.max(1, Math.min(budgetMs, Math.floor(remainingTime(color, Date.now()) - 200)))
    }
    const request = makeAiRequest(board, {
      phase: state.phase as 'setup' | 'play', players: state.players, current: color, dead: state.dead, budgetMs,
    })
    const expected = generation
    const revision = state.positionRevision
    search = { searchId: crypto.randomUUID(), gameId: state.sessionId, revision }
    report('search-start', { color, request })
    aiStatus.status = 'thinking'
    aiStatus.stats = null
    try {
      const worker = createWorker()
      active = worker
      worker.onmessage = (event: MessageEvent<AiResponse>) => {
        if (generation !== expected || state.positionRevision !== revision || state.peerLeft ||
          state.aiPaused || !aiAuthority() || aiTurnColor.value !== color) return
        const result = event.data
        report('search-result', { result })
        if (!result || typeof result !== 'object') return fail('AI 返回了无效结果，请重试')
        if (result.error) return fail(result.error)
        if (!isAiAction(result.action)) return fail('AI 未返回可用落子，请重试')
        if ((request.phase === 'setup') !== (result.action.kind === 'setup')) return fail('AI 返回了错误阶段的动作')
        const finished = search!
        cancel(true)
        aiStatus.stats = result.stats ?? null
        aiStatus.status = 'idle'
        const action = result.action.kind === 'setup'
          ? { ...result.action, color }
          : { ...result.action, color, aiAnalysis: toAiMoveAnalysis(result.stats) }
        const accepted = dispatchAi(action)
        emitAiSearch({ ...finished, type: accepted ? 'search-accepted' : 'search-rejected', detail: { action } })
        if (!accepted) fail('AI 落子未通过棋局校验，请重试')
      }
      worker.onerror = event => {
        if (generation === expected) fail(
          event.message || 'AI 后台程序加载或运行失败；若刚更新过版本，请刷新页面后重试',
          { source: 'worker', filename: event.filename, line: event.lineno, column: event.colno },
        )
      }
      timeout = setTimeout(() => {
        if (generation === expected) fail('AI 搜索超时，请重试或缩短思考时间')
      }, budgetMs + 10_000)
      worker.postMessage(request)
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }, { immediate: true })
  return () => { stop(); cancel(); aiStatus.status = 'idle' }
}
