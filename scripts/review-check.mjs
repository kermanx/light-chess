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

  // 自动播放把 cursor 推到末尾；候选进侧栏列表，曲线逐段绘制
  await page.waitForFunction(
    () => window.__review.cursor === window.__review.plies.length && !window.__review.playing,
    null,
    { timeout: 15000 },
  )
  assert(await page.locator('.cand-row').count() >= 1, 'top 候选收进侧栏列表')
  assert(await page.locator('[data-value-curve] polyline').count() === 1, '对抗曲线主线已绘制')
  assert(await page.locator('[data-value-curve] path').count() >= 1, '蓝/红优势区域填充已绘制')

  // 悬停候选列表项在棋盘上预览该条：动效线始终出现（即使是 top-1/实际所下）
  await page.locator('.cand-row').first().hover()
  const previewLine = page.locator('[data-cand-preview] .cand-preview-line')
  await previewLine.waitFor()
  assert.equal(
    await previewLine.evaluate(el => getComputedStyle(el).animationName.startsWith('cand-flow')),
    true,
    '候选预览线为流动虚线动效',
  )
  await page.locator('.cand-row').first().hover().then(() => page.mouse.move(0, 0))
  await page.waitForTimeout(100)

  // 悬停「家」高亮该方光路，移开恢复淡化；双方独立
  await page.locator('[data-home-hit="blue"]').hover({ force: true })
  await page.locator('[data-laser="blue"] .laser-hot').waitFor()
  assert.equal(await page.locator('[data-laser="red"] .laser-dim').count(), 1, '另一方光路仍淡化')
  assert.equal(await page.locator('[data-laser="blue"] .laser-glow').count(), 1, '高亮带 glow 层')
  await page.mouse.move(0, 0)
  await page.waitForFunction(() => !document.querySelector('[data-laser="blue"] .laser-hot'))
  assert.equal(await page.locator('[data-laser="blue"] .laser-dim').count(), 1, '移开后恢复淡化')

  // 拖拽步进条跳 ply；播放/暂停切换
  // 死步默认折叠为「…N」，展开后才能点到单个 ply
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

  // 视角切换：人人本地局默认旁观；切蓝方后蓝方行棋的 ply 按钮突出，切回旁观恢复中性
  assert.equal(await page.evaluate(() => window.__review.perspective), 'spec', '人人局默认旁观')
  const mineCount = async cls =>
    page.locator(`.ply-btn.${cls}`).count()
  await page.getByRole('radio', { name: '蓝方' }).click()
  assert.equal(await mineCount('mine-b'), await page.evaluate(() => window.__review.plies.filter(p => p.mover === 0).length), '蓝方视角突出蓝方 ply')
  assert.equal(await mineCount('mine-r'), 0)
  assert(await page.locator('.cur-ply .tag-mine, .cur-ply .tag-opp').count() === 1, '当前手标注我方/对方')
  await page.getByRole('radio', { name: '红方' }).click()
  assert.equal(await mineCount('mine-r'), await page.evaluate(() => window.__review.plies.filter(p => p.mover === 1).length), '红方视角突出红方 ply')
  assert.equal(await mineCount('mine-b'), 0)
  await page.getByRole('radio', { name: '旁观' }).click()
  assert.equal(await mineCount('mine-b'), 0, '旁观恢复中性')
  assert.equal(await mineCount('mine-r'), 0)

  // 返回对局
  await page.getByRole('button', { name: '返回对局' }).click()
  assert.equal(await page.locator('[data-review-board]').count(), 0)

  // 对局结束不再自动跳转：复盘入口在结算弹窗里，用户主动点才进
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
  await page.waitForTimeout(300)
  assert.equal(await page.evaluate(() => window.__review.active), false, '对局结束不自动打开复盘')
  const dialog = page.getByRole('dialog', { name: '蓝方获胜' })
  await dialog.waitFor()
  await dialog.getByRole('button', { name: '复盘分析' }).click()
  await page.locator('[data-review-board]').waitFor()
  assert(await page.evaluate(() => window.__review.active), '从结算弹窗进入复盘')
  assert.equal(await page.evaluate(() => window.__review.moves.length), 1, '复盘携带本局 moves')
  await page.getByRole('button', { name: '返回对局' }).click()
  assert.deepEqual(errors, [])
  console.log('ok: 结算弹窗手动进入复盘（不自动跳转）')
  console.log('ok: 复盘页播放/步进/候选/曲线/返回全部正常')
} finally {
  await browser.close()
  await vite.close()
}
