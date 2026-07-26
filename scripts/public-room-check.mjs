// 公开房间端到端校验：
// 1) 未勾选「公开」的房间不出现在加入页列表
// 2) 公开房间（默认勾选）出现在加入页列表，点击直接入座开局
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

const newPage = async (tag) => {
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log(`[pageerror ${tag}]`, e.message))
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  return p
}

// ===== 场景 1：私密房间不出现在公开列表 =====
const A1 = await newPage('A1')
await A1.locator('.pub-opt input').uncheck()
await A1.getByText('创建房间').click()
await A1.waitForSelector('.room-code')
const privCode = (await A1.locator('.room-code').innerText()).trim()
console.log('私密房间号', privCode)

const B1 = await newPage('B1')
await B1.getByText('加入房间').click()
// 等足够久（覆盖广播周期），列表应保持为空
await B1.waitForTimeout(10000)
const leaked = await B1.locator('.pub-item').count()
if (leaked !== 0) throw new Error(`私密房间不应出现在公开列表，实际看到 ${leaked} 个`)
console.log('ok: 私密房间未出现在公开列表')
await B1.close()

// ===== 场景 2：公开房间（默认勾选）出现在列表并可点击入座 =====
const A2 = await newPage('A2')
const pubChecked = await A2.locator('.pub-opt input').isChecked()
if (!pubChecked) throw new Error('「公开房间」应默认勾选')
await A2.getByText('创建房间').click()
await A2.waitForSelector('.room-code')
const pubCode = (await A2.locator('.room-code').innerText()).trim()
console.log('公开房间号', pubCode)

const B2 = await newPage('B2')
await B2.getByText('加入房间').click()
await waitFor(async () => {
  const texts = await B2.locator('.pub-code').allInnerTexts()
  return texts.includes(pubCode)
}, '公开房间出现在加入页列表')
console.log('ok: 公开房间出现在加入页列表（含就位进度）')
const meta = await B2.locator('.pub-item', { hasText: pubCode }).locator('.pub-meta').innerText()
if (!meta.includes('2 人局') || !meta.includes('1/2')) throw new Error(`房间信息不对：${meta}`)

await B2.locator('.pub-item', { hasText: pubCode }).click()
await A2.waitForSelector('svg.board-svg', { timeout: 40000 })
await B2.waitForSelector('svg.board-svg', { timeout: 40000 })
await waitFor(async () => (await B2.locator('.meta-note').innerText()).includes('你执红方'), 'B2 执红方')
console.log('ok: 点击公开房间直接入座，双方进入对局')

// 开局后房主停止广播，房间应在大约 EXPIRE 后从其他监听者列表消失（此处只验证房主侧无报错运行）
await A2.waitForTimeout(1000)
await browser.close()
console.log('公开房间校验全部通过')
process.exit(0)
