// Provider orchestration, credential isolation and authority checks, without a model API request.
import assert from 'node:assert/strict'
import { nextTick } from 'vue'
import type { AiProvider, AiWorkerMessage, AiWorkerRequest } from '../src/ai/providers'
import type { Action } from '../src/store'

const session = new Map<string, string>()
const local = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: {
  getItem: (key: string) => local.get(key) ?? null,
  setItem: (key: string, value: string) => local.set(key, value),
  removeItem: (key: string) => local.delete(key),
} })
Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
  getItem: (key: string) => session.get(key) ?? null,
  setItem: (key: string, value: string) => session.set(key, value),
  removeItem: (key: string) => session.delete(key),
} })
const { clearDshConfig, dshConnection, dshProfiles, saveDshProfile, deleteDshProfile, readDshConfig, saveDshConfig } = await import('../src/ai/config')
const { aiStatus, cancelAi, retryAi, startAiController } = await import('../src/ai/controller')
const { onAiSearch } = await import('../src/ai/telemetry')
const {
  aiProviderFor, applyRemote, applySnapshot, dispatch, serialize, setSender, startLocal,
  startOnline, state, toLobby, topUndoFrame,
} = await import('../src/store')

assert.equal(dshConnection.baseURL, 'https://api.deepseek.com/anthropic')
assert.equal(dshConnection.model, 'deepseek-flash')
assert.equal(dshConnection.remember, true)
const key = 'provider-test-private-key'
const config = { baseURL: dshConnection.baseURL, model: dshConnection.model, apiKey: key }
saveDshConfig(config, false)
assert.equal(session.has('light-chess:dsh-connection'), false)
assert.equal(local.has('light-chess:dsh-connection'), false)
saveDshConfig(config)
assert.deepEqual(readDshConfig(), config)
assert.equal(JSON.parse(local.get('light-chess:llm-profiles')!).profiles[0].apiKey, key)
clearDshConfig()
assert.equal(JSON.parse(local.get('light-chess:llm-profiles')!).profiles[0].apiKey, '')
assert.equal(dshConnection.remember, true)
saveDshConfig(config, false)
assert.equal(session.has('light-chess:dsh-connection'), false)
assert.equal(local.has('light-chess:dsh-connection'), false)
assert.throws(() => saveDshConfig({ ...config, baseURL: 'https://example.com?key=secret' }, false))
assert.throws(() => saveDshConfig({ ...config, baseURL: 'https://key:secret@example.com' }, false))
clearDshConfig()
assert.throws(readDshConfig, /API Key/)

