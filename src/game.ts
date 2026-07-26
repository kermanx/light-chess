/** 玩家调色板：下标即座位/回合顺序，0 号为房主 */
export const PALETTE = [
  { id: 'blue', name: '蓝', hex: '#2f6fed' },
  { id: 'red', name: '红', hex: '#e84a3c' },
  { id: 'yellow', name: '黄', hex: '#dd9a10' },
  { id: 'green', name: '绿', hex: '#34a05c' },
] as const
export type Color = (typeof PALETTE)[number]['id']
export const MIN_PLAYERS = 2
export const MAX_PLAYERS = PALETTE.length
/** 取前 n 个座位颜色（回合顺序），n 会被夹到合法范围 */
export const seatColors = (n: number): Color[] => {
  const k = Math.max(MIN_PLAYERS, Math.min(MAX_PLAYERS, Math.round(n)))
  return PALETTE.slice(0, k).map((p) => p.id)
}
/** 方向：0 右，1 下，2 左，3 上 */
export type Dir = 0 | 1 | 2 | 3
/** 斜镜朝向：'/' 左下-右上，'\\' 左上-右下 */
export type Ori = '/' | '\\'

/** 默认棋盘格数（NxN 格，N+1 x N+1 个点） */
export const DEFAULT_SIZE = 36

export interface Pt {
  x: number
  y: number
}

export interface Home {
  x: number
  y: number
  /** 激光发射方向（家中唯一没放镜子的那条边） */
  dir: Dir
}

export interface Mirror {
  color: Color
}

export interface Diag {
  color: Color
  ori: Ori
}

export interface BoardState {
  homes: Partial<Record<Color, Home>>
  /** 边镜，key 为边 id：`h:x:y`（横向边）或 `v:x:y`（纵向边） */
  edges: Map<string, Mirror>
  /** 斜镜，key 为 `x,y`（格子坐标），每格至多一面 */
  diags: Map<string, Diag>
  /** 棋盘格数 */
  size: number
}

export interface SimResult {
  /** 是否存在一条光路打到非己方的家 */
  hit: boolean
  /** 被打到的家的颜色（可能多家，含已出局的；结算由 store 过滤） */
  hits: Color[]
  /** 光路经过的所有线段（格点坐标系：点为整数，格子中心为 x+0.5），用于渲染 */
  segments: [Pt, Pt][]
  /** 一条获胜路径（若 hit），用于高亮 */
  hitPath: Pt[] | null
}

export const DX = [1, 0, -1, 0]
export const DY = [0, 1, 0, -1]

const opp = (d: Dir): Dir => (((d + 2) % 4) as Dir)

/** 斜镜反射表：REFL[ori][入射方向] = 出射方向 */
const REFL: Record<Ori, Dir[]> = {
  '/': [3, 2, 1, 0],
  '\\': [1, 0, 3, 2],
}

/** 格子 (x,y) 朝方向 d 跨出的那条边 */
export function edgeOf(x: number, y: number, d: Dir): string {
  switch (d) {
    case 0:
      return `v:${x + 1}:${y}`
    case 1:
      return `h:${x}:${y + 1}`
    case 2:
      return `v:${x}:${y}`
    default:
      return `h:${x}:${y}`
  }
}

/** 边的中点（格点坐标系） */
export function edgeMid(id: string): Pt {
  const [t, a, b] = id.split(':')
  const x = +a
  const y = +b
  return t === 'h' ? { x: x + 0.5, y } : { x, y: y + 0.5 }
}

const inside = (x: number, y: number, size: number) => x >= 0 && y >= 0 && x < size && y < size

/**
 * 隔开判定：把 color 色的边镜与棋盘边框视为墙，从任一家出发洪泛，
 * 若存在任何一个家不可达，即 color 色镜子把某一对玩家的家隔开了（非法）。
 * 斜镜不吸收激光，不算墙。
 */
export function createsEnclosure(
  edges: Map<string, Mirror>,
  color: Color,
  homes: Partial<Record<Color, Home>>,
  size: number,
): boolean {
  const list = Object.values(homes)
  if (list.length < 2) return false
  const seen = new Set<string>([`${list[0].x},${list[0].y}`])
  const queue: [number, number][] = [[list[0].x, list[0].y]]
  while (queue.length > 0) {
    const [x, y] = queue.pop()!
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const nx = x + DX[d]
      const ny = y + DY[d]
      if (!inside(nx, ny, size)) continue // 边框是墙
      const m = edges.get(edgeOf(x, y, d))
      if (m && m.color === color) continue // 该颜色的镜子是墙
      const key = `${nx},${ny}`
      if (!seen.has(key)) {
        seen.add(key)
        queue.push([nx, ny])
      }
    }
  }
  return list.some((h) => !seen.has(`${h.x},${h.y}`))
}

const center = (x: number, y: number): Pt => ({ x: x + 0.5, y: y + 0.5 })

