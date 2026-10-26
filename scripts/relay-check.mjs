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
let gameTopic = ''
let gameKey
const brokers = []
const browser = await chromium.launch()

async function waitForGame(page, predicate) {
  await page.evaluate(async () => { window.gameStore = await import('/src/store.ts') })
  await page.waitForFunction(predicate)
}

function decode(payload, secret = key) {
  const [iv, encoded] = payload.toString().split('.')
  const data = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', secret, Buffer.from(iv, 'base64'))
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
      if (packet.topic === gameTopic) {
        const body = decode(packet.payload, gameKey)
        // 旧协议在 start 之后另发 board-size；延迟它会重置玩家刚布置的家。
        if (body.kind === 'data' && body.data?.t === 'act' && body.data.act.kind === 'board-size') {
          return setTimeout(() => callback(null), 2000)
        }
        if (body.kind === 'data' && body.data?.t === 'act' && body.data.act.kind === 'setup') {
          return setTimeout(() => callback(null), 200)
        }
        return callback(null)
      }
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
  await A.clock.fastForward(31000)
  await A.waitForFunction(() => window.leaves === 1)
  await B.context().setOffline(false)
  await A.waitForFunction(() => window.joins === 2)
  await A.evaluate(() => window.room.send(25))
  await B.waitForFunction(() => window.received.length === 25)
  assert.deepEqual(await B.evaluate(() => window.received), Array.from({ length: 25 }, (_, i) => i + 1))
  await B.close()
  await A.waitForFunction(() => window.leaves === 2, null, { timeout: 5000 })
  assert.deepEqual(errors, [])
  console.log('ok: 遗嘱消息即时通知掉线，重连后保留消息序号')

  const gamePages = []
  for (let i = 0; i < 2; i++) {
    const context = await browser.newContext()
    await context.addInitScript(url => {
      localStorage.setItem('light-chess:mqtt-relays', url)
      window.RTCPeerConnection = class { constructor() { throw new Error('WebRTC must not be used') } }
    }, brokers[1].url)
    const page = await context.newPage()
    await page.goto(BASE)
    gamePages.push(page)
  }
  const [host, guest] = gamePages
  await host.getByText('创建房间', { exact: true }).click()
  await host.locator('.pub-opt input').uncheck()
  await host.getByRole('button', { name: '创建并等待' }).click()
  const code = await host.locator('.room-code').innerText()
  const namespace = `light-chess-kermanx/room-${code}`
  gameTopic = 'light-chess/v1/' + createHash('sha256').update(`topic/${namespace}`).digest('hex')
  gameKey = createHash('sha256').update(`key/${namespace}`).digest()
  await host.locator('.size-input').fill('24')
  await host.locator('.size-input').dispatchEvent('change')
  await host.getByLabel('允许撤回一步', { exact: false }).check()
  await host.getByLabel('边界反射', { exact: false }).uncheck()
  await guest.goto(`${BASE}/?join=${code}`)
  await guest.waitForSelector('svg.board-svg')
  const initial = await guest.evaluate(async () => {
    const { state, dispatch } = await import('/src/store.ts')
    const settings = { size: state.size, undo: state.allowUndo, boundary: state.boundaryReflects }
    dispatch({ kind: 'setup', color: state.myColor, home: { x: 6, y: 6, dir: 1 } })
    return { ...settings, awaitingHost: !state.homes.red }
  })
  assert.deepEqual(initial, { size: 24, undo: true, boundary: false, awaitingHost: true }, '开局设置完整，落子等待房主确认')
  await waitForGame(host, () => Boolean(window.gameStore.state.homes.red))
  await new Promise(resolve => setTimeout(resolve, 2500))
  assert.deepEqual(await guest.evaluate(async () => (await import('/src/store.ts')).state.homes.red), { x: 6, y: 6, dir: 1 })
  console.log('ok: 开局原子同步设置，迟到的设置不会清空客人的布置')

  assert(await guest.getByLabel('边界反射', { exact: false }).isDisabled(), '客人不能修改边界规则')
  await host.getByLabel('边界反射', { exact: false }).check()
  await waitForGame(guest, () => window.gameStore.state.boundaryReflects)
  assert(await guest.getByLabel('边界反射', { exact: false }).isChecked())
  console.log('ok: 建房设置带入客人，布置阶段房主更改边界规则会同步到客人')

  await host.evaluate(async () => {
    const { dispatch } = await import('/src/store.ts')
    dispatch({ kind: 'setup', color: 'blue', home: { x: 3, y: 3, dir: 0 } })
    dispatch({ kind: 'edge', color: 'blue', id: 'h:15:15' })
  })
  await waitForGame(guest, () => window.gameStore.state.current === 'red')
  await guest.evaluate(async () => {
    const { dispatch } = await import('/src/store.ts')
    dispatch({ kind: 'edge', color: 'red', id: 'v:4:3' })
  })
  for (const page of [host, guest]) {
    await waitForGame(page, () => {
      const { state } = window.gameStore
      return state.edges.get('v:4:3')?.color === 'red' && state.current === 'blue'
    })
  }
  console.log('ok: 客人在房主基地开口放镜，房主确认后两端棋局与回合一致')
  for (const page of [host, guest]) {
    assert(await page.getByLabel('边界反射', { exact: false }).isDisabled(), '开局后两端边界规则都锁定')
  }
  await guest.reload()
  await waitForGame(guest, () => {
    const { state } = window.gameStore
    return state.phase === 'play' && !state.peerLeft && state.boundaryReflects && state.edges.has('v:4:3')
  })
  assert(await guest.getByLabel('边界反射', { exact: false }).isChecked())
  console.log('ok: 开局后边界规则锁定，客人刷新重连后仍保持一致')

  for (const page of [host, guest]) {
    const clock = await page.evaluate(async () => {
      const { state, remainingTime } = await import('/src/store.ts')
      return { settings: { ...state.clockSettings }, blue: remainingTime('blue', Date.now()), red: remainingTime('red', Date.now()) }
    })
    assert.deepEqual(clock.settings, { enabled: true, initialMs: 120000, incrementMs: 10000 })
    assert(clock.blue > 120000 && clock.blue <= 130000, '蓝方落子后加 10 秒并继续倒计时')
    assert(clock.red > 120000 && clock.red <= 130000, `红方落子后加 10 秒并在对方回合停表: ${JSON.stringify(clock)}`)
    assert.equal(await page.locator('.clock-row').count(), 2)
    assert(await page.getByLabel('每人用时（分钟）').isDisabled(), '开局后棋钟设置锁定')
  }
  await host.evaluate(async () => {
    const { state, tickClock } = await import('/src/store.ts')
    tickClock(state.clock.runningSince + state.clock.remaining[state.current] + 1)
  })
  for (const page of [host, guest]) {
    await waitForGame(page, () => {
      const { state } = window.gameStore
      return state.phase === 'over' && state.winner === 'red' && state.timedOut.includes('blue') && state.clock.remaining.blue === 0
    })
    assert.equal(await page.locator('.clock-row[data-color="blue"] .clock-value').innerText(), '00:00')
  }
  console.log('ok: 默认 2 分钟加 10 秒、两端落子加秒、重连恢复、设置锁定及房主超时判负同步')
} finally {
  await browser.close()
  for (const { server, broker } of brokers) {
    for (const socket of server.clients) socket.terminate()
    if (server.address()) await new Promise(resolve => server.close(resolve))
    if (!broker.closed) await new Promise(resolve => broker.close(resolve))
  }
  await vite.close()
}
