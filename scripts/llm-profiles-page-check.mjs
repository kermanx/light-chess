// Production UI and packed DSH, with two local model endpoints and no personal credentials.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'

const directory = await mkdtemp(join(tmpdir(), 'chess-llm-profiles-'))
process.env.LIGHT_CHESS_AI_LOG_DIR = directory
const requests = [], errors = []
const choices = [
  { kind: 'setup', home: { x: 2, y: 2, dir: 0 } },
  { kind: 'setup', home: { x: 13, y: 13, dir: 2 } },
  { kind: 'diag', x: 2, y: 13, ori: '/' },
  { kind: 'diag', x: 8, y: 13, ori: '/' },
]
const api = createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  if (req.method === 'OPTIONS') return res.end()
  let body = ''; for await (const chunk of req) body += chunk
  const number = requests.length, side = number % 2 ? 'red' : 'blue'
  const message = JSON.parse(body)
  requests.push({ path: req.url, model: message.model, key: req.headers['x-api-key'] })
  assert.equal(req.url, `/${side}/anthropic/v1/messages`)
  assert.equal(message.model, `fixture-${side}`)
  assert.equal(req.headers['x-api-key'], `fixture-${side}-key`)
  assert(!body.includes('-key'))
  assert.deepEqual(Object.keys(message.tools.find(t => t.name === 'play').input_schema.properties), ['action'])
  if (number >= choices.length) return // Hold the next turn for cancellation and reload checks.
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (type, data = {}) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message: { id: `m${number}`, type: 'message', role: 'assistant', model: message.model, content: [], usage: { input_tokens: 100, output_tokens: 0 } } })
  event('content_block_start', { index: 0, content_block: { type: 'text', text: `${side === 'blue' ? '蓝' : '红'}方独立配置完成第 ${number + 1} 次决策。` } })
  event('content_block_stop', { index: 0 })
  event('content_block_start', { index: 1, content_block: { type: 'tool_use', id: `t${number}`, name: 'play', input: {} } })
  event('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ action: choices[number] }) } })
  event('content_block_stop', { index: 1 })
  event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } })
  event('message_stop'); res.end()
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
const server = await preview({ preview: { host: '127.0.0.1', port: 0, strictPort: true } })
const browser = await chromium.launch()
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } })
  const page = await context.newPage()
  page.on('pageerror', e => errors.push(e.message))
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  await page.goto(base)
  assert.equal(await page.getByRole('button', { name: /管理 LLM 配置/ }).count(), 0)
  await page.getByRole('button', { name: /单机对战/ }).click()
  await page.getByLabel('蓝方控制方式').selectOption('dsh')
  await page.getByRole('button', { name: /管理 LLM 配置/ }).click()
  const dialog = page.getByRole('dialog', { name: 'LLM 配置', exact: true })
  async function fill(name, side) {
    await dialog.getByLabel('LLM 配置名称').fill(name)
    await dialog.getByLabel('DSH 模型', { exact: true }).fill(`fixture-${side}`)
    await dialog.getByLabel('DSH API 地址').fill(`http://127.0.0.1:${api.address().port}/${side}/anthropic`)
    await dialog.getByLabel('DSH API Key').fill(`fixture-${side}-key`)
    assert(await dialog.getByLabel('记住 API 配置（包括 Key）').isChecked())
    await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
    await dialog.getByText('已保存，下次打开仍可使用。', { exact: true }).waitFor()
  }
  await fill('蓝方模型', 'blue')
  await dialog.getByRole('button', { name: /添加配置/ }).click()
  await fill('红方模型', 'red')
  await dialog.getByRole('button', { name: '复制配置', exact: true }).click()
  assert.equal(await dialog.getByLabel('LLM 配置名称').inputValue(), '红方模型 副本')
  await dialog.getByRole('button', { name: '保存配置', exact: true }).click()
  await dialog.getByRole('button', { name: '删除配置', exact: true }).click()
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
  assert.equal(await dialog.locator('.profile-item').count(), 2)
  await dialog.getByLabel('LLM 配置名称').fill('未保存的名字')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await dialog.getByRole('button', { name: '继续编辑', exact: true }).click()
  assert.equal(await dialog.getByLabel('LLM 配置名称').inputValue(), '未保存的名字')
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await dialog.getByRole('button', { name: '放弃更改', exact: true }).click()
  await page.reload()
  await page.getByRole('button', { name: /单机对战/ }).click()
  await page.getByLabel('蓝方控制方式').selectOption('dsh')
  await page.getByRole('button', { name: /管理 LLM 配置/ }).click()
  assert.equal(await dialog.getByLabel('LLM 配置名称').inputValue(), '蓝方模型')
  assert.equal(await dialog.locator('.profile-item').count(), 2)
  await mkdir('.dsh-build', { recursive: true })
  await page.screenshot({ path: '.dsh-build/llm-profiles-desktop.png' })
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await dialog.getByRole('button', { name: '保存配置', exact: true }).isVisible())
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  await page.screenshot({ path: '.dsh-build/llm-profiles-mobile.png' })
  await page.setViewportSize({ width: 1440, height: 1000 })
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  await page.getByLabel('蓝方控制方式').selectOption('dsh')
  await page.getByLabel('红方控制方式').selectOption('dsh')
  await page.getByLabel('红方 LLM 配置').selectOption({ label: '红方模型 · fixture-red' })
  await page.getByRole('spinbutton').first().fill('16')
  await page.getByRole('spinbutton').first().press('Tab')
  await page.getByLabel('棋钟', { exact: true }).uncheck()
  await page.getByRole('button', { name: '开始对局', exact: true }).click()
  await page.getByLabel('AI 上一步说明').getByText('红方独立配置完成第 4 次决策。', { exact: true }).waitFor({ timeout: 60000 })
  await page.getByRole('button', { name: '取消本次思考', exact: true }).click()
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).waitFor()
  assert.deepEqual(requests.slice(0, 4).map(r => r.model), ['fixture-blue', 'fixture-red', 'fixture-blue', 'fixture-red'])
  const selected = await Promise.all(['蓝方 LLM 配置', '红方 LLM 配置'].map(label => page.getByLabel(label).inputValue()))
  assert.notEqual(selected[0], selected[1])
  assert.equal(await page.getByLabel('选择 DSH 决策轨迹').locator('option').filter({ hasText: '已落子' }).count(), 4)
  await page.reload()
  await page.getByRole('button', { name: '恢复 AI 思考', exact: true }).waitFor()
  assert.deepEqual(await Promise.all(['蓝方 LLM 配置', '红方 LLM 配置'].map(label => page.getByLabel(label).inputValue())), selected)
  assert.equal(await page.getByLabel('选择 DSH 决策轨迹').locator('option').filter({ hasText: '已落子' }).count(), 4)
  await page.screenshot({ path: '.dsh-build/llm-profiles-match.png' })
  await page.getByRole('button', { name: /管理 LLM 配置/ }).click()
  await dialog.getByRole('button', { name: /红方模型 fixture-red/ }).click()
  await dialog.getByRole('button', { name: '删除配置', exact: true }).click()
  await dialog.getByRole('button', { name: '确认删除', exact: true }).click()
  await dialog.getByRole('button', { name: '完成', exact: true }).click()
  assert.equal(await page.getByLabel('红方 LLM 配置').locator('option:checked').textContent(), '原配置已删除，请重新选择')
  assert.deepEqual(errors, [])
  console.log('ok: production multi-LLM UI CRUD, unsaved changes, persistence, responsive modal, two actual DSH workers using distinct endpoint/model/key, legal moves and explanations, trajectory restoration, deleted-profile handling')
} finally {
  await browser.close(); api.closeAllConnections()
  await new Promise(resolve => api.close(resolve)); await new Promise(resolve => server.httpServer.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
