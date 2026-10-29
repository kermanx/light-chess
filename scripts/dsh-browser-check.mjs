// Real packed DSH core, provider and tool loop; only the remote model is a
// deterministic Messages fixture. No developer API credentials are read.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer as createVite, preview } from 'vite'

const key = 'dsh-fixture-key'
const records = await mkdtemp(join(tmpdir(), 'light-chess-dsh-browser-'))
process.env.LIGHT_CHESS_AI_LOG_DIR = records
let calls = [], scenario = 'play', stalled = false
const sequence = [
  ['analyze', { sequence: [], light: { color: 'blue', target: { x: 2, y: 13 } }, limit: 2 }],
  ['analyze', { sequence: [{ kind: 'diag', x: 2, y: 13, ori: '/' }], limit: 2 }],
  ['play', { action: { kind: 'edge', id: 'v:3:2' }, reason: 'illegal enclosure fixture' }],
  ['play', { action: { kind: 'diag', x: 2, y: 13, ori: '/' }, reason: '接通直接攻击，迫使对手防守。' }],
]
const api = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', '*')
  if (req.method === 'OPTIONS') return res.end()
  let body = ''; for await (const chunk of req) body += chunk
  assert.equal(req.headers['x-api-key'], key)
  const message = JSON.parse(body)
  assert(!body.includes(key), 'Credentials must not be part of the model prompt')
  assert.deepEqual(message.tools.map(t => t.name).sort(), ['analyze', 'play'], 'preset exposes only two native game tools')
  assert(JSON.stringify(message.system).includes('安全时优先直接进攻'), 'preset persona reaches model')
  assert(JSON.stringify(message.system).includes('棋盘边界全反射'), 'complete rules are in the system prompt')
  assert(!JSON.stringify(message.messages).includes('棋盘边界全反射'), 'rules are not repeated in tool results or user messages')
  calls.push(message)
  if (scenario === 'cancel') { stalled = true; return }
  if (scenario === 'error') {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'fixture rejected credentials' } }))
  }
  const [name, input] = scenario === 'setup'
    ? ['play', { action: { kind: 'setup', home: { x: 13, y: 13, dir: 2 } }, reason: '基地合法布置。' }]
    : scenario === 'preview' ? ['play', { action: { kind: 'edge', id: 'h:12:14' }, reason: '浏览器 DSH 完成合法落子。' }]
    : sequence[calls.length - 1] ?? ['analyze', {}]
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message: { id: `message-${calls.length}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
  event('content_block_start', { index: 5, content_block: { type: 'text', text: input.reason ?? '分析当前局面。' } })
  event('content_block_stop', { index: 5 })
  event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `tool-${calls.length}`, name, input: {} } })
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input, (key, value) => key === 'reason' ? undefined : value) } })
  event('content_block_stop', { index: 0 })
  event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 25 } })
  event('message_stop', {}); res.end()
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
const vite = await createVite({ cacheDir: 'node_modules/.vite-dsh-check', server: { host: '127.0.0.1', port: 0, hmr: false } })
await vite.listen()
const browser = await chromium.launch()
try {
  const page = await browser.newPage(), errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`)
  const request = await page.evaluate(async () => {
    const { makeAiRequest } = await import('/src/ai/protocol.ts'), { edgeOf } = await import('/src/game.ts')
    const board = { size: 16, boundaryReflects: true, homes: { blue: { x: 2, y: 2, dir: 0 }, red: { x: 13, y: 13, dir: 2 } }, edges: new Map(), diags: new Map() }
    for (const [color, home] of Object.entries(board.homes)) for (let d = 0; d < 4; d++) if (d !== home.dir) board.edges.set(edgeOf(home.x, home.y, d), { color })
    return makeAiRequest(board, { phase: 'play', players: ['blue', 'red'], current: 'blue', dead: [], budgetMs: 1 })
  })
  const run = request => page.evaluate(async ({ request, port, key }) => {
    const { createDshWorker } = await import('/src/ai/dsh-provider.ts'), worker = createDshWorker(), events = []
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { worker.terminate(); reject(new Error('DSH fixture timed out')) }, 30000)
      worker.onmessage = e => {
        if ('type' in e.data) events.push(e.data)
        else { clearTimeout(timer); worker.terminate(); resolve({ result: e.data, events }) }
      }
      worker.postMessage({ ...request, dsh: { apiKey: key, baseURL: `http://127.0.0.1:${port}/anthropic`, model: 'deepseek-flash' } })
    })
  }, { request, port: api.address().port, key })
  const played = await run(request)
  assert.deepEqual(played.result.action, sequence.at(-1)[1].action)
  assert(played.events.some(e => e.detail?.preset === 'light-chess'))
  const trace = played.events.filter(e => e.type === 'trajectory').map(e => e.payload)
  assert(trace.some(p => p.kind === 'header'))
  assert(trace.some(p => p.kind === 'stream' && p.frame.type === 'chunk'))
  assert.equal(trace.filter(p => p.kind === 'event' && p.event.type === 'tool/result').length, sequence.length)
  assert(trace.some(p => p.kind === 'event' && p.event.type === 'turn/end'), 'the Worker settles the full trajectory before returning its move')
  assert.equal(calls.length, sequence.length, 'No extra paid request after selecting a move')
  assert(played.events.some(e => e.detail?.result?.error?.includes('enclosure')))
  assert(played.events.some(e => e.detail?.result?.light?.pathToTarget?.length === 2))
  assert(played.events.some(e => e.detail?.result?.moves?.attack?.candidates?.length === 2))
  assert(played.events.some(e => e.detail?.result?.position?.current === 'red' && e.detail.result.moves?.defend.total > 0))
  assert.deepEqual(played.events.findLast(e => e.detail?.tool === 'play' && e.detail?.result?.ok)?.detail.result, { ok: true })
  assert(!JSON.stringify(played).includes(key))
  console.log('ok: actual packed DSH core performs all game tools, rejects illegal move, selects one legal action, and stops inference')
  scenario = 'setup'; calls = []
  const setup = structuredClone(request)
  setup.phase = 'setup'; setup.current = 1; setup.homes[1] = null
  setup.horizontal = setup.horizontal.map(c => c === 2 ? 0 : c); setup.vertical = setup.vertical.map(c => c === 2 ? 0 : c)
  assert.equal((await run(setup)).result.action.kind, 'setup')
  scenario = 'error'; calls = []
  assert.match((await run(request)).result.error, /fixture rejected credentials/)
  assert.equal(calls.length, 1)
  console.log('ok: actual DSH setup and actionable API authentication failure')
  scenario = 'cancel'; calls = []
  await page.evaluate(async ({ request, port, key }) => {
    const { createDshWorker } = await import('/src/ai/dsh-provider.ts')
    window.chessTestWorker = createDshWorker(); window.chessTestResults = []
    chessTestWorker.onmessage = e => { if (!('type' in e.data)) chessTestResults.push(e.data) }
    chessTestWorker.postMessage({ ...request, dsh: { apiKey: key, baseURL: `http://127.0.0.1:${port}/anthropic`, model: 'deepseek-flash' } })
  }, { request, port: api.address().port, key })
  for (let i = 0; !stalled && i < 100; i++) await new Promise(r => setTimeout(r, 100))
  assert(stalled)
  await page.evaluate(() => chessTestWorker.terminate())
  await new Promise(r => setTimeout(r, 100))
  assert.deepEqual(await page.evaluate(() => chessTestResults), [])
  assert.equal(calls.length, 1)
  assert.deepEqual(errors, [])
  console.log('ok: cancellation terminates browser runtime during network inference without a stale result')
  if (process.argv.includes('--preview')) {
    scenario = 'preview'; calls = []
    const production = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } })
    try {
      const product = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
      product.on('pageerror', e => errors.push(e.message))
      await product.goto(`http://127.0.0.1:${production.httpServer.address().port}/ai-test`)
      await product.getByLabel('测试 AI 实现').selectOption('dsh')
  await product.getByRole('button', { name: /管理 LLM 配置/ }).click()
      await product.getByLabel('DSH API 地址').fill(`http://127.0.0.1:${api.address().port}/anthropic`)
      await product.getByLabel('DSH API Key').fill(key)
      await product.getByRole('button', { name: '保存配置', exact: true }).click()
  await product.getByRole('button', { name: '完成', exact: true }).click()
      await product.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(4 * 16 + 4).click()
      await product.getByText('浏览器 DSH 完成合法落子。', { exact: true }).waitFor({ timeout: 30000 })
      await product.getByText('记录已保存到本地文件', { exact: true }).waitFor()
      await product.screenshot({ path: '.dsh-build/preview.png', fullPage: true })
      assert.equal(calls.length, 1)
      assert.deepEqual(errors, [])
      console.log('ok: production /ai-test page loads actual DSH assets and commits the chosen move with durable recording')
    } finally { await new Promise(r => production.httpServer.close(r)) }
  }
} finally {
  api.closeAllConnections(); await new Promise(r => api.close(r))
  await browser.close(); await vite.close()
  await rm(records, { recursive: true, force: true })
}
