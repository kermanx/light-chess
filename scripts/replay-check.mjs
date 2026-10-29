import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright'
import { preview } from 'vite'
import { initGame, advance, persist, boardOf } from './arena/game.mjs'
import { arenaReplay, publishReplay } from './arena/replay.ts'
import { replayFrames, replaySummary } from '../src/replay/model.ts'
import { simulate } from '../src/game.ts'

const temporary = mkdtempSync(join(tmpdir(), 'light-chess-replay-'))
let browser, server
try {
  const published = JSON.parse(readFileSync('public/replays/index.json', 'utf8'))
  assert.equal(new Set(published.map(item => item.id)).size, published.length)
  for (const item of published) {
    assert.match(item.id, /^[a-f0-9-]{36}$/)
    const saved = JSON.parse(readFileSync(`public/replays/${item.id}.json`, 'utf8'))
    assert(saved.winner, 'published matches must be complete')
    assert.deepEqual(replaySummary(saved), item)
    assert.equal(replayFrames(saved).at(-1).winner, saved.winner)
  }
  const arena = join(temporary, 'games'), directory = join(arena, 'fixture')
  const initial = initGame(directory, resolve('src/ai/engine.wasm'))
  const opening = { kind: 'diag', x: 2, y: 13, ori: '/' }
  const checked = advance(initial, opening, 'Test: direct check', 'dsh')
  const finished = advance(checked, { kind: 'edge', id: 'h:0:1' }, 'Test: intentionally ignore check', 'rust-wasm')
  persist(directory, finished)
  const replay = arenaReplay(directory), frames = replayFrames(replay)
  assert.equal(frames.length, 3)
  assert.equal(frames[0].move, null)
  assert.equal(frames[0].board.diags.size, 0)
  assert.equal(frames[1].winner, null, 'check alone does not end the game')
  assert.equal(frames[2].winner, 'blue', 'settle at the attacker’s next turn')
  for (const [i, expected] of [initial, checked, finished].entries()) {
    assert.deepEqual(frames[i].board.edges, boardOf(expected).edges)
    assert.deepEqual(frames[i].board.diags, boardOf(expected).diags)
    for (const color of ['blue', 'red']) assert.deepEqual(simulate(frames[i].board, color), simulate(boardOf(expected), color))
  }
  const falseOutcome = structuredClone(replay); falseOutcome.winner = 'red'
  assert.throws(() => replayFrames(falseOutcome), /结算不一致/)
  const badMove = structuredClone(replay); badMove.moves[1].action = opening
  assert.throws(() => replayFrames(badMove), /已占用/)
  const postGame = structuredClone(replay); postGame.moves.push(postGame.moves[0])
  assert.throws(() => replayFrames(postGame), /顺序/)
  const mismatch = structuredClone(finished); mismatch.diags = []
  persist(directory, mismatch)
  assert.throws(() => arenaReplay(directory), /authoritative state/)
  persist(directory, checked)
  assert.throws(() => publishReplay(directory, join(temporary, 'public')), /still in progress/)
  persist(directory, finished)

  // Isolated production build, including an actual static archive. No user games/files touched.
  const dist = join(temporary, 'dist'); mkdirSync(dist)
  copyFileSync('dist/index.html', join(dist, 'index.html'))
  copyFileSync('dist/404.html', join(dist, '404.html'))
  symlinkSync(resolve('dist/assets'), join(dist, 'assets'))
  publishReplay(directory, join(dist, 'replays'))
  publishReplay(directory, join(dist, 'replays'))
  assert.equal(JSON.parse(readFileSync(join(dist, 'replays/index.json'))).length, 1, 'idempotent export')
  assert(!readFileSync(join(dist, `replays/${initial.id}.json`), 'utf8').includes('iterations'))
  // Static record must remain sufficient even when the source match directory is unavailable.
  process.env.LIGHT_CHESS_ARENA_DIR = join(temporary, 'empty')
  process.env.LIGHT_CHESS_AI_LOG_DIR = join(temporary, 'logs')
  server = await preview({ base: '/light-chess/', build: { outDir: dist }, preview: { host: '127.0.0.1', port: 0, strictPort: true } })
  const base = `http://127.0.0.1:${server.httpServer.address().port}/light-chess/`
  browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } })
  const errors = [], workers = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('worker', worker => workers.push(worker.url()))
  await page.addInitScript(() => localStorage.setItem('light-chess:save', 'ordinary-game-sentinel'))
  const url = `${base}replay/${initial.id}`
  await page.goto(url)
  const at = async n => { await page.locator(`[data-replay-step="${n}"]`).waitFor() }
  const mirrors = () => page.locator('svg [data-edge], svg [data-diag]')
  await at(0)
  assert.equal(await mirrors().count(), 6)
  assert(await page.getByRole('button', { name: '上一步', exact: true }).isDisabled())
  const initialLight = await page.locator('[data-beam=blue]').innerHTML()
  await page.getByRole('button', { name: '下一步', exact: true }).click()
  await at(1)
  assert.equal(await mirrors().count(), 7)
  assert.equal(await page.locator('[data-diag="2,13"][data-last=true]').count(), 1)
  assert.notEqual(await page.locator('[data-beam=blue]').innerHTML(), initialLight, 'historical beams change with the actual board')
  await page.getByRole('button', { name: '上一步', exact: true }).click()
  await at(0)
  assert.equal(await page.locator('[data-beam=blue]').innerHTML(), initialLight)
  await page.keyboard.press('ArrowRight'); await at(1)
  await page.keyboard.press('ArrowRight'); await at(2)
  assert.equal(await page.locator('[data-edge="h:0:1"][data-last=true]').count(), 1)
  await page.getByRole('status').filter({ hasText: '蓝方获胜' }).waitFor()
  assert(await page.getByRole('button', { name: '下一步', exact: true }).isDisabled())
  await page.keyboard.press('Home'); await at(0)
  await page.getByRole('button', { name: '终局', exact: true }).click(); await at(2)
  await page.reload(); await at(0)
  await page.getByLabel('蓝方光路').uncheck()
  assert.equal(await page.locator('[data-beam=blue]').count(), 0)
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: '下载回放 JSON' }).click()
  const download = await downloadPromise
  assert.deepEqual(JSON.parse(readFileSync(await download.path(), 'utf8')), replay)
  await page.getByRole('link', { name: '全部回放' }).click()
  await page.getByRole('link', { name: /从开局观看/ }).click(); await at(0)
  await page.getByRole('link', { name: '回到大厅' }).click()
  await page.getByRole('link', { name: '对局回放 · DSH vs 规则 AI' }).click()
  await page.getByRole('link', { name: /从开局观看/ }).waitFor()
  await page.goto(url + '/'); await at(0)
  await page.setViewportSize({ width: 390, height: 844 })
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
  assert.equal(await page.evaluate(() => localStorage.getItem('light-chess:save')), 'ordinary-game-sentinel')
  assert.deepEqual(workers, [], 'replay never starts either AI')
  assert.deepEqual(errors, [])
  await page.goto(`${base}replay/00000000-0000-0000-0000-000000000000`)
  await page.getByRole('alert').filter({ hasText: '读取回放失败' }).waitFor()
  // The local read-only API follows a running match without moving the replay cursor.
  const liveDirectory = join(temporary, 'empty/live')
  const liveInitial = initGame(liveDirectory, resolve('src/ai/engine.wasm'))
  const liveCheck = advance(liveInitial, opening, 'Live fixture check', 'dsh')
  persist(liveDirectory, liveCheck)
  assert.equal((await fetch(`${base}__arena/replays/${liveInitial.id}`, { method: 'POST' })).status, 405)
  await page.goto(`${base}replay/${liveInitial.id}`); await at(0)
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await at(1)
  const liveEnd = advance(liveCheck, { kind: 'edge', id: 'h:0:1' }, 'Live fixture loss', 'rust-wasm')
  persist(liveDirectory, liveEnd)
  await page.getByText('已完赛 · 共 2 手', { exact: true }).waitFor({ timeout: 10000 })
  await at(1)
  await page.getByRole('button', { name: '下一步', exact: true }).click(); await at(2)
  await page.getByRole('status').filter({ hasText: '蓝方获胜' }).waitFor()
  assert.deepEqual(JSON.parse(readFileSync(join(liveDirectory, 'state.json'), 'utf8')), liveEnd)
  assert.deepEqual(errors, [])
  console.log('Replay checks passed: exact historical frames/beams, legality/result validation, completed-only portable export, static hosting under a subpath, initial frame, all controls, keyboard, edge/diagonal highlight, download, navigation, reload, responsive layout, no AI execution or save mutation.')
} finally {
  await browser?.close()
  if (server) await new Promise(resolve => server.httpServer.close(resolve))
  rmSync(temporary, { recursive: true, force: true })
}
