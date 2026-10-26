// 棋局消息直接走 MQTT over WebSocket，不依赖 WebRTC/UDP/NAT 穿透。
// 多个 broker 并行；每个对端独立编号、确认和重传，防止跨 broker 重复或乱序落子。
import mqtt, { type MqttClient } from 'mqtt'

const DEFAULT_URLS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker-cn.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
]
const HEARTBEAT = 4000
const PEER_TIMEOUT = 30000
const MAX_PAYLOAD = 512 * 1024

type Packet =
  | { from: string; kind: 'hello' }
  | { from: string; kind: 'bye' }
  | { from: string; kind: 'offline' }
  | { from: string; kind: 'data'; to: string; seq: number; data: unknown }
  | { from: string; kind: 'ack'; to: string; seq: number }

interface Peer {
  seen: number
  online: boolean
  paths: Set<MqttClient>
  sent: number
  received: number
  pending: Map<number, Packet>
  buffer: Map<number, unknown>
}

export interface RelayRoom {
  send: (data: unknown, target?: string) => void
  onMessage: (data: unknown, peerId: string) => void
  onPeerJoin: (peerId: string) => void
  onPeerLeave: (peerId: string) => void
  status: () => { up: number; total: number }
  leave: () => Promise<void>
}

const bytes = (s: string) => new TextEncoder().encode(s)
const hash = (s: string) => crypto.subtle.digest('SHA-256', bytes(s))
const base64 = (data: Uint8Array) => btoa(Array.from(data, (b) => String.fromCharCode(b)).join(''))

