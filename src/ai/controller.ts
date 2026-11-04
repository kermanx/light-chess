import { computed, reactive, ref, watch } from 'vue'
import { aiAuthority, aiProviderFor, board, dispatch, dispatchAi, isAiPlayer, remainingTime, state } from '../store'
import type { Color } from '../game'
import { isAiAction, makeAiRequest, toAiMoveAnalysis, type AiStats } from './protocol'
import { dshConfigToken, readDshConfig } from './config'
import { createDshWorker } from './dsh-provider'
import { redactAiDetail, type AiProvider, type AiWorkerMessage, type DshConfig } from './providers'
import { emitAiSearch, type AiSearchEvent } from './telemetry'
import { MODELS_BASE } from '../nn/models'
import type { NnWorkerMessage } from './nn-worker'
import { DshActivityTracker, dshActivityLabel } from './dsh-activity'

export const aiStatus = reactive({
  status: 'idle' as 'idle' | 'thinking' | 'error',
  color: null as Color | null,
  error: '',
  progress: '',
  provider: 'wasm' as AiProvider,
  stats: null as AiStats | null,
})
const retry = ref(0)
export function retryAi() {
  if (!aiAuthority() || state.peerLeft) return
  if (state.aiPaused) dispatch({ kind: 'ai-resume', color: state.players[0] })
  else retry.value++
}

export function cancelAi() {
  if (aiAuthority() && !state.peerLeft && !state.aiPaused) dispatch({ kind: 'ai-pause', color: state.players[0] })
}

/** All human homes are chosen before AI homes, so setup search sees a stable position. */
export const aiTurnColor = computed<Color | null>(() => {
  if (state.phase === 'play') return isAiPlayer(state.current) ? state.current : null
  if (state.phase !== 'setup' || state.players.some(c => !isAiPlayer(c) && !state.homes[c])) return null
  return state.players.find(c => isAiPlayer(c) && !state.homes[c]) ?? null
})

/** Keep the worker off the main thread; termination also cancels synchronous WASM searches. */
export function startAiController(createWorker: (provider: AiProvider) => Worker = provider =>
  provider === 'dsh' ? createDshWorker() : new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' })) {
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
  const configToken = computed(() => aiTurnColor.value
    ? dshConfigToken(state.aiProfileIds[aiTurnColor.value]) : '')
  const stop = watch(() => [
    state.positionRevision, state.mode, state.myColor, state.phase, state.current,
    state.peerLeft, state.aiPaused, state.boundaryReflects,
    aiTurnColor.value ? aiProviderFor(aiTurnColor.value) : null,
    aiTurnColor.value && aiProviderFor(aiTurnColor.value) === 'dsh' ? configToken.value : state.aiBudgetMs,
    aiTurnColor.value ? JSON.stringify(state.aiNnConfigs[aiTurnColor.value] ?? null) : null,
    state.aiPlayers.join(','), aiTurnColor.value, retry.value,
  ], () => {
    cancel()
    aiStatus.status = 'idle'
    aiStatus.error = ''
    aiStatus.progress = ''
    aiStatus.color = aiTurnColor.value
    const color = aiTurnColor.value
    if (!color || !aiAuthority() || state.peerLeft || state.aiPaused) return
    const provider = aiProviderFor(color)
    aiStatus.provider = provider
    let dsh: DshConfig | undefined
    const fail = (rawMessage: string, context?: Record<string, unknown>) => {
      const message = redactAiDetail(rawMessage, dsh?.apiKey) as string
      report('search-error', redactAiDetail({ message, ...context }, dsh?.apiKey))
      cancel(true)
      aiStatus.status = 'error'
      aiStatus.error = message
    }
    if (!state.boundaryReflects) return fail('AI 需要开启边界反射')
    if (provider === 'nn' && !state.aiNnConfigs[color]) return fail('NN 座位缺少模型配置，请重新选择模型')
    let budgetMs = state.aiBudgetMs
    if (provider === 'wasm' && state.phase === 'play' && state.clockSettings.enabled) {
      budgetMs = Math.max(1, Math.min(budgetMs, Math.floor(remainingTime(color, Date.now()) - 200)))
    }
    const request = makeAiRequest(board, {
      phase: state.phase as 'setup' | 'play', players: state.players, current: color, dead: state.dead, budgetMs,
    })
    const expected = generation
    const revision = state.positionRevision
    search = { searchId: crypto.randomUUID(), gameId: state.sessionId, revision }
    report('search-start', { color, provider, request })
    aiStatus.status = 'thinking'
    aiStatus.stats = null
    try {
      if (provider === 'dsh') dsh = readDshConfig(state.aiProfileIds[color])
      const nn = provider === 'nn' ? state.aiNnConfigs[color]! : null
      // NN 座位走池化 worker（active 不持有它，cancel 不会 terminate）；WASM/DSH 维持每次新建。
      const worker = nn
        ? acquireNnWorker(`${nn.modelId}|${nn.stochastic ? 1 : 0}`)
        : (active = createWorker(provider))
      const activity = new DshActivityTracker(Date.now())
      let lastProgressAt = 0, lastStage = ''
      worker.onmessage = (event: MessageEvent<AiWorkerMessage>) => {
        if (generation !== expected || state.positionRevision !== revision || state.peerLeft ||
          state.aiPaused || !aiAuthority() || aiTurnColor.value !== color) return
        const result = redactAiDetail(event.data, dsh?.apiKey) as AiWorkerMessage
        if (!result || typeof result !== 'object') return fail('AI 返回了无效结果，请重试')
        if ('type' in result) {
          if (result.type === 'trajectory') {
            report('search-trajectory', result.payload)
            const now = Date.now()
            activity.consume(result.payload, now)
            const current = activity.snapshot()
            if (current.stage !== lastStage || now - lastProgressAt >= 500) {
              lastProgressAt = now; lastStage = current.stage
              aiStatus.progress = `DSH · ${dshActivityLabel(current)}${current.characters ? ` · 已接收 ${current.characters.toLocaleString()} 字符` : ''}`
            }
            return
          }
          if (result.type !== 'progress') return fail('AI 返回了未知消息，请重试')
          aiStatus.progress = typeof result.message === 'string' ? result.message.slice(0, 280) : ''
          report('search-progress', { provider, ...result })
          return
        }
        report('search-result', { result })
        if (result.error) return fail(typeof result.error === 'string' ? result.error : 'AI 请求失败')
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
      if (provider !== 'dsh') timeout = setTimeout(() => {
        if (generation === expected) fail('AI 搜索超时，请重试或缩短思考时间')
      }, (provider === 'nn' ? Math.max(budgetMs, 20_000) : budgetMs) + 10_000)
      if (nn) {
        const message: NnWorkerMessage = {
          request,
          nn: { modelId: nn.modelId, stochastic: nn.stochastic, modelsBase: MODELS_BASE, limit: nn.limit },
        }
        worker.postMessage(message)
      } else {
        worker.postMessage(dsh ? { ...request, dsh } : request)
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
