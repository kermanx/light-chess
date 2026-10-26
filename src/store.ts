import { computed, reactive, ref, watch } from 'vue'
import { defaultClockSettings, freshClock, normalizeClockSettings, timeLeft, type ClockSettings, type ClockState, type ClockSync } from './clock'
import {
  createsEnclosure,
  DEFAULT_SIZE,
  DX,
  DY,
  edgeOf,
  seatColors,
  simulate,
  type BoardState,
  type Color,
  type Diag,
  type Dir,
  type Home,
  type Mirror,
  type Ori,
} from './game'

export type Phase = 'lobby' | 'setup' | 'play' | 'over'

/** 上一步放置的镜子（家的自动镜不算），用于 UI 加粗高亮与撤回权限判定 */
export type LastMove =
  | { kind: 'edge'; id: string; color: Color }
  | { kind: 'diag'; key: string; color: Color }
  | null

/** 撤回一步要恢复的局面帧（放镜前的完整局面） */
export interface UndoFrame {
  edges: [string, Mirror][]
  diags: [string, Diag][]
  current: Color
  dead: Color[]
  winner: Color | null
  phase: Phase
  lastMove: LastMove
  clock?: ClockState
  timedOut?: Color[]
}

export type Action =
  | { kind: 'setup'; color: Color; home: Home }
  | { kind: 'edge'; color: Color; id: string }
  | { kind: 'diag'; color: Color; x: number; y: number; ori: Ori }
  | { kind: 'laser-setting'; color: Color; allow: boolean }
  | { kind: 'undo-setting'; color: Color; allow: boolean; floor?: number }
  | { kind: 'undo'; color: Color; frame: UndoFrame }
  | { kind: 'board-size'; color: Color; size: number }
  | { kind: 'boundary-setting'; color: Color; enabled: boolean }
  | { kind: 'clock-setting'; color: Color; settings: ClockSettings }
  | { kind: 'timeout'; color: Color; turn: number }
  | { kind: 'restart'; color: Color }

export const state = reactive({
  mode: null as 'local' | 'online' | null,
  /** 联机模式下本方颜色（座位由加入顺序决定） */
  myColor: null as Color | null,
  roomCode: '',
  /** 对方是否已掉线/离开 */
  peerLeft: false,
  /** 联机大厅：已就座人数（等待页进度） */
  roomJoined: 0,
  /** 座位表（回合顺序），players[0] 为房主 */
  players: seatColors(2) as Color[],
  phase: 'lobby' as Phase,
  homes: {} as Partial<Record<Color, Home>>,
  edges: new Map<string, Mirror>(),
  diags: new Map<string, Diag>(),
  current: 'blue' as Color,
  winner: null as Color | null,
  /** 已出局的玩家（家被击中；跳过回合，家显示为 ✕） */
  dead: [] as Color[],
  /** 联机：房主是否允许显示光路（默认禁止；单机始终允许） */
  laserAllowed: false,
  /** 联机：房主是否允许撤回一步（默认禁止；单机始终允许） */
  allowUndo: false,
  /** 开局前可改；开启时边界对所有颜色的光全反射 */
  boundaryReflects: true,
  clockSettings: defaultClockSettings(),
  clock: freshClock(defaultClockSettings()),
  timedOut: [] as Color[],
  /** 可撤回的底线（历史栈深度）：开启「允许撤回」时锁定，开启之前下的步骤不可撤 */
  undoFloor: 0,
  /** 上一步放置的镜子（用于加粗高亮；家的自动镜不算） */
  lastMove: null as LastMove,
  /** 本局会话 id（对局 URL /s/<id> 与存档对应，浏览器后退/前进恢复用） */
  sessionId: '',
  /** 棋盘格数（联机由房主调整） */
  size: DEFAULT_SIZE,
})

export const board: BoardState = {
  homes: state.homes,
  edges: state.edges,
  diags: state.diags,
  get size() {
    return state.size
  },
  get boundaryReflects() {
    return state.boundaryReflects
  },
}

