import type { Color } from '../game'
import type { AiRequest, AiResponse } from './protocol'

export type AiProvider = 'wasm' | 'dsh'
export type AiProviders = Partial<Record<Color, AiProvider>>
/** Only opaque profile IDs travel with a game. Credentials stay in this browser. */
export type AiProfileIds = Partial<Record<Color, string>>
export interface DshConfig { baseURL: string; model: string; apiKey: string }
/** Credentials are sent only to the local DSH Worker, never to game snapshots or telemetry. */
export type AiWorkerRequest = AiRequest & { dsh?: DshConfig }
export interface AiProgress { type: 'progress'; message: string; detail?: unknown }
export type DshTrajectoryPayload = { sessionId: string } & (
  | { kind: 'header'; header: Record<string, unknown> }
  | { kind: 'event'; event: Record<string, unknown> }
  | { kind: 'stream'; frame: Record<string, unknown> }
)
export interface AiTrajectory { type: 'trajectory'; payload: DshTrajectoryPayload }
export type AiWorkerMessage = AiResponse | AiProgress | AiTrajectory
export const aiProviderName = (provider: AiProvider) => provider === 'dsh' ? 'DSH' : 'Rust / WASM'

/** Worker errors and tool output may echo HTTP headers; redact before display, save or sync. */
export function redactAiDetail(value: unknown, apiKey = ''): unknown {
  if (typeof value === 'string') {
    const text = apiKey ? value.split(apiKey).join('[redacted]') : value
    return text.replace(/Bearer\s+[^\s"',}]+/gi, 'Bearer [redacted]')
  }
  if (Array.isArray(value)) return value.map(item => redactAiDetail(item, apiKey))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
    /api[-_]?key|authorization|credential|password|secret|access[-_]?token/i.test(key)
      ? '[redacted]' : redactAiDetail(item, apiKey),
  ]))
}
