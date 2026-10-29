import { reactive, watch } from 'vue'
import { defaultClockSettings, freshClock } from '../clock'
import { edgeOf, type Color, type Dir, type Home, type Mirror } from '../game'
import { applySnapshot, onActionApplied, serialize, setGamePersistenceEnabled, state, toLobby, type Snapshot } from '../store'
import { onAiSearch } from './telemetry'
import { acknowledgeTestEvents, countTestGames, loadTestGame, readTestEvents, saveTestEvent, testEventLineage, type TestEvent, type TestGame } from './test-records'

declare const __AI_TEST_BUILD__: { builtAt: string; engineSha256: string; rulesSha256: string }
const build = typeof __AI_TEST_BUILD__ === 'undefined' ? null : __AI_TEST_BUILD__
export const aiTest = reactive({
  active: false, gameId: '', moveCount: 0, pendingCount: 0,
  storageStatus: 'saving' as 'saving' | 'saved' | 'browser-only' | 'error',
  storageError: null as string | null, diskPath: null as string | null, archivedCount: 0,
})
const POINTER = 'light-chess:ai-test:last'
let tabId: string | undefined
const pending = new Map<string, TestEvent>()
const memoryEvents = new Map<string, TestEvent>()
let game: TestGame | null = null
let writes = Promise.resolve()
let flushing = false
let browserFailed = false
let initialized = false
let navigation = 0
let activeSearch: string | null = null

export const isAiTestRoute = () => /\/ai-test(?:\/[a-f0-9-]{36})?\/?$/.test(location.pathname)
const routeId = () => location.pathname.match(/\/ai-test\/([a-f0-9-]{36})\/?$/)?.[1]
const appBase = () => location.pathname.replace(/(?:ai-test(?:\/[a-f0-9-]{36})?|s\/[^/]+)\/?$/, '').replace(/\/?$/, '/')
const endpoint = () => `${appBase()}__ai-test/record`
const copy = <T>(data: T): T => JSON.parse(JSON.stringify(data))
function remember(id: string) {
  try { sessionStorage.setItem(POINTER, id); localStorage.setItem(POINTER, id) } catch { /* IndexedDB remains authoritative. */ }
}
function remembered() {
  try { return sessionStorage.getItem(POINTER) ?? localStorage.getItem(POINTER) } catch { return null }
}
function storageError(error: unknown) { return error instanceof Error ? error.message : String(error) }
function updatePending() { aiTest.pendingCount = pending.size }

function record(type: string, detail: unknown, snapshot = serialize()) {
  if (!aiTest.active || !game) return
  const event: TestEvent = copy({
    v: 1, id: crypto.randomUUID(), gameId: game.id, parentId: game.headId || null, sequence: game.sequence + 1,
    tabId: tabId ??= crypto.randomUUID(), at: new Date().toISOString(), type, detail,
  })
  game = copy({ ...game, headId: event.id, sequence: event.sequence, moveCount: aiTest.moveCount, snapshot })
  const savedGame = game
  memoryEvents.set(event.id, event)
  pending.set(event.id, event)
  updatePending()
  if (!browserFailed) aiTest.storageStatus = 'saving'
  // Serialize commits so the stored head always matches the most recent event.
  writes = writes.then(async () => {
    try { await saveTestEvent(event, savedGame) }
    catch (error) {
      browserFailed = true
      aiTest.storageStatus = 'error'
      aiTest.storageError = `浏览器记录失败：${storageError(error)}。请导出记录。`
    }
  })
  void writes.then(flushAiTestRecords)
}

/** Idempotent upload; unacknowledged events stay in IndexedDB across reloads. */
export async function flushAiTestRecords() {
  if (flushing || !pending.size) return
  flushing = true
  try {
    while (pending.size) {
      const events = [...pending.values()].slice(0, 16)
      const response = await fetch(endpoint(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: 1, events }), signal: AbortSignal.timeout(5000),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const result = await response.json()
      if (result.ok !== true || !events.every(e => result.saved?.includes(e.id))) throw new Error('本地记录服务不可用')
      aiTest.diskPath = result.directory
      await writes
      if (!browserFailed) await acknowledgeTestEvents(events)
      for (const event of events) pending.delete(event.id)
      updatePending()
    }
    aiTest.storageStatus = browserFailed ? 'error' : 'saved'
    if (!browserFailed) aiTest.storageError = null
  } catch (error) {
    aiTest.storageStatus = browserFailed ? 'error' : 'browser-only'
    if (!browserFailed) aiTest.storageError = `本地文件待同步（${storageError(error)}）；浏览器已保留记录。`
  } finally { flushing = false }
}

