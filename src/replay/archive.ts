import { reactive, watch } from 'vue'
import { state, type Snapshot } from '../store'
import { listTestGames, readTestEvents, testEventLineage, type TestEvent, type TestGame } from '../ai/test-records'
import { appendRecording, newRecording, recordingSummary, type RecordedGame, type GameSummary } from './recording'

export const archiveStatus = reactive({ pending: 0, error: '', migrationError: '' })
let database: Promise<IDBDatabase> | undefined
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('light-chess-replays', 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore('games', { keyPath: 'id' })
      request.result.createObjectStore('summaries', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => { database = undefined; reject(request.error) }
    request.onblocked = () => reject(new Error('对局记录数据库被其他窗口占用'))
  })
}
function value<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function loadRecording(id: string): Promise<RecordedGame | undefined> {
  return value((await db()).transaction('games').objectStore('games').get(id))
}
export async function listRecordings(): Promise<GameSummary[]> {
  return value((await db()).transaction('summaries').objectStore('summaries').getAll())
}
export async function saveRecording(game: RecordedGame) {
  const tx = (await db()).transaction(['games', 'summaries'], 'readwrite')
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('保存对局记录失败'))
  })
  const games = tx.objectStore('games'), request = games.get(game.id)
  request.onsuccess = () => {
    const existing = request.result as RecordedGame | undefined
    // A reconnecting tab or old save must not truncate a newer archive.
    if (existing && (existing.events.length > game.events.length ||
      existing.events.length === game.events.length && existing.updatedAt > game.updatedAt ||
      existing.historyComplete && !game.historyComplete && game.events.length === 0)) return
    games.put(game)
    tx.objectStore('summaries').put(recordingSummary(game))
  }
  await done
}
let writes = Promise.resolve(), installed = false
export const flushRecordings = () => writes
export function queueRecording(game: RecordedGame) {
  // Freeze reactive snapshot values before an asynchronous write.
  const frozen = JSON.parse(JSON.stringify(game)) as RecordedGame
  archiveStatus.pending++
  writes = writes.then(async () => {
    try { await saveRecording(frozen); archiveStatus.error = '' }
    catch (error) { archiveStatus.error = `对局记录未保存：${error instanceof Error ? error.message : String(error)}。可先下载本局记录。` }
    finally { archiveStatus.pending-- }
  })
}
export function startReplayArchive() {
  if (installed) return
  installed = true
  // Sync observes every immutable replacement, including a quick restart followed by lobby navigation.
  watch(() => state.recording, game => { if (game) queueRecording(game) }, { flush: 'sync' })
}

/** Import only the chosen event lineage; search/model logs never enter a public replay. */
export function recordingFromTest(saved: TestGame, events: TestEvent[]): RecordedGame {
  const lineage = testEventLineage(saved.headId, new Map(events.map(e => [e.id, e])))
  let record: RecordedGame | undefined, previous: Snapshot | undefined
  for (const event of lineage.events) {
    const detail = event.detail as { snapshot?: Snapshot; before?: Snapshot; after?: Snapshot; action?: Parameters<typeof appendRecording>[3] }
    const snapshot = detail?.snapshot ?? detail?.before
    if (!record && snapshot) {
      record = newRecording(snapshot, { id: saved.id, at: saved.createdAt, complete: lineage.complete && event.type === 'game-start' })
      previous = snapshot
    }
    if (!record || !previous) continue
    // Restarted rounds have a new archive ID. Historical test sessions did not restart in place.
    if (event.type === 'action' && detail.after && detail.before && detail.action) {
      record = appendRecording(record, previous, detail.before, undefined, event.at)
      record = appendRecording(record, detail.before, detail.after, detail.action, event.at)
      previous = detail.after
    } else if (detail.snapshot) {
      record = appendRecording(record, previous, detail.snapshot, undefined, event.at)
      previous = detail.snapshot
    }
  }
  if (!record || !previous) return newRecording(saved.snapshot, { id: saved.id, at: saved.createdAt, complete: false })
  return appendRecording(record, previous, saved.snapshot)
}
let migration: Promise<void> | undefined
export function migrateSavedGames() {
  return migration ??= (async () => {
    try {
      const tests = await listTestGames()
      for (const test of tests) {
        if (await loadRecording(test.id)) continue
        await saveRecording(test.snapshot.recording ?? recordingFromTest(test, await readTestEvents(test.id)))
      }
      for (const storage of [sessionStorage, localStorage]) {
        let saved: Snapshot | undefined
        try { saved = JSON.parse(storage.getItem('light-chess:save') ?? 'null') } catch { continue }
        if (saved?.v !== 1 || !saved.sessionId || saved.phase === 'lobby') continue
        if (saved.recording) await saveRecording(saved.recording)
        else if (!await loadRecording(saved.sessionId)) await saveRecording(newRecording(saved, { id: saved.sessionId, complete: false }))
      }
    } catch (error) { archiveStatus.migrationError = `旧记录导入未完成：${error instanceof Error ? error.message : String(error)}` }
  })()
}
