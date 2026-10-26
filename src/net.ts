// 联机层：默认直接中继棋局消息，保留 trystero P2P 兼容旧房间。
// 模型：房主权威——建房者是房主，负责分配座位、判定开局、持有权威对局状态；
// 其余消息（放置动作）在房间内广播。
// 房号首位：1=Nostr P2P，2=MQTT P2P，3=WebSocket 中继（默认，不依赖 UDP）。
import { reactive } from 'vue'
import { defaultRelayUrls as nostrRelayUrls, getRelaySockets as getRelaySocketsNostr, joinRoom as joinRoomNostr, type MessageAction, type Room } from 'trystero'
import { seatColors, type Color } from './game'
import { joinRelayRoom, type RelayRoom } from './relay'
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
const JOIN_TIMEOUT = 30000

/** 信令通道 */
export type Signaling = 'relay' | 'nostr' | 'mqtt'

/** 保留旧房号的 P2P 协议，新房间默认走中继。 */
export const signalingOf = (code: string): Signaling => code.startsWith('3') ? 'relay' : code.startsWith('2') ? 'mqtt' : 'nostr'

export const isValidCode = (code: string) => /^[123]\d{3}$/.test(code)

/**
 * 旧 P2P 房间的信令中继：Nostr 优先列表 + trystero 内置默认列表；
 * MQTT 用其内置 broker 列表（含 broker-cn.emqx.io）。连接全部并行尝试，
 * WebSocket 可达不代表允许收发信令，也不代表 WebRTC 直连可用。
 * 仍可用 localStorage 的 light-chess:relays（逗号分隔 ws(s) 地址）整体覆盖，
 * 用于本地开发测试或公共中继不可达的网络环境。
 */
export const PREFERRED_NOSTR_RELAYS = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://nostr.mom',
  'wss://relay.nostr.band',
  'wss://purplerelay.com',
  'wss://nostr.data.haus',
  'wss://relay.snort.social',
]

const relayUrls = async (sig: Signaling): Promise<string[]> => {
  try {
    const raw = localStorage.getItem(RELAYS_KEY)
    if (raw) {
      const urls = raw.split(',').map((s) => s.trim()).filter(Boolean)
      if (urls.length) return urls
    }
  } catch {
    // 忽略读取失败
  }
  // MQTT 策略体积较大，按需动态加载（含其默认 broker 列表，其中有 broker-cn.emqx.io）
  if (sig === 'mqtt') return [...(await import('@trystero-p2p/mqtt')).defaultRelayUrls]
  // 去重：精选列表与默认列表可能有交集
  return [...new Set([...PREFERRED_NOSTR_RELAYS, ...nostrRelayUrls])]
}

const genCode = (sig: Signaling) =>
  (sig === 'relay' ? '3' : sig === 'mqtt' ? '2' : '1') +
  Array.from({ length: 3 }, () => Math.floor(Math.random() * 10)).join('')
const genToken = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36)).join('').slice(0, 12)

type Msg =
  | { t: 'hello'; token: string; want: Color | null }
  | { t: 'welcome'; color: Color; players: number; joined: number; started: boolean }
  | { t: 'room-info'; joined: number }
  | { t: 'start'; players: number; settings?: { size: number; laserAllowed: boolean; allowUndo: boolean; boundaryReflects?: boolean } }
  | { t: 'act'; act: Action; origin?: string }
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

// 身份档案存两份：sessionStorage（标签页私有，同标签页刷新保留、不同标签页隔离）为主，
// localStorage 仅作浏览器整个重启后的兜底。
// 关键场景：同机两个标签页共享 localStorage——若身份只存 localStorage，
// 加入方会读到房主标签页的 token，被房主误当成「房主重连」而永远开不了局。
/** 可用的 Web Storage（Node 测试环境没有这两个全局量，返回空数组整体跳过） */
const storages = (): Storage[] => {
  try {
    return [sessionStorage, localStorage]
  } catch {
    return []
  }
}

function loadNet(): NetRecord | null {
  for (const store of storages()) {
    try {
      const raw = store.getItem(NET_KEY)
      if (raw) return JSON.parse(raw) as NetRecord
    } catch {
      // 读不出来就尝试下一个存储
    }
  }
  return null
}

