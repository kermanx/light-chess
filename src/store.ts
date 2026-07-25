import { computed, reactive, watch } from 'vue'
import {
  createsEnclosure,
  DEFAULT_SIZE,
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

export type Action =
  | { kind: 'setup'; color: Color; home: Home }
  | { kind: 'edge'; color: Color; id: string }
  | { kind: 'diag'; color: Color; x: number; y: number; ori: Ori }
  | { kind: 'laser-setting'; color: Color; allow: boolean }
  | { kind: 'board-size'; color: Color; size: number }
  | { kind: 'restart' }

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

export const isPortEdge = (id: string) =>
  Object.values(state.homes).some((h) => edgeOf(h.x, h.y, h.dir) === id)

/** 选家合法性：不能落在任何一个家上，也不能与任何家相邻（含对角） */
export const isValidHomeCell = (x: number, y: number, _color: Color) => {
  if (isHomeCell(x, y)) return false
  return !Object.values(state.homes).some((h) => Math.max(Math.abs(h.x - x), Math.abs(h.y - y)) < 2)
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
  return createsEnclosure(trial, color, aliveHomes(), state.size)
}

/** 棋盘尺寸合法范围 */
export const SIZE_MIN = 16
export const SIZE_MAX = 48

function resetBoard() {
  // 注意：board.homes 持有本对象的引用，必须原地修改，不能整体替换
  for (const c of Object.keys(state.homes) as Color[]) delete state.homes[c]
  state.edges.clear()
  state.diags.clear()
  state.current = state.players[0]
  state.winner = null
  state.dead = []
  state.phase = 'setup'
}

/** 进入单机模式 */
export function startLocal(playerCount = 2) {
  state.mode = 'local'
  state.myColor = null
  state.roomCode = ''
  state.peerLeft = false
  state.players = seatColors(playerCount)
  resetBoard()
}

/** 联机模式下所有人到齐，开始布置 */
export function startOnline(myColor: Color, roomCode: string, players: Color[]) {
  state.mode = 'online'
  state.myColor = myColor
  state.roomCode = roomCode
  state.peerLeft = false
  state.players = players
  resetBoard()
}

/** 回大厅，清空一切 */
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
  state.laserAllowed = false
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

function validate(a: Action, local: boolean): boolean {
  if (a.kind === 'restart') return state.phase !== 'lobby'
  // 联机模式本地操作只能以本方颜色发出
  if (local && state.mode === 'online' && a.color !== state.myColor) return false
  if (state.peerLeft) return false
  if (a.kind === 'laser-setting') {
    // 只有房主可以改光路设置
    return state.mode === 'online' && a.color === state.players[0]
  }
  if (a.kind === 'board-size') {
    // 仅布置阶段可调；联机只有房主可调，单机任意
    if (state.phase !== 'setup') return false
    return state.mode === 'local' || a.color === state.players[0]
  }
  if (a.kind === 'setup') {
    if (state.phase !== 'setup' || state.homes[a.color]) return false
    if (!state.players.includes(a.color)) return false
    return isValidHomeCell(a.home.x, a.home.y, a.color)
  }
  if (state.phase !== 'play' || a.color !== state.current) return false
  if (state.dead.includes(a.color)) return false // 出局者不能操作
  if (a.kind === 'edge') {
    if (isPortEdge(a.id) || state.edges.has(a.id)) return false
    return !wouldEnclose(a.id, a.color)
  }
  return !isHomeCell(a.x, a.y) && !state.diags.has(`${a.x},${a.y}`)
}

function apply(a: Action) {
  if (a.kind === 'restart') {
    resetBoard()
    return
  }
  if (a.kind === 'laser-setting') {
    state.laserAllowed = a.allow
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
    }
    return
  }
  if (a.kind === 'edge') state.edges.set(a.id, { color: a.color })
  else state.diags.set(`${a.x},${a.y}`, { color: a.color, ori: a.ori })
  if (state.phase === 'play') {
    state.current = nextAlive(a.color)
    settleTurn()
  }
}

// 由 net 层注入，避免 store 依赖 WebSocket
let sender: ((a: Action) => void) | null = null
export function setSender(fn: ((a: Action) => void) | null) {
  sender = fn
}

/** 本地操作入口：校验 → 应用 →（联机时）广播 */
export function dispatch(a: Action) {
  if (!validate(a, true)) return
  apply(a)
  if (state.mode === 'online') sender?.(a)
}

/** 远端操作入口 */
export function applyRemote(a: Action) {
  if (!validate(a, false)) return
  apply(a)
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
  /** 座位表；旧存档缺省视为双人 */
  players?: Color[]
  phase: Phase
  homes: Partial<Record<Color, Home>>
  edges: [string, Mirror][]
  diags: [string, Diag][]
  current: Color
  winner: Color | null
  /** 已出局玩家；旧存档缺省视为无 */
  dead?: Color[]
  laserAllowed: boolean
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
    size: state.size,
  }
}

/**
 * 用快照整体覆盖当前对局。
 * preserveIdentity：联机同步时保留本机身份（mode/myColor/roomCode），
 * 因为快照来自对方序列化，身份字段是对方的。
 */
export function applySnapshot(s: Snapshot, preserveIdentity = false) {
  if (!preserveIdentity) {
    state.mode = s.mode
    state.myColor = s.myColor
    state.roomCode = s.roomCode
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
  state.size = s.size
}

const SAVE_KEY = 'light-chess:save'

export function loadSave(): Snapshot | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY)
    if (!raw) return null
    const s = JSON.parse(raw) as Snapshot
    if (s.v !== 1 || !s.phase || s.phase === 'lobby') return null
    return s
  } catch {
    return null
  }
}

// 任何状态变化后自动落盘；回到大厅则清除存档
watch(
  state,
  () => {
    try {
      if (state.phase === 'lobby') localStorage.removeItem(SAVE_KEY)
      else localStorage.setItem(SAVE_KEY, JSON.stringify(serialize()))
    } catch {
      // 隐私模式等写不进去时静默忽略
    }
  },
  { deep: true },
)
