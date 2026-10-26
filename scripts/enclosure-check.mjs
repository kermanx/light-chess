// 自带开发服务：检查斜镜封口的禁止预览、方向切换及两种落子顺序。
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
import { createServer } from 'vite'

const vite = await createServer({
  cacheDir: 'node_modules/.vite-enclosure-check',
  server: { host: '127.0.0.1', port: 0, hmr: false },
})
await vite.listen()
const browser = await chromium.launch()
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/`)
  await page.getByText('单机对战').click()
  const status = text => page.locator('.status-note').filter({ hasText: text }).waitFor()
  const position = async (x, y) => {
    const box = await page.locator('svg.board-svg').boundingBox()
    const scale = box.width / (72 + 36 * 28)
    return [box.x + (36 + x * 28) * scale, box.y + (36 + y * 28) * scale]
  }
  const click = async (x, y, button = 'left') => page.mouse.click(...await position(x, y), { button })
  const hover = async (x, y) => page.mouse.move(...await position(x, y))
  const setup = async () => {
    await click(10.5, 12.5)
    await status('选择家的开口')
    await click(11.6, 12.5)
    await status('红方')
    await click(20.5, 16.5)
    await status('选择家的开口')
    await click(19.4, 16.5)
    await status('蓝方回合')
  }
  const blueMirrors = page.locator('svg path[fill="#2f6fed"]')
  const forbiddenPreview = page.locator('svg line[stroke="#b91c1c"][stroke-dasharray="5 4"]')
  await setup()
  await click(11.5, 12)
  await status('红方回合')
  await click(25.5, 25)
  await status('蓝方回合')
  await hover(11.5, 12.5)
  await status('不能放')
  await forbiddenPreview.waitFor({ state: 'attached' })
  await click(11.5, 12.5)
  await hover(30.5, 30.5)
  await status('蓝方回合')
  assert.equal(await blueMirrors.count(), 4, '封口斜镜不能落下')
  console.log('ok: 斜镜封口显示禁止预览，点击后不落子、不换回合')

  await hover(11.5, 12.5)
  await page.keyboard.down('Shift')
  await status('蓝方回合')
  assert.equal(await forbiddenPreview.count(), 0, '切换到合法方向后取消禁止预览')
  await click(11.5, 12.5, 'right') // Shift + 右键仍是非法的 /，验证实际方向独立校验
  assert.equal(await blueMirrors.count(), 4, '右键同样校验实际落子的斜镜方向')
  await click(11.5, 12.5)
  await page.keyboard.up('Shift')
  await status('红方回合')
  assert.equal(await blueMirrors.count(), 5, '反向合法斜镜正常落下')
  console.log('ok: Shift 切换预览方向，左右键均按实际方向校验')

  await page.getByText('重新开始', { exact: true }).click()
  await setup()
  await click(11.5, 12.5)
  await status('红方回合')
  await click(25.5, 25)
  await status('蓝方回合')
  await hover(11.5, 12)
  await status('不能放')
  await forbiddenPreview.waitFor({ state: 'attached' })
  await click(11.5, 12)
  await hover(30.5, 30.5)
  await status('蓝方回合')
  assert.equal(await page.locator('[data-edge="h:11:12"]').count(), 0)
  console.log('ok: 先下斜镜、后用边镜封口也被拒绝')

  await page.getByText('重新开始', { exact: true }).click()
  await setup()
  await hover(11, 12.5)
  await status('不能放')
  await forbiddenPreview.waitFor({ state: 'attached' })
  console.log('ok: 自己封住基地开口会形成同色围墙，仍显示禁止预览')
  await click(25.5, 25)
  await status('红方回合')
  await hover(11, 12.5)
  await status('红方回合')
  assert.equal(await forbiddenPreview.count(), 0)
  await page.locator('svg line[stroke="#e84a3c"][stroke-width="2.6"]').waitFor({ state: 'attached' })
  await click(11, 12.5)
  await status('蓝方回合')
  assert.equal(await page.locator('[data-edge="v:11:12"][fill="#e84a3c"]').count(), 1)
  console.log('ok: 对方可以在基地开口预览并放镜，正常轮转回合')
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
  await vite.close()
}
