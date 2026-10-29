import { computed, reactive, ref, watch } from 'vue'
import { aiAuthority, aiEngineFor, board, dispatch, dispatchAi, isAiPlayer, remainingTime, state } from '../store'
import type { Color } from '../game'
import { isAiAction, makeAiRequest, toAiMoveAnalysis, type AiResponse, type AiStats } from './protocol'
import { emitAiSearch, type AiSearchEvent } from './telemetry'
import { MODELS_BASE } from '../nn/models'
import type { NnWorkerMessage } from './nn-worker'

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
  /**
   * NN worker 池（key = modelId|stochastic）：NN 推理是异步的，迟到响应由代际号丢弃，
   * 不必像 WASM 那样 terminate；复用 worker 让 onnx session 缓存生效，避免每手重载权重。
   */
  const nnWorkers = new Map<string, Worker>()
  const acquireNnWorker = (key: string): Worker => {
    let w = nnWorkers.get(key)
    if (!w) {
      w = new Worker(new URL('./nn-worker.ts', import.meta.url), { type: 'module' })
      nnWorkers.set(key, w)
    }
    return w
  }
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
    state.aiPlayers.join(','), JSON.stringify(state.aiEngines), aiTurnColor.value, retry.value,
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
    const engine = aiEngineFor(color)
    let budgetMs = engine.kind === 'wasm' && engine.budgetMs ? engine.budgetMs : state.aiBudgetMs
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
      // NN 座位走池化 worker（active 不持有它，cancel 不会 terminate）；WASM 维持每次新建。
      const worker = engine.kind === 'nn'
        ? acquireNnWorker(`${engine.modelId}|${engine.stochastic ? 1 : 0}`)
        : (active = createWorker())
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
      }, (engine.kind === 'nn' ? Math.max(budgetMs, 20_000) : budgetMs) + 10_000)
      if (engine.kind === 'nn') {
        const message: NnWorkerMessage = {
          request,
          nn: { modelId: engine.modelId, stochastic: engine.stochastic, modelsBase: MODELS_BASE },
        }
        worker.postMessage(message)
      } else {
        worker.postMessage(request)
      }
    } catch (error) {
      fail(error instanceof Error ? error.message : String(error))
    }
  }, { immediate: true })
  return () => {
    stop()
    cancel()
    for (const w of nnWorkers.values()) w.terminate()
    nnWorkers.clear()
    aiStatus.status = 'idle'
  }
}
