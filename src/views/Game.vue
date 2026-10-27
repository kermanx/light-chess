<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import ClockSettings from '../components/ClockSettings.vue'
import ChessClock from '../components/ChessClock.vue'
import VictoryBeam from '../components/VictoryBeam.vue'
import GameResult from '../components/GameResult.vue'
import type { ClockSettings as ClockConfig } from '../clock'
import {
  edgeMid,
  edgeOf,
  PALETTE,
  simulate,
  simulateDirected,
  type Color,
  type Dir,
  type DirSegment,
  type Ori,
  type Pt,
} from '../game'
import {
  board,
  canAct,
  dispatch,
  hostColor,
  isHomeCell,
  isValidExit,
  isValidHomeCell,
  isValidHomeSetup,
  setupColor,
  SIZE_MAX,
  SIZE_MIN,
  state,
  topUndoFrame,
  undoDepth,
  wouldEnclose,
  wouldEncloseDiag,
} from '../store'
import { ai, humanTurn, retryAi, togglePause } from '../ai'
import { openReview } from '../review'

const S = 28 // 格距（px）
const PAD = 36
const N = computed(() => state.size)
const SIZE = computed(() => PAD * 2 + N.value * S)
const u = (v: number) => PAD + v * S

const COLORS = Object.fromEntries(PALETTE.map((p) => [p.id, p.hex])) as Record<Color, string>
const name = (c: Color) => `${PALETTE.find((p) => p.id === c)?.name ?? c}方`

const hoverEdge = ref<string | null>(null)
const hoverCell = ref<Pt | null>(null)
/** setup 阶段：已点选家、等待选出口的格子 */
const pendingHome = ref<Pt | null>(null)
const victoryDismissed = ref(false)
const victoryReady = ref(false)
const victoryImpacts = ref<Color[]>([])
watch(() => [state.phase, state.winner], () => {
  victoryDismissed.value = false
  victoryReady.value = false
  victoryImpacts.value = []
})
const hasVictoryPath = computed(() => Boolean(state.victoryReplay?.targets.length))
const replayVisible = computed(() => state.phase === 'over' && hasVictoryPath.value && !victoryDismissed.value)
const replayPlaying = computed(() => replayVisible.value && !victoryReady.value)
const isVisiblyDead = (color: Color) => state.dead.includes(color) && !(
  replayPlaying.value && state.victoryReplay?.targets.some(t => t.color === color) && !victoryImpacts.value.includes(color)
)

// ---------- 网格数据（随棋盘尺寸变化） ----------
const dots = computed(() => {
  const a: Pt[] = []
  for (let x = 0; x <= N.value; x++) for (let y = 0; y <= N.value; y++) a.push({ x, y })
  return a
})

const cells = computed(() => {
  const a: Pt[] = []
  for (let x = 0; x < N.value; x++) for (let y = 0; y < N.value; y++) a.push({ x, y })
  return a
})

interface EdgeRef {
  id: string
  x: number
  y: number
}
const hedges = computed(() => {
  const a: EdgeRef[] = []
  for (let x = 0; x < N.value; x++) for (let y = 0; y <= N.value; y++) a.push({ id: `h:${x}:${y}`, x, y })
  return a
})
const vedges = computed(() => {
  const a: EdgeRef[] = []
  for (let x = 0; x <= N.value; x++) for (let y = 0; y < N.value; y++) a.push({ id: `v:${x}:${y}`, x, y })
  return a
})

// ---------- 几何辅助 ----------
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

// ---------- 钢笔笔迹 ----------

/** 确定性哈希：同一面镜子每次渲染的笔迹形状一致 */
function hash01(s: string) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 1000) / 1000
}

/**
 * 钢笔笔画：一条沿主轴平滑微弯的墨条（填充路径，非描边直线）。
 * 中段压笔最粗、两端提笔略收窄；弯度与粗细由 seed 决定，不歪歪扭扭。
 */
function penStroke(x1: number, y1: number, x2: number, y2: number, w: number, seed: string) {
  const STEPS = 10
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const nx = -dy / len
  const ny = dx / len
  const bow = (hash01(`${seed}b`) - 0.5) * 1.4 // 整笔一个平滑微弯
  const wScale = 0.9 + hash01(`${seed}w`) * 0.25 // 整笔粗细浮动
  const tip = 0.55 + hash01(`${seed}t`) * 0.15 // 端点提笔后保留的宽度比例
  const a: string[] = []
  const b: string[] = []
  for (let i = 0; i <= STEPS; i++) {
    const t = i / STEPS
    const lift = Math.sin(Math.PI * t) // 0→1→0：两端提笔、中段压笔
    const cx = x1 + dx * t + nx * bow * lift
    const cy = y1 + dy * t + ny * bow * lift
    const half = (w / 2) * wScale * (tip + (1 - tip) * lift)
    a.push(`${i ? 'L' : 'M'}${(cx + nx * half).toFixed(2)} ${(cy + ny * half).toFixed(2)}`)
    b.unshift(`L${(cx - nx * half).toFixed(2)} ${(cy - ny * half).toFixed(2)}`)
  }
  return a.join('') + b.join('') + 'Z'
}

