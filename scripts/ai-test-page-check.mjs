// Production assets + real WASM + durable local archive, isolated from user games.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'

const directory = await mkdtemp(join(tmpdir(), 'light-chess-ai-test-'))
process.env.LIGHT_CHESS_AI_LOG_DIR = directory
let server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } })
const port = server.httpServer.address().port
const base = `http://127.0.0.1:${port}`
const browser = await chromium.launch()
const errors = []
const diskEvents = async id => (await readFile(join(directory, `${id}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
const until = async (predicate, description, timeout = 20000) => {
  const end = Date.now() + timeout
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout: ${description}`)
}
const saved = page => page.evaluate(async () => {
  const db = await new Promise((resolve, reject) => {
    const req = indexedDB.open('light-chess-ai-tests', 1)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const req = db.transaction('games').objectStore('games').get(location.pathname.split('/').filter(Boolean).at(-1))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally { db.close() }
})
const closeServer = () => new Promise(resolve => server.httpServer.close(resolve))
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => {
    // Test mode must never overwrite the ordinary game's independent save.
    if (!localStorage.getItem('light-chess:save')) localStorage.setItem('light-chess:save', 'ordinary-game-sentinel')
  })
  await page.goto(`${base}/ai-test`)
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  await until(async () => (await saved(page))?.snapshot.phase === 'play', 'automatic setup')
  const first = await saved(page), id = first.id
  assert.equal(first.snapshot.size, 16)
  assert.equal(first.snapshot.clockSettings.enabled, false)
  assert.equal(first.snapshot.clock.runningSince, null)
  assert.equal(first.snapshot.boundaryReflects, true)
  assert.equal(first.snapshot.current, 'blue')
  assert.deepEqual(first.snapshot.aiPlayers, ['red'])
  assert.equal(await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').count(), 256)
  assert.equal(await page.getByRole('spinbutton').count(), 0)
  await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(4 * 16 + 4).click()
  await until(async () => (await saved(page))?.snapshot.lastMove?.color === 'red', 'real AI response')
  await page.getByText('记录已保存到本地文件', { exact: true }).waitFor()
  await until(async () => (await diskEvents(id)).some(e => e.type === 'search-accepted'), 'AI response disk commit')
  const events = await diskEvents(id)
  const actions = events.filter(e => e.type === 'action')
  assert.equal(actions.length, 2)
  assert.equal(actions[0].detail.actor, 'human')
  assert.equal(actions[1].detail.actor, 'ai')
  assert.equal(actions[0].detail.before.diags.length, 0)
  assert.equal(actions[0].detail.after.diags.length, 1)
  const search = events.find(e => e.type === 'search-start')
  const result = events.find(e => e.type === 'search-result')
  assert.equal(actions[1].detail.searchId, search.detail.searchId)
  assert.equal(result.detail.searchId, search.detail.searchId)
  assert.equal(search.detail.detail.request.size, 16)
  assert.equal(search.detail.detail.request.diagonals.length, 256)
  assert(result.detail.detail.result.stats.nodes > 0)
  assert(events[0].detail.build.engineSha256.match(/^[a-f0-9]{64}$/))
  assert.equal((await saved(page)).moveCount, 2)
  assert.equal(await page.evaluate(() => localStorage.getItem('light-chess:save')), 'ordinary-game-sentinel')
  console.log('ok: direct production route, fixed rules, real WASM, full human/AI positions + request/results on disk')

  await page.getByRole('button', { name: '撤回一步', exact: true }).click()
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).waitFor()
  await until(async () => (await diskEvents(id)).some(e => e.type === 'action' && e.detail.action.kind === 'undo'), 'undo retained')
  assert.equal((await saved(page)).snapshot.aiPaused, true)
  await page.reload()
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  assert.equal((await saved(page)).id, id)
  assert.equal((await saved(page)).snapshot.aiPaused, true)
  assert.equal((await saved(page)).snapshot.lastMove.color, 'blue')
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).click()
  await until(async () => (await saved(page)).moveCount === 3, 'replayed AI move after undo/reload')
  await until(async () => (await diskEvents(id)).filter(e => e.type === 'action').length === 5, 'move + undo + resume retained')
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '导出当前记录', exact: true }).click()
  const download = await downloadPromise
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'))
  assert.equal(exported.game.id, id)
  assert.equal(exported.game.moveCount, 3)
  assert.equal(exported.complete, true)
  assert.equal(exported.events.at(-1).id, exported.game.headId)
  assert(exported.events.some(e => e.type === 'action' && e.detail.action.kind === 'undo'))
  console.log('ok: undo history remains intact; direct deep-link reload resumes; exported JSON contains the entire branch')

  await page.route('**/__ai-test/record', route => route.abort())
  await page.getByRole('button', { name: '新对局', exact: true }).click()
  await until(async () => (await saved(page))?.id !== id, 'new independent game')
  const secondId = (await saved(page)).id
  await page.getByText('记录仅保存在浏览器，可导出备份', { exact: false }).waitFor()
  assert.equal((await saved(page)).moveCount, 0)
  await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(5 * 16 + 5).click()
  await until(async () => (await saved(page)).moveCount === 2, 'offline-recorded game')
  await page.reload()
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  assert.equal((await saved(page)).id, secondId)
  assert.equal((await saved(page)).moveCount, 2)
  await page.unroute('**/__ai-test/record')
  await page.evaluate(() => dispatchEvent(new Event('online')))
  await until(async () => {
    try { return (await diskEvents(secondId)).filter(e => e.type === 'action').length === 2 } catch { return false }
  }, 'retry after reload')
  await page.getByText('记录已保存到本地文件', { exact: true }).waitFor()
  assert((await diskEvents(id)).some(e => e.type === 'new-game'))
  assert.equal((await readdir(directory)).filter(f => f.endsWith('.jsonl')).length, 2)
  console.log('ok: new games preserve old archives; unavailable recording service survives reload and resends all pending events')

  // Restart the service: duplicate protection must be reconstructed from disk.
  await closeServer()
  server = await preview({ preview: { host: '127.0.0.1', port, strictPort: true } })
  const original = (await diskEvents(id))[0]
  const post = events => fetch(`${base}/__ai-test/record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, events }),
  })
  const count = (await diskEvents(id)).length
  assert.equal((await post([original, original])).status, 200)
  assert.equal((await diskEvents(id)).length, count)
  assert.equal((await post([{ ...original, gameId: '../escaped' }])).status, 400)
  const forbidden = await fetch(`${base}/__ai-test/record`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.org' },
    body: JSON.stringify({ version: 1, events: [original] }),
  })
  assert.equal(forbidden.status, 403)
  console.log('ok: server restart retains archives and deduplicates; malformed paths and cross-origin writes rejected')

  await page.getByRole('button', { name: '回到大厅', exact: true }).click()
  await page.getByRole('button', { name: '单机对战', exact: false }).waitFor()
  assert.equal(new URL(page.url()).pathname, '/')
  await page.goBack()
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  assert.equal((await saved(page)).id, secondId)
  // A trailing slash must also resolve built assets correctly.
  await page.goto(`${base}/ai-test/`)
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  assert.equal((await saved(page)).id, secondId)
  assert.deepEqual(errors, [])
  console.log('ok: lobby navigation/back and trailing-slash direct URLs; no browser runtime errors')
} finally {
  await browser.close()
  await closeServer()
  await rm(directory, { recursive: true, force: true })
}
console.log('AI test page checks passed')
