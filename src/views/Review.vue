<script setup lang="ts">
/** 独立复盘页：棋盘回放 + 逐步估值 + top-5 候选 + value 曲线 + 僵持折叠 + 第二意见。
 * 所有叠加层与棋盘同一 viewBox 坐标系（随棋盘一起缩放，不用 non-scaling-stroke 技巧）。
 */
import { computed, onUnmounted } from 'vue'
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
const name = (c: Color) => `${PALETTE.find((p) => p.id === c)?.name ?? c}方`

if (!modelList.loaded && !modelList.error) void refreshCkpts()
onUnmounted(() => closeReview())

// ---------- 棋盘重建：homes + 前 cursor 手 ----------
interface MirrorMark {
  color: Color
}
const boardAt = computed(() => {
  const edges = new Map<string, MirrorMark>()
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

// ---------- 当前 ply 信息 ----------
const curPly = computed<PlyLine | null>(() =>
  review.cursor >= 1 && review.cursor <= review.plies.length ? review.plies[review.cursor - 1] : null,
)

/** top-5 候选的灰色线段与 Q 标签位置（垂直偏移按名次交错，避免重叠） */
const topOverlay = computed(() => {
  const p = curPly.value
  if (!p) return []
  return p.top.slice(0, 5).map((t, rank) => {
    const l = moveLine(t.move)
    const dx = l.x2 - l.x1
    const dy = l.y2 - l.y1
    const len = Math.hypot(dx, dy) || 1
    const nx = -dy / len
    const ny = dx / len
    const off = (rank % 2 === 0 ? 1 : -1) * (5 + Math.floor(rank / 2) * 7)
    return {
      key: `top${rank}`,
      line: l,
      label: { x: (l.x1 + l.x2) / 2 + nx * off, y: (l.y1 + l.y2) / 2 + ny * off + 2.2 },
      q: t.q.toFixed(2),
      opacity: 0.85 - rank * 0.13,
      isActual: sameMove(t.move, p.move),
    }
  })
})

/** 实际所下着法与 top-1 不一致 → 该步标灰 */
const actualDeviates = computed(() => {
  const p = curPly.value
  return Boolean(p && p.top.length && !sameMove(p.top[0].move, p.move))
})

/** 实际所下着法的镜像渲染 key（用于标灰/加粗） */
const actualKey = computed(() => {
  const p = curPly.value
  if (!p) return null
  return p.move.kind === 'edge' ? `e:${p.move.id}` : `d:${p.move.x},${p.move.y}`
})
const mirrorKey = (kind: 'e' | 'd', key: string) => `${kind}:${key}`
const mirrorColor = (kind: 'e' | 'd', key: string, color: Color) =>
  actualDeviates.value && actualKey.value === mirrorKey(kind, key) ? '#8f8878' : COLORS[color]

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

/** 当前 ply 是不是失误手 */
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

// ---------- value 曲线（蓝方视角） ----------
const CW = 264
const CH = 96
const CPAD = 10
const curvePts = computed(() => {
  const total = Math.max(review.meta?.total_plies ?? 0, review.moves.length, review.plies.length, 1)
  return review.plies.map((p) => ({
    ply: p.ply,
    x: CPAD + ((p.ply + 0.5) / total) * (CW - CPAD * 2),
    y: CH / 2 - (blueValue(p) * (CH - CPAD * 2)) / 2,
    dead: p.dead,
  }))
})
const curvePath = computed(() => curvePts.value.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(''))
/** 曲线上的僵持段底纹 */
const deadBands = computed(() => {
  const total = Math.max(review.meta?.total_plies ?? 0, review.moves.length, 1)
  const bands: { x: number; w: number; len: number }[] = []
  const ps = review.plies
  let i = 0
  while (i < ps.length) {
    if (ps[i].dead) {
      let j = i
      while (j < ps.length && ps[j].dead) j++
      if (j - i >= 2) {
        bands.push({ x: CPAD + (i / total) * (CW - CPAD * 2), w: ((j - i) / total) * (CW - CPAD * 2), len: j - i })
      }
      i = j
    } else i++
  }
  return bands
})
const blunderDots = computed(() => {
  const total = Math.max(review.meta?.total_plies ?? 0, review.moves.length, 1)
  return (review.final?.blunders ?? [])
    .filter((b) => b.drop > 0.3)
    .map((b) => {
      const pt = curvePts.value.find((p) => p.ply === b.ply)
      return {
        ply: b.ply,
        drop: b.drop,
        x: CPAD + ((b.ply + 0.5) / total) * (CW - CPAD * 2),
        y: pt?.y ?? CH / 2,
      }
    })
})
const cursorX = computed(() => {
  const total = Math.max(review.meta?.total_plies ?? 0, review.moves.length, review.plies.length, 1)
  return review.cursor === 0 ? null : CPAD + ((review.cursor - 0.5) / total) * (CW - CPAD * 2)
})

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
  if (review.loading)
    return `分析中 ${review.progress.done}/${review.progress.total || '…'}（${review.coach}）`
  if (review.final) {
    const r = review.final.result as { winner?: string | null } | null
    const win = r?.winner ? `${name(r.winner as Color)}胜` : '已结束'
    const ms = review.final.elapsed_ms ?? review.final.ms
    return `分析完成：${win}，失误 ${review.final.blunders.length} 手${ms ? `，耗时 ${(ms / 1000).toFixed(1)}s` : ''}`
  }
  return '准备分析…'
})

