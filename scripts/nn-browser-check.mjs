// 浏览器端到端冒烟：真实 UI 开一局 6×6 NN vs NN（双 AI 座位），
// 验证 onnxruntime-web worker 链路（模型目录 → 外部权重 → wasm 推理 → dispatchAi 落子）。
// 用法：node scripts/nn-browser-check.mjs
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const vite = await createServer({ cacheDir: 'node_modules/.vite-nn-browser-check', server: { host: '127.0.0.1', port: 0, hmr: false } })
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
  // 蓝、红都设为 AI；默认 36 棋盘无 NN 模型 → 点提示里的 6×6 快键
  for (const name of ['蓝方控制方式', '红方控制方式']) {
    await page.getByLabel(name).selectOption('nn')
  }
  assert(await page.getByRole('button', { name: '开始对局' }).isDisabled())
  await page.getByRole('button', { name: '6×6', exact: true }).first().click()
  for (const side of ['蓝方', '红方']) {
    assert.match(await page.getByLabel(side + ' NN 模型').locator('option:checked').innerText(), /推荐/)
    await page.getByLabel(side + ' NN 计算量').selectOption('sims')
    await page.getByLabel(side + ' MCTS 模拟数').selectOption('50')
  }
  await page.getByRole('button', { name: '开始对局' }).click()

  // 等 AI 至少落 6 手（存档 moves 字段随每次落子增长）或已分出胜负
  await page.waitForFunction(
    () => {
      try {
        const save = JSON.parse(sessionStorage.getItem('light-chess:save') || localStorage.getItem('light-chess:save') || '{}')
        return (save.moves?.length ?? 0) >= 6 || save.phase === 'over'
      } catch { return false }
    },
    null, { timeout: 120_000 },
  )
  const finalSave = await page.evaluate(() => {
    const s = JSON.parse(sessionStorage.getItem('light-chess:save') || localStorage.getItem('light-chess:save') || '{}')
    return { moves: s.moves?.length ?? 0, phase: s.phase, aiProviders: s.aiProviders, aiNnConfigs: s.aiNnConfigs }
  })
  assert.ok(finalSave.moves >= 6 || finalSave.phase === 'over', `NN 未实际落子：${JSON.stringify(finalSave)}`)
  assert.equal(finalSave.aiProviders?.blue, 'nn', '存档未带 NN 引擎配置')
  assert.ok(finalSave.aiNnConfigs?.blue?.modelId, '存档未带 NN 模型配置')
  assert.deepEqual(errors, [], '浏览器端出现报错')
  console.log(`浏览器对局推进：${finalSave.moves} 手（phase=${finalSave.phase}）`)
  console.log('NN 浏览器端到端冒烟通过（双 NN 座位自动对弈，wasm 推理链路正常）')
} finally {
  await browser.close()
  await vite.close()
}
process.exit(0)
