import { shallowRef, watch, type ShallowRef } from 'vue'
import type { TrajectoryWatchToolResult } from './types'

interface Selection {
  recordId: string
  resultSeq?: number
  active: boolean
  observe?: TrajectoryWatchToolResult
}

/** Own only the selected Result tab's subscription within the caller's Vue effect scope. */
export function useLiveToolResult(selection: () => Selection): ShallowRef<unknown> {
  const value = shallowRef<unknown>(undefined)
  watch([
    () => selection().recordId,
    () => selection().resultSeq,
    () => selection().active,
    () => selection().observe,
  ], ([_id, seq, active, observe], _previous, onCleanup) => {
    value.value = undefined
    if (!active || seq === undefined || observe === undefined) return
    let current = true
    let dispose: (() => void) | undefined
    onCleanup(() => {
      current = false
      value.value = undefined
      dispose?.()
    })
    try {
      dispose = observe(seq, next => { if (current) value.value = next })
    } catch {
      // A failed subscription must leave the persisted rendered content usable.
      current = false
      value.value = undefined
    }
  }, { immediate: true, flush: 'sync' })
  return value
}
