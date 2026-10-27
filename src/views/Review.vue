<script setup lang="ts">
/** 独立复盘页：棋盘回放 + 对抗估值曲线 + top 候选列表 + 僵持折叠 + 第二意见。
 * 所有叠加层与棋盘同一 viewBox 坐标系（随棋盘一起缩放）。
 * 视觉层级：当前 ply 的实际着法与 top-1 推荐是主角；历史光路淡化；top-2..5 收进侧栏列表。
 */
import { computed, onUnmounted, ref } from 'vue'
import {
  edgeOf,
  PALETTE,
  simulate,
  type Color,
  type Dir,
  type Ori,
  type Pt,
} from '../game'
import {
  blueValue,
  closeReview,
  moverColor,
  moveText,
  review,
  runAnalysis,
  sameMove,
  setCursor,
  toggleDeadRun,
  togglePlay,
  type PlyLine,
  type ReviewMove,
} from '../review'
import { modelList, refreshCkpts } from '../ai'
import { state } from '../store'

const S = 28
const PAD = 36
const N = computed(() => review.size)
const SIZE = computed(() => PAD * 2 + N.value * S)
const u = (v: number) => PAD + v * S

const COLORS = Object.fromEntries(PALETTE.map((p) => [p.id, p.hex])) as Record<Color, string>

if (!modelList.loaded && !modelList.error) void refreshCkpts()
onUnmounted(() => closeReview())

/** Q/value 相对行棋方：正 = 有利 ▲，负 = 不利 ▼ */
const qSign = (v: number) => (v >= 0 ? '▲' : '▼')
const qClass = (v: number) => (v >= 0 ? 'q-pos' : 'q-neg')

// ---------- 棋盘重建：homes + 前 cursor 手 ----------
const boardAt = computed(() => {
  const edges = new Map<string, { color: Color }>()
  const diags = new Map<string, { color: Color; ori: Ori }>()
  for (const [c, h] of Object.entries(review.homes)) {
    if (!h) continue
    for (const d of [0, 1, 2, 3] as Dir[]) {
      if (d !== h.dir) edges.set(edgeOf(h.x, h.y, d), { color: c as Color })
    }
  }
  for (let i = 0; i < review.cursor && i < review.moves.length; i++) {
    const m = review.moves[i]
    const color = moverColor(i % 2)
    if (m.kind === 'edge') edges.set(m.id, { color })
    else diags.set(`${m.x},${m.y}`, { color, ori: m.ori })
  }
  return { edges, diags }
})

const simBoard = computed(() => ({
  homes: review.homes,
  edges: boardAt.value.edges,
  diags: boardAt.value.diags,
  size: review.size,
  boundaryReflects: review.boundaryReflects,
}))

/** 双方最新光路（随 cursor 变化；渲染上淡化处理，不抢候选与曲线） */
const lasers = computed(() => {
  const m = new Map<Color, ReturnType<typeof simulate>>()
  for (const c of ['blue', 'red'] as Color[]) {
    if (review.homes[c]) m.set(c, simulate(simBoard.value, c))
  }
  return m
})

const segPath = (segments: [Pt, Pt][]) =>
  segments.map(([p, q]) => `M${u(p.x)} ${u(p.y)}L${u(q.x)} ${u(q.y)}`).join('')

// ---------- 几何 ----------
function edgeLine(id: string) {
  const [t, a, b] = id.split(':')
  const x = +a
  const y = +b
  return t === 'h'
    ? { x1: u(x), y1: u(y), x2: u(x + 1), y2: u(y) }
    : { x1: u(x), y1: u(y), x2: u(x), y2: u(y + 1) }
}
function diagLine(x: number, y: number, ori: Ori) {
  return ori === '/'
    ? { x1: u(x), y1: u(y + 1), x2: u(x + 1), y2: u(y) }
    : { x1: u(x), y1: u(y), x2: u(x + 1), y2: u(y + 1) }
}
const moveLine = (m: ReviewMove) => (m.kind === 'edge' ? edgeLine(m.id) : diagLine(m.x, m.y, m.ori))
const moveMid = (m: ReviewMove) => {
  const l = moveLine(m)
  return { x: (l.x1 + l.x2) / 2, y: (l.y1 + l.y2) / 2 }
}

