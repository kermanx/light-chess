import { createApp } from 'vue'
import 'virtual:uno.css'
import './style.css'
import { startDshTrajectoryCapture } from './ai/trajectory'
import App from './App.vue'
import { startAiController } from './ai/controller'
import { enterAiTestMode, exitAiTestMode, isAiTestRoute } from './ai/test-session'
import { netClose, netRejoin } from './net'
import { applySnapshot, broadcastClock, loadSave, persistGame, setGamePersistenceEnabled, state, tickClock, toLobby, type Snapshot } from './store'
import { replayRoute, syncReplayRoute } from './replay/navigation'
import { loadRecording, migrateSavedGames, startReplayArchive } from './replay/archive'

/** 当前 URL 中的对局会话 id（/s/<id>），不在对局路径下为 null */
const sessionMatch = () => location.pathname.match(/\/s\/([^/]+?)\/?$/)?.[1] ?? null

/** 用存档恢复对局；联机还原局面后尝试重连原房间 */
async function restore(save: Snapshot) {
  if (!save.recording && save.sessionId) {
    try { save = { ...save, recording: await loadRecording(save.sessionId) } } catch { /* Restore remains usable if archive storage is unavailable. */ }
  }
  applySnapshot(save)
  if (save.mode === 'online') {
    // 其他人是否还在要等重连结果，先按掉线处理
    state.peerLeft = true
    netRejoin(save.roomCode, save.myColor ?? 'blue', save.players?.length ?? 2).catch(() => {})
  }
}

// 刷新恢复：URL 的 /s/<id> 与存档 sessionId 对上才恢复（旧格式存档已被 loadSave 忽略）
async function boot() {
  startDshTrajectoryCapture()
  startReplayArchive()
  await migrateSavedGames()
  if (replayRoute.value) setGamePersistenceEnabled(false)
  else if (isAiTestRoute()) await enterAiTestMode()
  else {
    const save = loadSave()
    const sid = sessionMatch()
    if (save && sid && save.sessionId === sid) await restore(save)
  }
  createApp(App).mount('#app')
  startAiController()
}
void boot()

// 用绝对时间计算剩余量，后台定时器被节流也不会漏扣时间。
let lastClockSync = 0
setInterval(() => {
  tickClock()
  if (state.phase === 'play' && state.clockSettings.enabled && Date.now() - lastClockSync >= 1000) {
    lastClockSync = Date.now()
    broadcastClock()
    persistGame()
  }
}, 100)
addEventListener('visibilitychange', () => { if (!document.hidden) tickClock() })
addEventListener('pagehide', () => {
  if (state.mode === 'online') state.peerLeft = true
  persistGame()
})

// 浏览器后退/前进：回大厅（存档保留）↔ 恢复对局
addEventListener('popstate', async () => {
  syncReplayRoute()
  if (replayRoute.value) {
    netClose()
    exitAiTestMode()
    setGamePersistenceEnabled(false)
    toLobby()
    return
  }
  setGamePersistenceEnabled(true)
  if (isAiTestRoute()) {
    netClose()
    await enterAiTestMode()
    return
  }
  exitAiTestMode()
  const id = sessionMatch()
  const s = loadSave()
  if (id && s && s.sessionId === id && state.sessionId !== id) {
    await restore(s)
    return
  }
  if (!id && state.phase !== 'lobby') {
    netClose()
    toLobby()
  }
})
