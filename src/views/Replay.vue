<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import ReplayBoard from '../components/ReplayBoard.vue'
import { simulate, type Color } from '../game'
import { describeMove, other, replayFrames, type ReplayDocument, type ReplaySummary } from '../replay/model'
import { appBase } from '../replay/navigation'

const props = defineProps<{ gameId: string | null }>()
const base = appBase()
const games = ref<ReplaySummary[]>([])
const game = shallowRef<ReplayDocument | null>(null)
const step = ref(0), error = ref(''), loading = ref(true), refreshing = ref(false)
const visibleBeams = ref<Color[]>(['blue', 'red'])
let generation = 0, timer: ReturnType<typeof setInterval> | undefined
let sourceUrl: string | null = null
const frames = computed(() => game.value ? replayFrames(game.value) : [])
const frame = computed(() => frames.value[step.value])
const name = (color: Color) => color === 'blue' ? '蓝方' : '红方'
const status = computed(() => {
  const f = frame.value
  if (!f) return ''
  if (f.winner) return `${name(f.winner)}获胜 · ${game.value?.players[f.winner]}`
  if (simulate(f.board, other(f.current)).hits.includes(f.current)) return `${name(f.current)}面临攻击，需要防守`
  return `轮到${name(f.current)} · ${game.value?.players[f.current]}`
})
async function json(url: string) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}
async function load(reset: boolean) {
  const token = generation, id = props.gameId
  if (reset) { loading.value = true; error.value = ''; game.value = null; step.value = 0; sourceUrl = null }
  if (refreshing.value && !reset) return
  refreshing.value = true
  try {
    if (id) {
      // Local live matches and published static records use exactly the same format and page.
      const published = `${base}replays/${id}.json`, local = `${base}__arena/replays/${id}`
      let url = sourceUrl ?? published, data: ReplayDocument
      try { data = await json(url) }
      catch { url = url === published ? local : published; data = await json(url) }
      if (token !== generation) return
      replayFrames(data) // Reject corrupt/incomplete records before replacing a visible board.
      if (data.id !== id) throw new Error('回放编号不匹配')
      sourceUrl = url
      game.value = data
      step.value = Math.min(step.value, data.moves.length)
      error.value = ''
    } else {
      const sources = await Promise.allSettled([json(`${base}replays/index.json`), json(`${base}__arena/replays`)])
      if (token !== generation) return
      const entries = new Map<string, ReplaySummary>()
      for (const result of sources) if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        for (const item of result.value) entries.set(item.id, item)
      }
      games.value = [...entries.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    }
  } catch (e) {
    if (token === generation) error.value = `读取回放失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    if (token === generation) { refreshing.value = false; loading.value = false }
  }
}
watch(() => props.gameId, () => { generation++; void load(true) }, { immediate: true })
function go(value: number) { step.value = Math.max(0, Math.min(game.value?.moves.length ?? 0, value)) }
function keyboard(event: KeyboardEvent) {
  if (!game.value || event.altKey || event.metaKey || event.ctrlKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
  const target = { ArrowLeft: step.value - 1, ArrowRight: step.value + 1, Home: 0, End: game.value.moves.length }[event.key]
  if (target !== undefined) { event.preventDefault(); go(target) }
}
function download() {
  if (!game.value) return
  const url = URL.createObjectURL(new Blob([JSON.stringify(game.value, null, 2)], { type: 'application/json' }))
  const anchor = document.createElement('a')
  anchor.href = url; anchor.download = `light-chess-replay-${game.value.id}.json`; anchor.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
onMounted(() => {
  addEventListener('keydown', keyboard)
  timer = setInterval(() => { if (!refreshing.value && (game.value && !game.value.winner || !props.gameId)) void load(false) }, 5000)
})
onUnmounted(() => { generation++; clearInterval(timer); removeEventListener('keydown', keyboard) })
</script>

<template>
  <main class="replays">
    <header>
      <div><p class="eyebrow">光镜棋 · 对局档案</p><h1>{{ game?.title ?? '对局回放' }}</h1></div>
      <nav>
        <a v-if="gameId" class="btn-plain" :href="`${base}replays`">全部回放</a>
        <a class="btn-plain" :href="base">回到大厅</a>
      </nav>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }} <button class="btn-plain" @click="load(!game)">重试</button></p>
    <p v-if="loading" role="status">正在读取对局…</p>
    <template v-else-if="game && frame">
      <div class="replay-layout" :data-replay-step="step">
        <section class="board-column">
          <div class="board-caption">
            <span>{{ game.initial.size }} × {{ game.initial.size }} · {{ game.initial.boundaryReflects ? '边界反射' : '边界透射' }} · 无棋钟</span>
            <span>{{ game.winner ? `已完赛 · 共 ${game.moves.length} 手` : `对局进行中 · 已记录 ${game.moves.length} 手` }}</span>
          </div>
          <ReplayBoard :frame="frame" :visible-beams="visibleBeams" />
          <div class="transport paper">
            <div class="transport-row">
              <button class="btn-plain" :disabled="step === 0" @click="go(0)">开局</button>
              <button class="btn-plain" :disabled="step === 0" @click="go(step - 1)">上一步</button>
              <output aria-live="polite">{{ step === 0 ? '初始局面' : `第 ${step} 手` }} / {{ game.moves.length }}</output>
              <button class="btn-primary" :disabled="step === game.moves.length" @click="go(step + 1)">下一步</button>
              <button class="btn-plain" :disabled="step === game.moves.length" @click="go(game.moves.length)">{{ game.winner ? '终局' : '最新' }}</button>
            </div>
            <input v-model.number="step" aria-label="回放进度" type="range" min="0" :max="game.moves.length" step="1" />
            <div class="beam-options">
              <label><input v-model="visibleBeams" type="checkbox" value="blue" /> 蓝方光路</label>
              <label><input v-model="visibleBeams" type="checkbox" value="red" /> 红方光路</label>
              <span>← → 逐步回放 · 金色标记本手</span>
            </div>
          </div>
        </section>
        <aside class="paper details">
          <div class="players"><span class="blue">蓝 · {{ game.players.blue }}</span><span class="red">红 · {{ game.players.red }}</span></div>
          <p class="position-status" role="status">{{ status }}</p>
          <section class="move-detail">
            <h2>{{ frame.move ? `第 ${step} 手 · ${name(frame.move.color)}` : '初始局面' }}</h2>
            <template v-if="frame.move">
              <p class="move-coordinate">{{ describeMove(frame.move.action) }}</p>
              <p class="rationale-label">落子方当时的说明</p>
              <p class="rationale">{{ frame.move.rationale || '此手没有附加说明。' }}</p>
              <p v-if="frame.move.thinkingMs !== undefined" class="muted">思考 {{ (frame.move.thinkingMs / 1000).toFixed(1) }} 秒<span v-if="frame.move.search"> · 深度 {{ frame.move.search.depth }} · {{ frame.move.search.nodes.toLocaleString() }} 节点</span></p>
            </template>
            <p v-else class="rationale">双方基地已布置。点击「下一步」从蓝方第一手开始。坐标从 0 开始；光路随当前回放局面重新计算。</p>
          </section>
          <h2>落子记录</h2>
          <ol class="move-list" aria-label="落子记录">
            <li v-for="(move, index) in game.moves" :key="index">
              <button :class="[{ selected: step === index + 1 }, move.color]" :aria-current="step === index + 1 ? 'step' : undefined" @click="go(index + 1)">
                <span class="move-number">{{ index + 1 }}.</span> {{ name(move.color) }} · {{ describeMove(move.action) }}
              </button>
            </li>
          </ol>
          <button class="btn-plain" @click="download">下载回放 JSON</button>
          <details v-if="game.provenance" class="provenance"><summary>对局版本</summary><p>{{ game.provenance.source }}</p><p>WASM SHA-256<br /><code>{{ game.provenance.engineSha256 }}</code></p></details>
        </aside>
      </div>
    </template>
    <section v-else-if="!gameId && !loading" class="game-list" aria-label="对局列表">
      <p v-if="!games.length">还没有回放。完成 AI 对局后可将记录加入这里。</p>
      <a v-for="item in games" :key="item.id" class="paper game-card" :href="`${base}replay/${item.id}`">
        <h2>{{ item.title }}</h2>
        <p>{{ new Date(item.createdAt).toLocaleDateString('zh-CN') }} · {{ item.plies }} 手</p>
        <p>{{ item.winner ? `${name(item.winner)}获胜` : '对局进行中' }} <span>从开局观看 →</span></p>
      </a>
    </section>
  </main>
</template>

<style scoped>
.replays { width: min(1380px, 100%); margin: 12px auto 24px; }
header, nav, .board-caption, .transport-row, .beam-options { display: flex; align-items: center; gap: 12px; }
header { justify-content: space-between; margin-bottom: 22px; }
h1 { margin: 4px 0 0; font-size: 28px; }
h2 { font-size: 16px; margin: 0 0 9px; }
p { margin: 0; }
a { color: inherit; text-decoration: none; }
.eyebrow, .muted, .board-caption, .beam-options, .provenance { font-size: 12px; color: #8a7f68; }
.replay-layout { display: grid; grid-template-columns: minmax(0, min(900px, max(360px, calc(100dvh - 300px)))) 330px; align-items: start; justify-content: center; gap: 24px; }
.board-column { min-width: 0; max-width: 900px; }
.board-caption { justify-content: space-between; margin: 0 0 10px; flex-wrap: wrap; }
.transport { padding: 15px; margin-top: 16px; border-radius: 12px; }
.transport-row { justify-content: center; flex-wrap: wrap; gap: 8px; }
.transport-row button { padding: 7px 12px; }
output { min-width: 112px; text-align: center; font-size: 14px; }
input[type=range] { width: 100%; margin: 17px 0 12px; accent-color: #2f6fed; }
.beam-options { flex-wrap: wrap; justify-content: center; }
.beam-options label { cursor: pointer; }
.details { padding: 22px; border-radius: 14px; display: flex; flex-direction: column; gap: 18px; min-width: 0; }
.players { display: flex; flex-direction: column; gap: 8px; font-size: 14px; }
.blue { color: #2f6fed; }.red { color: #e94b3c; }
.position-status { padding: 10px 0; border-block: 1px solid #daceb3; font-size: 14px; }
.move-coordinate { margin: 0 0 10px; font-family: ui-monospace, monospace; font-size: 13px; }
.rationale { font-size: 14px; line-height: 1.8; white-space: pre-wrap; overflow-wrap: anywhere; }
.rationale-label { color: #8a7f68; font-size: 12px; margin-bottom: 6px; }
.muted { margin-top: 12px; line-height: 1.6; }
.move-list { list-style: none; padding: 0; margin: -8px 0 0; max-height: 240px; overflow-y: auto; }
.move-list button { padding: 8px; width: 100%; text-align: left; border: 1px solid transparent; background: transparent; border-radius: 6px; font: inherit; font-size: 13px; cursor: pointer; }
.move-list button:hover { background: #e9dfc7; }.move-list .selected { background: #f2e4bd; border-color: #cead5f; }
.move-number { display: inline-block; min-width: 22px; color: #8a7f68; }
.provenance { line-height: 1.6; overflow-wrap: anywhere; }.provenance p { margin-top: 8px; }.provenance summary { cursor: pointer; }
.error { color: #b5372d; padding: 12px 0; }
.game-list { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 420px)); gap: 20px; }
.game-card { padding: 24px; border-radius: 12px; }.game-card p { margin-top: 12px; }.game-card span { float: right; color: #8a7f68; }
@media (max-width: 850px) { .replay-layout { grid-template-columns: 1fr; } header { flex-wrap: wrap; } .details { max-width: 100%; } }
@media (max-width: 480px) { h1 { font-size: 24px; } nav .btn-plain { padding: 7px 12px; } .transport { padding: 12px 8px; } .transport-row { gap: 6px; } .transport-row button { padding: 6px 8px; } output { order: -1; width: 100%; } }
</style>
