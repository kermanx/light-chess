// Exercise provider selection/configuration/recording through real Vue UI + DSH adapter.
// The model Worker is controlled; this test makes no external API requests.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const directory = await mkdtemp(join(tmpdir(), 'light-chess-provider-'))
process.env.LIGHT_CHESS_AI_LOG_DIR = directory
const vite = await createServer({ cacheDir: 'node_modules/.vite-ai-provider-check', server: { host: '127.0.0.1', port: 0, hmr: false } })
await vite.listen()
const base = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch()
const errors = []
const until = async (check, label) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timed out: ${label}`)
}
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } })
  await context.route('**/dsh/manifest.json', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ worker: 'worker-1234.js', image: 'image-1234.bin' }) }))
  await context.addInitScript(() => {
    const OriginalWorker = window.Worker
    window.__dshDelay = 5000
    window.__dshRequests = []
    window.Worker = class {
      constructor(url, options) {
        this.dsh = String(url).includes('/dsh/worker-1234.js')
        if (!this.dsh && !String(url).includes('/ai/worker.ts')) return new OriginalWorker(url, options)
      }
      postMessage(data) {
        if (this.dsh && data.t === 'req' && data.id === 'boot') return
        if (this.dsh && data.t === 'init') {
          queueMicrotask(() => this.onmessage?.({ data: { channel: 'light-chess', type: 'ready' } }))
          return
        }
        const request = this.dsh ? (data.request ?? JSON.parse(new TextDecoder().decode(data.body))) : data
        if (this.dsh) {
          window.__dshRequests.push(request)
          this.onmessage?.({ data: { channel: 'light-chess', type: 'progress', message: `正在检查光路 ${request.dsh.apiKey}`, detail: { tool: 'inspect', arguments: { apiKey: request.dsh.apiKey }, output: 'reachable paths' } } })
        }
        this.timer = setTimeout(() => {
          const result = {
            action: request.phase === 'setup'
              ? { kind: 'setup', home: request.current === 0 ? { x: 2, y: 2, dir: 0 } : { x: 10, y: 8, dir: 2 } }
              : { kind: 'edge', id: 'h:12:14' },
            stats: { nodes: 1, depth: 0, elapsedMs: 12000, score: 0, mode: this.dsh ? 'dsh' : 'attack', reason: this.dsh ? `工具验证完成 ${request.dsh.apiKey}` : 'WASM 验证完成' },
          }
          this.onmessage?.({ data: this.dsh ? { channel: 'light-chess', type: 'result', result } : result })
        }, this.dsh ? window.__dshDelay : 100)
      }
      terminate() { clearTimeout(this.timer) }
    }
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  const snapshot = () => page.evaluate(async () => (await import('/src/store.ts')).serialize())
  const key = 'browser-provider-test-secret'
  await page.goto(`${base}/ai-test`)
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  const firstId = (await snapshot()).sessionId
  assert.equal(await page.getByRole('spinbutton').count(), 0)
  assert.equal((await snapshot()).clockSettings.enabled, false)
  await page.getByLabel('测试 AI 实现').selectOption('dsh')
  await page.getByRole('button', { name: /管理 LLM 配置/ }).click()
  assert.equal(await page.getByLabel('AI 每步思考上限').count(), 0)
  assert.equal(await page.getByLabel('DSH API 地址').inputValue(), 'https://api.deepseek.com/anthropic')
  assert.equal(await page.getByLabel('DSH 模型', { exact: true }).inputValue(), 'deepseek-flash')
  assert.equal(await page.getByLabel('记住 API 配置（包括 Key）').isChecked(), true)
  const connection = { baseURL: 'https://example.com/anthropic', model: 'configured-model', apiKey: key }
  await page.getByLabel('DSH API 地址').fill(connection.baseURL)
  await page.getByLabel('DSH 模型', { exact: true }).fill(connection.model)
  await page.getByLabel('DSH API Key').fill(key)
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('light-chess:llm-profiles')).profiles.map(({baseURL, model, apiKey}) => ({baseURL, model, apiKey}))[0]), connection)
  assert.equal(await page.evaluate(() => sessionStorage.getItem('light-chess:dsh-connection')), null)
  await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(4 * 16 + 4).click()
  await page.getByText('正在检查光路 [redacted]', { exact: true }).waitFor({ timeout: 10000 }).catch(async error => {
    console.error(await page.locator('body').innerText())
    throw error
  })
  await page.getByRole('button', { name: '取消本次思考', exact: true }).click()
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).waitFor()
  assert.equal((await snapshot()).aiPaused, true)
  await page.getByLabel('测试 AI 实现').selectOption('wasm')
  assert.equal((await snapshot()).aiPaused, true)
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).click()
  await until(async () => (await snapshot()).lastMove?.color === 'red', 'WASM answer after switch')
  assert.equal((await snapshot()).aiProviders.red, 'wasm')
  await page.getByRole('button', { name: '撤回一步', exact: true }).click()
  await page.getByLabel('测试 AI 实现').selectOption('dsh')
  await page.evaluate(() => { __dshDelay = 150 })
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).click()
  await page.getByText('工具验证完成 [redacted]', { exact: true }).waitFor()
  assert(!(await page.locator('body').innerText()).includes(key))
  assert(!JSON.stringify(await snapshot()).includes(key))
  await until(async () => {
    try { return (await readFile(join(directory, `${firstId}.jsonl`), 'utf8')).includes('search-accepted') }
    catch { return false }
  }, 'events saved')
  const recorded = await readFile(join(directory, `${firstId}.jsonl`), 'utf8')
  assert(!recorded.includes(key))
  assert(recorded.includes('search-progress'))
  assert(recorded.includes('ai-provider-setting'))
  assert(recorded.includes('ai-pause'))
  console.log('ok: fixed test rules, both providers, DSH adapter/progress, cancel/switch/undo and credential-free disk records')

  const reopened = await context.newPage()
  await reopened.goto(base)
  assert.deepEqual(await reopened.evaluate(async () => (await import('/src/ai/config.ts')).readDshConfig()), connection)
  assert.equal(await reopened.evaluate(() => sessionStorage.getItem('light-chess:dsh-connection')), null)
  await reopened.close()
  await page.getByRole('button', { name: '新对局', exact: true }).click()
  const next = await snapshot()
  assert.notEqual(next.sessionId, firstId)
  assert.equal(next.aiProviders.red, 'dsh')
  assert.equal(next.size, 16)
  assert.equal(next.clockSettings.enabled, false)
  await page.reload()
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  assert.equal((await snapshot()).sessionId, next.sessionId)
  assert.equal((await snapshot()).aiProviders.red, 'dsh')
  await page.getByRole('button', { name: /管理 LLM 配置/ }).click()
  assert.equal(await page.getByLabel('DSH API 地址').inputValue(), connection.baseURL)
  assert.equal(await page.getByLabel('DSH 模型', { exact: true }).inputValue(), connection.model)
  assert.equal(await page.getByLabel('DSH API Key').inputValue(), key)
  await page.getByRole('button', { name: '清除 Key', exact: true }).click()
  assert.equal(await page.evaluate(() => sessionStorage.getItem('light-chess:dsh-connection')), null)
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('light-chess:llm-profiles')).profiles.map(({baseURL, model, apiKey}) => ({baseURL, model, apiKey}))[0]), { ...connection, apiKey: '' })
  assert.equal(await page.getByLabel('记住 API 配置（包括 Key）').isChecked(), true)
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(4 * 16 + 4).click()
  await page.locator('.ai-error[role="alert"]').filter({ hasText: 'API Key' }).waitFor()
  assert.equal((await snapshot()).lastMove.color, 'blue')
  await page.getByRole('button', { name: '回到大厅', exact: true }).click()
  assert.equal(new URL(page.url()).pathname, '/')
  await page.getByRole('button', { name: /单机对战/ }).click()
  await page.getByLabel('蓝方控制方式').selectOption('dsh')
  await page.getByLabel('红方控制方式').selectOption('dsh')
  await page.getByRole('button', { name: /管理 LLM 配置/ }).click()
  await page.getByLabel('LLM 配置名称').fill('模型 A')
  await page.getByLabel('DSH API Key').fill(key)
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: /添加配置/ }).click()
  await page.getByLabel('LLM 配置名称').fill('模型 B')
  await page.getByLabel('DSH 模型', { exact: true }).fill('second-model')
  await page.getByLabel('DSH API 地址').fill('https://second.example/anthropic')
  await page.getByLabel('DSH API Key').fill('second-private-key')
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.getByLabel('红方 LLM 配置').selectOption({ label: '模型 B · second-model' })
  await page.evaluate(() => { __dshRequests = []; __dshDelay = 2000 })
  await page.getByRole('button', { name: '开始对局', exact: true }).click()
  await until(() => page.evaluate(() => __dshRequests.length >= 2), 'second LLM gets its turn')
  await page.getByRole('button', { name: '取消本次思考', exact: true }).click()
  const llmRequests = await page.evaluate(() => __dshRequests)
  assert.equal(llmRequests[0].dsh.model, 'configured-model')
  assert.equal(llmRequests[0].dsh.apiKey, key)
  assert.equal(llmRequests[1].dsh.model, 'second-model')
  assert.equal(llmRequests[1].dsh.apiKey, 'second-private-key')
  const ids = (await snapshot()).aiProfileIds
  await page.reload()
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).waitFor()
  assert.deepEqual((await snapshot()).aiProfileIds, ids)
  assert.equal(await page.getByLabel('红方 LLM 配置').inputValue(), ids.red)
  console.log('ok: modal creates two profiles; each AI seat sends its selected model/key and retains its choice on reload')
  const legacy = await browser.newContext()
  const migrated = await legacy.newPage()
  await migrated.goto(base)
  await migrated.evaluate(connection => sessionStorage.setItem('light-chess:dsh-connection', JSON.stringify(connection)), connection)
  await migrated.reload()
  assert.deepEqual(await migrated.evaluate(async () => (await import('/src/ai/config.ts')).readDshConfig()), connection)
  assert.deepEqual(await migrated.evaluate(() => JSON.parse(localStorage.getItem('light-chess:llm-profiles')).profiles.map(({baseURL, model, apiKey}) => ({baseURL, model, apiKey}))[0]), connection)
  assert.equal(await migrated.evaluate(() => sessionStorage.getItem('light-chess:dsh-connection')), null)
  await legacy.close()
  assert.deepEqual(errors, [])
  console.log('ok: default persistent configuration, new-tab/reload restore, legacy migration, clear-key failure recovery, provider/new-game preservation and exit')
} finally {
  await browser.close()
  await vite.close()
  await rm(directory, { recursive: true, force: true })
}
