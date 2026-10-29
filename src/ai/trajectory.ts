import { shallowReactive, shallowRef } from 'vue'
import type { TrajectoryDocument } from '@deepseek-ai/trajectory-ui'
import { projectSession } from '../../vendor/trajectory-ui/demo/session-projection'
import { isObject } from '../../vendor/trajectory-ui/src/trajectory-content'
import { onAiSearch, type AiSearchEvent } from './telemetry'
import type { DshTrajectoryPayload } from './providers'
import { DshActivityTracker, type DshActivity } from './dsh-activity'

type RunStatus = 'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'
interface SavedRun {
  id: string; gameId: string; revision: number; color: string; phase: string; startedAt: number
  status: RunStatus; error?: string; payloads: DshTrajectoryPayload[]
}
export interface TrajectoryRun extends SavedRun {
  document: TrajectoryDocument
  activity: DshActivity
  storageError?: string
}

export const trajectoryRuns = shallowRef<TrajectoryRun[]>([])
const pending = new Map<string, ReturnType<typeof setTimeout>>()
const saves = new Map<string, ReturnType<typeof setTimeout>>()
const activityTrackers = new WeakMap<TrajectoryRun, DshActivityTracker>()
let stop: (() => void) | undefined
let database: Promise<IDBDatabase> | undefined

function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('light-chess:dsh-trajectories', 1)
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('runs', { keyPath: 'id' })
      store.createIndex('gameId', 'gameId')
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

/** Use the UI library's own DSH projector. Live frames are a presentation input,
 * never forged durable Session events. The canonical message replaces its deltas. */
export function projectTrajectory(run: Pick<SavedRun, 'payloads' | 'status' | 'color'>): TrajectoryDocument {
  const events: unknown[] = []
  const live = new Map<string, { attempt: unknown; turn: unknown; step: unknown; chunks: unknown[] }>()
  for (const payload of run.payloads) {
    if (payload.kind === 'header') events.push({ ...payload.header, type: 'session' })
    else if (payload.kind === 'event') {
      events.push(payload.event)
      const data = payload.event.data
      if (payload.event.type === 'assistant/message' && isObject(data)) live.delete(`${data.turn}:${data.step}`)
    } else {
      const frame = payload.frame
      if (frame.type === 'start') live.set(`${frame.turn}:${frame.step}`, { attempt: frame.attemptId, turn: frame.turn, step: frame.step, chunks: [] })
      else if (frame.type === 'chunk') {
        const attempt = [...live.values()].find(a => a.attempt === frame.attemptId)
        if (attempt) attempt.chunks.push({ type: 'assistant/live-chunk', time: frame.time,
          data: { turn: attempt.turn, step: attempt.step, chunk: frame.chunk } })
      }
    }
  }
  const colorNames: Record<string, string> = { blue: '蓝方', red: '红方', green: '绿方', yellow: '黄方' }
  const document = projectSession([...events, ...[...live.values()].flatMap(a => a.chunks)], `${colorNames[run.color] ?? run.color} DSH`)
  // Keep a selected live row/inspector in place when its durable message gains
  // the producer's message ID. The original ID remains in event metadata.
  const ids = new Map<string, string>()
  for (const row of document.records) if (row.kind === 'assistant' && row.requestId) {
    const id = `assistant:${row.requestId}`
    ids.set(row.id, id); row.id = id
  }
  for (const row of document.records) if (row.parentId) row.parentId = ids.get(row.parentId) ?? row.parentId
  for (const request of document.requests) if (request.resultId) request.resultId = ids.get(request.resultId) ?? request.resultId
  if (run.status !== 'running') {
    for (const record of document.records) if (record.status === 'running') {
      record.status = 'error'; record.interrupted = true
      // A host termination has no measured operation end. Leave timing absent.
    }
    for (const request of document.requests) if (request.status === 'running') request.status = 'error'
  }
  return { version: 1, ...document }
}