/** 房主（0 号座位） */
export const hostColor = computed<Color>(() => state.players[0])

/** 回合顺序中的下一位存活玩家 */
const nextAlive = (c: Color): Color => {
  let i = state.players.indexOf(c)
  do {
    i = (i + 1) % state.players.length
  } while (state.dead.includes(state.players[i]))
  return state.players[i]
}

export const isHomeCell = (x: number, y: number) =>
  Object.values(state.homes).some((h) => h.x === x && h.y === y)

/** 选家合法性：不能落在任何一个家上，也不能与任何家相邻（含对角） */
export const isValidHomeCell = (x: number, y: number, _color: Color) => {
  if (isHomeCell(x, y)) return false
  return !Object.values(state.homes).some((h) => Math.max(Math.abs(h.x - x), Math.abs(h.y - y)) < 2)
}

/**
 * 出口合法性：不能朝向棋盘外（家在最外圈且出口贴边）。
 * 否则敌方激光无法从棋盘外进入唯一没有镜子的开口——这家永远打不死。
 */
export const isValidExit = (x: number, y: number, dir: Dir) => {
  const nx = x + DX[dir]
  const ny = y + DY[dir]
  return nx >= 0 && ny >= 0 && nx < state.size && ny < state.size
}

/** 试放完整基地，只禁止开局第一回合实际结算时立即淘汰玩家的布置。 */
export function isValidHomeSetup(home: Home, color: Color): boolean {
  if (!isValidHomeCell(home.x, home.y, color) || !isValidExit(home.x, home.y, home.dir)) return false
  const trial: BoardState = {
    homes: { ...state.homes, [color]: home },
    edges: new Map(state.edges),
    diags: state.diags,
    size: state.size,
    boundaryReflects: state.boundaryReflects,
  }
  for (const d of [0, 1, 2, 3] as Dir[]) {
    if (d !== home.dir) trial.edges.set(edgeOf(home.x, home.y, d), { color })
  }
  // 开局只结算先手；其他玩家的光路威胁留待其回合处理，先手仍有机会放镜自救。
  return !simulate(trial, state.players[0]).hit
}

/** 存活玩家的家（出局者的家不再参与围死判定） */
const aliveHomes = () => {
  const homes: Partial<Record<Color, Home>> = {}
  for (const [c, h] of Object.entries(state.homes)) {
    if (!state.dead.includes(c as Color)) homes[c as Color] = h
  }
  return homes
}

/** color 在 id 处放边镜是否会把某一对存活玩家的家隔开 */
export const wouldEnclose = (id: string, color: Color) => {
  const trial = new Map(state.edges)
  trial.set(id, { color })
  return createsEnclosure(trial, color, aliveHomes(), state.size, state.diags)
}

/** 斜镜与边镜采用同一套隔开判定，按本次落子的颜色单独计算。 */
export const wouldEncloseDiag = (x: number, y: number, ori: Ori, color: Color) => {
  const trial = new Map(state.diags)
  trial.set(`${x},${y}`, { color, ori })
  return createsEnclosure(state.edges, color, aliveHomes(), state.size, trial)
}

/** 棋盘尺寸合法范围 */
export const SIZE_MIN = 16
export const SIZE_MAX = 48

// ---------- 撤回一步的历史栈 ----------

/** 放镜历史（每手放镜前的局面帧）；重启/换尺寸/快照覆盖时清空 */
const moveHistory: UndoFrame[] = []
/** 可撤回的步数（UI 按钮禁用态用；响应式） */
export const undoDepth = ref(0)

const pushFrame = () => {
  moveHistory.push({
    edges: [...state.edges],
    diags: [...state.diags],
    current: state.current,
    dead: [...state.dead],
    winner: state.winner,
    phase: state.phase,
    lastMove: state.lastMove,
    clock: { ...state.clock, remaining: { ...state.clock.remaining } },
    timedOut: [...state.timedOut],
  })
  undoDepth.value = moveHistory.length
}