const isLastEdge = (id: string) => state.lastMove?.kind === 'edge' && state.lastMove.id === id
const isLastDiag = (key: string) => state.lastMove?.kind === 'diag' && state.lastMove.key === key
const edgePen = (id: string, w: number) => {
  const p = edgeLine(id)
  return penStroke(p.x1, p.y1, p.x2, p.y2, w, `e${id}`)
}
const diagPen = (key: string, ori: Ori, w: number) => {
  const [x, y] = key.split(',').map(Number)
  const p = diagLine(x, y, ori)
  return penStroke(p.x1, p.y1, p.x2, p.y2, w, `g${key}`)
}

const DIRS: Dir[] = [0, 1, 2, 3]
const DX = [1, 0, -1, 0]
const DY = [0, 1, 0, -1]

function arrowAt(x: number, y: number, dir: Dir) {
  const m = edgeMid(edgeOf(x, y, dir))
  const mx = u(m.x)
  const my = u(m.y)
  const tip = { x: mx + DX[dir] * 12, y: my + DY[dir] * 12 }
  const c = { x: mx + DX[dir] * 5, y: my + DY[dir] * 5 }
  const b1 = { x: c.x - DY[dir] * 6, y: c.y - DX[dir] * 6 }
  const b2 = { x: c.x + DY[dir] * 6, y: c.y + DX[dir] * 6 }
  return `${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`
}

// ---------- 选出口（pendingHome 后的方向选择） ----------
const svgEl = ref<SVGSVGElement | null>(null)
/** 悬停指向的出口方向 */
const hoverExitDir = ref<Dir | null>(null)

/** 家周围 3×3 格的方向热区（贴到棋盘边缘时裁剪） */
const exitOverlay = computed(() => {
  const h = pendingHome.value
  if (!h || state.phase !== 'setup') return null
  const x = Math.max(0, u(h.x) - S)
  const y = Math.max(0, u(h.y) - S)
  return {
    x,
    y,
    width: Math.min(SIZE.value, u(h.x) + 2 * S) - x,
    height: Math.min(SIZE.value, u(h.y) + 2 * S) - y,
  }
})

/** 鼠标位置相对家中心的主轴方向 */
function dirFromEvent(ev: MouseEvent): Dir | null {
  const h = pendingHome.value
  const svg = svgEl.value
  if (!h || !svg) return null
  const r = svg.getBoundingClientRect()
  const k = SIZE.value / r.width
  const dx = (ev.clientX - r.left) * k - u(h.x + 0.5)
  const dy = (ev.clientY - r.top) * k - u(h.y + 0.5)
  if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 0 : 2
  return dy > 0 ? 1 : 3
}

function exitMove(ev: MouseEvent) {
  hoverExitDir.value = dirFromEvent(ev)
}

function exitClick(ev: MouseEvent) {
  if (!canAct.value || !humanTurn()) return
  const h = pendingHome.value
  const dir = dirFromEvent(ev)
  if (!h || dir === null || !isValidHomeSetup({ ...h, dir }, setupColor.value)) return
  dispatch({ kind: 'setup', color: setupColor.value, home: { x: h.x, y: h.y, dir } })
  pendingHome.value = null
  hoverExitDir.value = null
}

const safeHomeDirs = (x: number, y: number) =>
  DIRS.filter(dir => isValidHomeSetup({ x, y, dir }, setupColor.value))

/** 每个开口方向单独试放三面家镜，排除先手开局立即命中的方向。 */
const exitDirs = computed<Dir[]>(() => {
  const h = pendingHome.value
  return h ? safeHomeDirs(h.x, h.y) : []
})

/** 待选家在最外圈（存在被禁用的出口方向）时给出提示 */
const edgeExitHint = computed(() => {
  const h = pendingHome.value
  return h !== null && DIRS.some(d => !isValidExit(h.x, h.y, d))
})

const unsafeExit = computed(() => {
  const h = pendingHome.value
  const dir = hoverExitDir.value
  return h !== null && dir !== null && isValidExit(h.x, h.y, dir) && !exitDirs.value.includes(dir)
})

/** 悬停方向的大箭头（从家中心连一条杆到出口边） */
function exitArrow(dir: Dir) {
  const h = pendingHome.value!
  const m = edgeMid(edgeOf(h.x, h.y, dir))
  const mx = u(m.x)
  const my = u(m.y)
  const tip = { x: mx + DX[dir] * 13, y: my + DY[dir] * 13 }
  const b1 = { x: mx - DY[dir] * 8, y: my - DX[dir] * 8 }
  const b2 = { x: mx + DY[dir] * 8, y: my + DX[dir] * 8 }
  return {
    shaft: { x1: u(h.x + 0.5), y1: u(h.y + 0.5), x2: mx, y2: my },
    points: `${tip.x},${tip.y} ${b1.x},${b1.y} ${b2.x},${b2.y}`,
  }
}
const exitPreview = computed(() =>
  hoverExitDir.value !== null && pendingHome.value && (exitDirs.value.includes(hoverExitDir.value) || unsafeExit.value)
    ? exitArrow(hoverExitDir.value)
    : null,
)

// ---------- 交互 ----------
function cellClick(x: number, y: number, backslash: boolean) {
  if (!canAct.value || !humanTurn()) {
    remindWait()
    return
  }
  if (state.phase === 'setup') {
    if (!pendingHome.value) {
      if (safeHomeDirs(x, y).length) pendingHome.value = { x, y }
    } else if (pendingHome.value.x === x && pendingHome.value.y === y) {
      pendingHome.value = null
    } else if (safeHomeDirs(x, y).length) {
      // 已有待选家时点击别的合法格子：直接改选
      pendingHome.value = { x, y }
      hoverExitDir.value = null
    }
    return
  }
  if (state.phase !== 'play') return
  dispatch({ kind: 'diag', color: setupOrCurrent(), x, y, ori: backslash !== shiftHeld.value ? '\\' : '/' })
}