export async function joinRelayRoom(appId: string, roomId: string): Promise<RelayRoom> {
  let urls = DEFAULT_URLS
  try {
    const override = localStorage.getItem('light-chess:mqtt-relays')?.split(',').map((s) => s.trim()).filter(Boolean)
    if (override?.length) urls = [...new Set(override)]
  } catch { /* Storage 不可用时使用公共 broker */ }

  // topic 与加密密钥分开派生；不能直接把密钥放进公开 topic。
  // 与原 P2P 协议一样，知道房间号即可加入；四位房号不是私密口令。
  const namespace = `${appId}/${roomId}`
  const topic = 'light-chess/v1/' + Array.from(new Uint8Array(await hash(`topic/${namespace}`)), (b) => b.toString(16).padStart(2, '0')).join('')
  const key = await crypto.subtle.importKey('raw', await hash(`key/${namespace}`), 'AES-GCM', false, ['encrypt', 'decrypt'])
  const self = crypto.randomUUID()
  const peers = new Map<string, Peer>()
  const clients: MqttClient[] = []
  const subscribed = new Set<MqttClient>()
  const verified = new Map<MqttClient, number>()
  let closed = false
  let outgoing = Promise.resolve()
  let incoming = Promise.resolve()

  async function encode(packet: Packet) {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes(JSON.stringify(packet)))
    return `${base64(iv)}.${base64(new Uint8Array(ciphertext))}`
  }
  // 浏览器刷新/关闭来不及执行异步清理，由 broker 的遗嘱消息立即通知对端。
  const offlinePayload = await encode({ from: self, kind: 'offline' })

  function losePath(id: string, peer: Peer, client: MqttClient) {
    peer.paths.delete(client)
    if (peer.online && peer.paths.size === 0) {
      peer.online = false
      room.onPeerLeave(id)
    }
  }

  // 串行加密/发布和解密/处理，避免异步 WebCrypto 改变消息顺序。
  function publish(packet: Packet): Promise<void> {
    outgoing = outgoing.then(async () => {
      if (closed) return
      const payload = await encode(packet)
      for (const client of subscribed) {
        // 可靠性由对端 ACK 保证；broker ACK 仅证明中继收到了，不能证明玩家处理了。
        if (client.connected) client.publish(topic, payload, { qos: 0, retain: false }, () => {})
      }
    }).catch(() => {})
    return outgoing
  }

  function hello() { void publish({ from: self, kind: 'hello' }) }

  function receive(packet: Packet, client: MqttClient) {
    if (!packet || typeof packet.from !== 'string' || packet.from.length > 64) return
    if (packet.from === self) {
      // 收到自己发布的消息，才算该 broker 的订阅和转发都可用。
      verified.set(client, Date.now())
      return
    }
    if (packet.kind === 'bye') {
      if (peers.delete(packet.from)) room.onPeerLeave(packet.from)
      return
    }
    if (packet.kind === 'offline') {
      const peer = peers.get(packet.from)
      if (peer) losePath(packet.from, peer, client)
      return
    }
    if (!['hello', 'data', 'ack'].includes(packet.kind)) return
    let peer = peers.get(packet.from)
    if (!peer) {
      // 必须先收到 presence，避免旧数据包在离开之后重新创建对端。
      if (packet.kind !== 'hello') return
      peer = { seen: Date.now(), online: false, paths: new Set(), sent: 0, received: 0, pending: new Map(), buffer: new Map() }
      peers.set(packet.from, peer)
    }
    peer.paths.add(client)
    if (!peer.online) {
      peer.online = true
      hello()
      room.onPeerJoin(packet.from)
    }
    peer.seen = Date.now()
    if (packet.kind === 'hello' || packet.to !== self) return
    if (!Number.isSafeInteger(packet.seq) || packet.seq < 1) return
    if (packet.kind === 'ack') {
      if (packet.seq <= peer.sent) {
        for (const seq of peer.pending.keys()) if (seq <= packet.seq) peer.pending.delete(seq)
      }
      return
    }
    if (packet.seq > peer.received && packet.seq <= peer.received + 1024) peer.buffer.set(packet.seq, packet.data)
    while (peer.buffer.has(peer.received + 1)) {
      const seq = ++peer.received
      const data = peer.buffer.get(seq)
      peer.buffer.delete(seq)
      room.onMessage(data, packet.from)
    }
    if (peer.received) void publish({ from: self, kind: 'ack', to: packet.from, seq: peer.received })
  }

  const room: RelayRoom = {
    onMessage: () => {},
    onPeerJoin: () => {},
    onPeerLeave: () => {},
    send(data, target) {
      if (closed) return
      for (const [id, peer] of peers) {
        if (!peer.online || (target && target !== id)) continue
        const packet: Packet = { from: self, kind: 'data', to: id, seq: ++peer.sent, data }
        peer.pending.set(packet.seq, packet)
        void publish(packet)
      }
    },
    status: () => ({
      up: clients.filter((c) => c.connected && Date.now() - (verified.get(c) ?? 0) < PEER_TIMEOUT).length,
      total: clients.length,
    }),
    async leave() {
      if (closed) return
      clearInterval(heartbeat)
      clearInterval(retry)
      // 先发离开消息，再关闭 socket；不保留任何 retained 棋局数据。
      await publish({ from: self, kind: 'bye' })
      closed = true
      peers.clear()
      for (const client of clients) client.end(true)
    },
  }

  for (const url of urls) {
    const client = mqtt.connect(url, {
      clean: true,
      connectTimeout: 8000,
      reconnectPeriod: 3000,
      queueQoSZero: false,
      will: { topic, payload: offlinePayload, qos: 0, retain: false },
    })
    clients.push(client)
    client.on('connect', () => {
      client.subscribe(topic, { qos: 0 }, (error, grants) => {
        if (closed || error || !grants?.some((g) => g.topic === topic && g.qos <= 1)) return
        subscribed.add(client)
        hello()
      })
    })
    client.on('close', () => {
      subscribed.delete(client)
      verified.delete(client)
      if (!closed) for (const [id, peer] of peers) losePath(id, peer, client)
    })
    client.on('error', () => { verified.delete(client) })
    client.on('message', (receivedTopic, payload, meta) => {
      if (closed || receivedTopic !== topic || meta.retain || payload.length > MAX_PAYLOAD) return
      incoming = incoming.then(async () => {
        if (closed) return
        const [iv64, data64] = payload.toString().split('.')
        if (!iv64 || !data64) return
        const iv = Uint8Array.from(atob(iv64), (c) => c.charCodeAt(0))
        const data = Uint8Array.from(atob(data64), (c) => c.charCodeAt(0))
        if (iv.length !== 12) return
        const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
        receive(JSON.parse(new TextDecoder().decode(plaintext)) as Packet, client)
      }).catch(() => {}) // 无法解密或畸形的公共 broker 消息不能中断后续消息
    })
  }
  const heartbeat = setInterval(() => {
    hello()
    for (const [id, peer] of peers) {
      if (peer.online && Date.now() - peer.seen > PEER_TIMEOUT) {
        // 暂时掉线保留序号；同一页面网络恢复时继续原来的可靠消息流。
        peer.online = false
        peer.paths.clear()
        room.onPeerLeave(id)
      }
    }
  }, HEARTBEAT)
  const retry = setInterval(() => {
    for (const peer of peers.values()) {
      if (peer.online) for (const packet of peer.pending.values()) void publish(packet)
    }
  }, 2000)
  return room
}
