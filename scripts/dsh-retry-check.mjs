// Regression for game 5f41b775: the provider ended play with invalid JSON.
// Real DSH runtime and game tools; a local Messages endpoint supplies failures.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdir, symlink, lstat, writeFile } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'rolldown'

const root = fileURLToPath(new URL('..', import.meta.url))
const source = resolve(process.env.DSH_SOURCE ?? join(root, '../deepseek-harness'))
const output = join(root, '.dsh-build/retry-check')
const packer = await import(pathToFileURL(join(source, 'packages/experimental/webworker-packer/lib/index.js')).href)
await mkdir(output, { recursive: true })
await writeFile(join(output, 'package.json'), '{"type":"module","private":true}')
for (const [name, path] of packer.indexWorkspacePackages(source)) {
  const target = join(output, 'node_modules', name)
  await mkdir(dirname(target), { recursive: true })
  try { await lstat(target) } catch (error) {
    if (error.code !== 'ENOENT') throw error
    await symlink(path, target, 'dir')
  }
}
await build({ input: { runtime: join(root, 'scripts/dsh/runtime.mjs'), game: join(root, 'scripts/dsh-browser/tools.ts') },
  external: id => id.startsWith('@deepseek-ai/'), platform: 'node', output: { dir: output, format: 'esm' } })
const { createChessPlayer } = await import(pathToFileURL(join(output, 'runtime.js')).href)
const { createGameTools, RULES } = await import(pathToFileURL(join(output, 'game.js')).href)
const broken = '{"action": {"kind": "setup", "home": {"x": 17, "y": 17, "dir": 0}}, "rationale"'
const explanation = '基地布置回归测试。'
const valid = { action: { kind: 'setup', home: { x: 17, y: 17, dir: 0 } } }
let scenario, requests
const api = createServer(async (req, res) => {
  let body = ''; for await (const chunk of req) body += chunk
  assert.equal(req.headers['x-api-key'], 'retry-fixture-key')
  const request = JSON.parse(body); requests.push(request)
  assert(request.system.startsWith('You are an AI agent powered by DeepSeek Harness.\n\nYou are a coding agent powered by the deepseek-flash model.\n\n'), 'model requests retain the exact standard DSH opener')
  assert(request.system.includes('B 的新攻击给 A 一手防守机会'), 'the native preset includes the explicit settlement example')
  const playSchema = request.tools.find(t => t.name === 'play').input_schema
  assert.deepEqual(Object.keys(playSchema.properties), ['action'], 'only action belongs in the commit tool; explanation is response text')
  assert.deepEqual(playSchema.required, ['action'])
  if (scenario === 'auth') {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'fixture authentication failure' } }))
  }
  const number = requests.length
  const analyze = ['recover', 'no-text'].includes(scenario) && number === 1
  const malformed = scenario === 'exhaust' || scenario === 'cancel' || scenario === 'recover' && number === 2
  const args = malformed ? broken : JSON.stringify(analyze ? {} : scenario === 'tool-error' && number === 1
    ? { ...valid, action: { kind: 'setup', home: { x: 36, y: 36, dir: 0 } } } : valid)
  res.writeHead(200, { 'Content-Type': 'text/event-stream' })
  const event = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
  event('message_start', { message: { id: `m-${number}`, type: 'message', role: 'assistant', model: 'deepseek-flash', content: [], stop_reason: null, usage: { input_tokens: 100, output_tokens: 0 } } })
  event('content_block_start', { index: 5, content_block: { type: 'thinking', thinking: 'Internal fixture reasoning must not become the saved explanation.' } })
  event('content_block_stop', { index: 5 })
  if (analyze || scenario !== 'no-text') {
    event('content_block_start', { index: 6, content_block: { type: 'text', text: analyze ? 'Earlier analysis must not become the saved explanation.' : explanation } })
    event('content_block_stop', { index: 6 })
  }
  event('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `t-${number}`, name: analyze ? 'analyze' : 'play', input: {} } })
  event('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: args } })
  event('content_block_stop', { index: 0 })
  event('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 30 } })
  event('message_stop', {}); res.end()
})
await new Promise(resolve => api.listen(0, '127.0.0.1', resolve))
try {
  for (scenario of ['recover', 'exhaust', 'auth', 'cancel', 'tool-error', 'no-text']) {
    requests = []
    const events = [], selected = [], reasons = [], n = 36
    const game = createGameTools({ version: 1, phase: 'setup', size: n, current: 0, players: [0, 1], aliveMask: 3,
      homes: [null, null, null, null], horizontal: Array(n * (n + 1)).fill(0), vertical: Array(n * (n + 1)).fill(0),
      diagonals: Array(n * n).fill(0), budgetMs: 1 }, (action, reason) => { selected.push(action); reasons.push(reason) })
    let player
    player = await createChessPlayer({ game, rules: RULES, mode: 'browser',
      config: { apiKey: 'retry-fixture-key', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${api.address().port}/anthropic` },
      onSessionEvent(_id, event) {
        events.push(event)
        if (selected.length && event.type === 'tool/result' || scenario === 'cancel' && event.type === 'llm/retry') player.agent.cancel({ kind: 'parent' })
      },
    })
    try {
      await player.turn('布置基地，使用 play。')
      const retries = events.filter(e => e.type === 'llm/retry'), calls = events.filter(e => e.type === 'tool/call')
      if (scenario === 'recover') {
        assert.equal(requests.length, 3)
        assert.equal(retries.length, 1)
        assert.deepEqual(requests[1].messages, requests[2].messages, 'retry the same step without replaying completed tools or the broken call')
        assert.deepEqual(calls.map(e => e.data.name), ['analyze', 'play'])
        assert(events.some(e => e.type === 'assistant/attempt' && JSON.stringify(e).includes('rationale')))
        assert.deepEqual(selected, [valid.action]); assert.deepEqual(reasons, [explanation])
      } else if (scenario === 'exhaust') {
        assert.equal(requests.length, 3); assert.equal(retries.length, 2)
        assert.equal(calls.length, 0); assert.equal(selected.length, 0)
        assert.equal(events.at(-1).data.reason.error.code, 'MALFORMED_RESPONSE')
      } else if (scenario === 'auth') {
        assert.equal(requests.length, 1); assert.equal(retries.length, 0); assert.equal(selected.length, 0)
      } else if (scenario === 'cancel') {
        assert.equal(requests.length, 1); assert.equal(retries.length, 1); assert.equal(selected.length, 0)
        assert(!events.some(e => e.type === 'llm/retry-started'))
      } else if (scenario === 'no-text') {
        assert.equal(requests.length, 2); assert.deepEqual(selected, [valid.action]); assert.deepEqual(reasons, [''])
      } else {
        assert.equal(requests.length, 2); assert.equal(retries.length, 0)
        assert(events.some(e => e.type === 'tool/result' && e.data.message.isError))
        assert.deepEqual(selected, [valid.action]); assert.deepEqual(reasons, [explanation])
      }
      console.log(`ok: DSH retry regression — ${scenario}`)
    } finally { await player.dispose() }
  }
} finally {
  api.closeAllConnections(); await new Promise(resolve => api.close(resolve))
}
