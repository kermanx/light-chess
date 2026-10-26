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
    const { dispatch, startLocal, state } = await import('/src/store.ts')
    startLocal(2)
    dispatch({ kind: 'setup', color: 'blue', home: { x: 10, y: 12, dir: 0 } })
    dispatch({ kind: 'setup', color: 'red', home: { x: 20, y: 13, dir: 1 } })
    dispatch({ kind: 'diag', color: 'blue', x: 20, y: 14, ori: '/' })
    dispatch({ kind: 'edge', color: 'red', id: 'h:25:25' })
    dispatch({ kind: 'diag', color: 'blue', x: 24, y: 12, ori: '\\' })
    dispatch({ kind: 'edge', color: 'red', id: 'h:26:25' })
    dispatch({ kind: 'diag', color: 'blue', x: 24, y: 16, ori: '/' })
    dispatch({ kind: 'edge', color: 'red', id: 'h:27:25' })
    dispatch({ kind: 'diag', color: 'blue', x: 20, y: 16, ori: '\\' })
    dispatch({ kind: 'edge', color: 'red', id: 'h:28:25' })
    if (state.phase !== 'over' || state.winner !== 'blue') throw new Error('未触发真实光束获胜')
    return state.victoryReplay.targets[0].path
  })
  const beams = page.locator('.victory-beams')
  const beam = page.locator('.victory-beam-body')
  const photon = page.locator('.victory-photon')
  const modal = page.getByRole('dialog', { name: '蓝方获胜' })
  const confirm = page.getByRole('button', { name: '确定', exact: true })
  const screenshot = async name => {
    if (process.env.VICTORY_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.VICTORY_SCREENSHOT_DIR}/${name}.png` })
  }

  const path = await win()
  await beams.waitFor()
  assert.deepEqual(path[0], { x: 10.5, y: 12.5 })
  assert.deepEqual(path.at(-1), { x: 20.5, y: 13.5 })
  assert.equal(await beam.getAttribute('d'), path.map((p, i) => `${i ? 'L' : 'M'}${36 + p.x * 28} ${36 + p.y * 28}`).join(' '), '动画逐段沿实际模拟光路行进')
  assert.equal(await confirm.count(), 0, '击中之前不能出现确定按钮')
  assert.equal(await modal.count(), 0, '动画直接在棋盘上播放')
  assert.equal(await page.locator('[data-home="red"]').count(), 1, '光束到达之前基地仍在')
  const offset = Number(await beam.getAttribute('stroke-dashoffset'))
  const head = await photon.getAttribute('transform')
  await page.keyboard.press('Escape')
  await page.waitForTimeout(450)
  assert(Number(await beam.getAttribute('stroke-dashoffset')) < offset, '光束由起点向目标逐渐延伸')
  assert.notEqual(await photon.getAttribute('transform'), head, '光点沿发射方向移动')
  assert.equal(await confirm.count(), 0)
  await screenshot('victory-motion')
  await confirm.waitFor({ timeout: 5000 })
  assert.equal(await page.locator('[data-dead-home="red"]').count(), 1, '到达目标后基地显示被击中')
  assert.equal(Number(await beam.getAttribute('stroke-dashoffset')), 0)
  assert.equal(await photon.count(), 0)
  assert(await confirm.evaluate(el => el === document.activeElement))
  await screenshot('victory-desktop')
  await confirm.click()
  assert.equal(await beams.count(), 0)
  assert.equal(await modal.count(), 0)
  assert.equal(await page.evaluate(async () => (await import('/src/store.ts')).state.phase), 'over', '确认后保留最终棋局')
  console.log('ok: 致胜光束沿棋盘真实路径从基地出发、反射、命中，再显示确定')

  await page.reload()
  await beams.waitFor()
  assert.equal(await beam.getAttribute('d'), path.map((p, i) => `${i ? 'L' : 'M'}${36 + p.x * 28} ${36 + p.y * 28}`).join(' '), '恢复对局仍播放同一条光路')
  await page.evaluate(async () => (await import('/src/store.ts')).dispatch({ kind: 'restart', color: 'blue' }))
  await beams.waitFor({ state: 'detached' })
  await page.waitForTimeout(3800)
  assert.equal(await confirm.count(), 0, '播放中重开不残留延迟弹窗')

  await page.setViewportSize({ width: 390, height: 844 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await win()
  await confirm.waitFor({ timeout: 1500 })
  assert.equal(Number(await beam.getAttribute('stroke-dashoffset')), 0, '减少动态效果仍显示真实完整光路')
  const box = await modal.boundingBox()
  assert(box.x >= 0 && box.x + box.width <= 390 && box.y >= 0 && box.y + box.height <= 844)
  await screenshot('victory-mobile')
  await page.keyboard.press('Enter')
  await modal.waitFor({ state: 'detached' })

  await page.evaluate(async () => {
    const { dispatch, startLocal, state, tickClock } = await import('/src/store.ts')
    startLocal(2)
    dispatch({ kind: 'setup', color: 'blue', home: { x: 4, y: 4, dir: 0 } })
    dispatch({ kind: 'setup', color: 'red', home: { x: 8, y: 8, dir: 1 } })
    tickClock(state.clock.runningSince + state.clock.remaining.blue + 1)
  })
  await page.getByRole('dialog', { name: '红方获胜' }).waitFor()
  assert.equal(await beams.count(), 0, '超时获胜没有虚构的击杀光路')
  assert(await page.getByText('蓝方用时耗尽', { exact: true }).isVisible())
  await confirm.click()
  assert.deepEqual(errors, [])
  console.log('ok: 存档保留致胜光路，重开清理动画，手机、减少动态效果与超时结果正常')
} finally {
  await browser.close()
  await vite.close()
}
