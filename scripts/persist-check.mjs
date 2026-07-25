// 持久化端到端校验：localStorage 存档 + 刷新恢复（单机 & 联机 rejoin）
// 联机走 trystero P2P（公网中继信令），断言均轮询等待；需先启动 dev 服务
import { chromium } from 'playwright'
import net from 'node:net'

const BASE = process.env.BASE_URL || 'http://localhost:5173'
const SIZE = 72 + 36 * 28
const PAD = 36
const S = 28

// 本机若有 127.0.0.1:7897 代理（或 E2E_PROXY 指定），P2P 信令走代理；CI 直连
const proxyServer = process.env.E2E_PROXY || (await new Promise((r) => {
  const s = net.connect(7897, '127.0.0.1')
  s.setTimeout(1500)
  s.once('connect', () => { s.end(); r('http://127.0.0.1:7897') })
  s.once('error', () => r(''))
  s.once('timeout', () => { s.destroy(); r('') })
}))
const browser = await chromium.launch(
  proxyServer ? { proxy: { server: proxyServer, bypass: 'localhost,127.0.0.1' } } : {},
)
if (proxyServer) console.log('使用代理', proxyServer)

async function waitFor(fn, what, timeout = 25000) {
  const t0 = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      // 元素尚未出现等，继续轮询
    }
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

function makeDriver(page) {
  const boxOf = () => page.locator('svg.board-svg').boundingBox()
  return {
    status: () => page.locator('.status-note').innerText(),
    async clickCell(x, y, btn) {
      const box = await boxOf()
      const k = box.width / SIZE
      await page.mouse.click(box.x + (PAD + (x + 0.5) * S) * k, box.y + (PAD + (y + 0.5) * S) * k, btn ? { button: btn } : {})
      await page.waitForTimeout(150)
    },
    async clickEdgeU(ux, uy) {
      const box = await boxOf()
      const k = box.width / SIZE
      await page.mouse.click(box.x + ux * k, box.y + uy * k)
      await page.waitForTimeout(150)
    },
  }
}

// ---------- 1. 单机刷新恢复 ----------
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log('[pageerror local]', e.message))
  const d = makeDriver(page)
  await page.goto(BASE + '/', { waitUntil: 'networkidle' })
  await page.getByText('单机对战').click()
  await page.waitForSelector('svg.board-svg')
  await d.clickCell(10, 12) // 蓝家
  await d.clickEdgeU(PAD + 11 * S, PAD + 12.5 * S) // 出口
  if (!(await d.status()).includes('红方')) throw new Error('蓝家布置后应轮到红方')
  await page.reload({ waitUntil: 'networkidle' })
  await page.waitForSelector('svg.board-svg')
  await page.waitForTimeout(300)
  const st = await d.status()
  if (!st.includes('红方')) throw new Error(`单机刷新后状态未恢复：${st}`)
  // 蓝家的 3 条自动边镜也应恢复（edges > 0）
  const mirrorCount = await page.locator('svg.board-svg g[filter] line').count()
  if (mirrorCount < 3) throw new Error(`单机刷新后镜子未恢复，只剩 ${mirrorCount}`)
  console.log('ok: 单机刷新后局面恢复（状态:', st, '）')
  await ctx.close()
}

// ---------- 2. 联机刷新 rejoin ----------
{
  const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const A = await ctxA.newPage()
  const B = await ctxB.newPage()
  A.on('pageerror', (e) => console.log('[pageerror A]', e.message))
  B.on('pageerror', (e) => console.log('[pageerror B]', e.message))
  const da = makeDriver(A)
  const db = makeDriver(B)

  // 指向本地开发中继（默认公共 Nostr 中继在本机不可达；RELAY_URL 可覆盖）
  const RELAY = process.env.RELAY_URL || 'ws://localhost:8787'
  for (const p of [A, B]) {
    await p.addInitScript((r) => localStorage.setItem('light-chess:relays', r), RELAY)
  }

  await A.goto(BASE + '/', { waitUntil: 'networkidle' })
  await A.getByText('创建房间').click()
  await A.waitForSelector('.room-code')
  const code = (await A.locator('.room-code').innerText()).trim()
  console.log('房间号', code)

  await B.goto(BASE + '/', { waitUntil: 'networkidle' })
  await B.getByText('加入房间').click()
  await B.locator('.code-input').fill(code)
  await B.getByText('加入', { exact: true }).click()

  await A.waitForSelector('svg.board-svg', { timeout: 30000 })
  await B.waitForSelector('svg.board-svg', { timeout: 30000 })
  await A.waitForTimeout(300)

  // 双方布置
  await da.clickCell(8, 8)
  await da.clickEdgeU(PAD + 9 * S, PAD + 8.5 * S)
  await db.clickCell(20, 20)
  await db.clickEdgeU(PAD + 20 * S, PAD + 20.5 * S)
  // 等蓝方（A）进入回合后放一面边镜
  await waitFor(async () => (await da.status()).includes('你的回合'), '布置完成轮到 A')
  await da.clickEdgeU(PAD + 14.5 * S, PAD + 10 * S)
  await waitFor(async () => (await db.status()).includes('你的回合'), 'A 落子后轮到 B')

  // A 刷新：应从 localStorage 恢复并 rejoin
  await A.reload({ waitUntil: 'networkidle' })
  await A.waitForSelector('svg.board-svg')
  const stA = await waitFor(async () => {
    const s = await da.status()
    return s.includes('等待') && s
  }, 'A 刷新后重连并等待红方落子')
  console.log('ok: 联机刷新后局面恢复并重连（A 状态:', stA, '）')

  // B 不应再显示"有玩家掉线"，且轮到 B
  const stB = await waitFor(async () => {
    const s = await db.status()
    return !s.includes('掉线') && s
  }, 'B 的掉线提示消除')
  console.log('ok: 对端掉线提示已消除（B 状态:', stB, '）')

  // B 继续落子，A 应同步收到（验证重连后动作转发正常）
  await db.clickCell(15, 15) // 红 '/'
  const stA2 = await waitFor(async () => {
    const s = await da.status()
    return s.includes('你的回合') && s
  }, '重连后 B 落子同步到 A')
  console.log('ok: 重连后动作转发正常（A 状态:', stA2, '）')

  // B（加入方）刷新：同样应恢复局面并 rejoin
  await B.reload({ waitUntil: 'networkidle' })
  await B.waitForSelector('svg.board-svg')
  const stB2 = await waitFor(async () => {
    const s = await db.status()
    return s.includes('等待') && s
  }, 'B 刷新后重连并等待蓝方落子')
  console.log('ok: 加入方刷新后局面恢复并重连（B 状态:', stB2, '）')

  // A 的掉线提示也应消除；A 落子后 B 能同步收到
  await waitFor(async () => !(await da.status()).includes('掉线'), 'A 的掉线提示消除')
  await da.clickEdgeU(PAD + 16.5 * S, PAD + 12 * S) // 蓝边镜 h:16:12
  const stB3 = await waitFor(async () => {
    const s = await db.status()
    return s.includes('你的回合') && s
  }, 'B 重连后 A 落子同步到 B')
  console.log('ok: 加入方重连后动作转发正常（B 状态:', stB3, '）')

  await ctxA.close()
  await ctxB.close()
}

await browser.close()
console.log('持久化校验全部通过')
process.exit(0)