const clearHistory = () => {
  moveHistory.length = 0
  undoDepth.value = 0
  state.undoFloor = 0
}

/** 栈顶帧（撤回按钮点击时随 undo 动作广播，保证各端恢复同一局面） */
export const topUndoFrame = (): UndoFrame | null => moveHistory[moveHistory.length - 1] ?? null

/** 对局 URL：/s/<sessionId>；浏览器后退回大厅、前进恢复对局 */
const pushSessionUrl = () => {
  try {
    const base = location.pathname.replace(/s\/[^/]+\/?$/, '')
    history.pushState(null, '', `${base}s/${state.sessionId}`)
  } catch {
    // Node 测试等无 DOM 环境直接跳过
  }
}

function resetBoard() {
  // 注意：board.homes 持有本对象的引用，必须原地修改，不能整体替换
  for (const c of Object.keys(state.homes) as Color[]) delete state.homes[c]
  state.edges.clear()
  state.diags.clear()
  state.current = state.players[0]
  state.winner = null
  state.dead = []
  state.lastMove = null
  state.timedOut = []
  state.clock = freshClock(state.clockSettings, state.clock.revision + 1)
  clearHistory()
  state.phase = 'setup'
}

/** 进入单机模式 */
export function startLocal(playerCount = 2) {
  state.mode = 'local'
  state.myColor = null
  state.roomCode = ''
  state.peerLeft = false
  state.players = seatColors(playerCount)
  state.sessionId = crypto.randomUUID()
  resetBoard()
  pushSessionUrl()
}

/** 联机模式下所有人到齐，开始布置 */
export function startOnline(myColor: Color, roomCode: string, players: Color[]) {
  state.mode = 'online'
  state.myColor = myColor
  state.roomCode = roomCode
  state.peerLeft = false
  state.players = players
  state.sessionId = crypto.randomUUID()
  resetBoard()
  pushSessionUrl()
}

/** 回大厅，清空一切（存档保留在存储里，浏览器前进仍可恢复对局） */
export function toLobby() {
  state.mode = null
  state.myColor = null
  state.roomCode = ''
  state.peerLeft = false
  state.roomJoined = 0
  state.players = seatColors(2)
  state.phase = 'lobby'
  for (const c of Object.keys(state.homes) as Color[]) delete state.homes[c]
  state.edges.clear()
  state.diags.clear()
  state.winner = null
  state.dead = []
  state.lastMove = null
  state.sessionId = ''
  clearHistory()
  state.laserAllowed = false
  state.allowUndo = false
  state.boundaryReflects = true
  state.clockSettings = defaultClockSettings()
  state.clock = freshClock(state.clockSettings, state.clock.revision + 1)
  state.timedOut = []
  state.size = DEFAULT_SIZE
}

/**
 * 回合开头结算：只结算当前玩家的激光（命中需要消耗一个回合生效，
 * 被瞄准的玩家在自己的回合里有自救机会）。
 * 被打中的存活玩家出局；只剩一名存活玩家时其获胜。
 */
function settleTurn() {
  if (state.phase !== 'play') return
  const p = state.current
  if (state.dead.includes(p)) return
  const sim = simulate(board, p)
  for (const c of sim.hits) {
    if (c !== p && state.homes[c] && !state.dead.includes(c)) state.dead.push(c)
  }
  const alive = state.players.filter((c) => !state.dead.includes(c))
  if (alive.length === 1) {
    state.winner = alive[0]
    state.phase = 'over'
  }
}

/** 显示时钟独立于棋局状态，避免每次刷新数字都保存整盘棋。 */
export const clockNow = ref(Date.now())
let clockOffset = 0
let clockSender: (() => void) | null = null
export const isClockAuthority = () => state.mode !== 'online' || state.myColor === state.players[0]
const clockTime = (now = Date.now()) => isClockAuthority() ? now : now - clockOffset
export const remainingTime = (color: Color, now = clockNow.value) =>
  timeLeft(state.clock, color, state.current, clockTime(now))

