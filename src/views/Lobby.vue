<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { MAX_PLAYERS, MIN_PLAYERS, PALETTE, seatColors, type Color } from '../game'
import { announceRoom, watchRooms, type PublicRoom } from '../directory'
import { isValidCode, netClose, netCreate, netJoin, signaling, type Signaling } from '../net'
import { SIZE_MAX, SIZE_MIN, startLocal, state, type NnSeatConfig } from '../store'
import { loadNnModels, nnModelsForSize, type NnModelInfo } from '../nn/models'
import DshSettings from '../components/DshSettings.vue'
import DshProfileSelect from '../components/DshProfileSelect.vue'
import { defaultDshProfileId, readDshConfig } from '../ai/config'
import type { AiProfileIds, AiProvider, AiProviders } from '../ai/providers'
import ClockSettings from '../components/ClockSettings.vue'
import { appBase } from '../replay/navigation'
import { defaultOpeningSettings, maxOpeningMirrors, normalizeOpeningSettings, type OpeningPosition } from '../opening'
import { prepareOpening, openingProgressLabel } from '../prepare-opening'

const view = ref<'menu' | 'configure' | 'created' | 'join'>('menu')
const preparing = ref<'local' | 'online'>('local')
const code = ref('')
const joinCode = ref('')
const error = ref('')
const busy = ref(false)
const copied = ref(false)
/** 玩家人数（单机与创建房间共用） */
const count = ref(MIN_PLAYERS)
const openingSettings = ref(defaultOpeningSettings())
const openingLimit = computed(() => maxOpeningMirrors(state.size, count.value))
watch([() => state.size, count], () => {
  openingSettings.value = normalizeOpeningSettings(openingSettings.value, state.size, count.value)
})
const openingProgress = ref('')
let openingAbort: AbortController | undefined
let generatedOpening: OpeningPosition | undefined
async function generateConfiguredOpening() {
  openingAbort?.abort()
  openingAbort = new AbortController()
  openingProgress.value = openingSettings.value.enabled ? '正在生成并校验预设局面…' : ''
  try {
    return await prepareOpening(openingSettings.value, state.size, seatColors(count.value), state.boundaryReflects,
      openingAbort.signal, status => { openingProgress.value = openingProgressLabel(status) })
  } finally { openingProgress.value = '' }
}
const aiSeats = ref<Color[]>([])
const aiProviders = ref<AiProviders>({})
const aiProfileIds = ref<AiProfileIds>({})
const configuredSeats = computed(() => PALETTE.slice(0, count.value))
const selectedAi = computed(() => configuredSeats.value.map(p => p.id).filter(c =>
  aiSeats.value.includes(c)))
const hasDsh = computed(() => selectedAi.value.some(c => aiProviders.value[c] === 'dsh'))
const hasNnSeat = computed(() => selectedAi.value.some(c => aiProviders.value[c] === 'nn'))
const hasWasm = computed(() => selectedAi.value.some(c => (aiProviders.value[c] ?? 'wasm') === 'wasm'))
const hasAi = computed(() => selectedAi.value.length > 0)
watch(hasAi, value => { if (value) state.boundaryReflects = true })

