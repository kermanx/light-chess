import { createApp } from 'vue'
import './style.css'
import App from './App.vue'
import { netRejoin } from './net'
import { applySnapshot, loadSave, state } from './store'

createApp(App).mount('#app')

// 刷新恢复：单机直接还原；联机还原局面后尝试重连原房间
const save = loadSave()
if (save) {
  applySnapshot(save)
  if (save.mode === 'online') {
    // 其他人是否还在要等重连结果，先按掉线处理
    state.peerLeft = true
    netRejoin(save.roomCode, save.myColor ?? 'blue', save.players?.length ?? 2).catch(() => {})
  }
}
