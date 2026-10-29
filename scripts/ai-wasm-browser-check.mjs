// Real Rust/WASM in browser Workers, including mixed online play. Run npm run build:ai first.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'
import aedes from 'aedes'
import { WebSocketServer, createWebSocketStream } from 'ws'

const broker = aedes()
const relay = new WebSocketServer({ port: 0 })
relay.on('connection', socket => broker.handle(createWebSocketStream(socket)))
await new Promise(resolve => relay.once('listening', resolve))
const vite = await createServer({ cacheDir: 'node_modules/.vite-ai-wasm-check', server: { host: '127.0.0.1', port: 0, hmr: false } })
await vite.listen()
const base = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch()
const errors = []
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  await context.addInitScript(relayUrl => {
    localStorage.setItem('light-chess:mqtt-relays', relayUrl)
    window.__aiWorkers = []
    const OriginalWorker = window.Worker
    window.Worker = class extends OriginalWorker {
      postMessage(request, ...args) {
        if (request?.version === 1 && request?.horizontal) {
          this.record = { request, terminated: false }
          __aiWorkers.push(this.record)
        }
        return super.postMessage(request, ...args)
      }
      terminate() { if (this.record) this.record.terminated = true; return super.terminate() }
    }
  }, `ws://127.0.0.1:${relay.address().port}`)
  const host = await context.newPage()
  const guest = await context.newPage()
  for (const page of [host, guest]) page.on('pageerror', error => errors.push(error.message))
  const dispatch = (page, action) => page.evaluate(async action => (await import('/src/store.ts')).dispatch(action), action)
  const saved = page => page.evaluate(async () => (await import('/src/store.ts')).serialize())
  const waitPlay = page => page.waitForFunction(() => JSON.parse(sessionStorage.getItem('light-chess:save') ?? '{}').phase === 'play', { timeout: 20000 })

  await host.goto(base)
  await host.getByRole('button', { name: '挑战 AI', exact: false }).click()
  await host.getByLabel('AI 每步思考上限').selectOption('3000')
  await host.getByRole('spinbutton').last().fill('16')
  await host.getByRole('spinbutton').last().dispatchEvent('change')
  await host.getByRole('button', { name: '开始对局' }).click()
  await dispatch(host, { kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
  await waitPlay(host)
  assert((await saved(host)).homes.red)
  await dispatch(host, { kind: 'edge', color: 'blue', id: 'h:0:0' })
  await host.waitForFunction(() => JSON.parse(sessionStorage.getItem('light-chess:save') ?? '{}').lastMove?.color === 'red', { timeout: 20000 })
  assert.equal((await saved(host)).current, 'blue')
  assert.equal(await host.locator('.ai-error').count(), 0)
  const stats = await host.evaluate(async () => (await import('/src/ai/controller.ts')).aiStatus.stats)
  assert(stats.nodes > 0)
  console.log(`ok: real WASM loads in Worker, auto setup and move (${stats.nodes} nodes, ${stats.elapsedMs.toFixed(0)} ms)`)

  for (const kind of ['undo', 'restart']) {
    await dispatch(host, { kind: 'restart', color: 'blue' })
    await dispatch(host, { kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
    await waitPlay(host)
    const cancelled = await host.evaluate(async kind => {
      const store = await import('/src/store.ts')
      store.dispatch({ kind: 'edge', color: 'blue', id: 'h:0:0' })
      await Promise.resolve() // Vue launches Worker; WASM result cannot run before this JS task finishes.
      const record = __aiWorkers.at(-1)
      if (kind === 'undo') store.dispatch({ kind: 'undo', color: 'red', frame: store.topUndoFrame() })
      else store.dispatch({ kind: 'restart', color: 'blue' })
      await Promise.resolve()
      return record.request.phase === 'play' && record.terminated
    }, kind)
    assert(cancelled, `${kind} should terminate the real search Worker`)
    await host.waitForTimeout(3200)
    const snapshot = await saved(host)
    assert.equal(snapshot.lastMove, null)
    assert.equal(snapshot.phase, kind === 'undo' ? 'play' : 'setup')
  }
  console.log('ok: undo/restart terminate real WASM searches; no stale move appears after the budget expires')

  await host.getByRole('button', { name: '回到大厅' }).click()
  await host.getByRole('button', { name: '创建房间', exact: false }).click()
  await host.getByRole('button', { name: '3 人', exact: true }).click()
  await host.getByLabel('黄方控制方式').selectOption('wasm')
  await host.getByLabel('AI 每步思考上限').selectOption('3000')
  await host.getByRole('spinbutton').last().fill('16')
  await host.getByRole('spinbutton').last().dispatchEvent('change')
  await host.getByRole('button', { name: '创建并等待' }).click()
  await host.locator('.room-code').waitFor()
  const code = (await host.locator('.room-code').innerText()).trim()
  await guest.goto(`${base}/?join=${code}`)
  await host.locator('svg.board-svg').waitFor({ timeout: 20000 })
  await guest.locator('svg.board-svg').waitFor({ timeout: 20000 })
  await dispatch(host, { kind: 'setup', color: 'blue', home: { x: 2, y: 2, dir: 0 } })
  await dispatch(guest, { kind: 'setup', color: 'red', home: { x: 10, y: 8, dir: 2 } })
  await waitPlay(host)
  await waitPlay(guest)
  await dispatch(host, { kind: 'edge', color: 'blue', id: 'h:0:0' })
  await guest.waitForFunction(() => JSON.parse(sessionStorage.getItem('light-chess:save') ?? '{}').current === 'red')
  await dispatch(guest, { kind: 'edge', color: 'red', id: 'h:1:0' })
  await host.waitForFunction(() => JSON.parse(sessionStorage.getItem('light-chess:save') ?? '{}').lastMove?.color === 'yellow', { timeout: 20000 })
  await guest.waitForFunction(() => JSON.parse(sessionStorage.getItem('light-chess:save') ?? '{}').lastMove?.color === 'yellow', { timeout: 20000 })
  const a = await saved(host), b = await saved(guest)
  assert.deepEqual(a.homes, b.homes)
  assert.deepEqual(a.edges, b.edges)
  assert.deepEqual(a.diags, b.diags)
  assert.equal(await guest.evaluate(() => __aiWorkers.length), 0)
  assert.equal(await host.locator('.ai-error').count(), 0)
  assert.deepEqual(errors, [])
  console.log('ok: real WASM mixed three-player setup/move synchronizes; only host creates Workers')
} finally {
  await browser.close()
  await vite.close()
  for (const client of relay.clients) client.terminate()
  await new Promise(resolve => relay.close(resolve))
  await new Promise(resolve => broker.close(resolve))
}
console.log('Real AI browser checks passed')
