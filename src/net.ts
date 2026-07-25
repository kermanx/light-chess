// 联机层：基于 trystero（WebRTC P2P，Nostr 公共中继做信令），无需任何服务器。
// 模型：房主权威——建房者是房主，负责分配座位、判定开局、持有权威对局状态；
// 其余消息（放置动作）在 P2P 网关中直接广播，与原来的哑转发语义一致。
import { defaultRelayUrls, joinRoom, type MessageAction, type Room } from 'trystero'
import { seatColors, type Color } from './game'
import {
  applyRemote,
  applySnapshot,
  serialize,
  setSender,
  startOnline,
  state,
  type Action,
  type Snapshot,
} from './store'

const APP_ID = 'light-chess-kermanx'
const NET_KEY = 'light-chess:net'
const RELAYS_KEY = 'light-chess:relays'
const HELLO_INTERVAL = 2000
const JOIN_TIMEOUT = 20000

/**
 * 信令中继：8 个精选高可用公共 Nostr 中继优先，其后跟上 trystero 内置的完整
 * 默认列表（约 50 个）——连接全部并行尝试，任一可达即可完成握手，
 * 为各种受限网络（大陆直连/代理规则/TUN）做最坏打算。
 * 仍可用 localStorage 的 light-chess:relays（逗号分隔 ws(s) 地址）整体覆盖，
 * 用于本地开发测试或公共中继不可达的网络环境。
 */
const PREFERRED_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.nostr.band',
  'wss://purplerelay.com',
  'wss://nostr.data.haus',
  'wss://relay.snort.social',
  'wss://nostr.wine',
]

const relayUrls = (): string[] => {
  try {
    const raw = localStorage.getItem(RELAYS_KEY)
    if (raw) {
      const urls = raw.split(',').map((s) => s.trim()).filter(Boolean)
      if (urls.length) return urls
    }
  } catch {
    // 忽略读取失败
  }
  // 去重：精选列表与默认列表可能有交集
  return [...new Set([...PREFERRED_RELAYS, ...defaultRelayUrls])]
}

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const genCode = () =>
  Array.from({ length: 4 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('')
const genToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36)).join('').slice(0, 12)

type Msg =
  | { t: 'hello'; token: string; want: Color | null }
  | { t: 'welcome'; color: Color; players: number; joined: number; started: boolean }
  | { t: 'room-info'; joined: number }
  | { t: 'start'; players: number }
  | { t: 'act'; act: Action }
  | { t: 'sync'; snap: Snapshot }
  | { t: 'err'; msg: string }

/** 本机在房间里的身份档案（刷新重连用） */
interface NetRecord {
  code: string
  token: string
  host: boolean
  players: number
  /** 仅房主：token → 座位色（房主刷新后仍能认出重连的老玩家） */
  seats?: Record<string, Color>
}

function loadNet(): NetRecord | null {
  try {
    const raw = localStorage.getItem(NET_KEY)
    return raw ? (JSON.parse(raw) as NetRecord) : null
  } catch {
    return null
  }
}

function saveNet(rec: NetRecord) {
  try {
    localStorage.setItem(NET_KEY, JSON.stringify(rec))
  } catch {
    // 隐私模式等写不进去时静默忽略
  }
}

let room: Room | null = null
// trystero 的 DataPayload 要求索引签名，这里消息体由我们自己的协议保证，用 any 兜底
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let action: MessageAction<any> | null = null
let isHost = false
let started = false
let token = ''
let wantColor: Color | null = null
/** 房主：token → 座位色 */
let seats = new Map<string, Color>()
/** 当前在线的座位 token（含房主自己） */
let connected = new Set<string>()
let peerByToken = new Map<string, string>()
let welcomed = false
let helloTimer: ReturnType<typeof setInterval> | null = null
let pending: { resolve: () => void; reject: (e: Error) => void } | null = null

/** 本机是否握着一局恢复中的对局（联机刷新重连） */
const inGame = () => state.mode === 'online' && state.phase !== 'lobby'

