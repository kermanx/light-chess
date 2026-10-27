import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const vite = await createServer({
  cacheDir: 'node_modules/.vite-review-check',
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
await vite.listen()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`)

  // 6×6 本地人Vs人，下 4 手后打开复盘（低 sims 保证秒级完成）
  await page.evaluate(async () => {
    const { dispatch, startLocal, state } = await import('/src/store.ts')
    state.size = 6
    startLocal(2)
    dispatch({ kind: 'setup', color: 'blue', home: { x: 1, y: 1, dir: 0 } })
    dispatch({ kind: 'setup', color: 'red', home: { x: 4, y: 4, dir: 2 } })
    dispatch({ kind: 'edge', color: 'blue', id: 'h:2:2' })
    dispatch({ kind: 'diag', color: 'red', x: 3, y: 3, ori: '/' })
    dispatch({ kind: 'edge', color: 'blue', id: 'v:2:3' })
    dispatch({ kind: 'diag', color: 'red', x: 2, y: 4, ori: '\\' })
    const { review, openReview } = await import('/src/review.ts')
    review.sims = 50
    review.coach = 'purez_ext/gen24'
    openReview()
    ;window.__review = review
  })

  await page.locator('[data-review-board]').waitFor()
  await page.waitForFunction(
    () => window.__review.final !== null || window.__review.error !== '',
    null,
    { timeout: 60000 },
  )

  const snap = await page.evaluate(() => {
    const review = window.__review
    return {
      error: review.error,
      plies: review.plies.length,
      total: review.meta?.total_plies,
      final: Boolean(review.final),
      cursor: review.cursor,
      values: review.plies.map(p => p.value),
    }
  })
  assert.equal(snap.error, '', '分析流无错误')
  assert.equal(snap.plies, 4, '四个 ply 全部流入')
  assert.equal(snap.total, 4)
  assert(snap.final, '收到 final')
  assert(snap.values.every(v => v >= -1 && v <= 1), 'value 在 [-1,1]')
  console.log('ok: NDJSON 流逐 ply 消费完成', JSON.stringify(snap.values))

  // 自动播放把 cursor 推到末尾；top 候选灰线与 Q 数字出现在棋盘上
  await page.waitForFunction(
    () => window.__review.cursor === window.__review.plies.length && !window.__review.playing,
    null,
    { timeout: 15000 },
  )
  assert(await page.locator('[data-top-overlay] line').count() >= 1, 'top 候选灰线已绘制')
  assert(await page.locator('[data-top-overlay] text').count() >= 1, 'Q 值数字已标注')
  assert.equal(await page.locator('[data-value-curve] circle').count() >= 4, true, '曲线逐点绘制')

  // 拖拽步进条跳 ply；播放/暂停切换
  // 死步默认折叠为「僵持 ×N」，展开后才能点到单个 ply
  const runBtn = page.locator('.run-btn')
  if (await runBtn.count()) {
    await runBtn.first().click()
    assert.equal(await page.locator('.run-btn').count(), 0, '僵持段展开为单步')
  }
  await page.locator('.ply-btn', { hasText: '2' }).first().click()
  let cur = await page.evaluate(() => window.__review.cursor)
  assert.equal(cur, 2, '步进条跳到第 2 手')
  await page.getByRole('button', { name: '播放' }).click()
  await page.waitForTimeout(1300)
  cur = await page.evaluate(() => window.__review.cursor)
  assert(cur > 2, '播放继续推进')

  // 返回对局
  await page.getByRole('button', { name: '返回对局' }).click()
  assert.equal(await page.locator('[data-review-board]').count(), 0)

  // 对局结束自动展开复盘（超时获胜也算；人人本地局由前端持有 homes+moves 直接提交）
  await page.evaluate(async () => {
    const { dispatch, startLocal, state, tickClock } = await import('/src/store.ts')
    state.size = 6
    state.clockSettings = { enabled: true, initialMs: 1000, incrementMs: 0 }
    startLocal(2)
    dispatch({ kind: 'setup', color: 'blue', home: { x: 1, y: 1, dir: 0 } })
    dispatch({ kind: 'setup', color: 'red', home: { x: 4, y: 4, dir: 2 } })
    dispatch({ kind: 'edge', color: 'blue', id: 'h:2:2' })
    tickClock(state.clock.runningSince + state.clock.remaining.red + 1)
  })
  await page.locator('[data-review-board]').waitFor()
  assert(await page.evaluate(() => window.__review.active), '对局结束自动打开复盘')
  assert.equal(await page.evaluate(() => window.__review.moves.length), 1, '复盘携带本局 moves')
  await page.getByRole('button', { name: '返回对局' }).click()
  assert.deepEqual(errors, [])
  console.log('ok: 对局结束自动展开复盘（含超时获胜的人人本地局）')
  console.log('ok: 复盘页播放/步进/候选/曲线/返回全部正常')
} finally {
  await browser.close()
  await vite.close()
}
