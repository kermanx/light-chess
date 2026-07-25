// 激光模拟逻辑的一次性校验脚本（npx tsx scripts/sim-check.ts）
import { createsEnclosure, simulate, type BoardState } from '../src/game'

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
  console.log(`ok: ${msg}`)
}

// 场景 1：双方激光经反射后互相命中对方的家
// 蓝家 (4,4) 发射口向右；红家 (8,7) 发射口向左
const board1: BoardState = { size: 30,
  homes: {
    blue: { x: 4, y: 4, dir: 0 },
    red: { x: 8, y: 7, dir: 2 },
  },
  edges: new Map([
    ['h:4:5', { color: 'blue' }],
    ['v:4:4', { color: 'blue' }],
    ['h:4:4', { color: 'blue' }],
    ['v:9:7', { color: 'red' }],
    ['h:8:8', { color: 'red' }],
    ['h:8:7', { color: 'red' }],
  ]),
  diags: new Map([
    ['6,4', { color: 'blue', ori: '\\' }],
    ['6,7', { color: 'blue', ori: '\\' }],
  ]),
}
const b1 = simulate(board1, 'blue')
assert(b1.hit, '蓝方激光经两面己方斜镜反射后命中红家')
assert(!!b1.hitPath && b1.hitPath.length > 0, '蓝方存在获胜路径')
const r1 = simulate(board1, 'red')
assert(r1.hit, '红方激光被蓝色斜镜（敌镜必须反射）反射后命中蓝家')

// 场景 2：无阻拦时不命中
const board2: BoardState = { size: 30,
  homes: {
    blue: { x: 4, y: 4, dir: 0 },
    red: { x: 8, y: 7, dir: 2 },
  },
  edges: new Map(board1.edges),
  diags: new Map(),
}
assert(!simulate(board2, 'blue').hit, '无斜镜时蓝方不命中')
assert(!simulate(board2, 'red').hit, '无斜镜时红方不命中')

// 场景 3：己方边镜半反射——一支穿过、一支反射，光路分叉
const board3: BoardState = { size: 30,
  homes: {
    blue: { x: 0, y: 0, dir: 0 },
    red: { x: 29, y: 29, dir: 2 },
  },
  edges: new Map([
    ['h:0:0', { color: 'blue' }],
    ['v:0:0', { color: 'blue' }],
    ['h:0:1', { color: 'blue' }],
    ['v:3:0', { color: 'blue' }], // 蓝激光沿 y=0 向右，在 x=2 处撞到己方边镜
    ['v:29:29', { color: 'red' }],
    ['h:29:29', { color: 'red' }],
    ['h:29:30', { color: 'red' }],
  ]),
  diags: new Map(),
}
const b3 = simulate(board3, 'blue')
assert(!b3.hit, '半反射场景蓝方未命中')
assert(b3.segments.length >= 3, '半反射产生分叉（穿过 + 反射两条支路）')

// 场景 4：环路必须终止（四面己方斜镜构成矩形循环）
const board4: BoardState = { size: 30,
  homes: {
    blue: { x: 0, y: 1, dir: 0 },
    red: { x: 29, y: 29, dir: 2 },
  },
  edges: new Map([
    ['h:0:1', { color: 'blue' }],
    ['v:0:1', { color: 'blue' }],
    ['h:0:2', { color: 'blue' }],
    ['v:29:29', { color: 'red' }],
    ['h:29:29', { color: 'red' }],
    ['h:29:30', { color: 'red' }],
  ]),
  diags: new Map([
    ['1,1', { color: 'blue', ori: '/' }],
    ['2,1', { color: 'blue', ori: '\\' }],
    ['2,2', { color: 'blue', ori: '/' }],
    ['1,2', { color: 'blue', ori: '\\' }],
  ]),
}
const t0 = Date.now()
const b4 = simulate(board4, 'blue')
assert(Date.now() - t0 < 1000, '环路场景模拟在 1 秒内完成（无死循环）')
assert(!b4.hit, '环路场景蓝方未命中')

// 场景 5：围死判定——出口格其余 3 边被同色边镜占满即围死
const edges5 = new Map(board1.edges)
edges5.set('h:5:4', { color: 'blue' })
edges5.set('h:5:5', { color: 'blue' })
assert(!createsEnclosure(edges5, 'blue', board1.homes, 30), '出口格只占 2 边时尚未围死')
edges5.set('v:6:4', { color: 'blue' })
assert(createsEnclosure(edges5, 'blue', board1.homes, 30), '出口格 3 边被同色占满即围死')
assert(!createsEnclosure(edges5, 'red', board1.homes, 30), '以红色为墙时不构成围死')