// ---------- 当前 ply ----------
const curPly = computed<PlyLine | null>(() =>
  review.cursor >= 1 && review.cursor <= review.plies.length ? review.plies[review.cursor - 1] : null,
)

/** 棋盘上的主角：top-1 推荐线（灰色虚线 + Q 标签）；与实际所下一致时不画 */
const top1Overlay = computed(() => {
  const p = curPly.value
  if (!p || !p.top.length || sameMove(p.top[0].move, p.move)) return null
  const l = moveLine(p.top[0].move)
  const dx = l.x2 - l.x1
  const dy = l.y2 - l.y1
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  return {
    line: l,
    label: { x: (l.x1 + l.x2) / 2 + nx * 6, y: (l.y1 + l.y2) / 2 + ny * 6 + 2.2 },
    q: p.top[0].q,
  }
})

/** 侧栏候选列表悬停/点击时在棋盘上预览该条 */
const previewMove = ref<ReviewMove | null>(null)
const previewOverlay = computed(() => {
  const m = previewMove.value
  if (!m) return null
  if (top1Overlay.value && sameMove(m, curPly.value!.top[0].move)) return null // 已在棋盘上
  const p = curPly.value
  if (p && sameMove(m, p.move)) return null // 实际所下已在棋盘上
  return { line: moveLine(m) }
})

/** 实际所下着法与 top-1 不一致 → 该步标灰 */
const actualDeviates = computed(() => {
  const p = curPly.value
  return Boolean(p && p.top.length && !sameMove(p.top[0].move, p.move))
})
const actualKey = computed(() => {
  const p = curPly.value
  if (!p) return null
  return p.move.kind === 'edge' ? `e:${p.move.id}` : `d:${p.move.x},${p.move.y}`
})
const mirrorColor = (kind: 'e' | 'd', key: string, color: Color) =>
  actualDeviates.value && actualKey.value === `${kind}:${key}` ? '#8f8878' : COLORS[color]

/** 第二意见与 coach top-1 分歧 */
const secondDiff = computed(() => {
  const p = curPly.value
  if (!p?.second || !p.top.length) return null
  if (sameMove(p.second.move, p.top[0].move)) return null
  return {
    at: moveMid(p.move),
    text: `第二意见 ${review.meta?.second ?? review.second}：${moveText(p.second.move)}，Q=${p.second.q.toFixed(2)}`,
  }
})

const curBlunder = computed(() => review.final?.blunders.find((b) => b.ply === review.cursor - 1) ?? null)

// ---------- 步进条（僵持折叠） ----------
type StripItem = { kind: 'ply'; ply: number } | { kind: 'run'; start: number; len: number }
const stripItems = computed<StripItem[]>(() => {
  const items: StripItem[] = []
  const ps = review.plies
  let i = 0
  while (i < ps.length) {
    if (ps[i].dead) {
      let j = i
      while (j < ps.length && ps[j].dead) j++
      if (j - i >= 2 && !review.expandedRuns.includes(i)) {
        items.push({ kind: 'run', start: i, len: j - i })
      } else {
        for (let k = i; k < j; k++) items.push({ kind: 'ply', ply: k })
      }
      i = j
    } else {
      items.push({ kind: 'ply', ply: i })
      i++
    }
  }
  return items
})

const blunderPlies = computed(() => new Set((review.final?.blunders ?? []).map((b) => b.ply)))
const diffPlies = computed(
  () =>
    new Set(
      review.plies
        .filter((p) => p.second && p.top.length && !sameMove(p.second.move, p.top[0].move))
        .map((p) => p.ply),
    ),
)

