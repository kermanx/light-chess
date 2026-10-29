import type { Ref, ShallowRef } from 'vue'

/** Portable document used by format importers, the viewer and immutable shares. */
export interface TrajectoryDocument {
  [key: string]: unknown
  version: 1
  name: string
  records: TrajectoryRecord[]
  requests?: TrajectoryRequestDetails[]
}

/** Visual roles supported by the ledger and timeline. */
export type TrajectoryKind =
  | 'system'
  | 'user'
  | 'context'
  | 'compacted'
  | 'assistant'
  | 'tool'
  | 'subtool'

/** Lifecycle state of one projected operation. */
export type TrajectoryStatus = 'complete' | 'running' | 'error'

/** Tabs available across record and request inspectors. */
export type TrajectoryDetailTab =
  | 'code'
  | 'summary'
  | 'preview'
  | 'raw'
  | 'source'
  | 'payload'
  | 'result'
  | 'schema'
  | 'timing'
  | 'usage'
  | 'options'
  | 'diff'
  | 'systemPrompt'
  | 'tools'

/** Provider token buckets preserved without forcing a specific LLM SDK. */
export interface TrajectoryUsage {
  /** Uncached input; cacheRead and cacheWrite are separate, disjoint buckets. */
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
}

/** Tool definition displayed by system-prompt and record schema inspectors. */
export interface TrajectoryToolDefinition {
  name: string
  description?: string
  parameters?: unknown
  /** The recorded schema is deferred until the tool is requested. */
  deferLoading?: true
}

/** Ordered source content retained for rendered and raw assistant views. */
export interface TrajectoryContentBlock {
  type: 'text' | 'thinking' | 'tool-call' | 'image'
  content?: string
  toolName?: string
  callId?: string
  input?: unknown
  url?: string
  alt?: string
  /** Durable reference; callers may supply a resolved URL without a Harness runtime. */
  attachment?: Readonly<Record<string, unknown>>
  /** Original unsupported content, retained alongside a text fallback for older readers. */
  original?: unknown
}

/** Request-level data that cannot be reconstructed from one trajectory record. */
export interface TrajectoryRequestDetails {
  id: string
  number?: number
  turn?: number | null
  purpose?: 'generation' | 'compaction' | string
  status?: TrajectoryStatus
  provider?: string
  model?: string
  startedAt?: number | null
  durationMs?: number | null
  totalDurationMs?: number | null
  ttftMs?: number | null
  generationMs?: number | null
  throughput?: number | null
  /** False when the provider/session did not record request timing fields. */
  timingRecorded?: boolean
  options?: unknown
  /** Effective prompt text at this request's position; undefined means unavailable. */
  systemPrompt?: string
  /** Tool catalog captured for this request, when its header was loaded. */
  tools?: readonly TrajectoryToolDefinition[]
  usage?: TrajectoryUsage
  cumulativeUsage?: TrajectoryUsage
  error?: unknown
  retry?: number
  maxRetries?: number
  retryDelayMs?: number
  resultId?: string
}

/** Observe a live canonical tool result; undefined means unavailable, and null is a value. */
export type TrajectoryWatchToolResult = (
  resultSeq: number,
  onValue: (value: unknown) => void,
) => () => void