function installRecorder() {
  if (initialized) return
  initialized = true
  onActionApplied((action, before, after) => {
    if (!aiTest.active || after.sessionId !== aiTest.gameId) return
    const isMove = action.kind === 'edge' || action.kind === 'diag'
    if (isMove) aiTest.moveCount++
    record('action', {
      action, before, after,
      actor: (isMove || action.kind === 'setup') && state.aiPlayers.includes(action.color) ? 'ai' : 'human',
      searchId: isMove && state.aiPlayers.includes(action.color) ? activeSearch : null,
    }, after)
  })
  onAiSearch(event => {
    if (!aiTest.active || event.gameId !== aiTest.gameId) return
    if (event.type === 'search-start') activeSearch = event.searchId
    record(event.type, event)
    if (['search-accepted', 'search-rejected', 'search-error', 'search-cancel'].includes(event.type)) activeSearch = null
  })
  watch(() => state.aiBudgetMs, (budgetMs, previous) => {
    if (aiTest.active && state.sessionId === aiTest.gameId && budgetMs !== previous) record('budget-change', { previous, budgetMs })
  })
  setInterval(() => { void flushAiTestRecords() }, 5000)
  addEventListener('online', () => { void flushAiTestRecords() })
  addEventListener('pagehide', () => {
    record('page-hidden', { snapshot: serialize(), activeSearch })
    // Beacon has no acknowledgement. The next visit safely retries these IDs.
    const events: TestEvent[] = []
    for (const event of pending.values()) {
      if (new TextEncoder().encode(JSON.stringify({ events: [...events, event] })).length > 48_000) break
      events.push(event)
    }
    if (events.length) navigator.sendBeacon(endpoint(), new Blob([JSON.stringify({ version: 1, events })], { type: 'application/json' }))
  })
}

function initialSnapshot(id: string): Snapshot {
  const homes: Partial<Record<Color, Home>> = {
    blue: { x: 2, y: 2, dir: 0 }, red: { x: 13, y: 13, dir: 2 },
  }
  const edges: [string, Mirror][] = []
  for (const color of ['blue', 'red'] as const) {
    const home = homes[color]!
    for (const dir of [0, 1, 2, 3] as Dir[]) if (dir !== home.dir) edges.push([edgeOf(home.x, home.y, dir), { color }])
  }
  const clockSettings = { ...defaultClockSettings(), enabled: false }
  return {
    v: 1, sessionId: id, mode: 'local', myColor: null, roomCode: '',
    players: ['blue', 'red'], aiPlayers: ['red'], aiBudgetMs: 10_000, aiPaused: false,
    phase: 'play', size: 16, homes, edges, diags: [], current: 'blue',
    winner: null, dead: [], lastMove: null, victoryReplay: null,
    boundaryReflects: true, laserAllowed: true, allowUndo: true,
    clockSettings, clock: { ...freshClock(clockSettings), at: Date.now() }, timedOut: [],
  }
}

export function startAiTestGame() {
  navigation++
  if (aiTest.active) record('new-game', { snapshot: serialize(), activeSearch })
  installRecorder()
  setGamePersistenceEnabled(false)
  const id = crypto.randomUUID()
  const snapshot = initialSnapshot(id)
  aiTest.active = true
  aiTest.gameId = id
  aiTest.moveCount = 0
  activeSearch = null
  game = { id, createdAt: new Date().toISOString(), headId: '', sequence: 0, moveCount: 0, snapshot }
  applySnapshot(snapshot)
  state.peerLeft = false
  remember(id)
  history.replaceState(null, '', `${appBase()}ai-test/${id}`)
  record('game-start', { preset: 'duel-16-v1', build, userAgent: navigator.userAgent, snapshot })
  void writes.then(async () => { aiTest.archivedCount = Math.max(0, await countTestGames() - 1) }).catch(() => {})
}

export async function enterAiTestMode() {
  const token = ++navigation
  installRecorder()
  setGamePersistenceEnabled(false)
  try {
    for (const event of await readTestEvents()) pending.set(event.id, event)
    updatePending()
    const id = routeId() ?? remembered()
    const saved = id ? await loadTestGame(id) : undefined
    if (token !== navigation || !isAiTestRoute()) return
    if (saved && saved.snapshot.size === 16 && saved.snapshot.clockSettings?.enabled === false) {
      game = saved
      aiTest.active = true
      aiTest.gameId = saved.id
      aiTest.moveCount = saved.moveCount
      applySnapshot(saved.snapshot)
      state.peerLeft = false
      remember(saved.id)
      history.replaceState(null, '', `${appBase()}ai-test/${saved.id}`)
      record('session-resume', { build, snapshot: serialize() })
      aiTest.archivedCount = Math.max(0, await countTestGames() - 1)
    } else startAiTestGame()
  } catch (error) {
    if (token !== navigation || !isAiTestRoute()) return
    startAiTestGame()
    browserFailed = true
    aiTest.storageStatus = 'error'
    aiTest.storageError = `浏览器记录不可用：${storageError(error)}。请导出记录。`
  }
  void flushAiTestRecords()
}

/** Called on navigation too; old archives remain available for export/debugging. */
export function exitAiTestMode() {
  navigation++
  if (aiTest.active) record('session-leave', { snapshot: serialize(), activeSearch })
  aiTest.active = false
  game = null
  activeSearch = null
  setGamePersistenceEnabled(true)
}
export function leaveAiTestMode() {
  const base = appBase()
  exitAiTestMode()
  toLobby()
  history.pushState(null, '', base)
}

export async function exportAiTestGame() {
  if (!game) return
  const exported = copy(game)
  await writes
  const events = new Map<string, TestEvent>()
  try { for (const event of await readTestEvents(exported.id)) events.set(event.id, event) } catch { /* In-memory recovery below. */ }
  for (const event of memoryEvents.values()) if (event.gameId === exported.id) events.set(event.id, event)
  const payload = { format: 'light-chess-ai-test', version: 1, game: exported, ...testEventLineage(exported.headId, events) }
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `light-chess-ai-${exported.id}.json`
  link.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}