const send = (msg: Msg, target?: string) => {
  if (!action) return
  void (target ? action.send(msg, { target }) : action.send(msg))
}

const sendAct = (act: Action) => send({ t: 'act', act })

function persistSeats() {
  const rec = loadNet()
  if (rec?.host) saveNet({ ...rec, seats: Object.fromEntries(seats) })
}

function clearHello() {
  if (helloTimer) clearInterval(helloTimer)
  helloTimer = null
}

function sendHello() {
  send({ t: 'hello', token, want: wantColor })
}

// ---------- 房主侧 ----------

function hostOnHello(msg: Extract<Msg, { t: 'hello' }>, peerId: string) {
  if (!isHost) return
  let color = seats.get(msg.token)
  const rejoin = color !== undefined
  if (!color) {
    if (started) return send({ t: 'err', msg: '对局已开始，无法加入' }, peerId)
    const used = new Set(seats.values())
    // 优先满足对方申报的原座位（房主自己刷新丢了座位表时尤其有用）
    color =
      msg.want && state.players.includes(msg.want) && !used.has(msg.want)
        ? msg.want
        : state.players.find((c) => !used.has(c))
    if (!color) return send({ t: 'err', msg: '房间已满' }, peerId)
    seats.set(msg.token, color)
    persistSeats()
  }
  peerByToken.set(msg.token, peerId)
  connected.add(msg.token)
  state.roomJoined = connected.size
  send(
    { t: 'welcome', color, players: state.players.length, joined: connected.size, started },
    peerId,
  )
  send({ t: 'room-info', joined: connected.size })

  if (!started && connected.size === state.players.length && seats.size === state.players.length) {
    // 全员到齐：开局（房主先本地进入，再广播，最后同步房间设置）
    started = true
    startOnline(state.myColor!, state.roomCode, state.players)
    send({ t: 'start', players: state.players.length })
    sendAct({ kind: 'laser-setting', color: state.players[0], allow: state.laserAllowed })
    sendAct({ kind: 'board-size', color: state.players[0], size: state.size })
    return
  }
  if (started) {
    if (rejoin) send({ t: 'sync', snap: serialize() }, peerId) // 重连者补发权威状态
    if (connected.size === state.players.length) {
      // 全员在线：解除掉线锁定，并顺手做一次全量对齐
      state.peerLeft = false
      send({ t: 'sync', snap: serialize() })
    }
  }
}

function hostOnPeerLeave(peerId: string) {
  for (const [tok, pid] of peerByToken) {
    if (pid === peerId) {
      peerByToken.delete(tok)
      connected.delete(tok)
      break
    }
  }
  if (state.phase === 'lobby') {
    state.roomJoined = connected.size
    send({ t: 'room-info', joined: connected.size })
  } else {
    state.peerLeft = true
  }
}

// ---------- 加入者侧 ----------

function onWelcome(msg: Extract<Msg, { t: 'welcome' }>) {
  if (isHost || welcomed) return
  welcomed = true
  clearHello()
  state.myColor = msg.color
  state.players = seatColors(msg.players)
  state.roomJoined = msg.joined
  saveNet({ code: state.roomCode, token, host: false, players: msg.players })
  if (inGame()) state.peerLeft = false // 对局恢复（随后的 sync 会做状态对齐）
  pending?.resolve()
  pending = null
}

// ---------- 公共入口 ----------

function handle(msg: Msg, peerId: string) {
  switch (msg.t) {
    case 'hello':
      hostOnHello(msg, peerId)
      break
    case 'welcome':
      onWelcome(msg)
      break
    case 'room-info':
      state.roomJoined = msg.joined
      break
    case 'start':
      if (!isHost && !inGame()) {
        state.peerLeft = false
        state.players = seatColors(msg.players)
        startOnline(state.myColor!, state.roomCode, state.players)
      }
      break
    case 'act':
      applyRemote(msg.act)
      break
    case 'sync':
      // 房主的权威状态；保留本机身份，只覆盖对局数据
      applySnapshot(msg.snap, true)
      state.peerLeft = false
      break
    case 'err':
      clearHello()
      pending?.reject(new Error(msg.msg))
      pending = null
      break
  }
}

