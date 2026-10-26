import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { netClose, netRejoin } from './net'
import { applySnapshot, broadcastClock, loadSave, persistGame, state, tickClock, toLobby, type Snapshot } from './store'

createApp(App).mount('#app')

/** 当前 URL 中的对局会话 id（/s/<id>），不在对局路径下为 null */
const sessionMatch = () => location.pathname.match(/\/s\/([^/]+?)\/?$/)?.[1] ?? null

/** 用存档恢复对局；联机还原局面后尝试重连原房间 */
function restore(save: Snapshot) {
  applySnapshot(save)
  if (save.mode === 'online') {
    // 其他人是否还在要等重连结果，先按掉线处理
    state.peerLeft = true
    netRejoin(save.roomCode, save.myColor ?? 'blue', save.players?.length ?? 2).catch(() => {})
  }
}

// 刷新恢复：URL 的 /s/<id> 与存档 sessionId 对上才恢复（旧格式存档已被 loadSave 忽略）
const save = loadSave()
const sid = sessionMatch()
if (save && sid && save.sessionId === sid) restore(save)

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
addEventListener('popstate', () => {
  const id = sessionMatch()
  const s = loadSave()
  if (id && s && s.sessionId === id && state.sessionId !== id) {
    restore(s)
    return
  }
  if (!id && state.phase !== 'lobby') {
    netClose()
    toLobby()
  }
})
