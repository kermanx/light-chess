import type { Snapshot } from '../store'

export interface TestEvent {
  v: 1
  id: string
  gameId: string
  parentId: string | null
  sequence: number
  tabId: string
  at: string
  type: string
  detail: unknown
}
export interface TestGame {
  id: string
  createdAt: string
  headId: string
  sequence: number
  moveCount: number
  snapshot: Snapshot
}

/** Freeze an export at its captured head, even if AI moves during async reads. */
export function testEventLineage(headId: string, records: Map<string, TestEvent>) {
  const events: TestEvent[] = []
  const visited = new Set<string>()
  let cursor: string | null = headId
  while (cursor && !visited.has(cursor)) {
    const event = records.get(cursor)
    if (!event) break
    visited.add(cursor)
    events.push(event)
    cursor = event.parentId
  }
  return { events: events.reverse(), complete: cursor === null, missingParentId: cursor }
}

interface StoredEvent extends TestEvent { synced: number }
let database: Promise<IDBDatabase> | undefined
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('light-chess-ai-tests', 1)
    request.onupgradeneeded = () => {
      const events = request.result.createObjectStore('events', { keyPath: 'id' })
      events.createIndex('gameId', 'gameId')
      events.createIndex('synced', 'synced')
      request.result.createObjectStore('games', { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('对局数据库被其他窗口占用'))
  })
}
function completed(tx: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('对局记录写入失败'))
  })
}
function value<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}
export async function saveTestEvent(event: TestEvent, game: TestGame) {
  const tx = (await db()).transaction(['events', 'games'], 'readwrite')
  tx.objectStore('events').put({ ...event, synced: 0 })
  tx.objectStore('games').put(game)
  await completed(tx)
}
export async function loadTestGame(id: string): Promise<TestGame | undefined> {
  return value((await db()).transaction('games').objectStore('games').get(id))
}
export async function countTestGames(): Promise<number> {
  return value((await db()).transaction('games').objectStore('games').count())
}
export async function readTestEvents(gameId?: string): Promise<TestEvent[]> {
  const store = (await db()).transaction('events').objectStore('events')
  const rows: StoredEvent[] = await value(gameId
    ? store.index('gameId').getAll(gameId)
    : store.index('synced').getAll(0))
  return rows.map(({ synced: _, ...event }) => event).sort((a, b) => a.sequence - b.sequence || a.at.localeCompare(b.at))
}
export async function acknowledgeTestEvents(events: TestEvent[]) {
  const tx = (await db()).transaction('events', 'readwrite')
  for (const event of events) tx.objectStore('events').put({ ...event, synced: 1 })
  await completed(tx)
}
