import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const vite = await createServer({
  cacheDir: 'node_modules/.vite-victory-check',
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
await vite.listen()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`)
  const win = async () => page.evaluate(async () => {
    const { dispatch, startLocal, state, tickClock } = await import('/src/store.ts')
    startLocal(2)
    dispatch({ kind: 'setup', color: 'blue', home: { x: 4, y: 4, dir: 0 } })
    dispatch({ kind: 'setup', color: 'red', home: { x: 8, y: 8, dir: 1 } })
    tickClock(state.clock.runningSince + state.clock.remaining.blue + 1)
  })
  await win()
  const modal = page.getByRole('dialog', { name: '红方获胜' })
  const confirm = page.getByRole('button', { name: '确定' })
  await modal.waitFor()
  assert.equal(await confirm.count(), 0, '先播放动画，不能提前确认')
  await page.keyboard.press('Escape')
  assert(await modal.isVisible(), '动画期间不能提前关闭')
  await page.waitForTimeout(1100)
  assert.equal(await confirm.count(), 0)
  if (process.env.VICTORY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.VICTORY_SCREENSHOT_DIR}/victory-motion.png` })
  await confirm.waitFor()
  assert(await confirm.evaluate(el => el === document.activeElement), '动画后键盘焦点落在确定按钮')
  if (process.env.VICTORY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.VICTORY_SCREENSHOT_DIR}/victory-desktop.png` })
  await confirm.click()
  assert.equal(await modal.count(), 0)
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).state.phase), 'over', '确定只收起动画，保留最终棋局')
  assert.equal(await page.evaluate(() => document.body.style.overflow), '')
  console.log('ok: 超时获胜播放庆祝动画，结束后显示确定，关闭后保留棋局并恢复滚动')

  await win()
  await modal.waitFor()
  await page.evaluate(async () => (await import('/src/store.ts')).dispatch({ kind: 'restart', color: 'blue' }))
  await modal.waitFor({ state: 'detached' })
  assert.equal(await page.evaluate(() => document.body.style.overflow), '', '重新开始清理动画与滚动锁')
  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await win()
  await confirm.waitFor({ timeout: 1500 })
  const box = await modal.boundingBox()
  assert(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844)
  if (process.env.VICTORY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.VICTORY_SCREENSHOT_DIR}/victory-mobile.png` })
  await page.keyboard.press('Enter')
  await modal.waitFor({ state: 'detached' })
  assert.deepEqual(errors, [])
  console.log('ok: 新一局可重播，动画中重开不残留弹窗，手机尺寸与减少动态效果正常')
} finally {
  await browser.close()
  await vite.close()
}
