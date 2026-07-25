<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { MAX_PLAYERS, MIN_PLAYERS } from '../game'
import { netClose, netCreate, netJoin, signaling, type Signaling } from '../net'
import { SIZE_MAX, SIZE_MIN, startLocal, state } from '../store'

const view = ref<'menu' | 'created' | 'join'>('menu')
const code = ref('')
const joinCode = ref('')
const error = ref('')
const busy = ref(false)
const copied = ref(false)
/** 玩家人数（单机与创建房间共用） */
const count = ref(MIN_PLAYERS)
/** 联机信令通道（建房时使用；房号首位 1=Nostr 2=MQTT） */
const sig = ref<Signaling>('nostr')
const countOptions = Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => MIN_PLAYERS + i)

/** 建房后生成的加入链接（其他玩家打开即可直接入座） */
const joinUrl = computed(() =>
  code.value ? `${location.origin}${location.pathname}?join=${code.value}` : '',
)

async function copyJoinUrl() {
  try {
    await navigator.clipboard.writeText(joinUrl.value)
  } catch {
    // 剪贴板不可用时退化为全选展示，用户手动复制
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}

/** 清除地址栏里的 ?join= 参数（避免刷新后重复自动加入） */
function clearJoinParam() {
  if (new URLSearchParams(location.search).has('join')) {
    history.replaceState(null, '', location.pathname)
  }
}

function clampSize(e: Event) {
  const v = Math.round(Number((e.target as HTMLInputElement).value))
  state.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Number.isFinite(v) ? v : state.size))
}

function local() {
  startLocal(count.value)
}

