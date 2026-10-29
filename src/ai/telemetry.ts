/** Optional local diagnostics. Observers cannot affect game execution. */
export interface AiSearchEvent {
  type: 'search-start' | 'search-progress' | 'search-trajectory' | 'search-result' | 'search-cancel' | 'search-error' | 'search-accepted' | 'search-rejected'
  searchId: string
  gameId: string
  revision: number
  detail: unknown
}
const observers = new Set<(event: AiSearchEvent) => void>()
export function onAiSearch(observer: (event: AiSearchEvent) => void) {
  observers.add(observer)
  return () => observers.delete(observer)
}
export function emitAiSearch(event: AiSearchEvent) {
  for (const observer of observers) {
    try { observer(event) } catch (error) { console.error('AI recorder failed', error) }
  }
}
