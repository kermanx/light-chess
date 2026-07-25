// 调试：每步点击后打印状态栏文本
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://localhost:5173'
const SIZE = 72 + 36 * 28 // viewBox：PAD*2 + 36*S（默认棋盘 36x36）
const PAD = 36
const S = 28

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
page.on('pageerror', (e) => console.log('[pageerror]', e.message))

await page.goto(BASE + '/', { waitUntil: 'networkidle' })
await page.getByText('单机对战').click()
await page.waitForSelector('svg.board-svg')

const status = () => page.locator('.status-note').innerText()
const box = await page.locator('svg.board-svg').boundingBox()
console.log('svg box', box)
const k = box.width / SIZE
const px = (u) => box.x + u * k
const py = (u) => box.y + u * k
const click = async (ux, uy, btn) => {
  await page.mouse.click(px(ux), py(uy), btn ? { button: btn } : {})
  await page.waitForTimeout(120)
  console.log(`click u(${ux},${uy}) screen(${px(ux).toFixed(0)},${py(uy).toFixed(0)})${btn ? ' ' + btn : ''} ->`, await status())
}
const cell = (x, y) => [PAD + (x + 0.5) * S, PAD + (y + 0.5) * S]

console.log('初始 ->', await status())
// 选家悬停预览
const [hx, hy] = cell(10, 12)
await page.mouse.move(px(hx), py(hy))
await page.waitForTimeout(150)
await page.screenshot({ path: '/tmp/lc-3-preview.png' })
// 故意点在格子左上角（原边热区内），也应能选中家
await click(PAD + 10 * S + 2, PAD + 12 * S + 2) // 蓝家
await click(PAD + 11 * S, PAD + 12.5 * S) // 出口 v:11:12
await click(...cell(11, 13)) // 红家：相邻，应被拒绝
await click(...cell(20, 16)) // 红家
await click(PAD + 20 * S, PAD + 16.5 * S) // 出口 v:20:16
await click(...cell(14, 12)) // 蓝 '/'
await click(PAD + 14.5 * S, PAD + 9 * S) // 红边镜 h:14:9
await click(...cell(14, 9), 'right') // 蓝 '\'

// 悬停蓝家显示蓝光路
const [bx, by] = cell(10, 12)
await page.mouse.move(px(bx), py(by))
await page.waitForTimeout(200)
await page.screenshot({ path: '/tmp/lc-4-hover-laser.png' })
// 悬停红家显示红光路
const [rx, ry] = cell(20, 16)
await page.mouse.move(px(rx), py(ry))
await page.waitForTimeout(200)

await page.screenshot({ path: '/tmp/lc-2-game.png', fullPage: true })
await browser.close()
