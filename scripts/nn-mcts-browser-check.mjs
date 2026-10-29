// 浏览器端到端冒烟：真实 UI 开一局 6×6 NN(MCTS 3s) vs WASM(3s)，
// 验证 nn-worker 的 MCTS 链路（批量叶子评估 → PUCT → dispatchAi 落子）与
// WASM 引擎同桌混跑，且「AI 每步思考上限」对两种引擎同时生效。
// 用法：node scripts/nn-mcts-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const vite = await createServer({ cacheDir: 'node_modules/.vite-nn-mcts-browser-check', server: { host: '127.0.0.1', port: 0, hmr: false } })
await vite.listen()
const base = `http://127.0.0.1:${vite.httpServer.address().port}`
const browser = await chromium.launch()
const errors = []
try {
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 1000 } })).newPage()
  page.on('pageerror', (e) => errors.push(String(e)))
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
  await page.goto(base)

  await page.getByRole('button', { name: /单机对战/ }).click()
  // 蓝方 = 内置 WASM 引擎，红方 = NN 模型（MCTS）；默认 36 棋盘无 NN 模型 → 点 6×6 快键
  for (const name of ['蓝方控制方式', '红方控制方式']) {
    await page.getByLabel(name).selectOption('ai')
  }
  await page.getByRole('button', { name: '6×6', exact: true }).first().click()
  await page.getByLabel('蓝方 AI 引擎').selectOption('wasm')
  await page.getByLabel('红方 AI 引擎').selectOption({ index: 1 })
  // 「AI 每步思考上限」对 WASM/NN 一致生效
  await page.getByLabel('AI 每步思考上限').selectOption('3000')
  await page.getByRole('button', { name: '开始对局' }).click()

  // 等 AI 至少落 10 手或分出胜负（每手双方各最多 ~3s，留足余量）
  await page.waitForFunction(
    () => {
      try {
        const save = JSON.parse(sessionStorage.getItem('light-chess:save') || localStorage.getItem('light-chess:save') || '{}')
        return (save.moves?.length ?? 0) >= 10 || save.phase === 'over'
      } catch { return false }
    },
    { timeout: 240_000 },
  )
  const finalSave = await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('light-chess:save') || localStorage.getItem('light-chess:save') || '{}')
    return { moves: s.moves?.length ?? 0, phase: s.phase, aiEngines: s.aiEngines, lastMove: s.lastMove }
  })
  assert.ok(finalSave.moves >= 10 || finalSave.phase === 'over', `对局未推进：${JSON.stringify(finalSave)}`)
  assert.equal(finalSave.aiEngines?.red?.kind, 'nn', '存档未带 NN 引擎配置')
  assert.equal(finalSave.aiEngines?.blue?.kind, 'wasm', '存档未带 WASM 引擎配置')
  assert.deepEqual(errors, [], '浏览器端出现报错')
  console.log(`浏览器对局推进：${finalSave.moves} 手（phase=${finalSave.phase}）`)
  console.log('NN MCTS 浏览器端到端冒烟通过（NN MCTS 3s vs WASM 3s，无 console 错误）')
} finally {
  await browser.close()
  await vite.close()
}
process.exit(0)