class FakeWorker {
  onmessage: ((event: MessageEvent<AiWorkerMessage>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  request: AiWorkerRequest | null = null
  terminated = false
  provider: AiProvider
  constructor(provider: AiProvider) { this.provider = provider }
  postMessage(request: AiWorkerRequest) { this.request = request }
  terminate() { this.terminated = true }
  answer(data: AiWorkerMessage) { this.onmessage?.({ data } as MessageEvent<AiWorkerMessage>) }
}
const timers: { delay: number | undefined }[] = []
const realTimeout = globalThis.setTimeout, realClear = globalThis.clearTimeout
globalThis.setTimeout = ((_fn: unknown, delay?: number) => {
  const timer = { delay }; timers.push(timer); return timer
}) as unknown as typeof setTimeout
globalThis.clearTimeout = (() => {}) as typeof clearTimeout
const workers: FakeWorker[] = []
const events: unknown[] = []
const unobserve = onAiSearch(event => events.push(event))
const latest = () => workers.at(-1)!
const stop = startAiController(provider => {
  const worker = new FakeWorker(provider)
  workers.push(worker)
  return worker as unknown as Worker
})
try {
  state.size = 16
  startLocal(2, ['red'], { red: 'dsh' })
  state.clockSettings.enabled = false
  dispatch({ kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
  await nextTick()
  assert.equal(aiStatus.status, 'error')
  assert.match(aiStatus.error, /API Key/)
  assert.equal(workers.length, 0, 'Missing credentials must not invoke a provider')

  saveDshConfig(config, false)
  await nextTick()
  assert.equal(latest().provider, 'dsh')
  assert.equal(latest().request?.dsh?.apiKey, key)
  assert.equal(timers.length, 0, 'DSH must not inherit the WASM search timeout')
  latest().answer({ type: 'progress', message: `tool used ${key}`, detail: { apiKey: key, headers: { Authorization: `Bearer ${key}` }, output: `tool output ${key}` } })
  assert.equal(aiStatus.status, 'thinking', 'Progress is not a final result')
  assert(!aiStatus.progress.includes(key))
  assert(!JSON.stringify(events).includes(key))

  latest().answer({ type: 'trajectory', payload: { kind: 'stream', sessionId: 'test', frame: { type: 'start', step: 2 } } })
  assert.match(aiStatus.progress, /第 2 次请求 · 等待模型输出/)
  latest().answer({ type: 'trajectory', payload: { kind: 'stream', sessionId: 'test',
    frame: { type: 'chunk', chunk: { type: 'reasoning-delta', text: '验证光路' } } } })
  assert.match(aiStatus.progress, /模型思考中 · 已接收 4 字符/, 'streaming must replace the stale tool-completed status')

  const cancelled = latest()
  cancelAi()
  await nextTick()
  assert.equal(state.aiPaused, true)
  assert.equal(cancelled.terminated, true)
  cancelled.answer({ action: { kind: 'setup', home: { x: 10, y: 8, dir: 2 } } })
  assert.equal(state.homes.red, undefined)
  retryAi()
  await nextTick()
  assert.notEqual(latest(), cancelled)
  latest().answer({ action: { kind: 'setup', home: { x: 10, y: 8, dir: 2 } } })
  await nextTick()
  assert.equal(state.phase, 'play')
  dispatch({ kind: 'edge', color: 'blue', id: 'h:13:14' })
  await nextTick()
  const dsh = latest()
  const count = workers.length
  state.aiBudgetMs = 3000
  await nextTick()
  assert.equal(workers.length, count, 'WASM budget changes must not cancel DSH')
  assert.equal(timers.length, 0)

  dispatch({ kind: 'ai-provider-setting', color: 'blue', target: 'red', provider: 'wasm' })
  await nextTick()
  assert.equal(dsh.terminated, true)
  assert.equal(latest().provider, 'wasm')
  assert.equal(latest().request?.dsh, undefined, 'WASM never receives credentials')
  assert.equal(timers.at(-1)?.delay, 13000)
  const wasm = latest()
  saveDshConfig(config, true)
  await nextTick()
  assert.equal(latest(), wasm, 'DSH config must not interrupt WASM')
  dsh.answer({ action: { kind: 'edge', id: 'h:12:14' } })
  assert.equal(state.edges.has('h:12:14'), false, 'Switched-away provider cannot apply stale results')
  dispatch({ kind: 'ai-provider-setting', color: 'blue', target: 'red', provider: 'dsh' })
  await nextTick()
  latest().answer({ action: { kind: 'edge', id: 'h:12:14' }, stats: { nodes: 1, depth: 0, elapsedMs: 12000, score: 0, mode: 'dsh', reason: `decision ${key}` } })
  await nextTick()
  assert.equal(state.current, 'blue')
  assert.equal(state.lastMove?.aiAnalysis?.reason, 'decision [redacted]')
  assert(!JSON.stringify(serialize()).includes(key))
  assert(!JSON.stringify(events).includes(key), 'Even model/tool output must be scrubbed before telemetry')

  dispatch({ kind: 'undo', color: 'blue', frame: topUndoFrame()! })
  await nextTick()
  const beforeSwitch = workers.length
  dispatch({ kind: 'ai-provider-setting', color: 'blue', target: 'red', provider: 'wasm' })
  await nextTick()
  assert.equal(state.aiPaused, true)
  assert.equal(workers.length, beforeSwitch, 'Provider change respects undo pause')
  const snapshot = serialize()
  applySnapshot(snapshot)
  assert.equal(aiProviderFor('red'), 'wasm')
  applySnapshot({ ...snapshot, aiProviders: undefined })
  assert.equal(aiProviderFor('red'), 'wasm', 'Old snapshots default to WASM')
  console.log('ok: per-seat dispatch, no DSH WASM deadline, progress, cancellation, switch/undo, credential isolation and legacy snapshots')
  toLobby()
  const firstId = dshProfiles[0].id
  const otherKey = 'second-profile-private-key'
  const secondId = saveDshProfile({ name: 'Second model', model: 'second-model', baseURL: 'https://second.example/anthropic', apiKey: otherKey })
  assert.equal(JSON.parse(local.get('light-chess:llm-profiles')!).profiles.length, 2)
  startLocal(2, ['blue', 'red'], { blue: 'dsh', red: 'dsh' }, { blue: firstId, red: secondId })
  await nextTick()
  assert.equal(latest().request?.dsh?.apiKey, key)
  const firstRequest = latest()
  const unusedId = saveDshProfile({ ...config, name: 'Unused profile' })
  await nextTick()
  assert.equal(latest(), firstRequest, 'Adding a profile must not interrupt an unrelated active request')
  deleteDshProfile(unusedId)
  await nextTick()
  assert.equal(latest(), firstRequest, 'Deleting an unused profile must not interrupt the active request')
  saveDshProfile({ ...dshProfiles.find(p => p.id === secondId)!, model: 'updated-second-model' })
  await nextTick()
  assert.equal(latest(), firstRequest, 'Editing red config must not interrupt blue')
  latest().answer({ action: { kind: 'setup', home: { x: 2, y: 2, dir: 0 } } })
  await nextTick()
  assert.equal(latest().request?.dsh?.model, 'updated-second-model')
  assert.equal(latest().request?.dsh?.apiKey, otherKey)
  const stale = latest()
  dispatch({ kind: 'ai-profile-setting', color: 'blue', target: 'red', profileId: firstId })
  await nextTick()
  assert(stale.terminated)
  assert.equal(latest().request?.dsh?.apiKey, key)
  stale.answer({ action: { kind: 'setup', home: { x: 10, y: 8, dir: 2 } } })
  assert.equal(state.homes.red, undefined)
  dispatch({ kind: 'ai-profile-setting', color: 'blue', target: 'red', profileId: secondId })
  await nextTick()
  const twoProfiles = serialize()
  assert.deepEqual(twoProfiles.aiProfileIds, { blue: firstId, red: secondId })
  applySnapshot(twoProfiles)
  await nextTick()
  assert.equal(latest().request?.dsh?.apiKey, otherKey)
  deleteDshProfile(secondId)
  await nextTick()
  assert.equal(aiStatus.status, 'error')
  assert.match(aiStatus.error, /已删除/)
  assert.equal(latest().terminated, true)
  assert.throws(() => readDshConfig(secondId), /已删除/)
  assert(!JSON.stringify(serialize()).includes(otherKey))
  assert(!JSON.stringify(events).includes(otherKey))
  console.log('ok: two LLMs receive different credentials, independent edits, cancellation on selection, stale rejection, reload binding and deleted-profile safety')


  toLobby()
  startOnline('red', '3001', ['blue', 'red', 'yellow'], ['yellow'], { yellow: 'dsh' })
  const sent: Action[] = []
  setSender(action => sent.push(action), true)
  dispatch({ kind: 'ai-provider-setting', color: 'red', target: 'yellow', provider: 'wasm' })
  dispatch({ kind: 'ai-provider-setting', color: 'blue', target: 'yellow', provider: 'wasm' })
  cancelAi()
  assert.equal(sent.length, 0)
  assert.equal(aiProviderFor('yellow'), 'dsh')
  assert.equal(applyRemote({ kind: 'ai-provider-setting', color: 'red', target: 'yellow', provider: 'wasm' }), false)
  assert(applyRemote({ kind: 'ai-provider-setting', color: 'blue', target: 'yellow', provider: 'wasm' }))
  assert.equal(aiProviderFor('yellow'), 'wasm')
  dispatch({ kind: 'ai-profile-setting', color: 'red', target: 'yellow', profileId: 'guest-profile' })
  assert.equal(state.aiProfileIds.yellow, 'default')
  assert.equal(applyRemote({ kind: 'ai-profile-setting', color: 'red', target: 'yellow', profileId: 'guest-profile' }), false)
  assert(applyRemote({ kind: 'ai-profile-setting', color: 'blue', target: 'yellow', profileId: 'host-profile' }))
  assert.equal(state.aiProfileIds.yellow, 'host-profile')
  const beforeGuest = workers.length
  await nextTick()
  assert.equal(workers.length, beforeGuest, 'Guests never run either provider')
  assert(!JSON.stringify(sent).includes(key))
  console.log('ok: provider changes and cancellation remain host-authoritative; guest sync excludes credentials')
} finally {
  stop(); unobserve(); setSender(null); toLobby(); clearDshConfig()
  globalThis.setTimeout = realTimeout
  globalThis.clearTimeout = realClear
}
