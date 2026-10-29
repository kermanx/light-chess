<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { TrajectoryView } from '@deepseek-ai/trajectory-ui'
import '@deepseek-ai/trajectory-ui/style.css'
import { loadTrajectoryRuns, trajectoryRuns } from '../ai/trajectory'
import { dshActivityLabel } from '../ai/dsh-activity'

const props = defineProps<{ gameId: string; open: boolean }>()
const emit = defineEmits<{ 'update:open': [value: boolean] }>()
const selectedId = ref<string | null>(null)
const loadError = ref('')
const toggle = ref<HTMLButtonElement>()
const close = ref<HTMLButtonElement>()
const now = ref(Date.now())
const selectedRecordId = ref<string | null>(null)
const selectedRequestId = ref<string | null>(null)
let ticker: ReturnType<typeof setInterval> | undefined
const runs = computed(() => trajectoryRuns.value.filter(r => r.gameId === props.gameId))
const selected = computed(() => runs.value.find(r => r.id === selectedId.value) ?? runs.value.at(-1))
const elapsed = computed(() => Math.max(0, Math.floor((now.value - (selected.value?.startedAt ?? now.value)) / 1000)))
const silent = computed(() => Math.max(0, Math.floor((now.value - (selected.value?.activity.lastReceivedAt ?? now.value)) / 1000)))
watch(() => selected.value?.id, () => { selectedRecordId.value = null; selectedRequestId.value = null })
const statusNames = { running: '运行中', complete: '已落子', cancelled: '已取消', error: '失败', interrupted: '上次运行已中断' }
const colors: Record<string, string> = { blue: '蓝方', red: '红方', green: '绿方', yellow: '黄方' }
watch(() => props.gameId, async id => {
  selectedId.value = null; loadError.value = ''
  try { await loadTrajectoryRuns(id) } catch (error) { loadError.value = `无法读取历史轨迹：${String(error)}` }
}, { immediate: true })
function changeRun(event: Event) {
  const id = (event.target as HTMLSelectElement).value
  selectedId.value = id === runs.value.at(-1)?.id ? null : id
}
async function collapse() { emit('update:open', false); await nextTick(); toggle.value?.focus() }
async function expand() { emit('update:open', true); await nextTick(); close.value?.focus() }
function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape' && props.open) { event.preventDefault(); collapse() }
}
onMounted(() => {
  addEventListener('keydown', onKey)
  ticker = setInterval(() => { if (props.open && selected.value?.status === 'running') now.value = Date.now() }, 1000)
})
onBeforeUnmount(() => { removeEventListener('keydown', onKey); clearInterval(ticker) })
function showLatestOutput() {
  selectedRequestId.value = null
  selectedRecordId.value = [...(selected.value?.document.records ?? [])].reverse().find(r => r.kind === 'assistant')?.id ?? null
}
function download() {
  const run = selected.value
  if (!run) return
  const value = { ...run.document, chess: { gameId: run.gameId, searchId: run.id, revision: run.revision, color: run.color, phase: run.phase, status: run.status }, dsh: { payloads: run.payloads } }
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = `dsh-${run.id}.json`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>

<template>
  <button v-show="!open" ref="toggle" class="trajectory-toggle" aria-controls="dsh-trajectory-panel" :aria-expanded="open"
    @click="expand">
    <span v-if="runs.some(r => r.status === 'running')" class="live-dot" />DSH 轨迹 ‹
  </button>
  <aside v-show="open" id="dsh-trajectory-panel" class="dsh-trajectory-panel" aria-label="DSH 实时轨迹">
    <header class="trajectory-heading">
      <strong>DSH 轨迹</strong>
      <span v-if="selected" class="run-status" :data-status="selected.status">{{ statusNames[selected.status] }}</span>
      <button :disabled="!selected?.payloads.length" @click="download">导出</button>
      <button ref="close" aria-label="收起 DSH 轨迹" title="收起（Esc）" @click="collapse">收起 ›</button>
    </header>
    <div class="trajectory-run-picker">
      <select :value="selected?.id ?? ''" :disabled="!runs.length" aria-label="选择 DSH 决策轨迹" @change="changeRun">
        <option v-if="!runs.length" value="">等待 DSH 开始思考</option>
        <option v-for="(run, index) in runs" :key="run.id" :value="run.id">
          {{ index + 1 }} · {{ colors[run.color] }} · {{ run.phase === 'setup' ? '布置基地' : `局面 ${run.revision}` }} · {{ statusNames[run.status] }}
        </option>
      </select>
      <button :aria-pressed="selectedId === null" @click="selectedId = null">跟随最新</button>
    </div>
    <div v-if="selected?.status === 'running'" class="trajectory-activity" aria-label="DSH 当前活动">
      <div class="activity-summary">
        <strong>{{ dshActivityLabel(selected.activity) }}</strong>
        <span>本手 {{ Math.floor(elapsed / 60) }}:{{ String(elapsed % 60).padStart(2, '0') }}</span>
        <button v-if="selected.activity.tail" @click="showLatestOutput">查看当前输出</button>
      </div>
      <div class="activity-detail">
        <span v-if="selected.activity.characters">本次已接收 {{ selected.activity.characters.toLocaleString() }} 字符 · </span>
        {{ selected.activity.stage === 'preparing' ? '等待核心事件' : silent < 3 ? '正在接收活动' : `${silent} 秒未收到新事件` }}
        <span v-if="silent >= 20"> · 可等待或取消本次思考</span>
      </div>
      <p v-if="selected.activity.tail" class="activity-tail"><span>{{ selected.activity.tailKind }}末尾：</span>{{ selected.activity.tail }}</p>
    </div>
    <p v-if="loadError || selected?.storageError || selected?.error" class="trajectory-error" role="alert">{{ loadError || selected?.storageError || selected?.error }}</p>
    <TrajectoryView v-if="open && selected?.document.records.length" :key="selected.id" class="trajectory-content"
      v-model:selected-id="selectedRecordId" v-model:selected-request-id="selectedRequestId"
      :records="selected.document.records" :requests="selected.document.requests" locale="zh-CN" theme="light" />
    <div v-else class="trajectory-empty">
      <strong>{{ selected?.status === 'running' ? '正在启动 DSH…' : '等待 DSH 轨迹' }}</strong>
      <p>模型请求、流式输出与工具调用会在这里实时显示。</p>
    </div>
    <footer>轨迹自动保存在此浏览器 · 收起后仍持续记录</footer>
  </aside>
</template>

<style scoped>
.trajectory-toggle, .dsh-trajectory-panel { font-family: system-ui, -apple-system, 'PingFang SC', sans-serif; }
.trajectory-toggle { position: fixed; right: 0; top: 18px; z-index: 30; padding: 9px 12px; border: 1px solid #b8b9bd; border-radius: 7px 0 0 7px; color: #292d34; background: #fff; box-shadow: 0 2px 9px #0001; cursor: pointer; }
.live-dot { display: inline-block; width: 7px; height: 7px; margin-right: 7px; border-radius: 50%; background: #328453; }
.dsh-trajectory-panel { position: fixed; inset: 0 0 0 auto; z-index: 40; width: var(--trajectory-width, min(56vw, 880px)); min-width: 0; height: 100dvh; display: flex; flex-direction: column; background: #fff; color: #222830; border-left: 1px solid #d5d7da; box-shadow: -4px 0 16px #0000000c; font-size: 12px; }
.trajectory-heading { height: 44px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px; border-bottom: 1px solid #e6e7e9; }
.trajectory-heading strong { margin-right: auto; font-size: 13px; }
.dsh-trajectory-panel button { border: 1px solid #d4d7dc; border-radius: 5px; padding: 4px 8px; color: inherit; background: #fff; cursor: pointer; white-space: nowrap; font: inherit; }
.dsh-trajectory-panel button:disabled { opacity: .45; cursor: default; }
.dsh-trajectory-panel button:hover:enabled { background: #f1f3f6; }
.run-status { color: #727883; }
.run-status[data-status='running'] { color: #21774b; }
.run-status[data-status='error'] { color: #b33434; }
.trajectory-run-picker { display: flex; gap: 8px; flex: none; padding: 8px 12px; background: #fafbfc; border-bottom: 1px solid #e6e7e9; }
.trajectory-run-picker select { min-width: 0; flex: 1; border: 1px solid #d4d7dc; border-radius: 5px; padding: 5px; font: inherit; color: inherit; background: white; }
.trajectory-run-picker button[aria-pressed='true'] { color: #275db3; border-color: #b3c9eb; background: #f0f5ff; }
.trajectory-content { flex: 1; min-height: 0; }
.trajectory-activity { flex: none; padding: 8px 12px; border-bottom: 1px solid #dce8df; background: #f6faf7; }
.activity-summary { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.activity-summary strong { color: #21774b; font-weight: 500; margin-right: auto; }
.activity-detail { margin-top: 5px; color: #63746a; font-variant-numeric: tabular-nums; }
.activity-tail { margin: 6px 0 0; color: #4a5550; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 11px; }
.activity-tail span { color: #78857d; }
.trajectory-empty { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 30px; text-align: center; color: #737b88; }
.trajectory-empty strong { color: #3e4753; font-weight: 500; }
.trajectory-error { padding: 8px 12px; margin: 0; color: #a23333; background: #fff4f4; overflow-wrap: anywhere; }
footer { flex: none; padding: 6px 12px; border-top: 1px solid #e6e7e9; font-size: 11px; color: #747c86; }
@media (max-width: 980px) { .dsh-trajectory-panel { width: 100vw; } }
</style>
