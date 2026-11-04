// 8×8 人机对战冒烟：选 8×8 推荐模型开局 → 人选家 → AI 选家 → 人放斜镜 → AI 应手
import { chromium } from 'playwright'
const b = await chromium.launch({ executablePath: process.env.HOME + '/Library/Caches/ms-playwright/chromium_headless_shell-1223/chrome-headless-shell-mac-arm64/chrome-headless-shell' })
const p = await b.newPage()
p.on('pageerror', e => console.log('PAGE-EXC:', e.message))
await p.goto('http://localhost:5173/')
await p.getByText('人机对战').click()
await p.waitForSelector('.model-card', { timeout: 15000 })
const g8 = p.locator('.model-group', { hasText: '8×8' })
console.log('8x8 cards:', await g8.locator('.model-card').count(),
  'recommended:', await g8.locator('.model-card.recommended .mc-name').innerText())
await g8.locator('.model-card.recommended').click()
await p.locator('input[type=number]').last().fill('30')
await p.getByText('开始对局').click()
await p.waitForSelector('svg.board-svg')
console.log('viewBox:', await p.locator('svg.board-svg').getAttribute('viewBox'))
// 每次点击前重新量棋盘位置（侧栏加载会移动布局）
const clickGrid = async (gx, gy) => {
  const box = await p.locator('svg.board-svg').boundingBox()
  await p.mouse.click(box.x + (36 + gx * 28) * box.width / 296, box.y + (36 + gy * 28) * box.height / 296)
}
await clickGrid(3.5, 3.5) // 选家
await p.waitForTimeout(300)
await clickGrid(4.4, 3.5) // 出口向右
await p.waitForSelector('[data-home="red"]', { timeout: 30000 })
console.log('AI red home placed: ok')
await clickGrid(2.5, 2.5) // 人放斜镜
await p.waitForFunction(() => document.querySelectorAll('path[data-diag]').length >= 1, null, { timeout: 10000 })
console.log('human diag placed: ok')
// AI 应手（若这手直接致胜则进入 over 也算成功）
await p.waitForFunction(
  () => document.querySelectorAll('path[data-edge], path[data-diag]').length >= 8 ||
        document.querySelector('.status-note')?.textContent?.includes('获胜'), null, { timeout: 60000 })
console.log('AI replied (or human won): ok')
await p.waitForTimeout(1000)
console.log('status:', await p.locator('.status-note').innerText())
const save = JSON.parse(await p.evaluate(() => localStorage.getItem('light-chess:save')))
console.log('size:', save.size, 'phase:', save.phase, 'current:', save.current, 'diags:', save.diags.length)
await p.screenshot({ path: '/tmp/lc8x8.png' })
await b.close()
console.log('DONE')
