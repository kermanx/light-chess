// 撤回一步 / 等待方预览与提醒动画 / 上一步加粗 / 非房主无重新开始 / 对局 URL 的端到端校验
// 需先启动 dev 服务（localhost:5173）和本地中继（localhost:8787）。
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL || 'http://localhost:5173'
const RELAY = process.env.RELAY_URL || 'ws://localhost:8787'
const PAD = 36
const S = 28
const SIZE = 72 + 36 * 28

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

const mk = async (tag) => {
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log(`[pageerror ${tag}]`, e.message))
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  return p
}
const drv = (p) => ({
  toScreen: async (ux, uy) => {
    const box = await p.locator('svg.board-svg').boundingBox()
    const k = box.width / SIZE
    return [box.x + ux * k, box.y + uy * k]
  },
  clickU: async (ux, uy) => {
    const [sx, sy] = await drv(p).toScreen(ux, uy)
    await p.mouse.click(sx, sy)
    await p.waitForTimeout(150)
  },
  hoverU: async (ux, uy) => {
    const [sx, sy] = await drv(p).toScreen(ux, uy)
    await p.mouse.move(sx, sy)
    await p.waitForTimeout(150)
  },
  status: () => p.locator('.status-note').innerText(),
})
const cell = (x, y) => [PAD + (x + 0.5) * S, PAD + (y + 0.5) * S]
const hedge = (x, y) => [PAD + (x + 0.5) * S, PAD + y * S]

// ===== 联机 2 人局 =====
const A = await mk('A')
await A.getByText('创建房间').click()
await A.waitForSelector('.room-code')
const code = (await A.locator('.room-code').innerText()).trim()
const B = await mk('B')
await B.getByText('加入房间').click()
await B.locator('.code-input').fill(code)
await B.getByText('加入', { exact: true }).click()
await A.waitForSelector('svg.board-svg', { timeout: 40000 })
await B.waitForSelector('svg.board-svg', { timeout: 40000 })
const da = drv(A)
const db = drv(B)

// 布置：A 蓝家 (6,6) 出口向右；B 红家 (20,8) 出口向下
await da.clickU(...cell(6, 6))
await da.clickU(PAD + 7.6 * S, PAD + 6.5 * S)
await db.clickU(...cell(20, 8))
await db.clickU(PAD + 20.5 * S, PAD + 9.6 * S)
await waitFor(async () => (await da.status()).includes('你的回合'), 'A 先手')

// 对局 URL 应为 /s/<id>
if (!A.url().includes('/s/') || !B.url().includes('/s/')) throw new Error(`对局 URL 不含 /s/：A=${A.url()} B=${B.url()}`)
console.log('ok: 对局 URL 为 /s/<id>')

// 权限：B（非房主）没有「重新开始」，也没有「撤回一步」（房主未开启）
if ((await B.locator('button', { hasText: '重新开始' }).count()) !== 0) throw new Error('非房主不应看到重新开始')
if ((await B.locator('button', { hasText: '撤回一步' }).count()) !== 0) throw new Error('房主未开启时不应看到撤回一步')
if ((await A.locator('button', { hasText: '重新开始' }).count()) !== 1) throw new Error('房主应看到重新开始')
console.log('ok: 非房主无重新开始/撤回一步按钮')

// A 放边镜 h:10:10 → 上一步加粗；轮到 B
await da.clickU(...hedge(10, 10))
await waitFor(async () => (await db.status()).includes('你的回合'), 'A 落子后轮到 B')
await waitFor(async () => (await B.locator('svg path[data-last="1"]').count()) === 1, '上一步边镜加粗')
console.log('ok: 上一步放置的边镜加粗显示')

// B 放边镜 h:11:10 → 轮到 A（B 进入等待）
await db.clickU(...hedge(11, 10))
await waitFor(async () => !(await db.status()).includes('你的回合'), 'B 落子后等待 A')

// 等待方（B）悬停仍有预览（红色虚影），点击不落子且状态栏播放提醒动画
await db.hoverU(...hedge(12, 10))
const ghost = await B.locator('svg line[stroke-opacity="0.45"]').count()
if (ghost === 0) throw new Error('等待方悬停应显示放置预览')
console.log('ok: 等待方悬停显示预览')
const redReal = (p) => p.locator('svg path[fill="#e84a3c"][fill-opacity="0.92"]').count()
const redBefore = await redReal(B)
await db.clickU(...hedge(12, 10))
await waitFor(async () => (await B.locator('.status-note.nudged').count()) === 1, '提醒动画 class')
const redAfter = await redReal(B)
if (redAfter !== redBefore) throw new Error('等待方点击不应落子')
console.log('ok: 等待方点击不落子，状态栏播放提醒动画')

// 房主（A）在对局面板开启「允许撤回一步」→ B 出现撤回按钮；但开启前下的步骤不可撤
await A.locator('.ctl-note .chk', { hasText: '允许撤回一步' }).locator('input').check()
await waitFor(async () => (await B.locator('button', { hasText: '撤回一步' }).count()) === 1, 'B 出现撤回按钮')
await waitFor(
  async () => await B.locator('button', { hasText: '撤回一步' }).isDisabled(),
  '开启前的步骤不可撤：B 按钮禁用',
)
if (!(await A.locator('button', { hasText: '撤回一步' }).isDisabled()))
  throw new Error('开启前的步骤不可撤：A 按钮也应禁用')
console.log('ok: 房主开启后非房主也可撤回；开启前下的步骤不可撤')

