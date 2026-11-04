// TS ↔ Python 光路对拍：固定 6×6 棋盘（含边镜折返/斜镜/半反射分叉），
// 输出规范化后的 segments 供与 rl/lightchess env.simulate 逐段比对。
// 用法：npx tsx scripts/sim-parity.ts
import { edgeOf, simulate, simulateDirected, type BoardState, type Pt } from '../src/game'

// 蓝家 (2,4) 出口向右；红家 (4,1) 出口向左
const homes = {
  blue: { x: 2, y: 4, dir: 0 as const },
  red: { x: 4, y: 1, dir: 2 as const },
}
const edges = new Map<string, { color: 'blue' | 'red' }>()
for (const d of [1, 2, 3] as const) edges.set(edgeOf(2, 4, d), { color: 'blue' })
for (const d of [0, 1, 3] as const) edges.set(edgeOf(4, 1, d), { color: 'red' })
// 手工镜子：斜镜改变光路；红边镜在 (0,3) 左边界内侧制造折返段
edges.set('v:1:3', { color: 'red' })
edges.set('h:3:0', { color: 'blue' })
const diags = new Map<string, { color: 'blue' | 'red'; ori: '/' | '\\' }>([
  ['4,4', { color: 'blue', ori: '\\' }],
  ['3,2', { color: 'blue', ori: '/' }],
  ['1,1', { color: 'red', ori: '/' }],
])

const board: BoardState = { size: 6, homes, edges, diags, boundaryReflects: true }

const fmt = (p: Pt) => `${p.x},${p.y}`
const norm = (segs: [Pt, Pt][]) =>
  segs
    .map(([p, q]) => {
      const a = fmt(p)
      const b = fmt(q)
      return a < b || (a === b && p.y <= q.y) ? `${a}|${b}` : `${b}|${a}`
    })
    .sort()

for (const color of ['blue', 'red'] as const) {
  const r = simulate(board, color)
  console.log(`== ${color}: hit=${r.hit} hits=${r.hits.join('/')}`)
  console.log(`hitPath=${r.hitPath ? r.hitPath.map(fmt).join('>') : '-'}`)
  for (const s of norm(r.segments)) console.log(s)
  // simulateDirected 的无向集合必须与 segments 完全一致
  const undirected = new Set<string>()
  for (const { p, q } of simulateDirected(board, color)) {
    const a = fmt(p)
    const b = fmt(q)
    undirected.add(a < b || (a === b && p.y <= q.y) ? `${a}|${b}` : `${b}|${a}`)
  }
  const segSet = new Set(norm(r.segments))
  const same = undirected.size === segSet.size && [...undirected].every((s) => segSet.has(s))
  console.log(`directed-set-equal=${same}`)
  if (!same) throw new Error('simulateDirected 与 simulate 的段集合不一致')
}