function makeRun(saved: SavedRun): TrajectoryRun {
  const tracker = new DshActivityTracker(saved.startedAt)
  let time = saved.startedAt
  for (const payload of saved.payloads) {
    const sourceTime = payload.kind === 'event' ? payload.event.time : payload.kind === 'stream' ? payload.frame.time : undefined
    if (typeof sourceTime === 'number') time = sourceTime
    tracker.consume(payload, time)
  }
  const run = shallowReactive({ ...saved, document: projectTrajectory(saved), activity: tracker.snapshot() })
  activityTrackers.set(run, tracker)
  return run
}
function snapshot(run: TrajectoryRun): SavedRun {
  const { id, gameId, revision, color, phase, startedAt, status, error, payloads } = run
  return { id, gameId, revision, color, phase, startedAt, status, error, payloads: [...payloads] }
}
async function save(run: TrajectoryRun) {
  try {
    const database = await db()
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('runs', 'readwrite')
      tx.objectStore('runs').put(snapshot(run))
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
      tx.onabort = () => reject(tx.error)
    })
    run.storageError = undefined
  } catch (error) { run.storageError = `轨迹未能保存：${String(error)}` }
}
function publish(run: TrajectoryRun, immediate = false) {
  if (immediate) { clearTimeout(pending.get(run.id)); pending.delete(run.id) }
  if (!pending.has(run.id)) {
    const update = () => {
      pending.delete(run.id)
      run.document = projectTrajectory(run)
      run.activity = activityTrackers.get(run)!.snapshot()
    }
    if (immediate) update()
    else pending.set(run.id, setTimeout(update, 200))
  }
  if (immediate) { clearTimeout(saves.get(run.id)); saves.delete(run.id); void save(run) }
  else if (!saves.has(run.id)) saves.set(run.id, setTimeout(() => { saves.delete(run.id); void save(run) }, 500))
}

export async function loadTrajectoryRuns(gameId: string) {
  const database = await db()
  const saved = await new Promise<SavedRun[]>((resolve, reject) => {
    const request = database.transaction('runs').objectStore('runs').index('gameId').getAll(gameId)
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const known = new Set(trajectoryRuns.value.map(r => r.id))
  const restored = saved.filter(r => !known.has(r.id)).map(r => makeRun({ ...r, status: r.status === 'running' ? 'interrupted' : r.status }))
  trajectoryRuns.value = [...trajectoryRuns.value, ...restored].sort((a, b) => a.startedAt - b.startedAt)
}

export function captureTrajectory(event: AiSearchEvent) {
  if (event.type === 'search-start') {
    if (!isObject(event.detail) || event.detail.provider !== 'dsh') return
    if (trajectoryRuns.value.some(r => r.id === event.searchId)) return
    const request = isObject(event.detail.request) ? event.detail.request : {}
    trajectoryRuns.value = [...trajectoryRuns.value, makeRun({ id: event.searchId, gameId: event.gameId, revision: event.revision,
      color: String(event.detail.color), phase: String(request.phase), startedAt: Date.now(), status: 'running', payloads: [] })]
  }
  const run = trajectoryRuns.value.find(r => r.id === event.searchId && r.gameId === event.gameId)
  if (!run) return
  if (event.type === 'search-trajectory') {
    const payload = event.detail as DshTrajectoryPayload
    run.payloads.push(payload)
    activityTrackers.get(run)!.consume(payload, Date.now())
  }
  else if (event.type === 'search-accepted') run.status = 'complete'
  else if (event.type === 'search-cancel') run.status = 'cancelled'
  else if (event.type === 'search-rejected' || event.type === 'search-error') {
    run.status = 'error'
    run.error = isObject(event.detail) ? String(event.detail.message ?? '落子未通过校验') : String(event.detail)
  }
  publish(run, run.status !== 'running')
}

export function startDshTrajectoryCapture() {
  if (stop) return
  stop = onAiSearch(captureTrajectory)
  addEventListener('pagehide', () => { for (const run of trajectoryRuns.value) publish(run, true) })
}