function saveNet(rec: NetRecord) {
  const stores = storages()
  try {
    stores[0]?.setItem(NET_KEY, JSON.stringify(rec))
  } catch {
    // 隐私模式等写不进去时静默忽略
  }
  try {
    // 兜底存档：客人档案不覆盖本地已有的其它房间的房主档案
    // （同机 A 标签页是房主、B 标签页是客人时，保住 A 的重启恢复能力）
    const raw = stores[1]?.getItem(NET_KEY)
    const prev = raw ? (JSON.parse(raw) as NetRecord) : null
    if (!prev || prev.code === rec.code || rec.host) {
      stores[1]?.setItem(NET_KEY, JSON.stringify(rec))
    }
  } catch {
    // 同上
  }
}

let room: Room | null = null
let relayRoom: RelayRoom | null = null
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
let hostPeerId: string | null = null
let helloTimer: ReturnType<typeof setInterval> | null = null
let joinTimer: ReturnType<typeof setTimeout> | null = null
let relayTimer: ReturnType<typeof setInterval> | null = null
let pending: { resolve: () => void; reject: (e: Error) => void } | null = null

/** 中继模式 up=消息往返成功的在线 broker 数；旧 P2P 模式仅统计 socket。 */
export const signaling = reactive({ up: 0, total: 0 })

/** 轮询当前信令通道的中继 socket 状态（nostr / mqtt 各自统计） */
function trackRelays(code: string) {
  if (relayTimer) clearInterval(relayTimer)
  signaling.up = 0
  signaling.total = 0
  const sig = signalingOf(code)
  const poll = async () => {
    try {
      if (sig === 'relay') {
        const status = relayRoom?.status()
        signaling.up = status?.up ?? 0
        signaling.total = status?.total ?? 0
        return
      }
      // getRelaySockets 返回 { [url]: WebSocket }，取 values 统计。
      // 某些网络下 socket 会快速闪断（OPEN 窗口很短），故用峰值 latch：
      // 只要曾连上过就说明中继可达，对用户更有诊断意义
      const map: Record<string, { readyState: number }> =
        sig === 'mqtt'
          ? (await import('@trystero-p2p/mqtt')).getRelaySockets()
          : getRelaySocketsNostr()
      const socks = Object.values(map)
      signaling.total = Math.max(signaling.total, socks.length)
      signaling.up = Math.max(signaling.up, socks.filter((s) => s.readyState === 1).length)
    } catch {
      // 统计失败不影响功能
    }
  }
  relayTimer = setInterval(poll, 500)
  void poll()
}

/** 本机是否握着一局恢复中的对局（联机刷新重连） */
const inGame = () => state.mode === 'online' && state.phase !== 'lobby'

const send = (msg: Msg, target?: string) => {
  if (relayRoom) return relayRoom.send(msg, target)
  if (!action) return
  void (target ? action.send(msg, { target }) : action.send(msg))
}

const sendAct = (act: Action) => {
  // 中继模式由房主转发动作：开局只需所有人连上房主，不必等待客人两两发现。
  // origin 保留给旧版中继客户端去重；新版客人等房主确认才应用动作。
  if (relayRoom) {
    if (isHost) send({ t: 'act', act, origin: token })
    else if (hostPeerId) send({ t: 'act', act, origin: token }, hostPeerId)
  } else send({ t: 'act', act })
}

function persistSeats() {
  const rec = loadNet()
  if (rec?.host) saveNet({ ...rec, seats: Object.fromEntries(seats) })
}

function clearHello() {
  if (helloTimer) clearInterval(helloTimer)
  helloTimer = null
  if (joinTimer) clearTimeout(joinTimer)
  joinTimer = null
}

function sendHello(target?: string) {
  send({ t: 'hello', token, want: wantColor }, target)
}

// ---------- 房主侧 ----------

