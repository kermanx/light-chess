// Real DSH CLI profile + native preset + inference/tool loop. Only the model
// endpoint is a deterministic fixture; no personal credentials or config.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initGame, advance, findMoves, persist, loadState } from './arena/game.mjs'
import { prepareArena } from './dsh/build-native.mjs'

const directory = mkdtempSync(join(tmpdir(), 'light-chess-native-preset-'))
const key = 'native-preset-fixture-key'
let child, output = '', errors = '', calls = 0, watchdog
const initial = initGame(directory, new URL('../src/ai/engine.wasm', import.meta.url))
const blue = advance(initial, { kind: 'diag', x: 0, y: 0, ori: '/' }, 'fixture', 'fixture')
const redAttack = findMoves(blue, 'red', 'attack').candidates[0].action
const checked = advance(blue, redAttack, 'fixture check', 'fixture')
persist(directory, checked)
function losingMove(state) {
  // Safe moves sort first, so inspect every page if necessary.
  for (let offset = 0; ; offset += 80) {
    const page = findMoves(state, 'blue', 'legal', offset, 80)
    const miss = page.candidates.find(c => !c.safe)?.action
    if (miss || page.nextOffset === null) return miss
  }
}
const miss = losingMove(checked)
assert(miss)
const defense = findMoves(checked, 'blue', 'defend').candidates[0].action
const sequence = [
  ['analyze', { sequence: [], light: { color: 'red' }, limit: 2 }],
  ['analyze', { sequence: [miss] }],
  ['play', { action: { kind: 'diag', x: 2, y: 2, ori: '/' }, reason: 'invalid home fixture' }],
  ['play', { action: defense, reason: '守住基地，验证下一轮由宿主提供棋盘。' }],
  ['analyze', { sequence: [], limit: 1 }],
  ['play', { reason: '终局结算测试。' }],
]
const api = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  assert.equal(req.headers['x-api-key'], key)
  assert(!body.includes(key))
  const request = JSON.parse(body)
  assert.deepEqual(request.tools.map(t => t.name).sort(), ['analyze', 'play'])
  assert(JSON.stringify(request.system).includes('安全时优先直接进攻'))
  assert(!request.tools.find(t => t.name === 'play').input_schema.properties.revision, 'revision is managed by the host')
  const [name, input] = sequence[calls++] ?? []
  assert(name, 'no extra model request after terminal play')
  if (calls > 4) {
    assert.equal(loadState(directory).revision, 4)
    const texts = request.messages.filter(m => m.role === 'user').flatMap(m => typeof m.content === 'string' ? [m.content] : m.content.filter(b => b.type === 'text').map(b => b.text))
    assert(texts.some(text => text.includes('当前权威棋盘') && text.includes('"revision":4')), 'next board is injected as a new user message')
  }
  if (calls === sequence.length) {
    input.action = losingMove(loadState(directory))
    assert(input.action, 'fixture must offer an unsafe move to verify terminal settlement')
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message: { id: `m-${calls}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0 } } })
  event('content_block_start', { index: 5, content_block: { type: 'text', text: input.reason ?? '分析当前局面。' } })
  event('content_block_stop', { index: 5 })
  event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `t-${calls}`, name, input: {} } })
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input, (key, value) => key === 'reason' ? undefined : value) } })
  event('content_block_stop', { index: 0 })
  event('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 20 } })
  event('message_stop', {}); res.end()
})
try {
  await new Promise(r => api.listen(0, '127.0.0.1', r))
  const launch = await prepareArena(directory, { model: 'deepseek-flash', baseURL: `http://127.0.0.1:${api.address().port}/anthropic` })
  child = spawn(launch.command, launch.args, { env: { ...launch.env, DEEPSEEK_API_KEY: key }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { output += data })
  child.stderr.on('data', data => { errors += data })
  watchdog = setTimeout(() => { child.kill('SIGKILL') }, 60_000)
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, errors + output)
  assert.equal(calls, sequence.length)
  assert.equal(loadState(directory).winner, 'red')
  assert.equal(loadState(directory).ply, 5)
  assert(!existsSync(join(directory, 'player.lock')))
  const events = readFileSync(join(directory, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.filter(e => e.type === 'tool-call').length, sequence.length)
  assert.equal(events.filter(e => e.type === 'tool-error').length, 1)
  assert.deepEqual(events.findLast(e => e.type === 'tool-result' && e.detail.name === 'play').detail.value, { ok: true })
  assert.equal(events.filter(e => e.type === 'tool-result' && e.detail.name === 'play').length, 2)
  assert(events.some(e => e.type === 'dsh-run-start' && e.detail.preset === 'light-chess'))
  const session = readFileSync(join(directory, 'dsh-session.jsonl'), 'utf8')
  assert(session.includes('agent-preset/selected'))
  assert(!session.includes(key))
  assert(!session.includes('mcp-light-chess'))
  console.log('Native preset passed: real DSH profile, two tools and system rules, hypothetical analysis, illegal rejection, compact play results, fresh host board across two turns, exact terminal settlement, durable logs and credential isolation.')
} finally {
  clearTimeout(watchdog)
  if (child?.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await once(child, 'exit') }
  api.closeAllConnections(); await new Promise(r => api.close(r))
  rmSync(directory, { recursive: true, force: true })
}
