// 三人联机端到端校验（trystero P2P）：建 3 人房 → 三人入座 → 各自布置 → 回合轮转 → 三色渲染 → 淘汰制 UI
// 需先启动 dev 服务（默认打 http://localhost:5173，可用 BASE_URL 覆盖）；P2P 信令走公网中继，断言均轮询等待
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

async function waitFor(fn, what, timeout = 20000) {
  const t0 = Date.now()
  let last
  for (;;) {
    try {
      last = await fn()
      if (last) return last
    } catch {
      // 元素尚未出现等，继续轮询
    }
    if (Date.now() - t0 > timeout) throw new Error(`等待超时：${what}`)
    await new Promise((r) => setTimeout(r, 300))
  }
}

function makeDriver(page) {
  const boxOf = () => page.locator('svg.board-svg').boundingBox()
  const toScreen = async (ux, uy) => {
    const box = await boxOf()
    const k = box.width / SIZE
    return [box.x + ux * k, box.y + uy * k]
  }
  return {
    status: () => page.locator('.status-note').innerText(),
    waitStatus: (pred, what) => waitFor(async () => pred(await page.locator('.status-note').innerText()), what),
    async clickU(ux, uy, button = 'left') {
      const [sx, sy] = await toScreen(ux, uy)
      await page.mouse.click(sx, sy, { button })
      await page.waitForTimeout(150)
    },
    cell: (x, y) => [PAD + (x + 0.5) * S, PAD + (y + 0.5) * S],
  }
}

const ctxA = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const ctxB = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const ctxC = await browser.newContext({ viewport: { width: 1280, height: 900 } })
const A = await ctxA.newPage()
const B = await ctxB.newPage()
const C = await ctxC.newPage()
for (const [tag, p] of [['A', A], ['B', B], ['C', C]]) {
  p.on('pageerror', (e) => console.log(`[pageerror ${tag}]`, e.message))
}
const da = makeDriver(A)
const db = makeDriver(B)
const dc = makeDriver(C)

// 指向本地开发中继（默认公共 Nostr 中继在本机不可达；RELAY_URL 可覆盖）
const RELAY = process.env.RELAY_URL || 'ws://localhost:8787'
for (const p of [A, B, C]) {
  await p.addInitScript((r) => localStorage.setItem('light-chess:relays', r), RELAY)
}

// A：选 3 人，创建房间
await A.goto(BASE + '/', { waitUntil: 'networkidle' })
await A.locator('.count-btn', { hasText: '3' }).click()
await A.getByText('创建房间').click()
await A.waitForSelector('.room-code')
const code = (await A.locator('.room-code').innerText()).trim()
console.log('房间号', code)
if (!(await A.locator('.waiting').innerText()).includes('1/3')) throw new Error('等待进度应为 1/3')

// B、C 加入
await B.goto(BASE + '/', { waitUntil: 'networkidle' })
await B.getByText('加入房间').click()
await B.locator('.code-input').fill(code)
await B.getByText('加入', { exact: true }).click()
await waitFor(async () => (await A.locator('.waiting').innerText()).includes('2/3'), '就座进度 2/3')
console.log('ok: 就座进度 1/3 → 2/3')

await C.goto(BASE + '/', { waitUntil: 'networkidle' })
await C.getByText('加入房间').click()
await C.locator('.code-input').fill(code)
await C.getByText('加入', { exact: true }).click()

await A.waitForSelector('svg.board-svg', { timeout: 30000 })
await B.waitForSelector('svg.board-svg', { timeout: 30000 })
await C.waitForSelector('svg.board-svg', { timeout: 30000 })

// 身份检查
await waitFor(async () => (await A.locator('.meta-note').innerText()).includes('你执蓝方'), 'A 入座蓝方')
const roomB = await B.locator('.meta-note').innerText()
const roomC = await C.locator('.meta-note').innerText()
if (!roomB.includes('你执红方') || !roomC.includes('你执黄方'))
  throw new Error(`座位颜色不对：B=${roomB} C=${roomC}`)
console.log('ok: 三人入座，A=蓝 B=红 C=黄')

// 各自布置（联机 setup 不限顺序）
// A 蓝家 (6,6) 出口向右
await da.clickU(...da.cell(6, 6))
await da.clickU(PAD + 7.6 * S, PAD + 6.5 * S)
// B 红家 (20,8) 出口向下
await db.clickU(...db.cell(20, 8))
await db.clickU(PAD + 20.5 * S, PAD + 8.6 * S)
// C 黄家 (13,20) 出口向上
await dc.clickU(...dc.cell(13, 20))
await dc.clickU(PAD + 13.5 * S, PAD + 19.4 * S)

await da.waitStatus((s) => s.includes('你的回合'), '三方布置完轮到蓝方(A)')
console.log('ok: 三人布置完成，蓝方先手')

// 回合轮转：A 落子 → B 回合 → C 回合 → A 回合
await da.clickU(PAD + 10.5 * S, PAD + 10 * S) // 蓝边镜 h:10:10
await db.waitStatus((s) => s.includes('你的回合'), 'A 落子后轮到 B')
await db.clickU(PAD + 11.5 * S, PAD + 10 * S) // 红边镜 h:11:10
await dc.waitStatus((s) => s.includes('你的回合'), 'B 落子后轮到 C')
await dc.clickU(PAD + 12.5 * S, PAD + 10 * S) // 黄边镜 h:12:10
await da.waitStatus((s) => s.includes('你的回合'), 'C 落子后轮到 A')
console.log('ok: 联机回合轮转 蓝→红→黄→蓝')