// ---------- 对抗估值曲线（中线 0，上蓝下红） ----------
const CW = 264
const CH = 96
const CPAD = 10
const MID = CH / 2
const totalPlies = computed(() =>
  Math.max(review.meta?.total_plies ?? 0, review.moves.length, review.plies.length, 1),
)
const cx = (ply: number) => CPAD + ((ply + 0.5) / totalPlies.value) * (CW - CPAD * 2)
const cy = (v: number) => MID - (v * (CH - CPAD * 2)) / 2
/** 钳制到上/下半区后连成填充带，零交叉自然落在中线 */
const band = (pick: (v: number) => number) => {
  const ps = review.plies
  if (!ps.length) return ''
  const top = ps.map((p) => `L${cx(p.ply)} ${cy(pick(blueValue(p)))}`).join('')
  return `M${cx(ps[0].ply)} ${MID}${top}L${cx(ps.at(-1)!.ply)} ${MID}Z`
}
const blueBand = computed(() => band((v) => Math.max(0, v)))
const redBand = computed(() => band((v) => Math.min(0, v)))
const curveLine = computed(() => review.plies.map((p) => `${cx(p.ply)},${cy(blueValue(p))}`).join(' '))
const deadBands = computed(() => {
  const bands: { x: number; w: number; len: number }[] = []
  const ps = review.plies
  let i = 0
  while (i < ps.length) {
    if (ps[i].dead) {
      let j = i
      while (j < ps.length && ps[j].dead) j++
      if (j - i >= 2) bands.push({ x: cx(i) - (CW - CPAD * 2) / totalPlies.value / 2, w: ((j - i) / totalPlies.value) * (CW - CPAD * 2), len: j - i })
      i = j
    } else i++
  }
  return bands
})
const blunderDots = computed(() =>
  (review.final?.blunders ?? [])
    .filter((b) => b.drop > 0.3)
    .map((b) => {
      const pt = review.plies.find((p) => p.ply === b.ply)
      return { ply: b.ply, drop: b.drop, x: cx(b.ply), y: pt ? cy(blueValue(pt)) : MID }
    }),
)
const cursorX = computed(() => (review.cursor === 0 ? null : cx(review.cursor - 1)))

function onSlider(e: Event) {
  review.playing = false
  setCursor(Number((e.target as HTMLInputElement).value))
}
function jump(ply: number) {
  review.playing = false
  setCursor(ply + 1)
}

// ---------- 模型选择 ----------
const sizedModels = computed(() => modelList.list.filter((m) => m.size === review.size))
const coachOptions = computed(() =>
  sizedModels.value.flatMap((m) => m.gens.map((g) => ({ id: g.id, label: `${m.name} ${g.id.split('/')[1]}` }))),
)

const dots = computed(() => {
  const a: Pt[] = []
  for (let x = 0; x <= N.value; x++) for (let y = 0; y <= N.value; y++) a.push({ x, y })
  return a
})

const statusText = computed(() => {
  if (review.error) return `分析出错：${review.error}`
  if (review.loading) return `分析中 ${review.progress.done}/${review.progress.total || '…'}`
  if (review.final) return `完成 · 失误 ${review.final.blunders.length} 手`
  return '待分析'
})

const backLabel = computed(() => (state.phase === 'lobby' ? '返回大厅' : '返回对局'))
</script>

