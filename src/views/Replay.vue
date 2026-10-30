<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import ReplayBoard from '../components/ReplayBoard.vue'
import { PALETTE, simulate, type Color } from '../game'
import { formatTime } from '../clock'
import { archiveStatus, listRecordings, loadRecording, migrateSavedGames } from '../replay/archive'
import { playback, playerName as name, type AnyReplay, type GameSummary } from '../replay/recording'
import { appBase } from '../replay/navigation'

const props = defineProps<{ gameId: string | null }>()
const base = appBase()
const games = ref<GameSummary[]>([])
const game = shallowRef<AnyReplay | null>(null)
const step = ref(0), error = ref(''), loading = ref(true), refreshing = ref(false)
const visibleBeams = ref<Color[]>(PALETTE.map(p => p.id))
let generation = 0, timer: ReturnType<typeof setInterval> | undefined
let sourceUrl: string | null = null
const timeline = computed(() => game.value ? playback(game.value) : null)
const entries = computed(() => timeline.value?.entries ?? [])
const frame = computed(() => timeline.value?.frames[step.value])
const entry = computed(() => entries.value[step.value - 1])
const players = computed(() => timeline.value?.players ?? [])
const plies = computed(() => entries.value.filter(e => e.action).length)
const actor = (c: Color) => frame.value?.actors?.[c] ?? (game.value?.version === 1 ? game.value.players[c as 'blue' | 'red'] : '')
const colorHex = (c: Color) => PALETTE.find(p => p.id === c)?.hex
const canShowBeams = computed(() => game.value?.version !== 2 || game.value.mode !== 'online' || !!game.value.winner || timeline.value?.frames.at(-1)?.laserAllowed)
const status = computed(() => {
  const f = frame.value
  if (!f) return ''
  if (f.phase === 'setup') return '正在布置基地'
  if (f.winner) return `${name(f.winner)}获胜 · ${actor(f.winner)}`
  if (canShowBeams.value && players.value.some(c => c !== f.current && !f.dead?.includes(c) && simulate(f.board, c).hits.includes(f.current))) return `${name(f.current)}面临攻击，需要防守`
  return `轮到${name(f.current)} · ${actor(f.current)}`
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
    await migrateSavedGames()
    if (id) {
      let data: AnyReplay | undefined
      try { data = await loadRecording(id) } catch { /* Published replays remain usable without browser storage. */ }
      if (!data) {
        const published = `${base}replays/${id}.json`, local = `${base}__arena/replays/${id}`
        let url = sourceUrl ?? published
        try { data = await json(url) }
        catch { url = url === published ? local : published; data = await json(url) }
        sourceUrl = url
      }
      if (token !== generation) return
      const verified = playback(data!)
      if (data!.id !== id) throw new Error('回放编号不匹配')
      game.value = data!
      step.value = Math.min(step.value, verified.entries.length)
      error.value = ''
    } else {
      const sources = await Promise.allSettled([json(`${base}replays/index.json`), json(`${base}__arena/replays`), listRecordings()])
      if (token !== generation) return
      const found = new Map<string, GameSummary>()
      for (const [index, result] of sources.entries()) if (result.status === 'fulfilled' && Array.isArray(result.value)) {
        for (const item of result.value) found.set(item.id, { ...item, source: ['published', 'arena', 'browser'][index] })
      }
      if (sources[2].status === 'rejected') error.value = '无法读取浏览器中的对局记录。请检查浏览器存储权限后重试。'
      else error.value = ''
      games.value = [...found.values()].sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
    }
  } catch (e) {
    if (token === generation) error.value = `读取回放失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    if (token === generation) { refreshing.value = false; loading.value = false }
  }
}
watch(() => props.gameId, () => { generation++; void load(true) }, { immediate: true })
function go(value: number) { step.value = Math.max(0, Math.min(entries.value.length, value)) }
function keyboard(event: KeyboardEvent) {
  if (!game.value || event.altKey || event.metaKey || event.ctrlKey || (event.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return
  const target = { ArrowLeft: step.value - 1, ArrowRight: step.value + 1, Home: 0, End: entries.value.length }[event.key]
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
  timer = setInterval(() => { if (!refreshing.value && (game.value && (game.value.version === 2 || !game.value.winner) || !props.gameId)) void load(false) }, 3000)
})
onUnmounted(() => { generation++; clearInterval(timer); removeEventListener('keydown', keyboard) })
</script>

<template>
  <main class="replays">
    <header>
      <div><p class="eyebrow">光镜棋 · 对局档案</p><h1>{{ game?.title ?? '对局记录' }}</h1></div>
      <nav>
        <a v-if="gameId" class="btn-plain" :href="`${base}replays`">全部回放</a>
        <a class="btn-plain" :href="base">回到大厅</a>
      </nav>
    </header>
    <p v-if="error" class="error" role="alert">{{ error }} <button class="btn-plain" @click="load(!game)">重试</button></p>
    <p v-if="archiveStatus.migrationError" class="error" role="alert">{{ archiveStatus.migrationError }}</p>
    <p v-if="loading" role="status">正在读取对局…</p>
    <template v-else-if="game && frame">
      <p v-if="!timeline?.historyComplete" class="history-note">这份记录的历史不完整，只能回放已保存的局面和操作。</p>
      <div class="replay-layout" :data-replay-step="step">
        <section class="board-column">
          <div class="board-caption">
            <span>{{ frame.board.size }} × {{ frame.board.size }} · {{ frame.board.boundaryReflects ? '边界反射' : '边界透射' }} · {{ frame.clock ? '有棋钟' : '无棋钟' }}</span>
            <span>{{ game.winner ? `已完赛 · 共 ${plies} 手` : `对局未结束 · 已记录 ${plies} 手` }}</span>
          </div>
          <ReplayBoard :frame="frame" :visible-beams="canShowBeams ? visibleBeams : []" />
          <div class="transport paper">
            <div class="transport-row">
              <button class="btn-plain" :disabled="step === 0" @click="go(0)">开局</button>
              <button class="btn-plain" :disabled="step === 0" @click="go(step - 1)">上一步</button>
              <output aria-live="polite">{{ step === 0 ? '初始局面' : `第 ${step} 步` }} / {{ entries.length }}</output>
              <button class="btn-primary" :disabled="step === entries.length" @click="go(step + 1)">下一步</button>
              <button class="btn-plain" :disabled="step === entries.length" @click="go(entries.length)">{{ game.winner ? '终局' : '最新' }}</button>
            </div>
            <input v-model.number="step" aria-label="回放进度" type="range" min="0" :max="entries.length" step="1" />
            <div class="beam-options">
              <template v-if="canShowBeams"><label v-for="color in players" :key="color"><input v-model="visibleBeams" type="checkbox" :value="color" /> {{ name(color) }}光路</label></template>
              <span v-else>房主未开放光路，对局结束后可查看</span>
              <span>← → 逐步回放 · 金色标记本手</span>
            </div>
          </div>
        </section>
        <aside class="paper details">
          <div class="players"><span v-for="color in players" :key="color" :style="{ color: colorHex(color) }">{{ name(color) }} · {{ actor(color) }}{{ frame.dead?.includes(color) ? frame.timedOut?.includes(color) ? ' · 超时出局' : ' · 已出局' : '' }}<template v-if="frame.clock"> · {{ formatTime(frame.clock.remaining[color] ?? 0) }}</template></span></div>
          <p class="position-status" role="status">{{ status }}</p>
          <section class="move-detail">
            <h2>{{ entry ? `第 ${step} 步 · ${name(entry.color)}` : '初始局面' }}</h2>
            <template v-if="entry">
              <p class="move-coordinate">{{ entry.label }}</p>
              <p v-if="entry.action" class="rationale-label">落子方当时的说明</p>
              <p v-if="entry.action" class="rationale">{{ entry.rationale || '此手没有附加说明。' }}</p>
              <p v-if="entry.thinkingMs !== undefined" class="muted">思考 {{ (entry.thinkingMs / 1000).toFixed(1) }} 秒</p>
            </template>
            <p v-else class="rationale">点击「下一步」逐步查看。布置基地、落子、撤回与超时均按实际发生顺序记录。坐标从 0 开始；光路随回放局面重新计算。</p>
          </section>
          <h2>操作记录</h2>
          <ol class="move-list" aria-label="落子记录">
            <li v-for="(move, index) in entries" :key="index">
              <button :class="{ selected: step === index + 1 }" :style="{ color: colorHex(move.color) }" :aria-current="step === index + 1 ? 'step' : undefined" @click="go(index + 1)">
                <span class="move-number">{{ index + 1 }}.</span> {{ name(move.color) }} · {{ move.label }}
              </button>
            </li>
          </ol>
          <button class="btn-plain" @click="download">下载回放 JSON</button>
          <details v-if="game.version === 1 && game.provenance" class="provenance"><summary>对局版本</summary><p>{{ game.provenance.source }}</p><p>WASM SHA-256<br /><code>{{ game.provenance.engineSha256 }}</code></p></details>
        </aside>
      </div>
    </template>
    <template v-else-if="!gameId && !loading">
      <p class="archive-note">单机、人机和联机对局都会自动记录，包括未结束的对局。记录保存在当前浏览器；清除网站数据会删除记录，可下载 JSON 备份。</p>
      <section class="game-list" aria-label="对局列表">
        <p v-if="!games.some(item => item.source === 'browser')" class="empty-note">这里还没有你的对局记录。开始一局后，无需手动保存。</p>
        <a v-for="item in games" :key="item.id" class="paper game-card" :href="`${base}replay/${item.id}`" :data-recording-id="item.id">
          <p class="eyebrow">{{ item.source === 'browser' ? '本机对局' : item.source === 'arena' ? '本地 AI 对战' : '公开示例' }}{{ item.historyComplete === false ? ' · 历史不完整' : '' }}</p>
          <h2>{{ item.title }}</h2>
          <p>{{ new Date(item.createdAt).toLocaleString('zh-CN') }} · {{ item.plies }} 手</p>
          <p>{{ item.winner ? `${name(item.winner)}获胜` : item.phase === 'setup' ? '尚在布置' : '对局未结束' }} <span>{{ item.historyComplete === false ? '从保存局面观看' : '从开局观看' }} →</span></p>
        </a>
      </section>
    </template>
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

<style scoped>
.archive-note, .history-note { margin: 0 0 22px; font-size: 14px; line-height: 1.8; color: #786c53; }
.history-note { padding: 12px; background: #f2e4bd; border-radius: 8px; }
.empty-note { grid-column: 1 / -1; font-size: 14px; color: #786c53; }
.game-card .eyebrow { margin: 0 0 12px; }.game-card h2 { line-height: 1.7; }
</style>
