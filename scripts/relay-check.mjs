// 自带 Vite server、两个正常 MQTT broker 和一个只接收不转发的 broker，注入丢包、乱序和中继故障。
import assert from 'node:assert/strict'
import { createDecipheriv, createHash } from 'node:crypto'
import { once } from 'node:events'
import aedes from 'aedes'
import { WebSocketServer, createWebSocketStream } from 'ws'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// 隔离依赖缓存并关闭 HMR，避免开发时的热更新销毁正在检查的页面。
const vite = await createServer({
  cacheDir: 'node_modules/.vite-relay-check',
  server: { host: '127.0.0.1', port: 0, hmr: false },
  optimizeDeps: { include: ['vue', 'trystero', '@trystero-p2p/mqtt', 'mqtt'] },
})
await vite.listen()
const BASE = `http://127.0.0.1:${vite.httpServer.address().port}`
const app = 'light-chess-regression'
const id = crypto.randomUUID()
const key = createHash('sha256').update(`key/${app}/${id}`).digest()
const topic = 'light-chess/v1/' + createHash('sha256').update(`topic/${app}/${id}`).digest('hex')
const decoded = new Map()
let dropped = 0
let reordered = 0
let dropUntil = 0
const brokers = []
const browser = await chromium.launch()

function decode(payload) {
  const [iv, encoded] = payload.toString().split('.')
  const data = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'))
  decipher.setAuthTag(data.subarray(-16))
  return JSON.parse(Buffer.concat([decipher.update(data.subarray(0, -16)), decipher.final()]))
}

try {
  for (let i = 0; i < 3; i++) {
    const broker = aedes()
    const server = new WebSocketServer({ port: 0 })
    server.on('connection', socket => broker.handle(createWebSocketStream(socket)))
    await once(server, 'listening')
    broker.authorizePublish = (_client, packet, callback) => {
      if (packet.topic !== topic) return callback(null)
      let body
      try { body = decode(packet.payload) } catch { return callback(null) }
      decoded.set(packet.payload.toString(), body)
      if (body.kind === 'data' && body.seq === 1 && !dropUntil) dropUntil = Date.now() + 1000
      if (body.kind === 'data' && body.seq === 2) {
        reordered++
        setTimeout(() => callback(null), 250)
      } else callback(null)
    }
    broker.authorizeForward = (_client, packet) => {
      if (i === 2) return null // 模拟 WebSocket 已连接，但 broker 拒绝转发
      const body = decoded.get(packet.payload.toString())
      if (body?.kind === 'data' && body.seq === 1 && Date.now() < dropUntil) {
        dropped++
        return null
      }
      return packet
    }
    brokers.push({ broker, server, url: `ws://localhost:${server.address().port}` })
  }
  const urls = brokers.map(b => b.url).join(',')
  const pages = []
  const errors = []
  for (let i = 0; i < 3; i++) {
    const context = await browser.newContext()
    await context.addInitScript(urls => {
      localStorage.setItem('light-chess:mqtt-relays', urls)
      window.RTCPeerConnection = class { constructor() { throw new Error('WebRTC must not be used') } }
    }, urls)
    const page = await context.newPage()
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(BASE)
    await page.evaluate(async ({ app, id }) => {
      const { joinRelayRoom } = await import('/src/relay.ts')
      window.received = []
      window.joins = 0
      window.leaves = 0
      window.room = await joinRelayRoom(app, id)
      window.room.onMessage = data => window.received.push(data)
      window.room.onPeerJoin = () => window.joins++
      window.room.onPeerLeave = () => window.leaves++
    }, { app, id: i === 2 ? `${id}-other-room` : id })
    pages.push(page)
  }
  const [A, B, C] = pages
  try {
    await Promise.all([A, B].map(p => p.waitForFunction(() => window.joins === 1 && window.room.status().up === 2 && window.room.status().total === 3, null, { timeout: 10000 })))
  } catch (error) {
    console.log('startup', await Promise.all(pages.map(p => p.evaluate(() => ({ joins: window.joins, status: window.room.status() })))), errors)
    throw error
  }
  await A.evaluate(() => { for (let i = 1; i <= 20; i++) window.room.send(i) })
  await B.waitForFunction(() => window.received.length === 20)
  assert.deepEqual(await B.evaluate(() => window.received), Array.from({ length: 20 }, (_, i) => i + 1))
  assert(dropped > 0 && reordered > 0, '必须实际注入丢包和乱序')
  assert.deepEqual(await C.evaluate(() => window.received), [], '不同房间必须隔离')
  console.log('ok: 拒绝转发的中继不计入连接数；WebRTC 禁用；双中继重复、丢包、乱序下消息仍恰好按序处理一次，房间隔离')

  for (const socket of brokers[0].server.clients) socket.terminate()
  await new Promise(resolve => brokers[0].server.close(resolve))
  await new Promise(resolve => brokers[0].broker.close(resolve))
  await A.waitForFunction(() => window.room.status().up === 1)
  await A.evaluate(() => { for (let i = 21; i <= 24; i++) window.room.send(i) })
  await B.waitForFunction(() => window.received.length === 24)
  console.log('ok: 一个中继完全关闭，剩余中继继续传输')

  // 对端超时后重连仍使用原来的序号，不能丢掉在途消息或再次执行旧消息。
  await A.clock.install()
  await B.context().setOffline(true)
  await A.evaluate(() => window.room.send(25))
  await A.clock.fastForward(31000)
  await A.waitForFunction(() => window.leaves === 1)
  await B.context().setOffline(false)
  await A.waitForFunction(() => window.joins === 2)
  await B.waitForFunction(() => window.received.length === 25)
  assert.deepEqual(await B.evaluate(() => window.received), Array.from({ length: 25 }, (_, i) => i + 1))
  assert.deepEqual(errors, [])
  console.log('ok: 掉线超时后恢复，保留消息序号并补发未确认消息')
} finally {
  await browser.close()
  for (const { server, broker } of brokers) {
    for (const socket of server.clients) socket.terminate()
    if (server.address()) await new Promise(resolve => server.close(resolve))
    if (!broker.closed) await new Promise(resolve => broker.close(resolve))
  }
  await vite.close()
}