// 三色镜子都在 C 的页面上渲染（黄：3 条自动家镜 + 1 条刚放的）
await waitFor(async () => (await C.locator('svg path[fill="#dd9a10"]').count()) >= 4, '黄色镜子渲染')
const yellowCount = await C.locator('svg path[fill="#dd9a10"]').count()
const redCount = await C.locator('svg path[fill="#e84a3c"]').count()
const blueCount = await C.locator('svg path[fill="#2f6fed"]').count()
if (redCount < 4 || blueCount < 4) throw new Error(`镜子渲染数量异常：红${redCount} 蓝${blueCount}`)
console.log(`ok: 三色镜子渲染正常（蓝${blueCount} 红${redCount} 黄${yellowCount}）`)

await C.screenshot({ path: '/tmp/lc-mp-3p.png' })

// ===== 淘汰制 UI 验证（几何同 store-check 场景 F）=====
// A(蓝) 击杀 B(红)：先阻断镜 '/' (20,10)，再走廊 '\' (24,6) → '/' (24,12) → '\' (20,12)
// B、C 的 dummy 边：h:25:25 ~ h:32:25（y=25 的水平边，点击格 (x,25) 顶边）
const dummyEdge = (d, x) => d.clickU(PAD + (x + 0.5) * S, PAD + 25 * S)

await da.clickU(...da.cell(20, 10)) // A 阻断镜 '/'
await db.waitStatus((s) => s.includes('你的回合'), '阻断镜后轮到 B')
await dummyEdge(db, 25)
await dc.waitStatus((s) => s.includes('你的回合'), 'B dummy 后轮到 C')
await dummyEdge(dc, 26)
await da.waitStatus((s) => s.includes('你的回合'), 'C dummy 后轮到 A')
await da.clickU(...da.cell(24, 6), 'right') // A '\'
await db.waitStatus((s) => s.includes('你的回合'), '轮到 B(2)')
await dummyEdge(db, 27)
await dc.waitStatus((s) => s.includes('你的回合'), '轮到 C(2)')
await dummyEdge(dc, 28)
await da.waitStatus((s) => s.includes('你的回合'), '轮到 A(2)')
await da.clickU(...da.cell(24, 12)) // A '/'
await db.waitStatus((s) => s.includes('你的回合'), '轮到 B(3)')
await dummyEdge(db, 29)
await dc.waitStatus((s) => s.includes('你的回合'), '轮到 C(3)')
await dummyEdge(dc, 30)
await da.waitStatus((s) => s.includes('你的回合'), '轮到 A(3)')
await da.clickU(...da.cell(20, 12), 'right') // A '\' —— 走廊闭合，命中红家

// 命中当回合不结算：轮到 B，无人出局，无结算遮罩
await db.waitStatus((s) => s.includes('你的回合'), '走廊闭合后轮到 B')
for (const [tag, p] of [['A', A], ['B', B], ['C', C]]) {
  if ((await p.locator('.dead-x').count()) !== 0) throw new Error(`${tag} 页不应出现死家标记`)
  if ((await p.locator('.overlay').count()) !== 0) throw new Error(`${tag} 页不应出现结算遮罩`)
}
console.log('ok: 命中延迟结算（B 尚有自救机会，页面无 ✕ 无遮罩）')

await dummyEdge(db, 31) // B 放弃自救
await dc.waitStatus((s) => s.includes('你的回合'), 'B 弃疗后轮到 C')
await dummyEdge(dc, 32) // C 行动后轮到 A，回合开头结算：红死

// 结算后仍是 A 的回合；B 出局；三页均显示 ✕；对局继续
await da.waitStatus((s) => s.includes('你的回合'), '结算后仍是 A 的回合')
await waitFor(async () => (await B.locator('.meta-note').innerText()).includes('已出局'), 'B 页提示红方已出局')
for (const [tag, p] of [['A', A], ['B', B], ['C', C]]) {
  await waitFor(async () => (await p.locator('.dead-x').count()) === 1, `${tag} 页死家 ✕`)
  if ((await p.locator('.overlay').count()) !== 0) throw new Error(`${tag} 页对局应继续，无遮罩`)
}
console.log('ok: B 被淘汰——对局继续，三页均显示死家 ✕，B 页提示已出局')

// A 再落一子 → 轮转跳过 B，轮到 C
await da.clickU(PAD + 5.5 * S, PAD + 15 * S) // 蓝边镜 h:5:15
await dc.waitStatus((s) => s.includes('你的回合'), 'A 行动后跳过 B 轮到 C')
if ((await db.status()).includes('你的回合')) throw new Error('B 已出局，不应再有回合')
console.log('ok: 回合轮转跳过已出局的 B')

await C.screenshot({ path: '/tmp/lc-mp-elim.png' })
await browser.close()
console.log('三人联机校验全部通过')
process.exit(0)