/** One ordered entry in the trajectory ledger. */
export interface TrajectoryRecord {
  /** Stable identity across streaming patches and history prepends. */
  id: string
  /** Optional durable source sequence. Order is still owned by the containing array. */
  seq?: number
  kind: TrajectoryKind
  /** Null denotes activity between numbered turns. */
  turn?: number | null
  step?: number
  /** Compact single-line ledger text. */
  summary: string
  /** Stable group label shown after the turn in record details. */
  group?: string
  status?: TrajectoryStatus
  /** Unix epoch milliseconds. See timestampKind for observation-only exports. */
  startedAt?: number | null
  /** Observation timestamps are event markers, not evidence of an operation start. */
  timestampKind?: 'start' | 'observation'
  /** When a result was recorded; does not imply an exact execution end or duration. */
  resultObservedAt?: number | null
  /** Own operation duration. Null means still running or not recorded. */
  durationMs?: number | null
  /** Assistant first-token latency. */
  ttftMs?: number | null
  requestId?: string
  requestNumber?: number
  /** A request separator without visible assistant output; never a result link. */
  requestOnly?: boolean
  /** Tool-only developer notice; mixed content remains ordinary context. */
  toolChanges?: { added: readonly string[]; removed: readonly string[] }
  /** Durable tool-result event used by an optional live result observer. */
  resultSeq?: number
  callId?: string
  /** Tool name kept separately from its compact ledger summary. */
  toolName?: string
  /** Assistant/tool identity used to fold nested calls. */
  parentId?: string
  provider?: string
  model?: string
  input?: unknown
  output?: unknown
  reasoning?: string
  /** Ordered raw content blocks when prose fields alone cannot preserve source order. */
  sourceBlocks?: readonly TrajectoryContentBlock[]
  /** Tool-result blocks, separate from the established output value. */
  outputBlocks?: readonly TrajectoryContentBlock[]
  /** Exact recorded tool arguments, including whitespace. */
  inputRaw?: string
  /** Complete compaction provider output before summary projection. */
  rawOutput?: unknown
  /** A delivered prefix or tool call terminated before normal completion. */
  interrupted?: boolean
  /** User message claimed from the next-step inbox. Does not open a new turn. */
  steering?: boolean
  /** Durable native or nested tool failure identity. */
  error?: { name?: string; code?: string; reason?: string }
  schema?: unknown
  /** Tool catalog captured with a system prompt. */
  tools?: readonly TrajectoryToolDefinition[]
  /** Prior system prompt used to render update diffs. */
  previousInput?: unknown
  /** Prior tool catalog used to render update diffs. */
  previousTools?: readonly TrajectoryToolDefinition[]
  usage?: TrajectoryUsage
  source?: unknown
  metadata?: Readonly<Record<string, unknown>>
}

/** Older-history page returned by a progressive loader. */
export interface TrajectoryPage {
  records: readonly TrajectoryRecord[]
  hasMore: boolean
}

/** Context supplied to an older-history loader. */
export interface TrajectoryLoadContext {
  beforeId?: string
  beforeSeq?: number
  signal: AbortSignal
}

export type TrajectoryOlderLoader = (
  context: TrajectoryLoadContext,
) => Promise<TrajectoryPage>

/** Incremental operations accepted by a trajectory store. */
export type TrajectoryMutation =
  | { type: 'append'; records: readonly TrajectoryRecord[] }
  | { type: 'prepend'; records: readonly TrajectoryRecord[]; hasMore?: boolean }
  | { type: 'patch'; id: string; patch: Partial<Omit<TrajectoryRecord, 'id'>> }
  | { type: 'upsert'; record: TrajectoryRecord }
  | { type: 'remove'; ids: readonly string[] }
  | { type: 'replace'; records: readonly TrajectoryRecord[]; hasMore?: boolean }
  | { type: 'history'; hasMore: boolean; loading?: boolean }

export type TrajectoryStreamSource =
  | AsyncIterable<TrajectoryMutation>
  | ReadableStream<TrajectoryMutation>

export interface ConsumeTrajectoryOptions {
  signal?: AbortSignal
}

export interface CreateTrajectoryStoreOptions {
  records?: readonly TrajectoryRecord[]
  hasMore?: boolean
  loadOlder?: TrajectoryOlderLoader
}

/** Reactive store consumed directly by the Vue view. */
export interface TrajectoryStore {
  records: ShallowRef<readonly TrajectoryRecord[]>
  hasMore: Ref<boolean>
  loadingOlder: Ref<boolean>
  streaming: Ref<boolean>
  error: ShallowRef<unknown | null>
  append: (records: readonly TrajectoryRecord[]) => void
  prepend: (records: readonly TrajectoryRecord[], hasMore?: boolean) => void
  patch: (id: string, patch: Partial<Omit<TrajectoryRecord, 'id'>>) => void
  upsert: (record: TrajectoryRecord) => void
  remove: (ids: readonly string[]) => void
  replace: (records: readonly TrajectoryRecord[], hasMore?: boolean) => void
  apply: (mutation: TrajectoryMutation) => void
  consume: (
    source: TrajectoryStreamSource,
    options?: ConsumeTrajectoryOptions,
  ) => Promise<void>
  loadEarlier: () => Promise<boolean>
  setOlderLoader: (loader: TrajectoryOlderLoader | undefined) => void
  dispose: () => void
}

export type TrajectoryLocale = 'en' | 'zh-CN'
export type TrajectoryTheme = 'light' | 'dark' | 'auto' | 'host'
export type TrajectoryDurationMode = 'actual' | 'equal'

export interface TrajectoryTimeRange {
  start: number
  end: number
}