function holdClock(at: number) {
  if (state.clock.runningSince === null) return
  state.clock.remaining[state.current] = timeLeft(state.clock, state.current, state.current, at)
  state.clock.runningSince = null
}

function startTurnClock(at: number) {
  state.clock.turn++
  state.clock.revision++
  state.clock.runningSince = state.clockSettings.enabled && state.phase === 'play' && !state.peerLeft ? at : null
}

export function serializeClock(now = Date.now()): ClockSync {
  const at = clockTime(now)
  const remaining = { ...state.clock.remaining }
  remaining[state.current] = timeLeft(state.clock, state.current, state.current, at)
  return { ...state.clock, remaining, runningSince: state.clock.runningSince === null ? null : at, at }
}

export function applyClockSync(sync: ClockSync, force = false) {
  if (!force && sync.revision < state.clock.revision) return
  clockOffset = isClockAuthority() ? 0 : Date.now() - sync.at
  state.clock = {
    remaining: { ...sync.remaining }, runningSince: sync.runningSince,
    turn: sync.turn, revision: sync.revision,
  }
  clockNow.value = Date.now()
}

export function setClockSender(fn: (() => void) | null) { clockSender = fn }
export function broadcastClock() {
  if (isClockAuthority() && state.mode === 'online' && state.clockSettings.enabled) clockSender?.()
}

/** 即使后台标签页延迟执行，也按真实截止时刻结算，不能靠延迟的落子抢救已超时棋钟。 */
export function tickClock(now = Date.now()): boolean {
  clockNow.value = now
  if (!isClockAuthority() || !state.clockSettings.enabled || state.peerLeft) return false
  let expired = false
  while (state.phase === 'play' && state.clock.runningSince !== null &&
    timeLeft(state.clock, state.current, state.current, now) <= 0) {
    const action: Action = { kind: 'timeout', color: state.current, turn: state.clock.turn }
    const deadline = state.clock.runningSince + state.clock.remaining[state.current]
    apply(action, deadline)
    if (state.mode === 'online') sender?.(action)
    expired = true
  }
  return expired
}

watch(() => state.peerLeft, (paused) => {
  if (!state.clockSettings.enabled || state.phase !== 'play') return
  if (paused) holdClock(clockTime())
  else if (isClockAuthority()) state.clock.runningSince = Date.now()
  if (isClockAuthority()) {
    state.clock.revision++
    broadcastClock()
  }
}, { flush: 'sync' })

function validate(a: Action, local: boolean): boolean {
  if (a.kind === 'timeout') {
    return !local && !isClockAuthority() && state.phase === 'play' &&
      a.color === state.current && a.turn === state.clock.turn
  }
  if (a.kind === 'restart') {
    if (state.phase === 'lobby') return false
    // 联机只有房主可以重新开始
    return state.mode !== 'online' || a.color === state.players[0]
  }
  // 联机模式本地操作只能以本方颜色发出
  if (local && state.mode === 'online' && a.color !== state.myColor) return false
  if (state.peerLeft) return false
  if (a.kind === 'laser-setting' || a.kind === 'undo-setting') {
    // 只有房主可以改光路/撤回设置
    return state.mode === 'online' && a.color === state.players[0]
  }
  if (a.kind === 'undo') {
    if (state.phase !== 'play' && state.phase !== 'over') return false
    // 单机同屏始终允许；联机需房主开启「允许撤回一步」，只能撤回自己刚下的那手，
    // 且不能撤到开启该设置之前的步骤（undoFloor 为开启时的栈深）
    return (
      state.mode === 'local' ||
      (state.allowUndo && state.lastMove?.color === a.color && undoDepth.value > state.undoFloor)
    )
  }
  if (a.kind === 'board-size' || a.kind === 'boundary-setting' || a.kind === 'clock-setting') {
    // 仅布置阶段可调；联机只有房主可调，单机任意
    if (state.phase !== 'setup') return false
    return state.mode === 'local' || a.color === state.players[0]
  }
  if (a.kind === 'setup') {
    if (state.phase !== 'setup' || state.homes[a.color]) return false
    if (!state.players.includes(a.color)) return false
    return isValidHomeSetup(a.home, a.color)
  }
  if (state.phase !== 'play' || a.color !== state.current) return false
  if (state.dead.includes(a.color)) return false // 出局者不能操作
  if (a.kind === 'edge') {
    if (state.edges.has(a.id)) return false
    return !wouldEnclose(a.id, a.color)
  }
  return !isHomeCell(a.x, a.y) && !state.diags.has(`${a.x},${a.y}`) &&
    !wouldEncloseDiag(a.x, a.y, a.ori, a.color)
}

