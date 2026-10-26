// 公开大厅与棋局都使用 WebSocket 中继，代理网络不需要建立 WebRTC 连接。
import { joinRelayRoom } from './relay'

const APP_ID = 'light-chess-kermanx-lobby'
const LOBBY_ID = 'public-lobby-v2'
const ANNOUNCE_INTERVAL = 4000
const EXPIRE = 15000

export interface PublicRoom {
  code: string
  players: number
  joined: number
  ts: number
}

type AnnounceMsg = { t: 'room'; code: string; players: number; joined: number; ts: number }

/**
 * 开始对外广播房间信息（公开房间），返回停止函数。
 * info 每次广播时调用，房号/就位进度均为实时值；有新监听者进入大厅时立即补播一次。
 */
export async function announceRoom(info: () => Omit<PublicRoom, 'ts'>): Promise<() => void> {
  const room = await joinRelayRoom(APP_ID, LOBBY_ID)
  const announce = () => {
    const msg: AnnounceMsg = { t: 'room', ...info(), ts: Date.now() }
    room.send(msg)
  }
  room.onPeerJoin = () => announce()
  announce()
  const timer = setInterval(announce, ANNOUNCE_INTERVAL)
  return () => {
    clearInterval(timer)
    void room.leave()
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
  const room = await joinRelayRoom(APP_ID, LOBBY_ID)
  room.onMessage = (data) => {
    const msg = data as AnnounceMsg
    if (msg?.t !== 'room' || !msg.code) return
    found.set(msg.code, {
      code: msg.code,
      players: msg.players,
      joined: msg.joined,
      ts: Date.now(),
    })
    emit()
  }
  const timer = setInterval(emit, 2000) // 周期清扫过期房间
  return () => {
    clearInterval(timer)
    void room.leave()
  }
}