// ---------- AI 座位引擎（内置 WASM 引擎 / DSH / 本地 NN 模型） ----------
/** 本地 NN 模型目录（public/models/models.json） */
const nnModels = ref<NnModelInfo[]>([])
onMounted(() => { loadNnModels().then(l => (nnModels.value = l)).catch(() => { /* 目录不可用时只提供内置引擎 */ }) })
/** 当前棋盘尺寸可用的 NN 模型 */
const sizeModels = computed(() => nnModelsForSize(nnModels.value, state.size))
/** 默认 NN 模型：推荐款优先，其次目录首个 */
const defaultNnModel = computed(() => sizeModels.value.find(m => m.recommended) ?? sizeModels.value[0])
/** NN 座位的模型选择（models.json 里的模型 id） */
const seatEngine = reactive<Record<string, string>>({})
/** NN 座位的「随机」开关：开启后按温度 0.5 采样，否则 argmax */
const seatStochastic = reactive<Record<string, boolean>>({})
/** NN 座位的计算量模式：'time'（默认，共用全局思考上限）或 'sims'（固定模拟数） */
const seatLimitMode = reactive<Record<string, 'time' | 'sims'>>({})
/** NN 座位 sims 定额档（默认 150 = 训练/评测标准） */
const seatSims = reactive<Record<string, number>>({})
const limitModeOf = (c: string) => seatLimitMode[c] ?? 'time'
const simsOf = (c: string) => seatSims[c] ?? 150
const nnModelOf = (c: string) => sizeModels.value.find(m => m.id === seatEngine[c]) ?? defaultNnModel.value
const aiNnConfigs = computed(() => {
  const out: Partial<Record<Color, NnSeatConfig>> = {}
  for (const c of selectedAi.value) {
    if (aiProviders.value[c] !== 'nn') continue
    const model = nnModelOf(c)
    if (!model) continue
    out[c] = {
      modelId: model.id, ...(seatStochastic[c] ? { stochastic: true } : {}),
      ...(limitModeOf(c) === 'sims' ? { limit: { type: 'sims' as const, sims: simsOf(c) } } : {}),
    }
  }
  return out
})
/** NN 模型只支持边界反射棋盘（与 WASM 引擎一致；有 AI 座位时边界反射会被强制开启） */
const nnBlocked = computed(() => hasNnSeat.value && !state.boundaryReflects)
function changeSeat(color: Color, event: Event) {
  const value = (event.target as HTMLSelectElement).value
  const ai = value !== 'human'
  if (ai) aiProviders.value[color] = value as AiProvider
  if (value === 'dsh' && !aiProfileIds.value[color]) aiProfileIds.value[color] = defaultDshProfileId()
  if (value === 'nn' && !seatEngine[color] && defaultNnModel.value) seatEngine[color] = defaultNnModel.value.id
  aiSeats.value = ai ? [...aiSeats.value.filter(c => c !== color), color] : aiSeats.value.filter(c => c !== color)
}
/** 联机方式（3=中继，1/2=旧 P2P 协议） */
const sig = ref<Signaling>('relay')
/** 公开房间：创建后广播到大厅，其他玩家在加入页可直接看到并点击进入 */
const pub = ref(true)
/** 加入页实时看到的公开房间列表 */
const publicRooms = ref<PublicRoom[]>([])
/** 未坐满的公开房间 */
const openRooms = computed(() => publicRooms.value.filter((r) => r.joined < r.players))
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