function hostOnHello(msg: Extract<Msg, { t: 'hello' }>, peerId: string) {
  if (!isHost) return
  // 对方 token 与房主自己相同：只可能是同机另一标签页读到了本机档案，
  // 绝不能当成「自己重连」（会错乱座位、永远开不了局），明确报错
  if (msg.token === token) {
    return send(
      { t: 'err', msg: '身份冲突：本机另一个标签页已是房主，请刷新本页面后再加入' },
      peerId,
    )
  }
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
    // 全员到齐：中继模式把设置与开局合成一条消息，在客人能操作之前应用。
    // 另发 board-size 会在慢网络下清空客人刚放好的家。
    started = true
    startOnline(state.myColor!, state.roomCode, state.players)
    const settings = {
      size: state.size, laserAllowed: state.laserAllowed, allowUndo: state.allowUndo,
      boundaryReflects: state.boundaryReflects,
    }
    if (relayRoom) {
      send({
        t: 'start',
        players: state.players.length,
        settings,
      })
    } else {
      // 兼容仍在使用旧版客户端的 P2P 房间。
      send({ t: 'start', players: state.players.length, settings })
      sendAct({ kind: 'laser-setting', color: state.players[0], allow: state.laserAllowed })
      sendAct({ kind: 'undo-setting', color: state.players[0], allow: state.allowUndo, floor: 0 })
      sendAct({ kind: 'board-size', color: state.players[0], size: state.size })
    }
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
  let found = false
  for (const [tok, pid] of peerByToken) {
    if (pid === peerId) {
      found = true
      peerByToken.delete(tok)
      connected.delete(tok)
      break
    }
  }
  // 刷新后同一 token 已绑定新 peer；旧连接迟到的离线事件不能再次锁住棋盘。
  if (!found) return
  if (state.phase === 'lobby') {
    state.roomJoined = connected.size
    send({ t: 'room-info', joined: connected.size })
  } else {
    state.peerLeft = true
    if (relayRoom) send({ t: 'room-info', joined: connected.size })
  }
}

// ---------- 加入者侧 ----------

function onWelcome(msg: Extract<Msg, { t: 'welcome' }>, peerId: string) {
  if (isHost) return
  hostPeerId = peerId
  if (welcomed) return
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
      onWelcome(msg, peerId)
      break
    case 'room-info':
      state.roomJoined = msg.joined
      if (relayRoom && !isHost && inGame()) state.peerLeft = msg.joined < state.players.length
      break
    case 'start':
      if (!isHost && !inGame()) {
        state.peerLeft = false
        state.players = seatColors(msg.players)
        if (msg.settings) {
          state.size = msg.settings.size
          state.laserAllowed = msg.settings.laserAllowed
          state.allowUndo = msg.settings.allowUndo
        }
        state.boundaryReflects = msg.settings?.boundaryReflects ?? false
        startOnline(state.myColor!, state.roomCode, state.players)
      }
      break
    case 'act':
      if (relayRoom) {
        if (!isHost && peerId !== hostPeerId) return
        if (applyRemote(msg.act) && isHost) send(msg)
      } else applyRemote(msg.act)
      break
    case 'sync':
      // 房主的权威状态；保留本机身份，只覆盖对局数据
      applySnapshot(msg.snap, true)
      state.peerLeft = relayRoom ? state.roomJoined < state.players.length : false
      break
    case 'err':
      clearHello()
      pending?.reject(new Error(msg.msg))
      pending = null
      break
  }
}