function apply(a: Action, at = Date.now()) {
  if (a.kind === 'restart') {
    resetBoard()
    return
  }
  if (a.kind === 'laser-setting') {
    state.laserAllowed = a.allow
    return
  }
  if (a.kind === 'undo-setting') {
    state.allowUndo = a.allow
    // 开启时把当前栈深记为底线：之前下的步骤不可撤（floor 由房主端随动作带来，各端一致）
    state.undoFloor = a.allow ? (a.floor ?? undoDepth.value) : 0
    return
  }
  if (a.kind === 'boundary-setting') {
    state.boundaryReflects = a.enabled
    return
  }
  if (a.kind === 'clock-setting') {
    state.clockSettings = normalizeClockSettings(a.settings)
    state.clock = freshClock(state.clockSettings, state.clock.revision + 1)
    return
  }
  if (a.kind === 'timeout') {
    holdClock(at)
    state.clock.remaining[a.color] = 0
    state.dead.push(a.color)
    state.timedOut.push(a.color)
    clearHistory()
    const alive = state.players.filter(c => !state.dead.includes(c))
    if (alive.length === 1) {
      state.phase = 'over'
      state.winner = alive[0]
    } else {
      state.current = nextAlive(a.color)
      settleTurn()
    }
    startTurnClock(at)
    return
  }
  if (a.kind === 'undo') {
    // 各端都弹出各自栈顶（无刷新时各端栈完全一致）；
    // 恢复以动作携带的帧为准，刷新后栈深度不一致也不会分叉
    if (moveHistory.length) moveHistory.pop()
    undoDepth.value = moveHistory.length
    const f = a.frame
    state.edges.clear()
    for (const [k, v] of f.edges) state.edges.set(k, v)
    state.diags.clear()
    for (const [k, v] of f.diags) state.diags.set(k, v)
    state.current = f.current
    state.dead = [...f.dead]
    state.winner = f.winner
    state.phase = f.phase
    state.lastMove = f.lastMove
    state.timedOut = [...(f.timedOut ?? [])]
    if (f.clock) {
      state.clock = { ...f.clock, remaining: { ...f.clock.remaining }, revision: state.clock.revision + 1 }
      startTurnClock(at)
    }
    return
  }
  if (a.kind === 'board-size') {
    state.size = Math.max(SIZE_MIN, Math.min(SIZE_MAX, Math.round(a.size)))
    resetBoard()
    return
  }
  if (a.kind === 'setup') {
    state.homes[a.color] = a.home
    // 出口之外的 3 条边自动放镜
    for (const d of [0, 1, 2, 3] as Dir[]) {
      if (d !== a.home.dir) state.edges.set(edgeOf(a.home.x, a.home.y, d), { color: a.color })
    }
    if (state.players.every((c) => state.homes[c])) {
      state.phase = 'play'
      state.current = state.players[0]
      settleTurn()
      startTurnClock(at)
    }
    return
  }
  // 合法落子先扣实际用时；撤回恢复落子前的剩余时间，不重复赠送加秒。
  holdClock(at)
  pushFrame()
  if (state.clockSettings.enabled) state.clock.remaining[a.color] += state.clockSettings.incrementMs
  if (a.kind === 'edge') {
    state.edges.set(a.id, { color: a.color })
    state.lastMove = { kind: 'edge', id: a.id, color: a.color }
  } else {
    state.diags.set(`${a.x},${a.y}`, { color: a.color, ori: a.ori })
    state.lastMove = { kind: 'diag', key: `${a.x},${a.y}`, color: a.color }
  }
  if (state.phase === 'play') {
    state.current = nextAlive(a.color)
    settleTurn()
    startTurnClock(at)
  }
}