function checkProfiles() {
  for (const color of selectedAi.value) if (aiProviders.value[color] === 'dsh') {
    readDshConfig(aiProfileIds.value[color])
    aiProfileIds.value[color] ||= defaultDshProfileId()
  }
}
async function local() {
  busy.value = true
  error.value = ''
  try {
    checkProfiles()
    const opening = await generateConfiguredOpening()
    startLocal(count.value, selectedAi.value, aiProviders.value, aiProfileIds.value, opening, aiNnConfigs.value)
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}

function prepare(mode: 'local' | 'online') {
  preparing.value = mode
  generatedOpening = undefined
  error.value = ''
  view.value = 'configure'
}

// ---------- 公开房间：广播与监听的生命周期 ----------

let stopAnnounce: (() => void) | null = null
let stopWatch: (() => void) | null = null

/** 按当前 pub/房号（重）开始广播；未勾选公开则确保停止 */
async function syncAnnounce() {
  stopAnnounce?.()
  stopAnnounce = null
  if (view.value === 'created' && pub.value && code.value) {
    stopAnnounce = await announceRoom(() => ({
      code: code.value,
      players: count.value,
      joined: state.roomJoined,
    }))
  }
}

function stopAnnouncing() {
  stopAnnounce?.()
  stopAnnounce = null
}

function stopWatching() {
  stopWatch?.()
  stopWatch = null
  publicRooms.value = []
}

// 进入加入页开始监听大厅，离开即停；离开创建页停止广播（开局后组件卸载由 onUnmounted 兜底）
watch(view, async (v) => {
  if (v === 'join') {
    if (!stopWatch) stopWatch = await watchRooms((rooms) => (publicRooms.value = rooms))
  } else {
    stopWatching()
  }
  if (v !== 'created') stopAnnouncing()
})

onUnmounted(() => {
  openingAbort?.abort()
  stopAnnouncing()
  stopWatching()
})

/** 点击公开房间列表项：直接入座 */
function joinPublic(r: PublicRoom) {
  if (busy.value) return
  joinCode.value = r.code
  void join()
}

async function create() {
  busy.value = true
  error.value = ''
  try {
    checkProfiles()
    generatedOpening = await generateConfiguredOpening()
    code.value = await netCreate(count.value, sig.value, selectedAi.value, aiProviders.value, aiProfileIds.value, generatedOpening, aiNnConfigs.value)
    if (state.phase !== 'lobby') return
    view.value = 'created'
    void syncAnnounce()
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
    checkProfiles()
    code.value = await netCreate(count.value, sig.value, selectedAi.value, aiProviders.value, aiProfileIds.value, generatedOpening, aiNnConfigs.value)
    void syncAnnounce()
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
  openingAbort?.abort()
  netClose()
  stopAnnouncing()
  stopWatching()
  view.value = 'menu'
  error.value = ''
  clearJoinParam()
}

// 通过加入链接打开：?join=XXXX → 直接进入加入流程
onMounted(() => {
  const param = new URLSearchParams(location.search).get('join')
  if (!param) return
  const c = param.trim()
  if (!isValidCode(c)) return
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
      <div class="cards">
        <button class="card" @click="prepare('local')">
          <span class="card-title">单机对战</span>
          <span class="card-desc">自由搭配人类与 AI 座位</span>
        </button>
        <button class="card" :disabled="busy" @click="prepare('online')">
          <span class="card-title">创建房间</span>
          <span class="card-desc">邀请朋友，在线对决</span>
        </button>
        <button class="card" :disabled="busy" @click="view = 'join'">
          <span class="card-title">加入房间</span>
          <span class="card-desc">输入房间号入座</span>
        </button>
      </div>
      <a class="btn-plain replay-entry" :href="`${appBase()}replays`">对局回放 · DSH vs 规则 AI</a>
      <DshSettings />
    </div>

    <div v-else-if="view === 'configure'" class="panel">
      <div class="panel-head">
        <h2 class="panel-title">{{ preparing === 'local' ? '单机对战' : '创建房间' }}</h2>
        <p class="panel-label">准备好，就开始吧</p>
      </div>
      <fieldset class="prepare-settings" :disabled="busy">
        <div class="count-ctl">
          人数
          <button
            v-for="n in countOptions"
            :key="n"
            class="count-btn"
            :class="{ active: count === n }"
            :aria-pressed="count === n"
            :aria-label="`${n} 人`"
            @click="count = n"
          >
            {{ n }}
          </button>
        </div>
        <div class="seat-settings" aria-label="玩家座位">
          <div v-for="p in configuredSeats" :key="p.id" class="seat-card"><label class="seat-row">
            <span :style="{ color: p.hex }">{{ p.name }}方{{ preparing === 'online' && p.id === 'blue' ? '（房主）' : '' }}</span>
            <span class="seat-ctls">
              <select class="sig-select" :aria-label="`${p.name}方控制方式`" :value="selectedAi.includes(p.id) ? (aiProviders[p.id] ?? 'wasm') : 'human'"
                @change="changeSeat(p.id, $event)">
                <option value="human">{{ preparing === 'online' ? '真人玩家' : '人类' }}</option>
                <option value="wasm">AI · Rust / WASM</option>
                <option value="dsh">AI · DSH</option>
                <option value="nn">AI · 神经网络（本机）</option>
              </select>
              <template v-if="selectedAi.includes(p.id) && aiProviders[p.id] === 'nn'">
                <select v-model="seatEngine[p.id]" class="sig-select" :aria-label="`${p.name}方 NN 模型`">
                  <option v-for="m in sizeModels" :key="m.id" :value="m.id" :title="m.eloNote">
                    {{ m.name }} · Elo {{ m.elo }}{{ m.eloNote ? '†' : '' }}{{ m.recommended ? ' · 推荐' : '' }}
                  </option>
                </select>
                <select
                  class="sig-select" :aria-label="`${p.name}方 NN 计算量`"
                  :value="limitModeOf(p.id)"
                  @change="seatLimitMode[p.id] = ($event.target as HTMLSelectElement).value as 'time' | 'sims'"
                >
                  <option value="time">按时间</option>
                  <option value="sims">按模拟数</option>
                </select>
                <select
                  v-if="limitModeOf(p.id) === 'sims'" class="sig-select" :aria-label="`${p.name}方 MCTS 模拟数`"
                  :value="simsOf(p.id)"
                  @change="seatSims[p.id] = Number(($event.target as HTMLSelectElement).value)"
                >
                  <option :value="50">50 sims（快速）</option>
                  <option :value="150">150 sims（训练/评测标准）</option>
                  <option :value="400">400 sims（棋力优先）</option>
                </select>
                <label class="laser-opt seat-stochastic">
                  <input type="checkbox" v-model="seatStochastic[p.id]" />
                  随机
                </label>
              </template>
            </span>
          </label>
          <DshProfileSelect v-if="selectedAi.includes(p.id) && aiProviders[p.id] === 'dsh'" v-model="aiProfileIds[p.id]" :label="`${p.name}方 LLM 配置`" />
          </div>
        </div>
        <label v-if="hasWasm || hasNnSeat" class="laser-opt">
          AI 每步最多思考（WASM 与「按时间」NN 座位共用）
          <select v-model.number="state.aiBudgetMs" class="sig-select" aria-label="AI 每步思考上限">
            <option :value="3000">3 秒</option>
            <option :value="10000">10 秒</option>
            <option :value="30000">30 秒（棋力优先）</option>
          </select>
        </label>
        <DshSettings v-if="hasDsh" />
        <p v-if="hasDsh" class="ai-hint">DSH 不使用 WASM 的思考上限；启用棋钟时仍受棋局时间限制。</p>
        <p v-if="!sizeModels.length && nnModels.length" class="ai-hint">
          NN 模型只支持 {{ [...new Set(nnModels.map((m) => m.boardSize))].join('、') }}× 棋盘：把下方棋盘尺寸改为
          <button class="btn-plain size-chip" v-for="s in [...new Set(nnModels.map((m) => m.boardSize))]" :key="s" @click="state.size = s">{{ s }}×{{ s }}</button>
          即可为 AI 座位选择神经网络模型。
        </p>
        <p v-if="nnBlocked" class="error" style="margin: 0">NN 模型需要开启边界反射（与内置引擎一致）。</p>
        <p v-if="hasAi" class="ai-hint">AI 可提前落子，自动布置基地，需要边界反射。联机 AI 由房主运行，不占真人连接；NN 模型在本机浏览器内推理，无需联网。</p>
        <p v-if="preparing === 'online' && selectedAi.includes('blue')" class="ai-hint">蓝方由 AI 执棋，你仍是房主，可以管理房间和 AI。请保持房主页面在线。</p>
        <label class="laser-opt">棋盘
          <input class="size-input" type="number" :min="SIZE_MIN" :max="SIZE_MAX" :value="state.size" @change="clampSize" />
          × {{ state.size }} 格
        </label>
        <div class="opening-settings">
          <label class="laser-opt">
            <input type="checkbox" v-model="openingSettings.enabled" />
            生成预设基地与镜子
          </label>
          <template v-if="openingSettings.enabled">
            <label class="opening-count" for="opening-count">每方额外镜子 <strong>{{ openingSettings.mirrorsPerPlayer }} 面</strong></label>
            <input id="opening-count" class="opening-slider" type="range" min="1" :max="openingLimit" step="1"
              v-model.number="openingSettings.mirrorsPerPlayer" aria-label="每方预设镜子数" />
            <div class="opening-range"><span>1 面</span><span>{{ openingLimit }} 面</span></div>
            <p class="ai-hint">不含基地自带的 3 面镜子，各方数量相同。基地与镜子随机生成，校验禁围、所有光路及首手攻防，排除一手无解的开局，蓝方先手。</p>
          </template>
        </div>
        <ClockSettings :settings="state.clockSettings" @change="state.clockSettings = $event" />
        <label class="laser-opt">
          <input type="checkbox" v-model="state.boundaryReflects" :disabled="hasAi" />
          边界反射
        </label>
        <label v-if="preparing === 'online'" class="laser-opt pub-opt">
          <input type="checkbox" v-model="pub" />
          公开房间（允许其他玩家发现并加入）
        </label>
      </fieldset>
      <p v-if="openingProgress" class="ai-hint" role="status">{{ openingProgress }}</p>
      <div class="row">
        <button class="btn-primary" :disabled="busy || nnBlocked" @click="preparing === 'local' ? local() : create()">
          {{ openingProgress ? '正在生成局面…' : busy ? '正在准备…' : preparing === 'local' ? '开始对局' : '创建并等待' }}
        </button>
        <button class="btn-plain" :disabled="busy" @click="cancel">返回</button>
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
        <p v-if="state.openingSettings.enabled" class="ai-hint">预设局面已准备 · 每方 {{ state.openingSettings.mirrorsPerPlayer }} 面额外镜子；所有玩家将使用同一盘局面。</p>
        <ClockSettings :settings="state.clockSettings" @change="state.clockSettings = $event" />
        <label class="laser-opt">
          <input type="checkbox" v-model="state.boundaryReflects" :disabled="hasAi || state.openingSettings.enabled" />
          边界反射（所有光线碰到边界都会反射）
        </label>
        <label class="laser-opt">
          <input type="checkbox" v-model="pub" @change="syncAnnounce" />
          公开房间（其他玩家可在加入页直接看到并加入）
        </label>
        <label class="laser-opt">
          <input type="checkbox" v-model="state.laserAllowed" />
          允许显示光路（悬停棋子时查看）
        </label>
        <label class="laser-opt">
          <input type="checkbox" v-model="state.allowUndo" />
          允许撤回一步（开启后所有玩家都可撤回）
        </label>
        <label class="laser-opt">
          棋盘
          <input
            class="size-input"
            type="number"
            :min="SIZE_MIN"
            :max="SIZE_MAX"
            :value="state.size"
            :disabled="state.openingSettings.enabled"
            @change="clampSize"
          />
          × {{ state.size }} 格
        </label>
        <label class="laser-opt">
          连接方式
          <select class="sig-select" :value="sig" :disabled="busy" @change="onSigChange">
            <option value="relay">中继连接（推荐）</option>
            <option value="nostr">Nostr 直连</option>
            <option value="mqtt">MQTT 直连</option>
          </select>
          <span class="sig-hint">使用代理时请选择中继连接；切换后需重新分享链接</span>
        </label>
      </div>

      <p class="waiting">
        <span class="pulse"></span>
        等待真人加入 · 已就位 {{ state.roomJoined }}/{{ count }}（AI {{ selectedAi.length }}）<span class="dots"><i>.</i><i>.</i><i>.</i></span>
      </p>
      <p class="relay-status" :class="{ warn: signaling.total > 0 && signaling.up === 0 }">
        <template v-if="signaling.up > 0">中继已连接 {{ signaling.up }} 个</template>
        <template v-else-if="signaling.total > 0">正在连接中继（{{ signaling.up }}/{{ signaling.total }}）…若一直为 0，请检查代理或更换网络</template>
        <template v-else>中继连接中…</template>
      </p>

      <button class="btn-plain cancel-btn" @click="cancel">取消</button>
    </div>

    <div v-else class="panel">
      <p class="panel-label">
        {{ busy ? `正在加入房间 ${joinCode}…` : '输入 4 位房间号' }}
      </p>
      <input
        v-model="joinCode"
        class="code-input"
        maxlength="4"
        inputmode="numeric"
        placeholder="如 3839"
        @keyup.enter="join"
      />
      <div class="row">
        <button class="btn-primary" :disabled="busy || joinCode.trim().length !== 4" @click="join">
          加入
        </button>
        <button class="btn-plain" @click="cancel">返回</button>
      </div>
      <div class="public-rooms">
        <p class="pub-title">公开房间</p>
        <button
          v-for="r in openRooms"
          :key="r.code"
          class="pub-item"
          :disabled="busy"
          @click="joinPublic(r)"
        >
          <span class="pub-code">{{ r.code }}</span>
          <span class="pub-meta">{{ r.players }} 人局 · 已就位 {{ r.joined }}/{{ r.players }}</span>
        </button>
        <p v-if="!openRooms.length" class="pub-empty">正在寻找公开房间…</p>
      </div>
      <p v-if="busy" class="relay-status" :class="{ warn: signaling.total > 0 && signaling.up === 0 }">
        <template v-if="signaling.up > 0">中继已连接 {{ signaling.up }} 个，正在联系房主…</template>
        <template v-else>中继连接中（{{ signaling.up }}/{{ signaling.total }}）…</template>
      </p>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="state.peerLeft" class="error">对方已离开房间</p>
  </div>
</template>

<style scoped>
.opening-settings { display: flex; flex-direction: column; gap: 10px; padding: 14px; background: #eee7d8; border: 1px solid #d2c5aa; border-radius: 9px; }
.opening-count, .opening-range { display: flex; justify-content: space-between; gap: 12px; }
.opening-count { font-size: 14px; }
.opening-count strong { color: #2f6fed; font-weight: 600; font-variant-numeric: tabular-nums; }
.opening-slider { width: 100%; margin: 0; accent-color: #2f6fed; cursor: pointer; }
.opening-range { font-size: 12px; color: #8a7f68; }
.seat-card { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.replay-entry { color: inherit; text-decoration: none; }
.seat-settings { display: flex; flex-direction: column; gap: 10px; }
.seat-row { display: flex; align-items: center; justify-content: space-between; gap: 18px; font-size: 14px; }
.seat-ctls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
.seat-stochastic { font-size: 13px; white-space: nowrap; }
.size-chip { padding: 1px 8px; font-size: 12px; }
.ai-hint { margin: 0; font-size: 12px; color: #8a7f68; line-height: 1.6; }

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
.prepare-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
  min-width: 0;
  padding: 10px 0;
  margin: 0;
  border: 0;
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
.model-section {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-section-title {
  margin: 0;
  font-size: 13px;
  color: #8a7f68;
}
.model-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.model-group-title {
  margin: 0;
  font-size: 12px;
  letter-spacing: 2px;
  color: #b0a488;
  border-bottom: 1px dashed #d8cbab;
  padding-bottom: 3px;
}
.model-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
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
.public-rooms {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  background: #fffdf6;
  border: 2px dashed #d8cbab;
  border-radius: 8px;
}
.pub-title {
  margin: 0;
  font-size: 12px;
  letter-spacing: 2px;
  color: #b0a488;
}
.pub-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 12px;
  font-family: inherit;
  background: #fbf6ea;
  border: 2px solid #3d3627;
  border-radius: 10px 3px 12px 3px / 3px 12px 3px 10px;
  box-shadow: 2px 2px 0 rgba(61, 54, 39, 0.2);
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
}
.pub-item:hover:not(:disabled) {
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 rgba(61, 54, 39, 0.25);
}
.pub-item:disabled {
  opacity: 0.6;
  cursor: wait;
}
.pub-code {
  font-size: 20px;
  font-weight: 700;
  letter-spacing: 6px;
  color: #2f6fed;
  font-family: 'Courier New', monospace;
}
.pub-meta {
  font-size: 12px;
  color: #8a7f68;
}
.pub-empty {
  margin: 0;
  font-size: 13px;
  color: #b0a488;
  text-align: center;
}
.error {
  margin-top: 22px;
  color: #e84a3c;
  font-size: 14px;
}
</style>
