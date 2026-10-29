import { ref, shallowRef } from 'vue'
import type {
  ConsumeTrajectoryOptions,
  CreateTrajectoryStoreOptions,
  TrajectoryMutation,
  TrajectoryOlderLoader,
  TrajectoryRecord,
  TrajectoryStore,
  TrajectoryStreamSource,
} from './types'

function isReadableStream(
  source: TrajectoryStreamSource,
): source is ReadableStream<TrajectoryMutation> {
  return typeof (source as ReadableStream<TrajectoryMutation>).getReader === 'function'
}

function mergeAppend(
  current: readonly TrajectoryRecord[],
  incoming: readonly TrajectoryRecord[],
): readonly TrajectoryRecord[] {
  if (incoming.length === 0) return current
  const next = [...current]
  const indexes = new Map(next.map((record, index) => [record.id, index]))
  for (const record of incoming) {
    const index = indexes.get(record.id)
    if (index === undefined) {
      indexes.set(record.id, next.length)
      next.push(record)
    } else next[index] = { ...next[index], ...record }
  }
  return next
}

function mergePrepend(
  current: readonly TrajectoryRecord[],
  incoming: readonly TrajectoryRecord[],
): readonly TrajectoryRecord[] {
  if (incoming.length === 0) return current
  const existing = new Set(current.map(record => record.id))
  const prefix = incoming.filter(record => !existing.has(record.id))
  return prefix.length === 0 ? current : [...prefix, ...current]
}

/** Create a store with stable record identity, stream ingestion, and older-page loading. */
export function createTrajectoryStore(
  options: CreateTrajectoryStoreOptions = {},
): TrajectoryStore {
  const records = shallowRef<readonly TrajectoryRecord[]>([...(options.records ?? [])])
  const hasMore = ref(options.hasMore ?? false)
  const loadingOlder = ref(false)
  const streaming = ref(false)
  const error = shallowRef<unknown | null>(null)
  let olderLoader = options.loadOlder
  let disposed = false
  let activeStreams = 0
  let historyGeneration = 0
  let historyController: AbortController | null = null
  const controllers = new Set<AbortController>()

  const invalidateHistoryLoad = () => {
    historyGeneration += 1
    historyController?.abort()
    historyController = null
    loadingOlder.value = false
  }

  const append = (incoming: readonly TrajectoryRecord[]) => {
    records.value = mergeAppend(records.value, incoming)
  }
  const prepend = (incoming: readonly TrajectoryRecord[], more?: boolean) => {
    records.value = mergePrepend(records.value, incoming)
    if (more !== undefined) hasMore.value = more
  }
  const patch = (id: string, value: Partial<Omit<TrajectoryRecord, 'id'>>) => {
    const index = records.value.findIndex(record => record.id === id)
    if (index === -1) return
    const next = [...records.value]
    const current = next[index]
    if (current !== undefined) next[index] = { ...current, ...value, id }
    records.value = next
  }
  const upsert = (record: TrajectoryRecord) => { append([record]) }
  const remove = (ids: readonly string[]) => {
    if (ids.length === 0) return
    const removed = new Set(ids)
    records.value = records.value.filter(record => !removed.has(record.id))
  }
  const replace = (incoming: readonly TrajectoryRecord[], more?: boolean) => {
    invalidateHistoryLoad()
    records.value = [...incoming]
    if (more !== undefined) hasMore.value = more
  }
  const apply = (mutation: TrajectoryMutation) => {
    switch (mutation.type) {
      case 'append': append(mutation.records); break
      case 'prepend': prepend(mutation.records, mutation.hasMore); break
      case 'patch': patch(mutation.id, mutation.patch); break
      case 'upsert': upsert(mutation.record); break
      case 'remove': remove(mutation.ids); break
      case 'replace': replace(mutation.records, mutation.hasMore); break
      case 'history':
        hasMore.value = mutation.hasMore
        if (mutation.loading !== undefined) loadingOlder.value = mutation.loading
        break
      default: mutation satisfies never
    }
  }

  const consume = async (
    source: TrajectoryStreamSource,
    consumeOptions: ConsumeTrajectoryOptions = {},
  ): Promise<void> => {
    if (disposed) throw new Error('Trajectory store has been disposed')
    const controller = new AbortController()
    const forwardAbort = () => { controller.abort(consumeOptions.signal?.reason) }
    consumeOptions.signal?.addEventListener('abort', forwardAbort, { once: true })
    controllers.add(controller)
    activeStreams += 1
    streaming.value = true
    error.value = null
    try {
      if (isReadableStream(source)) {
        const reader = source.getReader()
        const cancel = () => { void reader.cancel(controller.signal.reason) }
        controller.signal.addEventListener('abort', cancel, { once: true })
        try {
          while (!controller.signal.aborted) {
            const { done, value } = await reader.read()
            if (done) break
            apply(value)
          }
        } finally {
          controller.signal.removeEventListener('abort', cancel)
          reader.releaseLock()
        }
      } else {
        for await (const mutation of source) {
          if (controller.signal.aborted) break
          apply(mutation)
        }
      }
    } catch (reason) {
      if (!controller.signal.aborted) {
        error.value = reason
        throw reason
      }
    } finally {
      consumeOptions.signal?.removeEventListener('abort', forwardAbort)
      controllers.delete(controller)
      activeStreams -= 1
      streaming.value = !disposed && activeStreams > 0
    }
  }

  const loadEarlier = async (): Promise<boolean> => {
    if (disposed || loadingOlder.value || !hasMore.value || olderLoader === undefined) return false
    const controller = new AbortController()
    const generation = historyGeneration
    historyController = controller
    controllers.add(controller)
    loadingOlder.value = true
    error.value = null
    try {
      const first = records.value[0]
      const page = await olderLoader({
        ...(first === undefined ? {} : { beforeId: first.id }),
        ...(first?.seq === undefined ? {} : { beforeSeq: first.seq }),
        signal: controller.signal,
      })
      if (disposed || controller.signal.aborted || generation !== historyGeneration) return false
      prepend(page.records, page.hasMore)
      return page.records.length > 0
    } catch (reason) {
      if (!controller.signal.aborted) {
        error.value = reason
        throw reason
      }
      return false
    } finally {
      controllers.delete(controller)
      if (historyController === controller) {
        historyController = null
        loadingOlder.value = false
      }
    }
  }

  const setOlderLoader = (loader: TrajectoryOlderLoader | undefined) => {
    if (olderLoader !== loader) invalidateHistoryLoad()
    olderLoader = loader
  }
  const dispose = () => {
    disposed = true
    historyGeneration += 1
    historyController = null
    for (const controller of controllers) controller.abort()
    controllers.clear()
    streaming.value = false
    loadingOlder.value = false
  }

  return {
    records,
    hasMore,
    loadingOlder,
    streaming,
    error,
    append,
    prepend,
    patch,
    upsert,
    remove,
    replace,
    apply,
    consume,
    loadEarlier,
    setOlderLoader,
    dispose,
  }
}
