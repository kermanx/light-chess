// Packed by the existing DSH VFS packer and loaded inside its stock Worker.
import { createChessPlayer } from '../dsh/runtime.mjs'
import { createGameTools, describePosition, RULES } from './tools.ts'

export const name = 'light-chess-browser'
export const inject = ['webServer']
const send = data => self.postMessage({ channel: 'light-chess', ...data })

export function apply(host) {
  let busy = false
  const choose = async (req, res) => {
    if (req.method !== 'POST' || busy) { res.writeHead(409); res.end('Already running or invalid method'); return }
    busy = true
    let body = ''
    const decoder = new TextDecoder()
    for await (const chunk of req) body += typeof chunk === 'string' ? chunk : decoder.decode(chunk, { stream: true })
    body += decoder.decode()
    let request
    try { request = JSON.parse(body) } catch { busy = false; res.writeHead(400); res.end('Invalid request'); return }
    const started = performance.now()
    let selected, player, calls = 0
    const playCalls = new Set()
    const progress = (message, detail) => send({ type: 'progress', message, detail })
    try {
      const game = createGameTools(request, (move, rationale) => { selected = { action: move, rationale } })
      player = await createChessPlayer({
        game, rules: RULES, mode: 'browser', config: request.dsh ?? {},
        onTool(kind, { name, args, result }) {
          if (kind === 'call') { calls++; progress(`DSH · ${name}`, { tool: name, input: args }) }
          else progress(`DSH · ${name} 完成`, { tool: name, result })
        },
        onSessionHeader(sessionId, header) {
          send({ type: 'trajectory', payload: { kind: 'header', sessionId, header } })
        },
        onSessionEvent(sessionId, event) {
          send({ type: 'trajectory', payload: { kind: 'event', sessionId, event } })
          if (event.type === 'llm/retry') progress(`DSH 请求未完成，正在重试（${event.data.retry}/${event.data.maxRetries}）`, {
            retry: event.data.retry, maxRetries: event.data.maxRetries, failure: event.data.failure,
          })
          if (event.type === 'tool/call' && event.data.name === 'play') playCalls.add(event.data.callId)
          // Settle the actual tool result before cancellation, and let the turn
          // close before returning the move (the controller kills this Worker).
          if (selected && event.type === 'tool/result' && playCalls.has(event.data.message.source?.callId)) player.agent.cancel({ kind: 'parent' })
        },
        onAssistantStream(sessionId, frame) {
          send({ type: 'trajectory', payload: { kind: 'stream', sessionId, frame } })
        },
      })
      progress('DSH 正在分析棋局', { provider: 'dsh', preset: player.preset, model: request.dsh.model, baseURL: request.dsh.baseURL })
      await player.turn(`请选择当前一步，必须通过 play 工具落子。当前权威局面：\n${JSON.stringify(describePosition(request))}`)
      if (!selected) {
        const failure = player.agent.session.snapshotEvents().filter(e => e.type === 'turn/end').at(-1)
        if (failure?.data?.reason?.error?.code === 'MALFORMED_RESPONSE') {
          throw new Error('模型 API 连续返回了不完整或无效的响应，自动重试后仍失败；本轮未落子，可点击重试 AI。')
        }
        throw new Error(`DSH 本轮结束但没有选择落子，请重试。${failure?.data?.reason?.message ?? failure?.data?.reason?.error?.message ?? ''}`)
      }
      send({ type: 'result', result: { action: selected.action, stats: {
        nodes: calls, depth: 0, score: 0, mode: 'dsh', elapsedMs: performance.now() - started, reason: selected.rationale,
      } } })
    } catch (error) {
      const safe = String(error.message ?? error).split(request?.dsh?.apiKey || '\0').join('[redacted]')
      send({ type: 'result', result: { action: null, error: safe } })
    } finally { await player?.dispose(); busy = false; res.end('{}') }
  }
  host.effect(() => host.webServer.register({ kind: 'exact', path: '/light-chess/choose', handler: choose }))
  send({ type: 'ready' })
}