function edgeClick(id: string) {
  if (!canAct.value || !humanTurn()) {
    remindWait()
    return
  }
  if (state.phase === 'setup') {
    const h = pendingHome.value
    if (!h) return
    const dir = DIRS.find((d) => edgeOf(h.x, h.y, d) === id)
    if (dir === undefined || !isValidHomeSetup({ ...h, dir }, setupColor.value)) return
    dispatch({ kind: 'setup', color: setupColor.value, home: { x: h.x, y: h.y, dir } })
    pendingHome.value = null
    return
  }
  if (state.phase !== 'play') return
  dispatch({ kind: 'edge', color: setupOrCurrent(), id })
}

const setupOrCurrent = () => (state.phase === 'setup' ? setupColor.value : state.current)

/** 选家阶段（尚未点出家）：禁用边热区，让整个格子都可点击 */
const edgeHitEnabled = computed(() => !(state.phase === 'setup' && !pendingHome.value))

/** 本机是否为房主侧（单机视为房主）：决定能否重新开始 */
const isHostSide = computed(() => state.mode === 'local' || state.myColor === hostColor.value)

function restart() {
  pendingHome.value = null
  dispatch({ kind: 'restart', color: state.mode === 'online' ? state.myColor! : state.players[0] })
}

// ---------- 撤回一步 ----------

/** 撤回是否开放：单机始终开放；联机由房主设置 */
const undoAvailable = computed(() => state.mode === 'local' || state.allowUndo)
const canUndoNow = computed(
  () =>
    undoAvailable.value &&
    undoDepth.value > 0 &&
    (state.phase === 'play' || state.phase === 'over') &&
    !state.peerLeft &&
    // 联机只能撤回自己刚下的那手，且不能撤到开启「允许撤回」之前的步骤
    (state.mode === 'local' ||
      (state.lastMove?.color === state.myColor && undoDepth.value > state.undoFloor)),
)

function undo() {
  const frame = topUndoFrame()
  if (!frame) return
  dispatch({ kind: 'undo', color: state.mode === 'online' ? state.myColor! : state.current, frame })
}

function toggleUndo(e: Event) {
  const allow = (e.target as HTMLInputElement).checked
  // 开启时带上当前栈深作为底线：开启之前下的步骤不可撤
  dispatch({ kind: 'undo-setting', color: hostColor.value, allow, floor: undoDepth.value })
}

// ---------- Shift 反向斜镜 ----------

/** 按住 Shift 时斜镜方向取反（左键放「\」、右键放「/」），预览同步翻转 */
const shiftHeld = ref(false)
const onKey = (e: KeyboardEvent) => {
  if (e.key === 'Shift') shiftHeld.value = e.type === 'keydown'
}
const onBlur = () => (shiftHeld.value = false)
onMounted(() => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('keyup', onKey)
  window.addEventListener('blur', onBlur)
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKey)
  window.removeEventListener('blur', onBlur)
})

// ---------- 等待时的提醒动画 ----------

/** 递增触发状态栏提醒动画（:key 重挂载重放） */
const nudge = ref(0)

/** 对方回合点击棋盘：状态栏描边脉冲提醒「还没轮到你」 */
function remindWait() {
  if (state.phase !== 'play' || state.peerLeft) return
  if (state.mode !== 'online' && !ai.mode) return
  nudge.value++
}

/** 放镜预览的颜色：联机等待时也按自己的颜色预览（筹划下一手） */
const previewColor = computed<Color>(() =>
  state.mode === 'online' ? state.myColor! : state.phase === 'setup' ? setupColor.value : state.current,
)

// ---------- 展示计算 ----------
const sims = computed(() => {
  const m = new Map<Color, ReturnType<typeof simulate>>()
  for (const c of state.players) if (!state.dead.includes(c)) m.set(c, simulate(board, c))
  return m
})

/** 光路显示：单机始终允许；联机由房主开关（默认禁止） */
const laserVisible = computed(() => state.mode === 'local' || state.laserAllowed)

/** 鼠标悬停的家（出局者的家已毁，不展示光路） */
const hoverHomeColor = computed<Color | null>(() => {
  const c = hoverCell.value
  if (!c || !laserVisible.value) return null
  for (const col of state.players) {
    if (state.dead.includes(col)) continue
    const h = state.homes[col]
    if (h && h.x === c.x && h.y === c.y) return col
  }
  return null
})
const showPath = computed(() => replayVisible.value ? null : hoverHomeColor.value)
/** AI 对战：全程展示双方光路（含结束后），便于观战 */
const showAllLasers = computed(() => ai.mode === 'aivai')

/** 该颜色当前是否展示光路；返回 null 表示不展示或已出局（出局者不再模拟） */
const laserSim = (c: Color) =>
  showPath.value === c || showAllLasers.value ? sims.value.get(c) ?? null : null

/** 有向光路段（传播方向箭头用；与 sims 同一批存活玩家） */
const dsims = computed(() => {
  const m = new Map<Color, DirSegment[]>()
  for (const c of state.players) if (!state.dead.includes(c)) m.set(c, simulateDirected(board, c))
  return m
})

