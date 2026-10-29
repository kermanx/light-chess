import { shallowRef } from 'vue'

const readRoute = () => {
  const match = location.pathname.match(/\/(?:replays|replay\/([a-f0-9-]{36}))\/?$/)
  return match ? { id: match[1] ?? null } : null
}
export const replayRoute = shallowRef(readRoute())
export const syncReplayRoute = () => { replayRoute.value = readRoute() }
export const appBase = () => location.pathname.replace(/\/(?:replays|replay\/[a-f0-9-]{36}|ai-test(?:\/[a-f0-9-]{36})?|s\/[^/]+)\/?$/, '/').replace(/\/?$/, '/')
