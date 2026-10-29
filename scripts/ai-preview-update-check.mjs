// Rebuild while a real page is open, before it lazily creates its AI Worker.
// Use a separate dist and recorder directory; never touch the user's preview.
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { build, preview } from 'vite'

// Keep outDir inside Vite's root: outside it Vite already defaults to preserving
// files, which would hide this regression if emptyOutDir were removed again.
const directory = await mkdtemp(join(process.cwd(), '.ai-preview-update-'))
const outDir = join(directory, 'site')
const logs = join(directory, 'logs')
process.env.LIGHT_CHESS_AI_LOG_DIR = logs
let server, browser
const until = async (predicate, description) => {
  const end = Date.now() + 25000
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Timeout: ${description}`)
}
try {
  await cp('dist', outDir, { recursive: true })
  const assets = join(outDir, 'assets')
  const oldAssets = new Map(await Promise.all((await readdir(assets))
    .map(async name => [name, await readFile(join(assets, name))])))
  server = await preview({ build: { outDir }, preview: { host: '127.0.0.1', port: 0, strictPort: true } })
  const base = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch()
  const context = await browser.newContext()
  const errors = [], loadedAssets = new Set()
  context.on('response', response => {
    if (response.ok()) loadedAssets.add(new URL(response.url()).pathname.split('/').at(-1))
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${base}/ai-test`)
  await page.getByRole('heading', { name: 'AI 测试', exact: true }).waitFor()
  const gameUrl = page.url()
  const id = new URL(gameUrl).pathname.split('/').at(-1)
  const events = async () => {
    try { return (await readFile(join(logs, `${id}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse) }
    catch (error) { if (error.code === 'ENOENT') return []; throw error }
  }
  await until(async () => (await events()).some(e => e.type === 'game-start'), 'saved initial position')
  assert(![...loadedAssets].some(name => /^worker-.*\.js$/.test(name)), 'Worker must still be lazy')

  // Force a different Worker hash without editing source or changing the search.
  // Deliberately inherit emptyOutDir from the real config under test.
  await build({
    build: { outDir }, logLevel: 'silent',
    worker: { plugins: () => [{
      name: 'preview-update-regression',
      renderChunk: code => ({ code: `console.debug('preview-update-regression');\n${code}`, map: null }),
    }] },
  })
  assert((await readdir(assets)).some(name => /^worker-.*\.js$/.test(name) && !oldAssets.has(name)),
    'The rebuild must actually emit a new Worker URL')
  for (const [name, bytes] of oldAssets) {
    assert.deepEqual(await readFile(join(assets, name)), bytes, `Existing asset preserved: ${name}`)
  }

  // Same page, no reload/retry: its old entry must still load its matching Worker/WASM.
  await page.locator('svg.board-svg > rect.hit[width="28"][height="28"]').nth(13 * 16 + 2).click()
  await until(async () => (await events()).some(e => e.type === 'search-accepted'), 'AI move after rebuild')
  const recorded = await events()
  assert.equal(page.url(), gameUrl)
  assert(!recorded.some(e => e.type === 'search-error'))
  assert(recorded.some(e => e.type === 'search-result' && e.detail.detail.result.stats.nodes > 0))
  const actions = recorded.filter(e => e.type === 'action')
  assert.equal(actions.length, 2)
  assert.equal(actions[0].detail.actor, 'human')
  assert.equal(actions[1].detail.actor, 'ai')
  assert([...loadedAssets].some(name => /^worker-.*\.js$/.test(name) && oldAssets.has(name)))
  assert([...loadedAssets].some(name => /^engine-.*\.wasm$/.test(name) && oldAssets.has(name)))
  assert.deepEqual(errors, [])
  console.log('ok: rebuild retains old assets; the already-open page loads its original Worker/WASM and records a real AI move without refreshing')
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
  await rm(directory, { recursive: true, force: true })
}
