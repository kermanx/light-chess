// Production app and actual packed DSH. Only the remote model is a fixture;
// its stream is held open to verify the panel before settlement.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'

const key = 'trajectory-fixture-secret', directory = await mkdtemp(join(tmpdir(), 'chess-trajectory-'))
process.env.LIGHT_CHESS_AI_LOG_DIR = directory
let calls = 0, scenario = 'play', releaseStream
const gate = new Promise(resolve => { releaseStream = resolve })
const sequence = [
  ['analyze', { sequence: [], light: { color: 'red' }, limit: 2 }],
  ['play', { action: { kind: 'diag', x: 13, y: 13, ori: '/' }, reason: '非法落子测试' }],
  ['play', { action: { kind: 'edge', id: 'h:12:14' }, reason: '轨迹测试合法落子' }],
]
const api = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.end()
  let body = ''; for await (const chunk of req) body += chunk
  assert(!body.includes(key))
  assert.equal(req.headers['x-api-key'], key)
  const turn = calls++
  const [name, input] = sequence[turn] ?? ['analyze', {}]
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message: { id: `m-${calls}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
  event('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '' } })
  event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '先检查当前光路。' } })
  if (scenario === 'cancel') return // leave an actual live prefix for cancellation
  if (turn === 0) await gate
  event('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: '再验证落点是否合法。' } })
  event('content_block_stop', { index: 0 })
  event('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
  event('content_block_delta', { index: 1, delta: { type: 'text_delta', text: input.reason ?? '检查红方的安全与进攻。' } })
  event('content_block_stop', { index: 1 })
  event('content_block_start', { index: 2, content_block: { type: 'tool_use', id: `t-${calls}`, name, input: {} } })
  event('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input, (key, value) => key === 'reason' ? undefined : value) } })
  event('content_block_stop', { index: 2 })
  event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 25 } })
  event('message_stop', {}); res.end()
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1050 } }), errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/ai-test`)
  await page.getByLabel('测试 AI 实现').selectOption('dsh')
  await page.getByRole('button', { name: /管理 LLM 配置/ }).click()
  await page.getByLabel('DSH API 地址').fill(`http://127.0.0.1:${api.address().port}/anthropic`)
  await page.getByLabel('DSH API Key').fill(key)
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByRole('button', { name: '完成', exact: true }).click()
  await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(4 * 16 + 4).click()
  const panel = page.getByRole('complementary', { name: 'DSH 实时轨迹' })
  const live = panel.locator('.tui-row[data-kind="assistant"]').filter({ hasText: '先检查当前光路。' })
  await live.waitFor({ timeout: 30000 })
  assert.equal(calls, 1, 'live prefix is visible while first model response is still open')
  await live.click()
  await panel.getByText('先检查当前光路。', { exact: true }).last().waitFor()
  await mkdir('.dsh-build', { recursive: true })
  await page.screenshot({ path: '.dsh-build/trajectory-live.png' })
  await panel.getByRole('button', { name: '收起 DSH 轨迹' }).click()
  await panel.waitFor({ state: 'hidden' })
  releaseStream()
  await page.getByText('轨迹测试合法落子', { exact: true }).waitFor({ timeout: 30000 })
  assert.equal(calls, sequence.length)
  await page.getByRole('button', { name: 'DSH 轨迹 ‹', exact: true }).click()
  await panel.locator('.run-status').filter({ hasText: '已落子' }).waitFor()
  const exportRun = async () => {
    const download = page.waitForEvent('download')
    await panel.getByRole('button', { name: '导出', exact: true }).click()
    return JSON.parse(await readFile(await (await download).path(), 'utf8'))
  }
  const document = await exportRun()
  assert.equal(document.records.filter(r => r.kind === 'tool').length, sequence.length)
  assert(document.records.some(r => r.reasoning === '先检查当前光路。再验证落点是否合法。'))
  assert(document.records.some(r => r.output === '检查红方的安全与进攻。'))
  assert(document.records.some(r => r.kind === 'tool' && JSON.stringify(r.output).includes('base cell')))
  assert(document.records.some(r => r.kind === 'assistant' && r.output === '轨迹测试合法落子'))
  assert(document.records.some(r => r.kind === 'tool' && r.toolName === 'play' && Array.isArray(r.output)
    && r.output.length === 1 && r.output[0].type === 'text' && r.output[0].text === '{"ok":true}'))
  assert(document.requests.every(r => r.provider && r.model && r.tools?.length === 2 && r.systemPrompt && r.usage?.output === 25))
  assert(document.dsh.payloads.some(p => p.kind === 'event' && p.event.type === 'turn/end'))
  assert(!JSON.stringify(document).includes(key))
  await panel.getByRole('row', { name: /^工具 analyze/ }).click()
  await panel.getByRole('button', { name: '结果', exact: true }).click()
  await page.screenshot({ path: '.dsh-build/trajectory-result.png' })
  await page.reload()
  await panel.locator('.run-status').filter({ hasText: '已落子' }).waitFor()
  assert.equal((await exportRun()).dsh.payloads.length, document.dsh.payloads.length)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.equal(Math.round((await panel.boundingBox()).width), 390)
  await page.screenshot({ path: '.dsh-build/trajectory-mobile.png' })
  await page.getByRole('button', { name: '收起 DSH 轨迹' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  await page.setViewportSize({ width: 1600, height: 1050 })
  scenario = 'cancel'
  await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(5 * 16 + 5).click()
  await page.getByRole('button', { name: 'DSH 轨迹 ‹', exact: true }).click()
  await panel.locator('.tui-row[data-kind="assistant"]').filter({ hasText: '先检查当前光路。' }).waitFor({ timeout: 30000 })
  await page.getByRole('button', { name: '取消本次思考', exact: true }).click()
  await panel.locator('.run-status').filter({ hasText: '已取消' }).waitFor()
  const cancelled = await exportRun()
  assert(cancelled.records.some(r => r.reasoning === '先检查当前光路。' && r.interrupted))
  assert.equal(await panel.getByLabel('选择 DSH 决策轨迹').locator('option').count(), 2)
  await panel.getByLabel('选择 DSH 决策轨迹').selectOption(document.chess.searchId)
  await panel.locator('.run-status').filter({ hasText: '已落子' }).waitFor()
  assert.deepEqual(errors, [])
  console.log('Trajectory panel passed: actual DSH streaming prefix, exact messages/tools/results/prompt/usage, final settlement, collapse while running, history, IndexedDB reload, export/redaction, cancellation, responsive layout and no browser errors.')
} finally {
  releaseStream()
  await browser.close(); api.closeAllConnections()
  await new Promise(resolve => api.close(resolve)); await new Promise(resolve => server.httpServer.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
