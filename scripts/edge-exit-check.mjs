import { chromium } from 'playwright'
const PAD = 36, S = 28, SIZE = 72 + 36 * 28
const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const p = await ctx.newPage()
p.on('pageerror', (e) => console.log('[pageerror]', e.message))
await p.goto('http://localhost:5173/', { waitUntil: 'domcontentloaded' })
await p.getByText('单机对战').click()
await p.waitForSelector('svg.board-svg')
const clickU = async (ux, uy) => {
  const box = await p.locator('svg.board-svg').boundingBox()
  const k = box.width / SIZE
  await p.mouse.click(box.x + ux * k, box.y + uy * k)
  await p.waitForTimeout(150)
}
// 蓝方选左边缘格子 (0,5)
await clickU(PAD + 0.5 * S, PAD + 5.5 * S)
await p.waitForTimeout(300)
const arrows = await p.locator('svg polygon.pulse').count()
if (arrows !== 3) throw new Error(`边缘格子应只有 3 个候选出口箭头，实际 ${arrows}`)
console.log('ok: 边缘格子只显示 3 个候选出口箭头')
const status = await p.locator('.status-note').innerText()
if (!status.includes('不能朝向棋盘外')) throw new Error(`状态提示不对：${status}`)
console.log('ok: 状态提示', JSON.stringify(status))
// 点出界方向（家左侧）应无效；点朝内方向（右侧）应成功
await clickU(PAD + 0.2 * S, PAD + 5.5 * S) // 左边热区（出界方向）
await p.waitForTimeout(300)
if (!(await p.locator('.status-note').innerText()).includes('出口')) throw new Error('出界方向不应能确认')
console.log('ok: 点击出界方向无效，仍处于选出口状态')
await clickU(PAD + 1.4 * S, PAD + 5.5 * S) // 右边热区（朝内）
await p.waitForTimeout(400)
const st2 = await p.locator('.status-note').innerText()
if (!st2.includes('红方')) throw new Error(`朝内出口应确认成功轮到红方，实际：${st2}`)
console.log('ok: 朝内出口确认成功，轮到红方')
await browser.close()