const stateKey = (x: number, y: number, d: Dir) => `${x},${y},${d}`

const segKey = (p: Pt, q: Pt) =>
  p.x < q.x || (p.x === q.x && p.y <= q.y)
    ? `${p.x},${p.y}|${q.x},${q.y}`
    : `${q.x},${q.y}|${p.x},${p.y}`

interface Node {
  x: number
  y: number
  dir: Dir
  /** 从父节点到本节点新增的折点 */
  pts: Pt[]
  /** 父节点在 nodes 中的下标，-1 表示根 */
  parent: number
}

/**
 * 模拟 color 方从家发射的激光。
 * 己方镜子为半反射（穿过与反射两条分支都走），其他颜色的镜子必须反射。
 * 家不是特殊格子：自己的激光也能穿过/反射自己家的镜子（半反射），
 * 进入任一非己方的家即命中（被吸收，该分支终止）。
 * 用全局状态访问表剪枝：同一 (x, y, dir) 状态的后续光路是确定的，无需重复探索。
 */
export function simulate(board: BoardState, color: Color): SimResult {
  const home = board.homes[color]
  // 非己方的家都是命中目标
  const targets = new Map<string, Color>()
  for (const [c, h] of Object.entries(board.homes)) {
    if (c !== color && h) targets.set(`${h.x},${h.y}`, c as Color)
  }
  const empty: SimResult = { hit: false, hits: [], segments: [], hitPath: null }
  if (!home || targets.size === 0) return empty
  const size = board.size

  const segSet = new Map<string, [Pt, Pt]>()
  const addSeg = (p: Pt, q: Pt) => segSet.set(segKey(p, q), [p, q])

  const homePt = center(home.x, home.y)
  const fx = home.x + DX[home.dir]
  const fy = home.y + DY[home.dir]
  if (!inside(fx, fy, size)) {
    // 发射口朝棋盘外，激光直接消失
    const mid = edgeMid(edgeOf(home.x, home.y, home.dir))
    addSeg(homePt, mid)
    return { hit: false, hits: [], segments: [...segSet.values()], hitPath: null }
  }

  const nodes: Node[] = []
  const visited = new Set<string>([stateKey(home.x, home.y, home.dir)])
  let hit = false
  const hits: Color[] = []
  let hitNode = -1

  // 根节点：激光进入的第一个格子
  nodes.push({ x: fx, y: fy, dir: home.dir, pts: [center(fx, fy)], parent: -1 })
  addSeg(homePt, center(fx, fy))
  const stack = [0]

  while (stack.length > 0) {
    const ni = stack.pop()!
    const node = nodes[ni]
    const key = stateKey(node.x, node.y, node.dir)
    if (visited.has(key)) continue
    visited.add(key)

    const target = targets.get(`${node.x},${node.y}`)
    if (target) {
      hit = true
      if (!hits.includes(target)) hits.push(target)
      if (hitNode === -1) hitNode = ni
      continue // 被打中的家吸收激光
    }

    const diag = board.diags.get(`${node.x},${node.y}`)
    let dirs: Dir[]
    if (diag) {
      const r = REFL[diag.ori][node.dir]
      dirs = diag.color === color ? [node.dir, r] : [r]
    } else {
      dirs = [node.dir]
    }

    for (const d of dirs) {
      const eid = edgeOf(node.x, node.y, d)
      const m = board.edges.get(eid)
      // 无镜：穿过；己镜：穿过+反射（半反射）；敌镜：必须反射
      const outs: Dir[] = m ? (m.color === color ? [d, opp(d)] : [opp(d)]) : [d]
      for (const d2 of outs) {
        if (m && d2 === opp(d)) {
          // 在边上反射回本格
          const mid = edgeMid(eid)
          const c = center(node.x, node.y)
          addSeg(c, mid)
          addSeg(mid, c)
          stack.push(nodes.length)
          nodes.push({ x: node.x, y: node.y, dir: d2, pts: [mid, c], parent: ni })
        } else {
          const nx = node.x + DX[d2]
          const ny = node.y + DY[d2]
          const c = center(node.x, node.y)
          if (!inside(nx, ny, size)) {
            addSeg(c, edgeMid(eid))
          } else {
            addSeg(c, center(nx, ny))
            stack.push(nodes.length)
            nodes.push({ x: nx, y: ny, dir: d2, pts: [center(nx, ny)], parent: ni })
          }
        }
      }
    }
  }

  let hitPath: Pt[] | null = null
  if (hit) {
    const rev: Pt[] = []
    for (let i = hitNode; i !== -1; i = nodes[i].parent) {
      const pts = nodes[i].pts
      for (let j = pts.length - 1; j >= 0; j--) rev.push(pts[j])
    }
    hitPath = [homePt, ...rev.reverse()]
  }

  return { hit, hits, segments: [...segSet.values()], hitPath }
}