// A 再放一手 h:12:10（开启后下的）：A 可撤自己，B 不能
const blueReal = (p) => p.locator('svg path[fill="#2f6fed"][fill-opacity="0.92"]').count()
const blueBefore = await blueReal(A)
await da.clickU(...hedge(12, 10))
await waitFor(async () => (await db.status()).includes('你的回合'), 'A 落子后轮到 B')
await waitFor(
  async () => !(await A.locator('button', { hasText: '撤回一步' }).isDisabled()),
  'A 可撤自己开启后下的那手',
)
if (!(await B.locator('button', { hasText: '撤回一步' }).isDisabled()))
  throw new Error('最后一手属于 A，B 的撤回按钮应禁用')
console.log('ok: 只能撤回自己刚下的那手（A 可用，B 禁用）')

// A 撤回自己这手：双端一致
await A.locator('button', { hasText: '撤回一步' }).click()
await waitFor(async () => (await da.status()).includes('你的回合'), '撤回后回到 A 的回合')
for (const [tag, p] of [['A', A], ['B', B]]) {
  const n = await blueReal(p)
  if (n !== blueBefore) throw new Error(`${tag} 页撤回后蓝镜数量应为 ${blueBefore}，实际 ${n}`)
}
console.log('ok: 房主撤回自己开启后下的那手，双端局面一致')

// B 开启后下的一手同样可撤：A 落子 → B 落子 h:13:10 → B 撤回（双端一致）
await da.clickU(...hedge(12, 10))
await waitFor(async () => (await db.status()).includes('你的回合'), 'A 再次落子后轮到 B')
await db.clickU(...hedge(13, 10))
await waitFor(async () => (await da.status()).includes('你的回合'), 'B 落子后轮到 A')
await waitFor(
  async () => !(await B.locator('button', { hasText: '撤回一步' }).isDisabled()),
  'B 可撤自己开启后下的那手',
)
await B.locator('button', { hasText: '撤回一步' }).click()
await waitFor(async () => (await db.status()).includes('你的回合'), '撤回后回到 B 的回合')
for (const [tag, p] of [['A', A], ['B', B]]) {
  const n = await redReal(p)
  if (n !== redBefore) throw new Error(`${tag} 页撤回后红镜数量应为 ${redBefore}，实际 ${n}`)
}
console.log('ok: 非房主撤回自己开启后下的那手，双端局面一致')

// ===== 单机：撤回按钮始终可用 =====
const C = await mk('C')
await C.getByText('单机对战').click()
await C.waitForSelector('svg.board-svg')
const dc = drv(C)
await dc.clickU(...cell(6, 6))
await dc.clickU(PAD + 7.6 * S, PAD + 6.5 * S)
await dc.clickU(...cell(20, 8))
await dc.clickU(PAD + 20.5 * S, PAD + 9.6 * S)
await dc.clickU(...hedge(10, 10))
if ((await C.locator('svg path[data-last="1"]').count()) !== 1) throw new Error('单机：上一步应加粗')
await C.locator('button', { hasText: '撤回一步' }).click()
await C.waitForTimeout(300)
if ((await C.locator('svg path[fill="#2f6fed"]').count()) !== 3) throw new Error('单机：撤回后蓝镜应为 3 条（家的自动镜）')
console.log('ok: 单机撤回一步可用')

// ===== 单机：Shift 反向斜镜 =====
const ghostLine = C.locator('svg line[stroke-opacity="0.45"]')
const ghostY = async () => [
  Number(await ghostLine.getAttribute('y1')),
  Number(await ghostLine.getAttribute('y2')),
]
await dc.hoverU(...cell(15, 15))
await waitFor(async () => (await ghostLine.count()) === 1, '斜镜预览出现')
let [gy1, gy2] = await ghostY()
if (!(gy1 > gy2)) throw new Error('默认斜镜预览应为「/」（y1 > y2）')
await C.keyboard.down('Shift')
await C.waitForTimeout(250)
;[gy1, gy2] = await ghostY()
if (!(gy1 < gy2)) throw new Error('按住 Shift 斜镜预览应翻转为「\\」（y1 < y2）')
console.log('ok: Shift 按住时斜镜预览反向')
// Shift+左键：放下的是「\」——data-diag="15,15" 且 data-ori 为反斜杠
await dc.clickU(...cell(15, 15))
await waitFor(async () => (await C.locator('svg path[data-diag="15,15"]').count()) === 1, 'Shift+左键落子')
if ((await C.locator('svg path[data-diag="15,15"]').getAttribute('data-ori')) !== '\\')
  throw new Error('Shift+左键应放下「\\」斜镜')
console.log('ok: Shift+左键放下「\\」斜镜')
await C.keyboard.up('Shift')
// 松开 Shift：预览恢复「/」，左键放「/」——data-diag="18,15"
await dc.hoverU(...cell(18, 15))
await C.waitForTimeout(250)
;[gy1, gy2] = await ghostY()
if (!(gy1 > gy2)) throw new Error('松开 Shift 斜镜预览应恢复为「/」')
await dc.clickU(...cell(18, 15))
await waitFor(async () => (await C.locator('svg path[data-diag="18,15"]').count()) === 1, '左键落子')
if ((await C.locator('svg path[data-diag="18,15"]').getAttribute('data-ori')) !== '/')
  throw new Error('左键应放下「/」斜镜')
console.log('ok: 松开 Shift 后左键放下「/」斜镜')

await browser.close()
console.log('撤回/预览/权限校验全部通过')
process.exit(0)