// 由 net 层注入，避免 store 依赖 WebSocket
let sender: ((a: Action) => void) | null = null
let waitForHost = false
export function setSender(fn: ((a: Action) => void) | null, deferLocal = false) {
  sender = fn
  waitForHost = deferLocal
}

/** 本地操作入口：校验 → 应用 →（联机时）广播 */
export function dispatch(a: Action) {
  if ((a.kind === 'edge' || a.kind === 'diag' || a.kind === 'undo') && tickClock()) return
  if (!validate(a, true)) return
  // 中继客人的动作由房主确认后通过 applyRemote 应用，避免刷新/重连时局面分叉。
  if (state.mode === 'online' && (waitForHost || (state.clockSettings.enabled && !isClockAuthority()))) {
    sender?.(a)
    return
  }
  apply(a)
  if (state.mode === 'online') sender?.(a)
}

/** 远端操作入口 */
export function applyRemote(a: Action, clock?: ClockSync) {
  if (isClockAuthority() && (a.kind === 'edge' || a.kind === 'diag' || a.kind === 'undo') && tickClock()) return false
  if (!validate(a, false)) return false
  apply(a, clock?.at ?? Date.now())
  if (clock) applyClockSync(clock, true)
  return true
}

/** 当前本地玩家是否可以操作 */
export const canAct = computed(() => {
  if (state.phase !== 'setup' && state.phase !== 'play') return false
  if (state.peerLeft) return false
  if (state.mode === 'local') return true
  if (state.phase === 'setup') return !state.homes[state.myColor!]
  return state.current === state.myColor
})

/** 单机 setup 阶段的当前布置方（按座位顺序依次布置） */
export const setupColor = computed<Color>(() => {
  if (state.mode === 'online') return state.myColor!
  return state.players.find((c) => !state.homes[c]) ?? state.players[0]
})

// ---------- 对局持久化（localStorage） ----------

export interface Snapshot {
  v: 1
  mode: 'local' | 'online'
  myColor: Color | null
  roomCode: string
  /** 座位表；缺省视为双人 */
  players?: Color[]
  phase: Phase
  homes: Partial<Record<Color, Home>>
  edges: [string, Mirror][]
  diags: [string, Diag][]
  current: Color
  winner: Color | null
  /** 已出局玩家；缺省视为无 */
  dead?: Color[]
  laserAllowed: boolean
  /** 缺省视为禁止撤回 */
  allowUndo?: boolean
  /** 老存档缺省为关闭，保留该局原来的边界规则 */
  boundaryReflects?: boolean
  clockSettings?: ClockSettings
  clock?: ClockSync
  timedOut?: Color[]
  /** 上一步放置的镜子；缺省视为无 */
  lastMove?: LastMove
  /** 对局会话 id（/s/<id>）；无此字段的存档视为旧格式，加载时直接忽略 */
  sessionId?: string
  size: number
}

export function serialize(): Snapshot {
  return {
    v: 1,
    mode: state.mode ?? 'local',
    myColor: state.myColor,
    roomCode: state.roomCode,
    players: [...state.players],
    phase: state.phase,
    homes: { ...state.homes },
    edges: [...state.edges],
    diags: [...state.diags],
    current: state.current,
    winner: state.winner,
    dead: [...state.dead],
    laserAllowed: state.laserAllowed,
    allowUndo: state.allowUndo,
    boundaryReflects: state.boundaryReflects,
    clockSettings: { ...state.clockSettings },
    clock: serializeClock(),
    timedOut: [...state.timedOut],
    lastMove: state.lastMove,
    sessionId: state.sessionId,
    size: state.size,
  }
}

