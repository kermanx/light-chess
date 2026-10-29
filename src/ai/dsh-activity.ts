import type { DshTrajectoryPayload } from './providers'

type Stage = 'preparing' | 'waiting' | 'reasoning' | 'text' | 'tool-input' | 'tool' | 'settling' | 'retry'
export interface DshActivity {
  stage: Stage
  step: number
  characters: number
  tail: string
  tailKind: string
  lastReceivedAt: number
  tool: string
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}

/** A small, incremental view of actual DSH events. Never invents session events
 * or token counts; the complete, unmodified payloads remain in the recorder. */
export class DshActivityTracker {
  private value: DshActivity
  constructor(startedAt: number) {
    this.value = { stage: 'preparing', step: 0, characters: 0, tail: '', tailKind: '', lastReceivedAt: startedAt, tool: '' }
  }
  consume(payload: DshTrajectoryPayload, receivedAt: number) {
    const value = this.value
    value.lastReceivedAt = receivedAt
    if (payload.kind === 'event') {
      const { type, data: raw } = payload.event, data = object(raw)
      if (type === 'step/start') { value.stage = 'waiting'; value.step = Number(data.step) || value.step }
      else if (type === 'llm/retry') value.stage = 'retry'
      else if (type === 'tool/call') { value.stage = 'tool'; value.tool = String(data.name ?? '') }
      else if (type === 'tool/result' || type === 'turn/end') value.stage = 'settling'
    } else if (payload.kind === 'stream') {
      const frame = payload.frame
      if (frame.type === 'start') {
        value.stage = 'waiting'; value.step = Number(frame.step) || value.step
        value.characters = 0; value.tail = ''; value.tailKind = ''
      } else if (frame.type === 'end') value.stage = 'settling'
      else if (frame.type === 'chunk') {
        const chunk = object(frame.chunk)
        const kind = chunk.type === 'reasoning-delta' ? '思考' : chunk.type === 'text-delta' ? '正文' : ''
        if (kind && typeof chunk.text === 'string' && chunk.text) {
          value.stage = kind === '思考' ? 'reasoning' : 'text'
          value.characters += chunk.text.length
          value.tail = ((value.tailKind === kind ? value.tail : '') + chunk.text).slice(-240)
          value.tailKind = kind
        } else if ((chunk.type === 'block-start' && chunk.blockType === 'tool-call') || chunk.type === 'tool-call-delta') value.stage = 'tool-input'
      }
    }
  }
  snapshot(): DshActivity { return { ...this.value } }
}

export function dshActivityLabel(value: DshActivity): string {
  const stage = { preparing: '启动中', waiting: '等待模型输出', reasoning: '模型思考中', text: '生成正文',
    'tool-input': '生成工具调用', tool: `执行 ${value.tool}`, settling: '处理模型或工具结果', retry: '等待重试' }[value.stage]
  return `${value.step ? `第 ${value.step} 次请求 · ` : ''}${stage}`
}
