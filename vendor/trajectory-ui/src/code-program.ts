import type { TrajectoryRecord } from './types'

/** Replayable run_code source and its exact recorded arguments. */
export interface TrajectoryCodeProgram {
  source: string
  rawInput: string
  description: string
  language?: 'typescript' | 'python'
}

function object(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try { value = JSON.parse(value) } catch { return undefined }
  }
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function recordedLanguage(schema: Record<string, unknown> | undefined): TrajectoryCodeProgram['language'] {
  const declared = typeof schema?.description === 'string'
    ? /^Execute a program in `([^`]+)`/.exec(schema.description)?.[1]?.toLowerCase()
    : undefined
  if (declared !== undefined && declared !== 'typescript' && declared !== 'python') return undefined
  const hint = object(object(object(schema?.parameters ?? schema)?.properties)?.code)?.description
  const typescript = declared === 'typescript' || typeof hint === 'string' && /\bTypeScript\b/i.test(hint)
  const python = declared === 'python' || typeof hint === 'string' && /\bPython\b/i.test(hint)
  return typescript === python ? undefined : typescript ? 'typescript' : 'python'
}

/** Read recorded source and language; unknown or conflicting hints remain plain text. */
export function trajectoryCodeProgram(record: TrajectoryRecord): TrajectoryCodeProgram | undefined {
  if ((record.kind !== 'tool' && record.kind !== 'subtool') || record.toolName !== 'run_code') return undefined
  const args = object(record.inputRaw ?? record.input)
  if (typeof args?.code !== 'string' || args.description !== undefined && typeof args.description !== 'string') return undefined
  const language = recordedLanguage(object(record.schema))
  return {
    source: args.code,
    rawInput: record.inputRaw ?? (typeof record.input === 'string' ? record.input : JSON.stringify(record.input, null, 2)),
    description: typeof args.description === 'string' && args.description.trim() !== ''
      ? args.description : args.code.split(/\r?\n/).find(line => line.trim() !== '')?.trim() ?? '',
    ...(language === undefined ? {} : { language }),
  }
}