const backLabel = computed(() => (state.phase === 'lobby' ? '返回大厅' : '返回对局'))
</script>

<template>
  <div class="game review-page">
    <div class="paper board-wrap">
      <svg class="board-svg" :viewBox="`0 0 ${SIZE} ${SIZE}`" data-review-board>
        <circle v-for="d in dots" :key="`d${d.x},${d.y}`" :cx="u(d.x)" :cy="u(d.y)" r="2" class="dot" />

        <!-- 光路（双方全程显示，便于理解局面） -->
        <template v-for="c in (['blue', 'red'] as Color[])" :key="`l${c}`">
          <g v-if="lasers.get(c)?.segments.length">
            <path :d="segPath(lasers.get(c)!.segments)" :stroke="COLORS[c]" class="laser-glow" />
            <path :d="segPath(lasers.get(c)!.segments)" :stroke="COLORS[c]" class="laser-core" />
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

        <!-- top-5 候选：灰色线条 + Q 值数字 -->
        <g v-if="topOverlay.length" class="no-events" data-top-overlay>
          <line
            v-for="t in topOverlay"
            :key="t.key"
            v-bind="t.line"
            stroke="#9a917e"
            :stroke-opacity="t.opacity"
            :stroke-width="t.isActual ? 3.4 : 1.6"
            :stroke-dasharray="t.isActual ? '' : '4 3'"
            stroke-linecap="round"
          />
          <text
            v-for="t in topOverlay"
            :key="`t${t.key}`"
            :x="t.label.x"
            :y="t.label.y"
            class="q-label"
          >{{ t.q }}</text>
        </g>

        <!-- 第二意见分歧标记 -->
        <g v-if="secondDiff" class="no-events second-diff" :transform="`translate(${secondDiff.at.x} ${secondDiff.at.y - 9})`">
          <circle r="5" fill="#fffdf6" stroke="#7c6f52" stroke-width="1.2" />
          <text y="2.6" class="diff-num">2</text>
          <title>{{ secondDiff.text }}</title>
        </g>
      </svg>
    </div>

    <aside class="side">
      <h1 class="logo-sm">复盘</h1>

      <div class="note status-note">{{ statusText }}</div>

      <div class="note meta-note">
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
          <input type="number" min="10" max="2000" v-model.number="review.sims" class="sel sims-in" />
        </label>
        <div class="btn-row">
          <button class="btn-plain" :disabled="review.loading" @click="runAnalysis()">
            {{ review.loading ? '分析中…' : '重新分析' }}
          </button>
          <button class="btn-plain" @click="closeReview()">{{ backLabel }}</button>
        </div>
      </div>

      <div class="note">
        <div class="play-row">
          <button class="btn-plain play-btn" @click="togglePlay">
            {{ review.playing ? '暂停' : '播放' }}
          </button>
          <input
            type="range"
            class="scrub"
            min="0"
            :max="review.plies.length"
            :value="review.cursor"
            @input="onSlider"
          />
          <span class="ply-cnt">{{ review.cursor }}/{{ review.meta?.total_plies ?? review.moves.length }}</span>
        </div>
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
              @click="jump(it.ply)"
            >
              {{ it.ply + 1 }}<i v-if="diffPlies.has(it.ply)" class="diff-dot">2</i>
            </button>
            <button v-else class="run-btn" @click="toggleDeadRun(it.start)">僵持 ×{{ it.len }}</button>
          </template>
        </div>
        <p v-if="curPly" class="ply-info">
          第 {{ review.cursor }} 手（{{ name(moverColor(curPly.mover)) }}）：{{ moveText(curPly.move) }}
          <br />
          估值（蓝方视角）{{ blueValue(curPly).toFixed(2) }}
          <template v-if="curPly.top.length">
            · top-1 {{ moveText(curPly.top[0].move) }} Q={{ curPly.top[0].q.toFixed(2) }}
          </template>
          <template v-if="actualDeviates"> · <span class="dev">实际所下偏离 top-1（已标灰）</span></template>
          <template v-if="curBlunder"> · <span class="dev">失误，跌 {{ curBlunder.drop.toFixed(2) }}</span></template>
          <template v-if="curPly.dead"> · 僵持</template>
        </p>
        <p v-else class="ply-info">初始局面（拖动步进条或点击播放）</p>
      </div>

      <div class="note">
        <p class="curve-title">估值走势（相对蓝方）</p>
        <svg :viewBox="`0 0 ${CW} ${CH}`" class="curve" data-value-curve>
          <line :x1="CPAD" :x2="CW - CPAD" :y1="CH / 2" :y2="CH / 2" stroke="#d8cbab" stroke-width="1" />
          <g v-for="(b, i) in deadBands" :key="`b${i}`">
            <rect :x="b.x" y="4" :width="Math.max(b.w, 2)" :height="CH - 8" fill="#9a917e" opacity="0.16" />
            <text :x="b.x + Math.max(b.w, 2) / 2" :y="CH / 2 + 2" class="band-label">僵持×{{ b.len }}</text>
          </g>
          <path v-if="curvePts.length" :d="curvePath" fill="none" stroke="#2f6fed" stroke-width="1.6" />
          <circle
            v-for="p in curvePts"
            :key="`p${p.ply}`"
            :cx="p.x"
            :cy="p.y"
            :r="p.dead ? 1.2 : 2"
            :fill="p.dead ? '#b0a488' : '#2f6fed'"
          />
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
            <title>第 {{ b.ply + 1 }} 手失误，估值跌 {{ b.drop.toFixed(2) }}</title>
          </circle>
          <line
            v-if="cursorX !== null"
            :x1="cursorX"
            :x2="cursorX"
            y1="4"
            :y2="CH - 4"
            stroke="#35301f"
            stroke-width="1"
            stroke-dasharray="3 2"
          />
        </svg>
      </div>
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
  gap: 16px;
  max-height: calc(100vh - 44px);
  overflow-y: auto;
  padding: 16px 6px 6px;
  scrollbar-width: thin;
}
.logo-sm {
  font-size: 26px;
  margin: 0;
  text-align: center;
  color: #35301f;
  letter-spacing: 8px;
}
.note {
  position: relative;
  padding: 12px 14px;
  font-size: 14px;
  line-height: 1.6;
  color: #35301f;
  background: #fbf6ea;
  border: 2px solid #3d3627;
  border-radius: 14px 4px 16px 4px / 4px 16px 4px 14px;
  box-shadow: 3px 3px 0 rgba(61, 54, 39, 0.18);
}
.status-note {
  font-weight: 700;
}
.meta-note {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.row-ctl {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #5c5340;
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
  width: 72px;
  text-align: center;
}
.btn-row {
  display: flex;
  gap: 10px;
}
.btn-row .btn-plain {
  flex: 1;
  padding: 6px 0;
}
.play-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.play-btn {
  padding: 4px 12px;
  font-size: 13px;
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
  background: #efe7d2;
  border: 1.5px dashed #b0a488;
  border-radius: 6px;
  color: #8a7f68;
  cursor: pointer;
}
.ply-info {
  margin: 8px 0 0;
  font-size: 12.5px;
  color: #6b5f47;
  line-height: 1.7;
}
.dev {
  color: #b91c1c;
}
.curve-title {
  margin: 0 0 6px;
  font-size: 13px;
  font-weight: 700;
}
.curve {
  display: block;
  width: 100%;
  height: auto;
}
.band-label {
  font-size: 7px;
  fill: #8a7f68;
  text-anchor: middle;
}
.blunder-dot {
  cursor: pointer;
  pointer-events: auto;
}
/* Q 值标签：随棋盘同坐标系缩放，白描边保证在光路上可读 */
.q-label {
  font-size: 6.5px;
  fill: #6b5f47;
  text-anchor: middle;
  paint-order: stroke;
  stroke: #fbf6ea;
  stroke-width: 2.4;
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
.laser-glow {
  fill: none;
  stroke-width: 9;
  stroke-opacity: 0.18;
  stroke-linecap: round;
  pointer-events: none;
}
.laser-core {
  fill: none;
  stroke-width: 2.4;
  stroke-opacity: 0.75;
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