/** 一段有向光路的箭头三角形（svg 像素坐标）；垂直微偏，让同格反向的两支箭不叠在一起 */
function arrowFor(seg: DirSegment) {
  const { p, q } = seg
  const dx = q.x - p.x
  const dy = q.y - p.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux
  const L = 0.16
  const W = 0.1
  const OFF = 0.07
  const cx = p.x + dx * 0.62 + nx * OFF
  const cy = p.y + dy * 0.62 + ny * OFF
  const tip = { x: cx + ux * L, y: cy + uy * L }
  const b1 = { x: cx - ux * L * 0.4 + nx * W, y: cy - uy * L * 0.4 + ny * W }
  const b2 = { x: cx - ux * L * 0.4 - nx * W, y: cy - uy * L * 0.4 - ny * W }
  return `${u(tip.x)},${u(tip.y)} ${u(b1.x)},${u(b1.y)} ${u(b2.x)},${u(b2.y)}`
}

const dirArrowMap = computed(() => {
  const m = new Map<Color, string[]>()
  for (const [c, segs] of dsims.value) m.set(c, segs.map(arrowFor))
  return m
})

function toggleLaser(e: Event) {
  dispatch({ kind: 'laser-setting', color: hostColor.value, allow: (e.target as HTMLInputElement).checked })
}

function changeSize(e: Event) {
  const v = Math.round(Number((e.target as HTMLInputElement).value))
  if (!Number.isFinite(v)) return
  dispatch({ kind: 'board-size', color: state.mode === 'online' ? hostColor.value : setupColor.value, size: v })
}

function toggleBoundary(e: Event) {
  dispatch({
    kind: 'boundary-setting',
    color: state.mode === 'online' ? hostColor.value : setupColor.value,
    enabled: (e.target as HTMLInputElement).checked,
  })
}

function changeClock(settings: ClockConfig) {
  dispatch({ kind: 'clock-setting', color: state.mode === 'online' ? hostColor.value : setupColor.value, settings })
}

// 棋盘尺寸变化会重置对局，清掉本地待选状态
watch(
  () => state.size,
  () => {
    pendingHome.value = null
  },
)

const segPath = (segments: [Pt, Pt][]) =>
  segments.map(([p, q]) => `M${u(p.x)} ${u(p.y)}L${u(q.x)} ${u(q.y)}`).join('')
const linePath = (pts: Pt[]) => pts.map((p) => `${u(p.x)},${u(p.y)}`).join(' ')

const ghostEdge = computed(() => {
  const id = hoverEdge.value
  // 对方回合也显示预览（仅不可点击），方便筹划下一手
  if (state.phase !== 'play' || !id || state.edges.has(id)) return null
  return id
})

/** 悬停的边若放镜会把家围死：给禁止预览 */
const ghostEdgeBad = computed(() => {
  const id = ghostEdge.value
  return id && wouldEnclose(id, previewColor.value) ? id : null
})

const ghostCell = computed(() => {
  const c = hoverCell.value
  if (state.phase !== 'play' || !c || isHomeCell(c.x, c.y) || state.diags.has(`${c.x},${c.y}`))
    return null
  return c
})

const ghostCellBad = computed(() => {
  const c = ghostCell.value
  return !!c && wouldEncloseDiag(c.x, c.y, shiftHeld.value ? '\\' : '/', previewColor.value)
})

/** setup 阶段悬停格子时的家预览 */
const ghostHome = computed(() => {
  const c = hoverCell.value
  if (
    !canAct.value ||
    !humanTurn() ||
    state.phase !== 'setup' ||
    pendingHome.value ||
    !c ||
    !isValidHomeCell(c.x, c.y, setupColor.value)
  )
    return null
  return c
})
const ghostHomeBad = computed(() => {
  const h = ghostHome.value
  return h !== null && safeHomeDirs(h.x, h.y).length === 0
})

const statusColor = computed<Color | null>(() => {
  if (state.phase === 'over') return state.winner
  if (state.phase === 'setup') return setupColor.value
  return state.current
})

const statusText = computed(() => {
  if (replayPlaying.value) return '致胜光路…'
  if (state.peerLeft) return '有玩家掉线，等待重连…'
  if (ai.mode && ai.error) return `AI 服务出错：${ai.error}`
  if (ai.mode && ai.thinking) return `${name(statusColor.value ?? state.current)} AI 思考中…`
  if (ai.mode === 'aivai' && ai.paused && state.phase !== 'over') return '已暂停（点击侧栏「继续」恢复）'
  if (ghostEdgeBad.value || ghostCellBad.value) return '此处放镜会把某对玩家的家隔开，不能放'
  if (state.phase === 'over') return `${name(state.winner!)}获胜！`
  if (state.phase === 'setup') {
    if (ghostHomeBad.value) return '这个位置会让先手在开局立即命中基地，请换一个位置'
    if (unsafeExit.value) return '这个开口会让先手在开局立即命中基地，请换个方向或位置'
    if (state.mode === 'online') {
      if (!state.homes[state.myColor!])
        return pendingHome.value
          ? edgeExitHint.value
            ? '边缘格子的出口不能朝向棋盘外，换个方向'
            : '移动鼠标选择家的开口方向，点击确认'
          : '轮到你布置：点击一个格子作为家'
      return '等待其他玩家布置…'
    }
    const p = name(setupColor.value)
    return pendingHome.value
      ? edgeExitHint.value
        ? `${p}：边缘格子的出口不能朝向棋盘外，换个方向`
        : `${p}：移动鼠标选择家的开口方向，点击确认`
      : `${p}：点击一个格子作为家`
  }
  if (state.mode === 'online')
    return state.current === state.myColor ? '你的回合：放置一面镜子' : `等待${name(state.current)}放置镜子…`
  return `${name(state.current)}回合：点击网格边放边镜；左键格子放「/」斜镜，右键放「\\」斜镜（按住 Shift 反向）`
})
</script>