function openRoom(code: string) {
  const urls = relayUrls()
  room = joinRoom(
    {
      appId: APP_ID,
      relayConfig: { urls },
      // 把 mDNS(.local) 候选地址改写为 127.0.0.1（trystero 官方开关）。
      // 在 TUN/代理（fake-ip）网络里，.local 会解析到虚拟网卡地址导致 ICE 永远失败；
      // 改写后同机多标签页可直接 loopback 互连，跨机场景本来就不靠 host 候选（走 STUN srflx）。
      _test_only_mdnsHostFallbackToLoopback: true,
    },
    `room-${code}`,
  )
  action = room.makeAction('msg')
  action.onMessage = (msg: Msg, ctx: { peerId: string }) => {
    try {
      handle(msg, ctx.peerId)
    } catch {
      // 忽略异常消息
    }
  }
  room.onPeerJoin = () => {
    // 新 peer 出现：加入者（重）发 hello，其中可能就有（重连回来的）房主
    if (!isHost && (!welcomed || (inGame() && state.peerLeft))) sendHello()
  }
  room.onPeerLeave = (peerId) => {
    if (isHost) hostOnPeerLeave(peerId)
    else if (inGame()) state.peerLeft = true
  }
  setSender((a) => sendAct(a))
}

/** 等待房主 welcome；期间周期广播 hello，超时视为房间不存在/房主不在线 */
function waitWelcome(): Promise<void> {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject }
    clearHello()
    helloTimer = setInterval(sendHello, HELLO_INTERVAL)
    sendHello()
    setTimeout(() => {
      if (pending) {
        pending = null
        netClose()
        reject(new Error('连接超时：房间不存在或房主不在线'))
      }
    }, JOIN_TIMEOUT)
  })
}

/** 创建房间，返回房间号（本方坐 0 号位） */
export async function netCreate(playerCount: number): Promise<string> {
  netClose()
  isHost = true
  started = false
  token = loadNet()?.token ?? genToken()
  const code = genCode()
  state.players = seatColors(playerCount)
  state.myColor = state.players[0]
  state.roomCode = code
  state.roomJoined = 1
  state.peerLeft = false
  seats = new Map([[token, state.myColor]])
  connected = new Set([token])
  peerByToken = new Map()
  saveNet({ code, token, host: true, players: playerCount, seats: Object.fromEntries(seats) })
  openRoom(code)
  return code
}

/** 加入房间（座位由房主按加入顺序分配） */
export async function netJoin(code: string): Promise<void> {
  netClose()
  isHost = false
  started = false
  welcomed = false
  wantColor = null
  token = loadNet()?.token ?? genToken()
  state.roomCode = code.trim().toUpperCase()
  openRoom(state.roomCode)
  await waitWelcome()
}

/** 刷新后重连原房间（房主恢复座位表并等待大家重连；加入者凭 token 领回原座位） */
export async function netRejoin(code: string, color: Color, playerCount: number): Promise<void> {
  netClose()
  const rec = loadNet()
  token = rec?.token ?? genToken()
  wantColor = color
  started = true
  state.roomCode = code.trim().toUpperCase()
  if (rec?.host && rec.code === state.roomCode) {
    // 房主恢复：重建座位表，等其他玩家 hello 后逐个补发权威状态
    isHost = true
    state.players = seatColors(playerCount)
    seats = new Map(Object.entries(rec.seats ?? {}))
    seats.set(token, color)
    persistSeats()
    connected = new Set([token])
    peerByToken = new Map()
    openRoom(state.roomCode)
    return
  }
  isHost = false
  welcomed = false
  openRoom(state.roomCode)
  await waitWelcome()
}

export function netClose() {
  clearHello()
  pending = null
  setSender(null)
  if (room) void room.leave()
  room = null
  action = null
  isHost = false
  started = false
  welcomed = false
  seats = new Map()
  connected = new Set()
  peerByToken = new Map()
}
