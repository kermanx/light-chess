// 公开房间目录：借助信令通道上一个众所周知的「大厅房间」做无服务器的房间发现。
// 房主勾选「公开」后周期广播房号与就位进度；加入页监听大厅，把仍在广播的房间列出来。
// 大厅在 Nostr（8 个精选中继）与 MQTT（前 4 个 broker）双通道同时进行，
// 与房间本身的信令通道无关——只要能连上其中一条通道就能发现/被发现在本地中继覆盖
// （localStorage light-chess:relays）下只走覆盖地址，供开发测试使用。
import { joinRoom as joinRoomNostr, type MessageAction, type Room } from 'trystero'
import { PREFERRED_NOSTR_RELAYS } from './net'

// 注意：大厅使用独立的 appId。trystero 的 SharedPeerManager 按 appId 复用 P2P 连接并跨房间绑定，
// 实测大厅与对局共用 appId 时，先在大厅相遇的两个加入者之间在对局房间里收不到彼此的消息
// （跨房间绑定竞态）。独立 appId 让大厅连接与对局连接完全隔离，规避该问题。
const APP_ID = 'light-chess-kermanx-lobby'
const LOBBY_ID = 'public-lobby-v1'
const RELAYS_KEY = 'light-chess:relays'
/** 房主广播间隔；加入方把超过 EXPIRE 未再广播的房间视为已关闭 */
const ANNOUNCE_INTERVAL = 4000
const EXPIRE = 15000
const MQTT_LOBBY_BROKERS = 4

export interface PublicRoom {
  code: string
  players: number
  joined: number
  ts: number
}

type AnnounceMsg = { t: 'room'; code: string; players: number; joined: number; ts: number }

/** 打开大厅（可能多条通道各一个 trystero room） */
async function openLobbies(): Promise<Room[]> {
  let override: string[] = []
  try {
    const raw = localStorage.getItem(RELAYS_KEY)
    override = raw?.split(',').map((s) => s.trim()).filter(Boolean) ?? []
  } catch {
    // 读取失败按无覆盖处理
  }
  if (override.length) {
    return [joinRoomNostr({ appId: APP_ID, relayConfig: { urls: override } }, LOBBY_ID)]
  }
  const rooms: Room[] = [
    joinRoomNostr({ appId: APP_ID, relayConfig: { urls: PREFERRED_NOSTR_RELAYS } }, LOBBY_ID),
  ]
  try {
    const mqtt = await import('@trystero-p2p/mqtt')
    rooms.push(
      mqtt.joinRoom(
        { appId: APP_ID, relayConfig: { urls: mqtt.defaultRelayUrls.slice(0, MQTT_LOBBY_BROKERS) } },
        LOBBY_ID,
      ),
    )
  } catch {
    // MQTT 加载失败时只用 Nostr，不影响主流程
  }
  return rooms
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeDirAction = (r: Room) => r.makeAction<any>('dir')

/**
 * 开始对外广播房间信息（公开房间），返回停止函数。
 * info 每次广播时调用，房号/就位进度均为实时值；有新监听者进入大厅时立即补播一次。
 */
export async function announceRoom(info: () => Omit<PublicRoom, 'ts'>): Promise<() => void> {
  const rooms = await openLobbies()
  const actions = rooms.map(makeDirAction)
  const announce = () => {
    const msg: AnnounceMsg = { t: 'room', ...info(), ts: Date.now() }
    for (const a of actions) void a.send(msg)
  }
  for (const r of rooms) r.onPeerJoin = () => announce()
  announce()
  const timer = setInterval(announce, ANNOUNCE_INTERVAL)
  return () => {
    clearInterval(timer)
    for (const r of rooms) void r.leave()
  }
}

/**
 * 监听公开房间，返回停止函数。
 * onUpdate 收到按最近活跃排序的房间列表；超过 EXPIRE 未再广播的房间自动剔除。
 */
export async function watchRooms(onUpdate: (rooms: PublicRoom[]) => void): Promise<() => void> {
  const found = new Map<string, PublicRoom>()
  const emit = () => {
    const now = Date.now()
    for (const [c, r] of found) if (now - r.ts > EXPIRE) found.delete(c)
    onUpdate([...found.values()].sort((a, b) => b.ts - a.ts))
  }
  const rooms = await openLobbies()
  for (const r of rooms) {
    const a: MessageAction<AnnounceMsg> = makeDirAction(r)
    a.onMessage = (msg) => {
      if (msg?.t !== 'room' || !msg.code) return
      found.set(msg.code, {
        code: msg.code,
        players: msg.players,
        joined: msg.joined,
        ts: msg.ts || Date.now(),
      })
      emit()
    }
  }
  const timer = setInterval(emit, 2000) // 周期清扫过期房间
  return () => {
    clearInterval(timer)
    for (const r of rooms) void r.leave()
  }
}