<template>
  <div class="game">
    <div class="paper board-wrap">
      <svg ref="svgEl" class="board-svg" :viewBox="`0 0 ${SIZE} ${SIZE}`">
        <!-- 格子点击层 -->
        <rect
          v-for="c in cells"
          :key="`c${c.x},${c.y}`"
          :x="u(c.x)"
          :y="u(c.y)"
          :width="S"
          :height="S"
          fill="transparent"
          class="hit"
          @click="cellClick(c.x, c.y, false)"
          @contextmenu.prevent="cellClick(c.x, c.y, true)"
          @mouseenter="hoverCell = c"
          @mouseleave="hoverCell = null"
        />

        <!-- 网格点（清晰圆点，不做笔迹处理） -->
        <circle v-for="d in dots" :key="`d${d.x},${d.y}`" :cx="u(d.x)" :cy="u(d.y)" r="2" class="dot" />

        <!-- 镜子：钢笔笔迹的填充墨条（上一步放置的用更粗的一笔） -->
        <g>
          <!-- 边镜 -->
          <path
            v-for="[id, m] in state.edges"
            :key="`e${id}`"
            :d="edgePen(id, isLastEdge(id) ? 3.4 : 2.4)"
            :fill="COLORS[m.color]"
            fill-opacity="0.92"
            :data-edge="id"
            :data-last="isLastEdge(id) ? '1' : null"
            class="no-events"
          />

          <!-- 斜镜 -->
          <path
            v-for="[key, g] in state.diags"
            :key="`g${key}`"
            :d="diagPen(key, g.ori, isLastDiag(key) ? 3.2 : 2.2)"
            :fill="COLORS[g.color]"
            fill-opacity="0.92"
            :data-diag="key"
            :data-ori="g.ori"
            :data-last="isLastDiag(key) ? '1' : null"
            class="no-events"
          />
        </g>

        <!-- setup：待选的家（圆点预览）与出口候选箭头 -->
        <g v-if="pendingHome">
          <circle
            :cx="u(pendingHome.x + 0.5)"
            :cy="u(pendingHome.y + 0.5)"
            :r="S * 0.2"
            :fill="COLORS[setupColor]"
            fill-opacity="0.55"
            class="no-events"
          />
          <!-- 未悬停时四个候选方向呼吸提示；悬停时只突出当前方向 -->
          <template v-if="!exitPreview">
            <polygon
              v-for="d in exitDirs"
              :key="`exit${d}`"
              :points="arrowAt(pendingHome.x, pendingHome.y, d)"
              :fill="COLORS[setupColor]"
              fill-opacity="0.65"
              class="no-events pulse"
            />
          </template>
          <template v-else>
            <line
              v-bind="exitPreview.shaft"
              :stroke="unsafeExit ? '#b91c1c' : COLORS[setupColor]"
              stroke-width="3"
              stroke-opacity="0.75"
              stroke-linecap="round"
              class="no-events"
            />
            <polygon
              :points="exitPreview.points"
              :fill="unsafeExit ? '#b91c1c' : COLORS[setupColor]"
              :data-unsafe-exit="unsafeExit ? '1' : null"
              class="no-events"
            />
          </template>
        </g>

        <!-- 光路（悬停对应颜色的家时显示；AI 对战全程显示双方） -->
        <template v-for="c in state.players" :key="`l${c}`">
          <g v-if="laserSim(c)" :style="{ color: COLORS[c] }">
            <path
              v-if="laserSim(c)!.segments.length"
              :d="segPath(laserSim(c)!.segments)"
              :stroke="COLORS[c]"
              class="laser-glow"
            />
            <path
              v-if="laserSim(c)!.segments.length"
              :d="segPath(laserSim(c)!.segments)"
              :stroke="COLORS[c]"
              class="laser-core"
            />
            <!-- 传播方向箭头（同格折返的两条反向段会画出一来一回两支箭） -->
            <polygon
              v-for="(a, i) in dirArrowMap.get(c) ?? []"
              :key="`a${c}-${i}`"
              :points="a"
              :fill="COLORS[c]"
              class="laser-arrow"
            />
            <template v-if="laserSim(c)!.hitPath">
              <polyline
                :points="linePath(laserSim(c)!.hitPath!)"
                :stroke="COLORS[c]"
                class="laser-hit"
              />
              <polyline
                :points="linePath(laserSim(c)!.hitPath!)"
                class="laser-hit-core"
              />
            </template>
          </g>
        </template>

        <!-- 家：小圆点；出局者的家变为 ✕（钢笔笔迹，画在光路之上） -->
        <g>
          <template v-for="c in state.players" :key="c">
            <template v-if="state.homes[c]">
              <circle
                v-if="!isVisiblyDead(c)"
                :data-home="c"
                :cx="u(state.homes[c]!.x + 0.5)"
                :cy="u(state.homes[c]!.y + 0.5)"
                :r="S * 0.2"
                :fill="COLORS[c]"
                class="no-events"
              />
              <g v-else class="dead-x no-events" :fill="COLORS[c]" :data-dead-home="c">
                <path
                  :d="
                    penStroke(
                      u(state.homes[c]!.x + 0.5) - S * 0.22,
                      u(state.homes[c]!.y + 0.5) - S * 0.22,
                      u(state.homes[c]!.x + 0.5) + S * 0.22,
                      u(state.homes[c]!.y + 0.5) + S * 0.22,
                      2.6,
                      `x${c}a`,
                    )
                  "
                />
                <path
                  :d="
                    penStroke(
                      u(state.homes[c]!.x + 0.5) - S * 0.22,
                      u(state.homes[c]!.y + 0.5) + S * 0.22,
                      u(state.homes[c]!.x + 0.5) + S * 0.22,
                      u(state.homes[c]!.y + 0.5) - S * 0.22,
                      2.6,
                      `x${c}b`,
                    )
                  "
                />
              </g>
            </template>
          </template>
        </g>

        <!-- 悬停虚影：边镜 / 斜镜 / 选家预览 / 围死禁止 -->
        <template v-if="ghostEdge">
          <line
            v-bind="edgeLine(ghostEdge)"
            :stroke="ghostEdgeBad ? '#b91c1c' : COLORS[previewColor]"
            :stroke-opacity="ghostEdgeBad ? 0.55 : 0.45"
            stroke-width="2.6"
            stroke-linecap="round"
            :stroke-dasharray="ghostEdgeBad ? '5 4' : ''"
            class="no-events"
          />
          <g v-if="ghostEdgeBad" class="no-events">
            <circle
              :cx="u(edgeMid(ghostEdge).x)"
              :cy="u(edgeMid(ghostEdge).y)"
              r="8"
              fill="none"
              stroke="#b91c1c"
              stroke-width="2"
            />
            <line
              :x1="u(edgeMid(ghostEdge).x) - 5.5"
              :y1="u(edgeMid(ghostEdge).y) + 5.5"
              :x2="u(edgeMid(ghostEdge).x) + 5.5"
              :y2="u(edgeMid(ghostEdge).y) - 5.5"
              stroke="#b91c1c"
              stroke-width="2"
              stroke-linecap="round"
            />
          </g>
        </template>
        <line
          v-if="ghostCell"
          v-bind="diagLine(ghostCell.x, ghostCell.y, shiftHeld ? '\\' : '/')"
          :stroke="ghostCellBad ? '#b91c1c' : COLORS[previewColor]"
          :stroke-opacity="ghostCellBad ? 0.55 : 0.45"
          :stroke-dasharray="ghostCellBad ? '5 4' : ''"
          stroke-width="2.4"
          stroke-linecap="round"
          class="no-events"
        />
        <circle
          v-if="ghostHome"
          :cx="u(ghostHome.x + 0.5)"
          :cy="u(ghostHome.y + 0.5)"
          :r="S * 0.2"
          :fill="ghostHomeBad ? '#b91c1c' : COLORS[setupColor]"
          :data-unsafe-home="ghostHomeBad ? '1' : null"
          fill-opacity="0.3"
          class="no-events"
        />

        <!-- 边点击层 -->
        <rect
          v-for="e in hedges"
          :key="`hh${e.id}`"
          :x="u(e.x)"
          :y="u(e.y) - 6"
          :width="S"
          :height="12"
          fill="transparent"
          :class="edgeHitEnabled ? 'hit' : 'hit-off'"
          @click="edgeClick(e.id)"
          @mouseenter="hoverEdge = e.id"
          @mouseleave="hoverEdge = null"
        />
        <rect
          v-for="e in vedges"
          :key="`hv${e.id}`"
          :x="u(e.x) - 6"
          :y="u(e.y)"
          :width="12"
          :height="S"
          fill="transparent"
          :class="edgeHitEnabled ? 'hit' : 'hit-off'"
          @click="edgeClick(e.id)"
          @mouseenter="hoverEdge = e.id"
          @mouseleave="hoverEdge = null"
        />

        <!-- 选出口热区：家周围 3×3 格，按主轴方向判定，置于最上层 -->
        <rect
          v-if="exitOverlay"
          v-bind="exitOverlay"
          fill="transparent"
          class="hit"
          @mousemove="exitMove"
          @mouseleave="hoverExitDir = null"
          @click="exitClick"
        />
        <VictoryBeam v-if="replayVisible && state.victoryReplay" :replay="state.victoryReplay" :spacing="S" :padding="PAD"
          @impact="victoryImpacts.push($event)" @complete="victoryReady = true" />
      </svg>

      <GameResult v-if="state.phase === 'over' && state.winner && !victoryDismissed && (!hasVictoryPath || victoryReady)"
        :winner="state.winner" :timed-out="state.timedOut" :laser-win="hasVictoryPath" @confirm="victoryDismissed = true" />
    </div>

    <aside class="side">
      <h1 class="logo-sm">光镜棋</h1>

      <div :key="nudge" class="note status-note" :class="[statusColor ?? '', { nudged: nudge > 0 }]">{{ statusText }}</div>
      <ChessClock />

      <div class="note meta-note">
        <label
          v-if="state.phase === 'setup' && (state.mode === 'local' || state.myColor === hostColor)"
          class="size-ctl"
        >
          棋盘
          <input
            type="number"
            :min="SIZE_MIN"
            :max="SIZE_MAX"
            :value="state.size"
            @change="changeSize"
          />
          × {{ state.size }}
        </label>
        <span v-else class="room">棋盘 {{ state.size }}×{{ state.size }}</span>
        <span v-if="state.mode === 'online'" class="room">
          房间 {{ state.roomCode }} · 你执{{ name(state.myColor!) }}
        </span>
        <template v-if="ai.mode">
          <span v-for="c in state.players" :key="`ai-${c}`" class="room" :style="{ color: COLORS[c] }">
            {{ name(c) }}：{{ ai.mode === 'human' && c === ai.humanColor ? '你' : (ai.ckpts[c] || 'AI') }}
          </span>
          <span class="room">MCTS sims：{{ ai.sims }}</span>
        </template>
        <span
          v-for="c in state.players.filter((c) => state.dead.includes(c))"
          :key="`dead-${c}`"
          class="room"
          :style="{ color: COLORS[c] }"
        >
          ✕ {{ name(c) }}{{ state.timedOut.includes(c) ? '超时出局' : '已出局' }}
        </span>
      </div>

      <div class="ctl-note note">
      <ClockSettings :settings="state.clockSettings" :disabled="state.phase !== 'setup' || !isHostSide" @change="changeClock" />
      <label class="chk">
        <input type="checkbox" :checked="state.boundaryReflects"
          :disabled="state.phase !== 'setup' || !isHostSide" @change="toggleBoundary" />
        边界反射
      </label>
      <template v-if="state.mode === 'online' && state.myColor === hostColor">
        <label class="chk">
          <input type="checkbox" :checked="state.laserAllowed" @change="toggleLaser" />
          允许显示光路
        </label>
        <label class="chk">
          <input type="checkbox" :checked="state.allowUndo" @change="toggleUndo" />
          允许撤回一步
        </label>
      </template>
      <span v-else-if="state.mode === 'online'" class="laser-tag">
        光路显示：{{ state.laserAllowed ? '允许' : '禁止' }}（由房主设置）
      </span>
      <span v-else class="laser-tag">鼠标悬停在「家」上可查看光路</span>
      <div v-if="undoAvailable || isHostSide" class="btn-row">
        <button v-if="ai.mode === 'aivai'" class="btn-plain" @click="togglePause">
          {{ ai.paused ? '继续' : '暂停' }}
        </button>
        <button v-if="ai.mode && ai.error" class="btn-plain" @click="retryAi">重试 AI</button>
        <button v-if="undoAvailable && !ai.mode" class="btn-plain" :disabled="!canUndoNow" @click="undo">撤回一步</button>
        <button v-if="state.phase === 'over' && state.mode === 'local'" class="btn-plain" @click="openReview()">复盘分析</button>
        <button v-if="isHostSide" class="btn-plain" @click="restart">重新开始</button>
      </div>
    </div>

    <div class="note help-note">
      <h3>怎么玩</h3>
      <div class="help-body">
        <p><b>目标</b>：让自家的激光经镜面反射，打到别人的家。</p>
        <p><b>开局</b>：各选一个格子当家并指定开口，其余 3 条边自动放上你的镜子。家向四个方向发光，光线也能穿过自己的家镜。</p>
        <p><b>放镜</b>：轮流每回合放一面，不可移除。点网格边放边镜；左键格子放「/」、右键放「\」斜镜，Shift 反向。对方基地的开口也可放镜，仍须遵守禁围规则。</p>
        <p><b>反射</b>：自己的镜子对自己半反射（穿过+反射），别人的镜子只反射。</p>
        <p><b>边界</b>：开启「边界反射」时，边界对所有光线全反射；关闭时出界光线终止。开局后不可更改。</p>
        <p><b>限制</b>：每种颜色的边镜、斜镜分别连同边框，不能把仍在场的基地彼此隔开；所有基地仍在同一区域时允许。</p>
        <p><b>布置</b>：允许基地同排或同列，只禁止先手在开局立即命中基地的布置；后续回合的光路威胁仍可通过放镜化解。</p>
        <p><b>结算</b>：轮到谁就在其回合开头结算其激光；被打中出局（✕）。双人打中即胜，多人活到最后获胜。</p>
        <p><b>棋钟</b>：只扣当前行动者的时间，合法放镜后加秒；超时出局，多人局继续。掉线等待重连时暂停。</p>
      </div>
    </div>
    </aside>
  </div>