/**
 * 用快照整体覆盖当前对局。
 * preserveIdentity：联机同步时保留本机身份（mode/myColor/roomCode/sessionId），
 * 因为快照来自对方序列化，身份字段是对方的（sessionId 是本机会话的 URL 标识，
 * 被对方的覆盖后，本机刷新时 URL 与存档会对不上，无法恢复）。
 */
export function applySnapshot(s: Snapshot, preserveIdentity = false) {
  if (!preserveIdentity) {
    state.mode = s.mode
    state.myColor = s.myColor
    state.roomCode = s.roomCode
    state.sessionId = s.sessionId ?? ''
  }
  state.players = s.players?.length ? s.players : seatColors(2)
  state.phase = s.phase
  // homes/edges/diags 被 board 引用，必须原地修改
  for (const c of Object.keys(state.homes) as Color[]) delete state.homes[c]
  if (s.homes) for (const [c, h] of Object.entries(s.homes)) state.homes[c as Color] = h
  state.edges.clear()
  for (const [k, v] of s.edges) state.edges.set(k, v)
  state.diags.clear()
  for (const [k, v] of s.diags) state.diags.set(k, v)
  state.current = s.current
  state.winner = s.winner
  state.dead = s.dead?.length ? [...s.dead] : []
  state.laserAllowed = s.laserAllowed
  state.allowUndo = s.allowUndo ?? false
  state.boundaryReflects = s.boundaryReflects ?? false
  state.clockSettings = s.clockSettings ? normalizeClockSettings(s.clockSettings) : { ...defaultClockSettings(), enabled: false }
  state.timedOut = [...(s.timedOut ?? [])]
  if (s.clock) applyClockSync(s.clock, true)
  else state.clock = freshClock(state.clockSettings)
  // 联机恢复先暂停在最近保存的剩余时间，待房主确认所有人重连后再启动。
  if (!preserveIdentity && s.mode === 'online') state.clock.runningSince = null
  state.lastMove = s.lastMove ?? null
  clearHistory() // 历史栈不随快照走，恢复后从空栈重新累计
  state.size = s.size
}

const SAVE_KEY = 'light-chess:save'

/** 可用的 Web Storage（Node 测试环境没有这两个全局量，返回空数组整体跳过持久化） */
const storages = (): Storage[] => {
  try {
    return [sessionStorage, localStorage]
  } catch {
    return []
  }
}

export function loadSave(): Snapshot | null {
  // sessionStorage（标签页私有，刷新保留）优先；localStorage 仅作浏览器重启后的兜底。
  // 同机双标签页共享 localStorage，若只读 localStorage 会拿到对方标签页的对局。
  for (const store of storages()) {
    try {
      const raw = store.getItem(SAVE_KEY)
      if (!raw) continue
      const s = JSON.parse(raw) as Snapshot
      // 旧格式（无 sessionId 或大厅态）不做兼容，直接忽略
      if (s.v !== 1 || !s.phase || s.phase === 'lobby' || !s.sessionId) continue
      return s
    } catch {
      // 读不出来就尝试下一个存储
    }
  }
  return null
}

export function persistGame() {
  if (state.phase === 'lobby') return
  for (const store of storages()) {
    try { store.setItem(SAVE_KEY, JSON.stringify(serialize())) } catch { /* 忽略存储不可用 */ }
  }
}

// 任何状态变化后自动落盘（sessionStorage + localStorage 双写）。
// 回到大厅时【不写也不删】——存档要保留，浏览器「前进」才能凭 /s/<id> 恢复对局；
// 大厅快照本身也会被 loadSave 过滤，写进去只会冲掉真正的对局存档。
watch(
  state,
  persistGame,
  { deep: true },
)
