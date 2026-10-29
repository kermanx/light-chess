import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import * as Persona from '@deepseek-ai/dsh-persona'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import AgentPresets from '@deepseek-ai/dsh-agent-preset-registry'
import AgentPreset from '@deepseek-ai/dsh-agent-preset'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek-api-key'
import * as LlmRetry from '@deepseek-ai/dsh-llm-retry'
import { createLaunchEnvironmentSnapshot, DSH_LAUNCH_ENVIRONMENT_KEY } from '@deepseek-ai/dsh-launch-environment'
import { chessPreset, PRESET_ID } from './preset.mjs'
import { gameToolsPlugin } from './tools.mjs'

// Called by a DSH profile plugin on Node, or by the stock DSH Worker plugin.
// Tool execution, preset mounting, prompt composition and inference are DSH's.
export async function createChessPlayer({ game, rules, mode, config, onTool, afterTool, onSessionEvent, onSessionHeader, onAssistantStream }) {
  if (!config.apiKey?.trim() || !config.model?.trim()) throw new Error('请先配置 DSH 的 API Key 和模型')
  const endpoint = new URL(config.baseURL)
  if (!['https:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('DSH API 地址无效')
  const ctx = new Context()
  let moveExplanation = ''
  try {
    ctx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, createLaunchEnvironmentSnapshot([{ source: 'process', values: { DEEPSEEK_API_KEY: config.apiKey } }]))
    await ctx.plugin(Loader)
    ctx.loader.builtins['chess-persona'] = Persona
    ctx.loader.builtins['chess-native-executor'] = NativeToolExecutor
    ctx.loader.builtins['light-chess-tools'] = gameToolsPlugin({ game, mode, onTool, afterTool, getMoveExplanation: () => moveExplanation })
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt, { personaPrefix: '', includeHarnessIdentity: true, includeRuntimeContext: false })
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(LlmDeepSeek, { baseURL: endpoint.href, retryPolicy: {
      mode: 'normal', maxRetries: 2,
      retryableCodes: ['EMPTY_RESPONSE', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'MALFORMED_RESPONSE'],
    } })
    // Retry the failed request inside DSH's existing step; never replay tools
    // already executed or repair incomplete tool arguments into a guessed move.
    await ctx.plugin(LlmRetry)
    await ctx.plugin(AgentPresets, { default: PRESET_ID })
    await ctx.plugin(AgentPreset, chessPreset(rules))
    const announced = new Set()
    ctx.on('session/event', (session, event) => {
      // Only public text from the completed response that selects this move.
      // Missing text stays empty; do not substitute reasoning or an older step.
      if (event.type === 'step/start') moveExplanation = ''
      if (event.type === 'assistant/message') {
        moveExplanation = event.data.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').trim()
      }
      if (!announced.has(session.id)) {
        announced.add(session.id)
        onSessionHeader?.(session.id, session.header)
      }
      onSessionEvent?.(session.id, event)
    })
    if (onAssistantStream) ctx.on('agent/assistant-stream', ({ agent, frame }) => onAssistantStream(agent.session.id, frame))
    const agent = await ctx.agentLoop.create(SessionId(`chess-${crypto.randomUUID()}`), { provider: 'deepseek-official', model: config.model })
    await ctx.agentPresets.select(agent, PRESET_ID)
    return {
      ctx, agent, preset: PRESET_ID,
      async turn(text) {
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
      },
      dispose: () => ctx.fiber.dispose(),
    }
  } catch (error) { await ctx.fiber.dispose(); throw error }
}