// 场景 6：边框也算墙——家在顶行、出口朝上，出口格左右封边即被边框+镜子隔开
const homes6 = {
  blue: { x: 4, y: 1, dir: 3 as const },
  red: { x: 20, y: 20, dir: 2 as const },
}
const edges6 = new Map<string, { color: 'blue' | 'red' }>([
  // 蓝家自动镜（出口朝上，其余 3 边）
  ['v:5:1', { color: 'blue' }],
  ['h:4:2', { color: 'blue' }],
  ['v:4:1', { color: 'blue' }],
  // 红家自动镜（出口朝左）
  ['v:21:20', { color: 'red' }],
  ['h:20:20', { color: 'red' }],
  ['h:20:21', { color: 'red' }],
  // 出口格 (4,0) 的右边
  ['v:5:0', { color: 'blue' }],
])
assert(!createsEnclosure(edges6, 'blue', homes6, 30), '出口格左侧未封时两家仍连通')
edges6.set('v:4:0', { color: 'blue' }) // 左侧也封住，边框补上顶边
assert(createsEnclosure(edges6, 'blue', homes6, 30), '边框+同色镜子把两家隔开即非法（蓝围蓝也算）')
assert(!createsEnclosure(edges6, 'red', homes6, 30), '以红色为墙时不构成隔开')

// 场景 7：三人局——激光命中任一非己方的家即获胜
// 蓝家 (4,4) 出口向右直击红家 (8,4)；黄家 (20,20) 在远处
const homes7 = {
  blue: { x: 4, y: 4, dir: 0 as const },
  red: { x: 8, y: 4, dir: 2 as const },
  yellow: { x: 20, y: 20, dir: 3 as const },
}
const homeEdges7: [string, { color: 'blue' | 'red' | 'yellow' }][] = [
  // 蓝家自动镜（出口向右）
  ['h:4:5', { color: 'blue' }],
  ['v:4:4', { color: 'blue' }],
  ['h:4:4', { color: 'blue' }],
  // 红家自动镜（出口向左）
  ['v:9:4', { color: 'red' }],
  ['h:8:5', { color: 'red' }],
  ['h:8:4', { color: 'red' }],
  // 黄家自动镜（出口向上）
  ['v:21:20', { color: 'yellow' }],
  ['h:20:21', { color: 'yellow' }],
  ['v:20:20', { color: 'yellow' }],
]
const board7: BoardState = { size: 30, homes: homes7, edges: new Map(homeEdges7), diags: new Map() }
assert(simulate(board7, 'blue').hit, '三人局：蓝方激光沿直线命中红家')
assert(simulate(board7, 'red').hit, '三人局：红方激光沿直线命中蓝家')
assert(!simulate(board7, 'yellow').hit, '三人局：黄方激光无阻拦不命中')

// 场景 8：三人局围死判定——任一颜色的镜子把任意一对玩家隔开即非法
// 黄家出口格 (20,19) 的三条外边放黄镜：黄墙把黄家与其他两家隔开
const edges8 = new Map(homeEdges7)
edges8.set('h:20:19', { color: 'yellow' })
edges8.set('v:20:19', { color: 'yellow' })
assert(!createsEnclosure(edges8, 'yellow', homes7, 30), '三人局：出口格只占 2 边时尚未隔开')
edges8.set('v:21:19', { color: 'yellow' })
assert(createsEnclosure(edges8, 'yellow', homes7, 30), '三人局：黄墙把黄家与蓝/红隔开即非法')
assert(!createsEnclosure(edges8, 'blue', homes7, 30), '三人局：同样的镜子按蓝色为墙则不构成隔开')

// 场景 9：家镜普通化——激光经反射回到自己的家，穿过家（半反射）后继续前进并命中
// 蓝家 (4,4) 出口向右，激光绕一圈从下方穿回家中，向上穿出后命中红家 (4,0)
const board9: BoardState = { size: 30,
  homes: {
    blue: { x: 4, y: 4, dir: 0 },
    red: { x: 4, y: 0, dir: 1 },
  },
  edges: new Map([
    // 蓝家自动镜（出口向右）
    ['h:4:5', { color: 'blue' }],
    ['v:4:4', { color: 'blue' }],
    ['h:4:4', { color: 'blue' }],
    // 红家自动镜（出口向下）
    ['v:4:0', { color: 'red' }],
    ['h:4:0', { color: 'red' }],
    ['v:5:0', { color: 'red' }],
  ]),
  diags: new Map([
    ['6,4', { color: 'blue', ori: '\\' }], // 右→下
    ['6,6', { color: 'blue', ori: '/' }], // 下→左
    ['4,6', { color: 'blue', ori: '\\' }], // 左→上，进入家下方
  ]),
}
const b9 = simulate(board9, 'blue')
assert(b9.hit && b9.hits.includes('red'), '激光穿过自己的家（半反射）后命中红家')
assert(
  b9.segments.some(([p, q]) => p.x === 4.5 && q.x === 4.5 && Math.min(p.y, q.y) <= 3.5),
  '存在从家中心向上穿出家的光路段',
)

console.log('全部通过')