async function create() {
  busy.value = true
  error.value = ''
  try {
    code.value = await netCreate(count.value, sig.value)
    view.value = 'created'
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

/** 建房后切换信令通道：按新通道重建房间（房间号/链接随之更新） */
async function onSigChange(e: Event) {
  sig.value = (e.target as HTMLSelectElement).value as Signaling
  if (view.value !== 'created') return
  busy.value = true
  error.value = ''
  try {
    code.value = await netCreate(count.value, sig.value)
  } catch (err) {
    error.value = (err as Error).message
  } finally {
    busy.value = false
  }
}

async function join() {
  if (!joinCode.value.trim()) return
  busy.value = true
  error.value = ''
  try {
    await netJoin(joinCode.value)
    // 成功后会收到 start 消息，自动进入游戏
    clearJoinParam()
  } catch (e) {
    error.value = (e as Error).message
  } finally {
    busy.value = false
  }
}

function cancel() {
  netClose()
  view.value = 'menu'
  error.value = ''
  clearJoinParam()
}

// 通过加入链接打开：?join=XXXX → 直接进入加入流程
onMounted(() => {
  const param = new URLSearchParams(location.search).get('join')
  if (!param) return
  const c = param.trim()
  if (!/^[12]\d{3}$/.test(c)) return
  joinCode.value = c
  view.value = 'join'
  void join()
})
</script>

<template>
  <div class="lobby">
    <h1 class="logo">光镜棋</h1>
    <p class="tagline">纸上的激光反射对决</p>

    <div v-if="view === 'menu'" class="menu">
      <div class="count-ctl">
        人数
        <button
          v-for="n in countOptions"
          :key="n"
          class="count-btn"
          :class="{ active: count === n }"
          @click="count = n"
        >
          {{ n }}
        </button>
      </div>
      <div class="cards">
        <button class="card" @click="local">
          <span class="card-title">单机对战</span>
          <span class="card-desc">{{ count }} 人同屏，轮流操作</span>
        </button>
        <button class="card" :disabled="busy" @click="create">
          <span class="card-title">创建房间</span>
          <span class="card-desc">{{ count }} 人联机，你坐 1 号位</span>
        </button>
        <button class="card" :disabled="busy" @click="view = 'join'">
          <span class="card-title">加入房间</span>
          <span class="card-desc">输入房间号入座</span>
        </button>
      </div>
    </div>

    <div v-else-if="view === 'created'" class="panel">
      <div class="panel-head">
        <h2 class="panel-title">房间已创建</h2>
        <p class="panel-label">把房间号或链接发给朋友，打开即可加入（{{ count }} 人局）</p>
      </div>

      <div class="room-code-wrap">
        <span class="room-code-box">
          <span class="room-code">{{ code }}</span>
          <button class="btn-primary copy-link" @click="copyJoinUrl">{{ copied ? '已复制' : '复制链接' }}</button>
        </span>
      </div>

      <div class="settings">
        <label class="laser-opt">
          <input type="checkbox" v-model="state.laserAllowed" />
          允许显示光路（悬停棋子时查看）
        </label>
        <label class="laser-opt">
          棋盘
          <input
            class="size-input"
            type="number"
            :min="SIZE_MIN"
            :max="SIZE_MAX"
            :value="state.size"
            @change="clampSize"
          />
          × {{ state.size }} 格
        </label>
        <label class="laser-opt">
          信令
          <select class="sig-select" :value="sig" :disabled="busy" @change="onSigChange">
            <option value="nostr">Nostr</option>
            <option value="mqtt">MQTT</option>
          </select>
          <span class="sig-hint">朋友连不上时换另一种，房间号会更新</span>
        </label>
      </div>

      <p class="waiting">
        <span class="pulse"></span>
        等待玩家加入 {{ state.roomJoined }}/{{ count }}<span class="dots"><i>.</i><i>.</i><i>.</i></span>
      </p>
      <p class="relay-status" :class="{ warn: signaling.total > 0 && signaling.up === 0 }">
        <template v-if="signaling.up > 0">信令中继已连接 {{ signaling.up }} 个</template>
        <template v-else-if="signaling.total > 0">信令中继连接中（{{ signaling.up }}/{{ signaling.total }}）…若一直为 0，说明当前网络连不上中继，请换信令或网络</template>
        <template v-else>信令中继连接中…</template>
      </p>

      <button class="btn-plain cancel-btn" @click="cancel">取消</button>
    </div>

    <div v-else class="panel">
      <p class="panel-label">
        {{ busy ? `正在加入房间 ${joinCode}…` : '输入 4 位房间号（首位区分信令通道）' }}
      </p>
      <input
        v-model="joinCode"
        class="code-input"
        maxlength="4"
        inputmode="numeric"
        placeholder="如 1839"
        @keyup.enter="join"
      />
      <div class="row">
        <button class="btn-primary" :disabled="busy || joinCode.trim().length !== 4" @click="join">
          加入
        </button>
        <button class="btn-plain" @click="cancel">返回</button>
      </div>
      <p v-if="busy" class="relay-status" :class="{ warn: signaling.total > 0 && signaling.up === 0 }">
        <template v-if="signaling.up > 0">信令中继已连接 {{ signaling.up }} 个，正在联系房主…</template>
        <template v-else>信令中继连接中（{{ signaling.up }}/{{ signaling.total }}）…</template>
      </p>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="state.peerLeft" class="error">对方已离开房间</p>
  </div>
</template>

<style scoped>
.lobby {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding-top: 8vh;
}
.logo {
  font-size: 56px;
  letter-spacing: 10px;
  margin: 0;
  color: #35301f;
  text-shadow: 3px 3px 0 rgba(53, 48, 31, 0.12);
  transform: rotate(-1.5deg);
}
.tagline {
  margin: 10px 0 40px;
  color: #8a7f68;
  font-size: 15px;
  letter-spacing: 4px;
}
.cards {
  display: flex;
  gap: 22px;
  flex-wrap: wrap;
  justify-content: center;
}
.menu {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 26px;
}
.count-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #8a7f68;
}
.count-btn {
  width: 34px;
  height: 34px;
  font-size: 15px;
  font-family: inherit;
  cursor: pointer;
  background: #fbf6ea;
  border: 2px solid #3d3627;
  border-radius: 10px 3px 12px 3px / 3px 12px 3px 10px;
  color: #35301f;
  box-shadow: 2px 2px 0 rgba(61, 54, 39, 0.2);
}
.count-btn.active {
  background: #2f6fed;
  border-color: #1e4fb8;
  color: #fff;
}
.sig-select {
  padding: 4px 8px;
  font-size: 14px;
  font-family: inherit;
  background: #fffdf6;
  border: 2px solid #3d3627;
  border-radius: 8px;
  outline: none;
  color: #35301f;
  cursor: pointer;
}
.sig-select:focus {
  border-color: #2f6fed;
}
.sig-hint {
  font-size: 12px;
  color: #b0a488;
}
.relay-status {
  margin: 0;
  font-size: 12px;
  color: #b0a488;
  max-width: 300px;
  text-align: center;
  line-height: 1.6;
}
.relay-status.warn {
  color: #c47f2a;
}
.card {
  width: 180px;
  padding: 26px 18px 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: center;
  background: #fbf6ea;
  border: 2px solid #3d3627;
  border-radius: 12px;
  box-shadow: 4px 4px 0 rgba(61, 54, 39, 0.25);
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
  font-family: inherit;
}
.card:hover:not(:disabled) {
  transform: translate(-2px, -2px);
  box-shadow: 6px 6px 0 rgba(61, 54, 39, 0.25);
}
.card:active:not(:disabled) {
  transform: translate(1px, 1px);
  box-shadow: 2px 2px 0 rgba(61, 54, 39, 0.25);
}
.card:disabled {
  opacity: 0.6;
  cursor: wait;
}
.card:nth-child(1) {
  transform: rotate(-1deg);
}
.card:nth-child(2) {
  transform: rotate(0.8deg);
}
.card:nth-child(3) {
  transform: rotate(-0.6deg);
}
.card:nth-child(1):hover,
.card:nth-child(2):hover,
.card:nth-child(3):hover {
  transform: translate(-2px, -2px) rotate(0deg);
}
.card-title {
  font-size: 20px;
  font-weight: 700;
  color: #35301f;
}
.card-desc {
  font-size: 13px;
  color: #8a7f68;
}
.panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 18px;
  width: 480px;
  max-width: calc(100vw - 48px);
  background: #fbf6ea;
  border: 2px solid #3d3627;
  border-radius: 12px;
  box-shadow: 4px 4px 0 rgba(61, 54, 39, 0.25);
  padding: 30px 36px 26px;
}
.panel-head {
  text-align: center;
}
.panel > .panel-label {
  text-align: center;
}
.panel-title {
  margin: 0 0 6px;
  font-size: 22px;
  letter-spacing: 4px;
  color: #35301f;
}
.panel-label {
  margin: 0;
  color: #8a7f68;
  font-size: 14px;
}
.room-code-wrap {
  display: flex;
  justify-content: center;
  padding: 10px 0 14px;
  border-bottom: 2px dashed #d8cbab;
}
.room-code {
  font-size: 44px;
  font-weight: 700;
  letter-spacing: 14px;
  padding-left: 14px;
  color: #2f6fed;
  font-family: 'Courier New', monospace;
}
.room-code-box {
  position: relative;
}
.copy-link {
  position: absolute;
  left: calc(100% + 14px);
  bottom: 10px;
  white-space: nowrap;
  padding: 4px 12px;
  font-size: 13px;
}
/* 窄屏：复制按钮换到房间号下一行 */
@media (max-width: 520px) {
  .room-code-box {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .copy-link {
    position: static;
  }
}
.settings {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 16px;
  background: #fffdf6;
  border: 2px dashed #d8cbab;
  border-radius: 8px;
}
.waiting {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  margin: 2px 0 0;
  color: #8a7f68;
  font-size: 14px;
}
.pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #2f6fed;
  animation: pulse 1.4s infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1); }
}
.laser-opt {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: #5c5340;
  cursor: pointer;
}
.laser-opt input {
  accent-color: #2f6fed;
}
.size-input {
  width: 64px;
  padding: 4px 8px;
  font-size: 14px;
  font-family: inherit;
  text-align: center;
  background: #fffdf6;
  border: 2px solid #3d3627;
  border-radius: 8px;
  outline: none;
  color: #35301f;
}
.dots i {
  animation: blink 1.4s infinite;
  font-style: normal;
}
.dots i:nth-child(2) {
  animation-delay: 0.4s;
}
.dots i:nth-child(3) {
  animation-delay: 0.8s;
}
@keyframes blink {
  0%, 100% { opacity: 0.2; }
  50% { opacity: 1; }
}
.code-input {
  align-self: center;
  font-size: 30px;
  text-align: center;
  letter-spacing: 10px;
  padding: 8px 8px 8px 18px;
  width: 210px;
  text-transform: uppercase;
  background: #fffdf6;
  border: 2px solid #3d3627;
  border-radius: 10px;
  outline: none;
  font-family: 'Courier New', monospace;
  color: #35301f;
}
.code-input:focus {
  border-color: #2f6fed;
}
.row {
  display: flex;
  gap: 12px;
  justify-content: center;
}
.cancel-btn {
  align-self: center;
  min-width: 120px;
}
.error {
  margin-top: 22px;
  color: #e84a3c;
  font-size: 14px;
}
</style>