<template>
  <div class="game review-page">
    <div class="paper board-wrap">
      <svg class="board-svg" :viewBox="`0 0 ${SIZE} ${SIZE}`" data-review-board>
        <circle v-for="d in dots" :key="`d${d.x},${d.y}`" :cx="u(d.x)" :cy="u(d.y)" r="2" class="dot" />

        <!-- 双方光路（淡化，仅作局面背景） -->
        <template v-for="c in (['blue', 'red'] as Color[])" :key="`l${c}`">
          <g v-if="lasers.get(c)?.segments.length">
            <path :d="segPath(lasers.get(c)!.segments)" :stroke="COLORS[c]" class="laser-dim" />
          </g>
        </template>

        <!-- 镜子（实际所下与 top-1 不一致的那步标灰） -->
        <line
          v-for="[id, m] in boardAt.edges"
          :key="`e${id}`"
          v-bind="edgeLine(id)"
          :stroke="mirrorColor('e', id, m.color)"
          :stroke-width="actualKey === `e:${id}` ? 4 : 2.6"
          stroke-linecap="round"
          class="no-events"
        />
        <line
          v-for="[key, g] in boardAt.diags"
          :key="`g${key}`"
          v-bind="diagLine(+key.split(',')[0], +key.split(',')[1], g.ori)"
          :stroke="mirrorColor('d', key, g.color)"
          :stroke-width="actualKey === `d:${key}` ? 3.8 : 2.4"
          stroke-linecap="round"
          class="no-events"
        />

        <!-- 家 -->
        <template v-for="c in (['blue', 'red'] as Color[])" :key="`h${c}`">
          <circle
            v-if="review.homes[c]"
            :cx="u(review.homes[c]!.x + 0.5)"
            :cy="u(review.homes[c]!.y + 0.5)"
            :r="S * 0.2"
            :fill="COLORS[c]"
            class="no-events"
          />
        </template>

        <!-- top-1 推荐（与实际所下不一致时；其余候选在侧栏列表） -->
        <g v-if="top1Overlay" class="no-events" data-top-overlay>
          <line
            v-bind="top1Overlay.line"
            stroke="#9a917e"
            stroke-width="2.6"
            stroke-dasharray="5 3"
            stroke-linecap="round"
          />
          <text
            :x="top1Overlay.label.x"
            :y="top1Overlay.label.y"
            class="q-label"
            :class="qClass(top1Overlay.q)"
          >{{ qSign(top1Overlay.q) }}{{ Math.abs(top1Overlay.q).toFixed(2) }}</text>
        </g>

        <!-- 侧栏候选的棋盘预览 -->
        <line
          v-if="previewOverlay"
          v-bind="previewOverlay.line"
          stroke="#9a917e"
          stroke-width="2.2"
          stroke-opacity="0.8"
          stroke-dasharray="2 2.5"
          stroke-linecap="round"
          class="no-events"
          data-cand-preview
        />

        <!-- 第二意见分歧标记 -->
        <g v-if="secondDiff" class="second-diff" :transform="`translate(${secondDiff.at.x} ${secondDiff.at.y - 9})`">
          <circle r="5" fill="#fffdf6" stroke="#7c6f52" stroke-width="1.2" />
          <text y="2.6" class="diff-num">2</text>
          <title>{{ secondDiff.text }}</title>
        </g>
      </svg>
    </div>

    <aside class="side">
      <div class="head-row">
        <h1 class="logo-sm">复盘</h1>
        <span class="st" :class="{ err: review.error }">{{ statusText }}</span>
        <button class="btn-plain back-btn" @click="closeReview()">{{ backLabel }}</button>
      </div>

      <!-- 播放控制：通用媒体图标语义 -->
      <div class="note ctl">
        <button
          class="btn-plain play-btn"
          :aria-label="review.playing ? '暂停' : '播放'"
          :title="review.playing ? '暂停' : '播放'"
          @click="togglePlay"
        >{{ review.playing ? '⏸' : '▶' }}</button>
        <button class="btn-plain skip-btn" aria-label="回到开局" title="回到开局" @click="jump(-1)">⏮</button>
        <input
          type="range"
          class="scrub"
          min="0"
          :max="review.plies.length"
          :value="review.cursor"
          aria-label="步进条"
          @input="onSlider"
        />
        <span class="ply-cnt">{{ review.cursor }}/{{ review.meta?.total_plies ?? review.moves.length }}</span>
        <button class="btn-plain skip-btn" aria-label="跳到终局" title="跳到终局" @click="jump(review.plies.length - 1)">⏭</button>
      </div>

      <!-- 当前手：实际着法 + 估值是主角 -->
      <div v-if="curPly" class="note cur-ply">
        <div class="cur-main">
          <span class="mover-dot" :style="{ background: COLORS[moverColor(curPly.mover)] }"></span>
          <span class="cur-move">#{{ review.cursor }} {{ moveText(curPly.move) }}</span>
          <span class="cur-q" :class="qClass(blueValue(curPly))" :title="`局面估值（蓝方视角）：${qSign(blueValue(curPly))} 对蓝方${blueValue(curPly) >= 0 ? '有利' : '不利'}`">
            {{ qSign(blueValue(curPly)) }} {{ Math.abs(blueValue(curPly)).toFixed(2) }}
          </span>
        </div>
        <div class="cur-tags">
          <span v-if="actualDeviates" class="tag tag-dev" title="实际所下与教练 top-1 推荐不一致（棋盘上该步已标灰，虚线为推荐）">≠ 推荐</span>
          <span v-if="curBlunder" class="tag tag-blunder" :title="`这一手估值跌 ${curBlunder.drop.toFixed(2)}`">失误 −{{ curBlunder.drop.toFixed(2) }}</span>
          <span v-if="curPly.dead" class="tag" title="僵持步：双方都无法打开局面">僵持</span>
          <span v-if="secondDiff" class="tag" :title="secondDiff.text">② 二见分歧</span>
        </div>
      </div>
      <div v-else class="note cur-ply empty">开局局面 · 按 ▶ 逐步播放打分</div>

      <!-- 候选着法列表：top-1 在棋盘上，其余点击预览 -->
      <div v-if="curPly?.top.length" class="note cand-note">
        <p class="note-title">候选着法 <span class="hint">悬停/点击在棋盘预览</span></p>
        <button
          v-for="(t, i) in curPly.top.slice(0, 5)"
          :key="i"
          class="cand-row"
          :class="{ actual: sameMove(t.move, curPly!.move) }"
          @mouseenter="previewMove = t.move"
          @mouseleave="previewMove = null"
          @click="previewMove = t.move"
        >
          <span class="cand-rank">{{ i + 1 }}</span>
          <span class="cand-move">{{ moveText(t.move) }}</span>
          <span v-if="sameMove(t.move, curPly!.move)" class="cand-actual" title="实际所下">✓</span>
          <span class="cand-q" :class="qClass(t.q)" :title="`Q=${t.q.toFixed(3)}，${qSign(t.q)} 对行棋方${t.q >= 0 ? '有利' : '不利'}`">
            {{ qSign(t.q) }} {{ Math.abs(t.q).toFixed(2) }}
          </span>
        </button>
      </div>

      <!-- 对抗估值曲线：上蓝下红 -->
      <div class="note">
        <p class="note-title">局势 <span class="hint"><i class="sq sq-b"></i>蓝优 <i class="sq sq-r"></i>红优</span></p>
        <svg :viewBox="`0 0 ${CW} ${CH}`" class="curve" data-value-curve>
          <g v-for="(b, i) in deadBands" :key="`b${i}`">
            <rect :x="b.x" y="4" :width="Math.max(b.w, 2)" :height="CH - 8" fill="#9a917e" opacity="0.08">
              <title>僵持 ×{{ b.len }}</title>
            </rect>
          </g>
          <path v-if="blueBand" :d="blueBand" fill="#2f6fed" opacity="0.22" />
          <path v-if="redBand" :d="redBand" fill="#e84a3c" opacity="0.22" />
          <line :x1="CPAD" :x2="CW - CPAD" :y1="MID" :y2="MID" stroke="#b0a488" stroke-width="1" stroke-dasharray="3 3" />
          <polyline v-if="curveLine" :points="curveLine" fill="none" stroke="#35301f" stroke-width="1.4" />
          <circle
            v-for="b in blunderDots"
            :key="`bl${b.ply}`"
            :cx="b.x"
            :cy="b.y"
            r="4"
            fill="#e84a3c"
            stroke="#fffdf6"
            stroke-width="1.2"
            class="blunder-dot"
            @click="jump(b.ply)"
          >
            <title>第 {{ b.ply + 1 }} 手失误，估值跌 {{ b.drop.toFixed(2) }}（点击跳转）</title>
          </circle>
          <line
            v-if="cursorX !== null"
            :x1="cursorX"
            :x2="cursorX"
            y1="4"
            :y2="CH - 4"
            stroke="#35301f"
            stroke-width="1.4"
          />
        </svg>
        <!-- 步进按钮条：僵持折叠 -->
        <div class="strip">
          <template v-for="(it, i) in stripItems" :key="i">
            <button
              v-if="it.kind === 'ply'"
              class="ply-btn"
              :class="{
                active: review.cursor === it.ply + 1,
                blunder: blunderPlies.has(it.ply),
                dead: review.plies[it.ply].dead,
              }"
              :title="`第 ${it.ply + 1} 手`"
              @click="jump(it.ply)"
            >
              {{ it.ply + 1 }}<i v-if="diffPlies.has(it.ply)" class="diff-dot">2</i>
            </button>
            <button v-else class="run-btn" :title="`僵持 ${it.len} 手，点击展开`" @click="toggleDeadRun(it.start)">…{{ it.len }}</button>
          </template>
        </div>
      </div>

      <!-- 分析设置：默认收起 -->
      <details class="note settings">
        <summary>分析设置</summary>
        <label class="row-ctl">
          教练
          <select v-model="review.coach" class="sel">
            <option v-for="o in coachOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
        </label>
        <label class="row-ctl">
          第二意见
          <select v-model="review.second" class="sel">
            <option value="">不使用</option>
            <option v-for="o in coachOptions" :key="o.id" :value="o.id">{{ o.label }}</option>
          </select>
        </label>
        <label class="row-ctl">
          sims
          <input type="number" min="50" max="200" step="50" v-model.number="review.sims" class="sel sims-in" />
          <button class="btn-plain" :disabled="review.loading" @click="runAnalysis()">
            {{ review.loading ? '分析中…' : '重新分析' }}
          </button>
        </label>
      </details>
    </aside>
  </div>