async function openRoom(code: string) {
  const sig = signalingOf(code)
  if (sig === 'relay') {
    relayRoom = await joinRelayRoom(APP_ID, `room-${code}`)
    relayRoom.onMessage = (msg, peerId) => {
      try { handle(msg as Msg, peerId) } catch { /* 忽略异常消息 */ }
    }
    relayRoom.onPeerJoin = (peerId) => {
      // 只向新对端打招呼；发现另一个客人不能触发房主重复发送快照。
      if (!isHost) sendHello(peerId)
    }
    relayRoom.onPeerLeave = (peerId) => {
      if (isHost) hostOnPeerLeave(peerId)
      else if (inGame() && peerId === hostPeerId) state.peerLeft = true
    }
    trackRelays(code)
    setSender(sendAct, !isHost)
    return
  }
  const urls = await relayUrls(sig)
  const join = sig === 'mqtt' ? (await import('@trystero-p2p/mqtt')).joinRoom : joinRoomNostr
  room = join(
    {
      appId: APP_ID,
      relayConfig: { urls },
    },
    `room-${code}`,
  )
  trackRelays(code)
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

/** 等待房主 welcome；期间周期广播 hello，超时按中继连接情况给出具体原因 */
function waitWelcome(): Promise<void> {
  return new Promise((resolve, reject) => {
    pending = { resolve, reject }
    clearHello()
    helloTimer = setInterval(sendHello, HELLO_INTERVAL)
    sendHello()
    joinTimer = setTimeout(() => {
      if (pending) {
        pending = null
        // 注意先取中继数再 netClose——netClose 会把 signaling.up 清零，
        // 之前顺序写反导致报错永远显示「连不上任何信令中继」
        const up = signaling.up
        const directRelay = signalingOf(state.roomCode) === 'relay'
        netClose()
        reject(
          new Error(
            directRelay
              ? up === 0
                ? '连接失败：当前网络无法收发中继消息，请检查代理或更换网络后重试'
                : '中继可用，但房主没有回应：请确认房主仍停留在房间页面，并使用最新的房间链接'
              : up === 0
              ? '连接失败：当前网络连不上任何信令中继。请更换网络，或让房主换用另一种信令（Nostr / MQTT）'
              : `已连上 ${up} 个信令中继，但联系不上房主：房间不存在、房主不在线，或 P2P 连接被当前网络拦截`,
          ),
        )
      }
    }, JOIN_TIMEOUT)
  })
}

/** 创建房间，返回房间号（本方坐 0 号位）；signaling 决定信令通道并编入房号首位 */
export async function netCreate(playerCount: number, signaling: Signaling = 'relay'): Promise<string> {
  netClose()
  isHost = true
  started = false
  token = genToken() // 每开一局新房间就用新身份，杜绝与本地历史档案撞 token
  const code = genCode(signaling)
  state.players = seatColors(playerCount)
  state.myColor = state.players[0]
  state.roomCode = code
  state.roomJoined = 1
  state.peerLeft = false
  seats = new Map([[token, state.myColor]])
  connected = new Set([token])
  peerByToken = new Map()
  saveNet({ code, token, host: true, players: playerCount, seats: Object.fromEntries(seats) })
  await openRoom(code)
  return code
}

/** 加入房间（座位由房主按加入顺序分配；信令通道由房号首位决定） */
export async function netJoin(code: string): Promise<void> {
  netClose()
  const normalized = code.trim()
  if (!isValidCode(normalized)) throw new Error('房间号无效（1、2 或 3 开头的 4 位数字）')
  isHost = false
  started = false
  welcomed = false
  hostPeerId = null
  wantColor = null
  // 只有在「以客人身份重进同一个房间」（刷新重连）时才复用旧 token；
  // 否则必须换新——否则同机另一标签页是房主时，会因 token 相同被当成房主重连
  const rec = loadNet()
  token = rec && !rec.host && rec.code === normalized ? rec.token : genToken()
  state.roomCode = normalized
  await openRoom(state.roomCode)
  await waitWelcome()
}

/** 刷新后重连原房间（房主恢复座位表并等待大家重连；加入者凭 token 领回原座位） */
export async function netRejoin(code: string, color: Color, playerCount: number): Promise<void> {
  netClose()
  const rec = loadNet()
  token = rec && rec.code === code.trim() ? rec.token : genToken()
  wantColor = color
  started = true
  state.roomCode = code.trim()
  if (rec?.host && rec.code === state.roomCode) {
    // 房主恢复：重建座位表，等其他玩家 hello 后逐个补发权威状态
    isHost = true
    state.players = seatColors(playerCount)
    seats = new Map(Object.entries(rec.seats ?? {}))
    seats.set(token, color)
    persistSeats()
    connected = new Set([token])
    peerByToken = new Map()
    await openRoom(state.roomCode)
    return
  }
  isHost = false
  welcomed = false
  await openRoom(state.roomCode)
  await waitWelcome()
}

export function netClose() {
  clearHello()
  if (relayTimer) clearInterval(relayTimer)
  relayTimer = null
  signaling.up = 0
  signaling.total = 0
  pending = null
  setSender(null)
  if (room) void room.leave()
  room = null
  if (relayRoom) void relayRoom.leave()
  relayRoom = null
  action = null
  isHost = false
  started = false
  welcomed = false
  hostPeerId = null
  seats = new Map()
  connected = new Set()
  peerByToken = new Map()
}
