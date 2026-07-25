// 最简 Nostr 中继：只实现 trystero 信令用到的协议子集（REQ/CLOSE/EVENT → 按 #x 标签与 kind 匹配转发）。
// 仅用于本地开发与端到端测试（本机网络无法直连公共 Nostr 中继时充当信令通道）。
// 运行：node scripts/dev-relay.mjs（默认端口 8787，PORT 环境变量可覆盖）
import { WebSocketServer } from 'ws'

const PORT = Number(process.env.PORT) || 8787
const wss = new WebSocketServer({ port: PORT })

wss.on('connection', (sock) => {
  // subId -> { kinds: Set<number>, topics: Set<string> }
  const subs = new Map()
  sock.subs = subs
  console.log('[relay] 连接，当前', wss.clients.size, '个客户端')

  sock.on('message', (data) => {
    let msg
    try {
      msg = JSON.parse(data.toString())
    } catch {
      return
    }
    if (!Array.isArray(msg)) return

    if (msg[0] === 'REQ') {
      const [, subId, filter] = msg
      subs.set(subId, {
        kinds: new Set(filter?.kinds ?? []),
        topics: new Set(filter?.['#x'] ?? []),
      })
      console.log('[relay] REQ', JSON.stringify(filter))
      sock.send(JSON.stringify(['EOSE', subId]))
    } else if (msg[0] === 'CLOSE') {
      subs.delete(msg[1])
    } else if (msg[0] === 'EVENT') {
      const evt = msg[1]
      if (!evt || typeof evt !== 'object') return
      const topics = (evt.tags ?? []).filter((t) => t[0] === 'x').map((t) => t[1])
      let delivered = 0
      for (const client of wss.clients) {
        if (client === sock || client.readyState !== client.OPEN || !client.subs) continue
        for (const [subId, f] of client.subs) {
          if (f.kinds.has(evt.kind) && topics.some((t) => f.topics.has(t))) {
            client.send(JSON.stringify(['EVENT', subId, evt]))
            delivered++
          }
        }
      }
      console.log('[relay] EVENT kind', evt.kind, 'topics', topics.join(','), '→ 转发', delivered, '个订阅')
      sock.send(JSON.stringify(['OK', evt.id ?? '', true, '']))
    }
  })

  sock.on('close', () => subs.clear())
})

console.log(`light-chess dev relay (minimal nostr) listening on :${PORT}`)