</template>

<style scoped>
.review-page {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 26px;
  width: 100%;
}
.board-wrap {
  position: relative;
  flex: none;
  width: min(calc(100vh - 44px), calc(100vw - 360px), 900px);
  border-radius: 26px 12px 30px 12px / 12px 30px 12px 26px;
}
.board-svg {
  display: block;
  width: 100%;
  height: auto;
}
.dot {
  fill: #a99d80;
  pointer-events: none;
}
.no-events {
  pointer-events: none;
}
.side {
  flex: none;
  width: 300px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  max-height: calc(100vh - 44px);
  overflow-y: auto;
  padding: 16px 6px 6px;
  scrollbar-width: thin;
}
.head-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.logo-sm {
  font-size: 24px;
  margin: 0;
  color: #35301f;
  letter-spacing: 6px;
}
.st {
  flex: 1;
  font-size: 12px;
  color: #8a7f68;
}
.st.err {
  color: #b91c1c;
}
.back-btn {
  padding: 4px 10px;
  font-size: 12px;
}
.note {
  position: relative;
  padding: 10px 12px;
  font-size: 14px;
  color: #35301f;
  background: #fbf6ea;
  border: 2px solid #3d3627;
  border-radius: 14px 4px 16px 4px / 4px 16px 4px 14px;
  box-shadow: 3px 3px 0 rgba(61, 54, 39, 0.18);
}
.note-title {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 700;
  color: #6b5f47;
}
.hint {
  font-weight: 400;
  color: #b0a488;
  font-size: 11px;
}
/* 播放控制 */
.ctl {
  display: flex;
  align-items: center;
  gap: 8px;
}
.play-btn {
  width: 34px;
  padding: 4px 0;
  font-size: 14px;
}
.skip-btn {
  width: 28px;
  padding: 4px 0;
  font-size: 12px;
}
.scrub {
  flex: 1;
  min-width: 0;
  accent-color: #2f6fed;
}
.ply-cnt {
  font-size: 12px;
  color: #8a7f68;
  white-space: nowrap;
}
/* 当前手 */
.cur-ply.empty {
  font-size: 12px;
  color: #b0a488;
  text-align: center;
}
.cur-main {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mover-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex: none;
}
.cur-move {
  flex: 1;
  font-weight: 700;
  font-size: 14px;
}
.cur-q {
  font-size: 16px;
  font-weight: 700;
  cursor: help;
}
.q-pos {
  color: #2c8a4e;
}
.q-neg {
  color: #e84a3c;
}
.cur-tags {
  display: flex;
  gap: 6px;
  margin-top: 6px;
  flex-wrap: wrap;
}
.tag {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 8px;
  background: #efe7d2;
  color: #8a7f68;
  cursor: help;
}
.tag-dev {
  background: #f3e2c5;
  color: #8a6d1f;
}
.tag-blunder {
  background: #f8d7d3;
  color: #b91c1c;
}
/* 候选列表 */
.cand-note {
  padding-top: 8px;
}
.cand-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 3px 6px;
  font-size: 12.5px;
  font-family: inherit;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: #5c5340;
  cursor: pointer;
  text-align: left;
}
.cand-row:hover {
  background: #efe7d2;
}
.cand-row.actual {
  color: #35301f;
  font-weight: 700;
}
.cand-rank {
  width: 14px;
  color: #b0a488;
  font-size: 11px;
}
.cand-move {
  flex: 1;
}
.cand-actual {
  color: #2c8a4e;
}
.cand-q {
  font-variant-numeric: tabular-nums;
  cursor: help;
}
/* 曲线 */
.curve {
  display: block;
  width: 100%;
  height: auto;
}
.sq {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 2px;
  margin: 0 3px 0 6px;
}
.sq-b {
  background: #2f6fed;
}
.sq-r {
  background: #e84a3c;
}
.blunder-dot {
  cursor: pointer;
  pointer-events: auto;
}
/* 步进按钮条 */
.strip {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.ply-btn {
  position: relative;
  min-width: 26px;
  padding: 2px 4px;
  font-size: 11px;
  font-family: inherit;
  background: #fffdf6;
  border: 1.5px solid #b0a488;
  border-radius: 6px;
  color: #5c5340;
  cursor: pointer;
}
.ply-btn.active {
  background: #2f6fed;
  border-color: #1e4fb8;
  color: #fff;
}
.ply-btn.blunder {
  border-color: #e84a3c;
  color: #e84a3c;
}
.ply-btn.blunder.active {
  color: #fff;
}
.ply-btn.dead {
  opacity: 0.55;
}
.diff-dot {
  position: absolute;
  top: -6px;
  right: -5px;
  width: 11px;
  height: 11px;
  border-radius: 50%;
  background: #7c6f52;
  color: #fff;
  font-size: 8px;
  font-style: normal;
  line-height: 11px;
  text-align: center;
}
.run-btn {
  padding: 2px 8px;
  font-size: 11px;
  font-family: inherit;
  background: transparent;
  border: 1.5px dashed #cfc3a5;
  border-radius: 6px;
  color: #b0a488;
  cursor: pointer;
}
/* 设置 */
.settings summary {
  font-size: 12px;
  color: #8a7f68;
  cursor: pointer;
}
.settings[open] summary {
  margin-bottom: 8px;
}
.row-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #5c5340;
  margin-top: 6px;
}
.sel {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  font-size: 13px;
  font-family: inherit;
  background: #fffdf6;
  border: 2px solid #3d3627;
  border-radius: 8px;
  outline: none;
  color: #35301f;
}
.sims-in {
  flex: none;
  width: 64px;
  text-align: center;
}
/* Q 值标签：随棋盘同坐标系缩放，白描边保证可读 */
.q-label {
  font-size: 7px;
  font-weight: 700;
  text-anchor: middle;
  paint-order: stroke;
  stroke: #fbf6ea;
  stroke-width: 2.6;
}
.diff-num {
  font-size: 7px;
  fill: #7c6f52;
  text-anchor: middle;
  font-weight: 700;
}
.second-diff {
  pointer-events: auto;
}
/* 淡化的光路背景 */
.laser-dim {
  fill: none;
  stroke-width: 2.6;
  stroke-opacity: 0.22;
  stroke-linecap: round;
  pointer-events: none;
}
@media (max-width: 980px) {
  .review-page {
    flex-direction: column;
    gap: 18px;
  }
  .board-wrap {
    width: min(97vw, calc(100vh - 44px));
  }
  .side {
    width: min(97vw, 620px);
    max-height: none;
  }
}
</style>
