// 同机双标签页联机校验：同一个 browser context 开两个 page（共享 localStorage、sessionStorage 各自独立），
// 复现并回归「标签页 B 读到标签页 A 的身份 token 导致永远开不了局」的 bug。
// 需先启动 dev 服务（localhost:5173）和本地中继（localhost:8787）。
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://localhost:5173'
const RELAY = process.env.RELAY_URL || 'ws://localhost:8787'

async function waitFor(fn, what, timeout = 30000) {
  const t0 = Date.now()
  let last
  for (;;) {
    try {
      last = await fn()
      if (last) return last
    } catch {
      // 继续轮询
    }
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

const browser = await chromium.launch()
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
await ctx.addInitScript((r) => localStorage.setItem('light-chess:relays', r), RELAY)

// 标签页 A：创建 2 人房
const A = await ctx.newPage()
A.on('pageerror', (e) => console.log('[pageerror A]', e.message))
await A.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
await A.getByText('创建房间').click()
await A.waitForSelector('.room-code')
const code = (await A.locator('.room-code').innerText()).trim()
console.log('房间号', code)

// 标签页 B：同一 context（共享 localStorage），通过加入链接自动加入
const B = await ctx.newPage()
B.on('pageerror', (e) => console.log('[pageerror B]', e.message))
await B.goto(`${BASE}/?join=${code}`, { waitUntil: 'domcontentloaded' })

// 关键断言：双方都必须进入棋盘（旧代码下 B 会被当成「房主重连」，永远停在等待页）
await A.waitForSelector('svg.board-svg', { timeout: 40000 })
await B.waitForSelector('svg.board-svg', { timeout: 40000 })
console.log('ok: 同机双标签页双双进入对局')

await waitFor(async () => (await A.locator('.meta-note').innerText()).includes('你执蓝方'), 'A 执蓝方')
await waitFor(async () => (await B.locator('.meta-note').innerText()).includes('你执红方'), 'B 执红方')
console.log('ok: 座位分配正确（A=蓝 B=红）')

// B 刷新（同标签页 sessionStorage 保留）：应恢复对局并重连成功
await B.reload({ waitUntil: 'domcontentloaded' })
await B.waitForSelector('svg.board-svg', { timeout: 40000 })
await waitFor(async () => (await B.locator('.meta-note').innerText()).includes('你执红方'), 'B 刷新后仍执红方')
console.log('ok: B 刷新后恢复原座位并重连')

await browser.close()
console.log('同机双标签页校验全部通过')
process.exit(0)