</template>

<style scoped>
.game {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 26px;
  width: 100%;
}
/* 右侧便签栏 */
.side {
  flex: none;
  width: 264px;
  display: flex;
  flex-direction: column;
  gap: 18px;
  max-height: calc(100vh - 44px);
  padding: 16px 6px 6px;
}
.logo-sm {
  font-size: 26px;
  margin: 0;
  text-align: center;
  color: #35301f;
  transform: rotate(-2deg);
  letter-spacing: 8px;
}
/* 小便签：手抖边框 + 顶部胶带 */
.note {
  position: relative;
  padding: 13px 14px 12px;
  font-size: 14px;
  line-height: 1.6;
  color: #35301f;
  background: #fbf6ea;
  border: 2px solid #3d3627;
  border-radius: 14px 4px 16px 4px / 4px 16px 4px 14px;
  box-shadow: 3px 3px 0 rgba(61, 54, 39, 0.18);
}
.note::before {
  content: '';
  position: absolute;
  top: -10px;
  left: 50%;
  width: 62px;
  height: 18px;
  transform: translateX(-50%) rotate(-2deg);
  background: rgba(232, 202, 122, 0.6);
  border-left: 1px dashed rgba(70, 64, 46, 0.3);
  border-right: 1px dashed rgba(70, 64, 46, 0.3);
  box-shadow: 0 1px 2px rgba(70, 64, 46, 0.2);
  pointer-events: none;
}
.side .note:nth-child(2n + 1) {
  transform: rotate(0.6deg);
}
.side .note:nth-child(2n) {
  transform: rotate(-0.5deg);
}
.status-note {
  font-weight: 700;
}
.status-note.blue {
  border-color: #2f6fed;
  color: #2f6fed;
}
.status-note.red {
  border-color: #e84a3c;
  color: #e84a3c;
}
.status-note.yellow {
  border-color: #dd9a10;
  color: #b57d0a;
}
.status-note.green {
  border-color: #34a05c;
  color: #2c8a4e;
}
/* 对方回合点击棋盘时的提醒：描边脉冲（outline 不影响布局大小） */
.status-note.nudged {
  outline: 2px solid transparent;
  outline-offset: 3px;
  animation: status-nudge 0.65s ease-out;
}
@keyframes status-nudge {
  0% {
    outline-width: 2px;
    outline-color: transparent;
  }
  30% {
    outline-width: 4px;
    outline-color: currentColor;
  }
  60% {
    outline-width: 2.5px;
    outline-color: currentColor;
  }
  100% {
    outline-width: 2px;
    outline-color: transparent;
  }
}
.wait-host {
  font-size: 13px;
  color: #8a7f68;
}
.meta-note {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.room {
  font-size: 13px;
  color: #8a7f68;
}
.size-ctl {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #8a7f68;
}
.size-ctl input {
  width: 58px;
  padding: 3px 6px;
  font-size: 13px;
  font-family: inherit;
  text-align: center;
  background: #fffdf6;
  border: 2px solid #3d3627;
  border-radius: 8px;
  outline: none;
  color: #35301f;
}
.board-wrap {
  position: relative;
  flex: none;
  width: min(calc(100vh - 44px), calc(100vw - 350px), 1500px);
  /* 大幅收窄"手抖"圆角，保证整张网格都在纸面内 */
  border-radius: 26px 12px 30px 12px / 12px 30px 12px 26px;
}
.board-wrap::before,
.board-wrap::after {
  content: '';
  position: absolute;
  top: -13px;
  width: 96px;
  height: 26px;
  background: rgba(232, 202, 122, 0.6);
  border-left: 1px dashed rgba(70, 64, 46, 0.3);
  border-right: 1px dashed rgba(70, 64, 46, 0.3);
  box-shadow: 0 1px 3px rgba(70, 64, 46, 0.25);
  z-index: 2;
  pointer-events: none;
}
.board-wrap::before {
  left: 8%;
  transform: rotate(-4deg);
}
.board-wrap::after {
  right: 8%;
  transform: rotate(3deg);
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
.hit {
  cursor: pointer;
}
.hit-off {
  pointer-events: none;
}
.no-events {
  pointer-events: none;
}
.pulse {
  animation: pulse 1.2s ease-in-out infinite;
}
@keyframes pulse {
  0%, 100% { opacity: 0.65; }
  50% { opacity: 0.2; }
}
.laser-glow {
  fill: none;
  stroke-width: 11;
  stroke-opacity: 0.3;
  stroke-linecap: round;
  pointer-events: none;
}
.laser-core {
  fill: none;
  stroke-width: 3.2;
  stroke-opacity: 0.95;
  stroke-linecap: round;
  pointer-events: none;
}
.laser-arrow {
  pointer-events: none;
  animation: pulse 1.6s ease-in-out infinite;
}
.laser-hit {
  fill: none;
  stroke-width: 4.5;
  stroke-linejoin: round;
  stroke-linecap: round;
  filter: drop-shadow(0 0 6px currentColor);
  pointer-events: none;
}
.laser-hit-core {
  fill: none;
  stroke: #fffdf0;
  stroke-width: 1.6;
  stroke-linejoin: round;
  stroke-linecap: round;
  stroke-opacity: 0.9;
  pointer-events: none;
}
.ctl-note {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.chk {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  color: #5c5340;
}
.chk input {
  accent-color: #2f6fed;
}
.laser-tag {
  font-size: 13px;
  color: #8a7f68;
}
.btn-row {
  display: flex;
  gap: 10px;
}
.btn-row .btn-plain {
  flex: 1;
  padding: 7px 0;
}
.help-note h3 {
  margin: 0;
  font-size: 14px;
  font-weight: 700;
}
/* 规则文本区域内部滚动，侧栏整体不滚 */
.help-note {
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.help-body {
  overflow-y: auto;
  min-height: 0;
  scrollbar-width: thin;
}
.help-note p {
  margin: 8px 0 0;
  font-size: 12.5px;
  line-height: 1.75;
  color: #8a7f68;
}
.help-note p b {
  color: #6b5f47;
}
/* 窄屏回退为上下布局 */
@media (max-width: 980px) {
  .game {
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
