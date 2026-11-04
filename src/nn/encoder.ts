/**
 * 光镜棋特征编码器（端侧 TS 版）：逐通道移植 rl/lightchess/features.py 的 encode()，
 * 激光访问表移植 rl/lightchess/env.py 的 trace_laser()（与 simulate 遍历语义一致）。
 * 任何改动必须与 Python 侧同步， FEATURE_VERSION 必须与 features.FEATURE_VERSION 一致。
 *
 * 输出 (C, size, size) 行主序 Float32Array，通道顺序（默认 light+ply 全开，C=31）：
 *   0-1   edge_h[cur, opp]    h 边 x∈[0,s),y∈[0,s] → [min(y,s-1)][x]
 *   2-3   edge_v[cur, opp]    v 边 x∈[0,s],y∈[0,s) → [y][min(x,s-1)]
 *   4-7   diag                每色 '/' 与 '\' 各一平面
 *   8-9   home                家位置
 *   10-17 home_dir            家开口方向（ch10 + ci*4 + dir 单点）
 *   18-25 light               方向光路：光以方向 d 经过格 (x,y)（含折返段同格反向节点）
 *   26-28 scalars             命中对手 / 被对手命中（全平面 0/1）/ ply 进度
 *   29-30 coords              归一化 x / y 坐标
 * 颜色顺序始终以当前行动方在前（order = players 从 current 轮转）。
 */
import {
  DX,
  DY,
  edgeOf,
  type BoardState,
  type Color,
  type Dir,
} from '../game'

export const N_EDGE_H = 2
export const N_EDGE_V = 2
export const N_DIAG = 4
export const N_HOME = 2
export const N_HOME_DIR = 8
export const N_LIGHT = 8
export const N_COORD = 2

/** 特征开关：与 features.py num_channels(light, ply) 同义 */
export interface FeatureFlags {
  light: boolean
  ply: boolean
}

export function numChannels(light = true, ply = true): number {
  let n = N_EDGE_H + N_EDGE_V + N_DIAG + N_HOME + N_HOME_DIR + N_COORD
  n += ply ? 3 : 2
  return n + (light ? N_LIGHT : 0)
}

/**
 * feature_version → 开关映射。与 rl/lightchess/features.py FEATURE_VERSION 对应：
 *   dirlight31-v1 —— light+ply 全开（31 通道，含手数进度平面）
 *   dirlight30-v1 —— light 开、ply 关（30 通道；6×6 SOTA / 8×8 推荐模型均为该变体）
 * ply=False 时标量组只有 2 通道（命中对手/被命中），坐标平面顺移到 28-29。
 */
export const FEATURE_VERSIONS = {
  'dirlight31-v1': { light: true, ply: true, channels: 31 },
  'dirlight30-v1': { light: true, ply: false, channels: 30 },
} as const satisfies Record<string, FeatureFlags & { channels: number }>

export type FeatureVersion = keyof typeof FEATURE_VERSIONS

/** 默认（最新）特征版本；消费真实 SOTA 权重时应显式传 'dirlight30-v1' */
export const FEATURE_VERSION: FeatureVersion = 'dirlight31-v1'

export const NUM_CHANNELS = numChannels()

export function flagsForVersion(version: string): FeatureFlags & { channels: number } {
  const f = (FEATURE_VERSIONS as Record<string, FeatureFlags & { channels: number }>)[version]
  if (!f) throw new Error(`未知 feature_version: ${version}`)
  return f
}

/** 环境侧回合状态：game.ts 的 BoardState 不维护这些（由 store.ts 维护），编码需要。 */
export interface EncoderState {
  board: BoardState
  current: Color
  players: Color[]
  ply: number
  maxPlies: number
  phase: 'setup' | 'play' | 'over'
}

// 斜镜反射表：与 game.ts / env.py 的 REFL 一致
const REFL: Record<'/' | '\\', Dir[]> = {
  '/': [3, 2, 1, 0],
  '\\': [1, 0, 3, 2],
}
const opp = (d: Dir): Dir => (((d + 2) % 4) as Dir)
const inside = (x: number, y: number, size: number) => x >= 0 && y >= 0 && x < size && y < size

/**
 * env.trace_laser 的逐行移植：返回 (hits, visited)。
 * visited 是 4·s² 的 (cell, dir) 访问表（bytearray 下标 (y*s+x)*4+d）。
 * 边镜/边界反射产生的“格中心→边中点→格中心”折返段会生成同格相反方向的节点，
 * (x,y,dir) 四平面天然区分，不做合并。
 */
export function traceLaser(
  board: BoardState,
  color: Color,
): { hits: Set<Color>; visited: Uint8Array } {
  const size = board.size
  const visited = new Uint8Array(size * size * 4)
  const hits = new Set<Color>()
  const home = board.homes[color]
  const homeList = Object.values(board.homes)
  if (!home || homeList.length < 2) return { hits, visited }
  const targets = new Map<string, Color>()
  for (const [c, h] of Object.entries(board.homes)) {
    if (c !== color && h) targets.set(`${h.x},${h.y}`, c as Color)
  }
  const boundaryReflects = board.boundaryReflects ?? false
  const queue = [0, 1, 2, 3].map((d) => (home.y * size + home.x) * 4 + d)
  for (let ni = 0; ni < queue.length; ni++) {
    const nid = queue[ni]
    if (visited[nid]) continue
    visited[nid] = 1
    const cell = nid >> 2
    const d = (nid & 3) as Dir
    const x = cell % size
    const y = Math.floor(cell / size)
    const t = targets.get(`${x},${y}`)
    if (t) {
      hits.add(t)
      continue // 被打中的家吸收激光
    }
    const diag = board.diags.get(`${x},${y}`)
    let dirs: Dir[]
    if (diag) {
      const r = REFL[diag.ori][d]
      dirs = diag.color === color ? [d, r] : [r]
    } else {
      dirs = [d]
    }
    for (const dd of dirs) {
      const nx = x + DX[dd]
      const ny = y + DY[dd]
      const inNext = inside(nx, ny, size)
      const boundary = boundaryReflects && !inNext
      const m = boundary ? undefined : board.edges.get(edgeOf(x, y, dd))
      const outs: Dir[] = boundary
        ? [opp(dd)]
        : m
          ? m.color === color
            ? [dd, opp(dd)]
            : [opp(dd)]
          : [dd]
      for (const d2 of outs) {
        if (d2 === dd) {
          // 穿透/直行：走到邻格，方向保持 d2
          if (inNext) queue.push((ny * size + nx) * 4 + d2)
        } else {
          // d2 == opp(dd)：只出现在边界/有镜时，反射回本格
          queue.push(cell * 4 + d2)
        }
      }
    }
  }
  return { hits, visited }
}

/**
 * features.encode 的逐通道移植。返回 (numChannels, size, size) 行主序。
 * opts 可传 FeatureFlags（{light, ply}）或 feature_version 字符串
 * （'dirlight30-v1' / 'dirlight31-v1'）；缺省 = dirlight31-v1（全开）。
 * light=false 去掉 8 个方向光路平面，ply=false 去掉手数进度平面（消融用）。
 */
export function encodeState(
  st: EncoderState,
  opts: FeatureVersion | Partial<FeatureFlags> = FEATURE_VERSION,
): Float32Array {
  const flags = typeof opts === 'string' ? flagsForVersion(opts) : opts
  const light = flags.light ?? true
  const ply = flags.ply ?? true
  const size = st.board.size
  const out = new Float32Array(numChannels(light, ply) * size * size)
  const players = st.players
  const curIdx = players.includes(st.current) ? players.indexOf(st.current) : 0
  const order = players.map((_, k) => players[(curIdx + k) % players.length])
  const cidx = new Map<Color, number>(order.map((c, i) => [c, i]))
  let ch = 0
  const put = (c: number, y: number, x: number, v: number) => {
    out[c * size * size + y * size + x] = v
  }

  // 边镜：edge_h[c][min(y,s-1)][x]，edge_v[c][y][min(x,s-1)]
  for (const [eid, m] of st.board.edges) {
    const ci = cidx.get(m.color)
    if (ci === undefined) continue
    const [t, a, b] = eid.split(':')
    const x = +a
    const y = +b
    if (t === 'h') {
      put(ch + ci, Math.min(y, size - 1), x, 1)
    } else {
      put(N_EDGE_H + ch + ci, y, Math.min(x, size - 1), 1)
    }
  }
  ch += N_EDGE_H + N_EDGE_V

  // 斜镜
  for (const [cell, dg] of st.board.diags) {
    const ci = cidx.get(dg.color)
    if (ci === undefined) continue
    const oi = dg.ori === '/' ? 0 : 1
    const [x, y] = cell.split(',').map(Number)
    put(ch + ci * 2 + oi, y, x, 1)
  }
  ch += N_DIAG

  // 家位置 + 开口方向
  for (const [ci, c] of order.entries()) {
    const h = st.board.homes[c]
    if (!h) continue
    put(ch + ci, h.y, h.x, 1)
    put(ch + N_HOME + ci * 4 + h.dir, h.y, h.x, 1)
  }
  ch += N_HOME + N_HOME_DIR

  // 方向光路平面（按 order 重排颜色）
  if (light) {
    const nHomes = Object.keys(st.board.homes).length
    for (const [ci, c] of order.entries()) {
      const h = st.board.homes[c]
      if (!h || nHomes < 2) continue
      const { visited } = traceLaser(st.board, c)
      for (let cell = 0; cell < size * size; cell++) {
        for (let d = 0; d < 4; d++) {
          if (visited[cell * 4 + d]) {
            out[(ch + ci * 4 + d) * size * size + cell] = 1
          }
        }
      }
    }
    ch += N_LIGHT
  }

  // 标量平面：当前行动方是否已命中 / 被命中
  let hitMe = false
  let hitOpp = false
  if (st.phase === 'play' && st.board.homes[st.current]) {
    hitOpp = traceLaser(st.board, st.current).hits.size > 0
    const other = players.find((c) => c !== st.current)
    if (other && st.board.homes[other]) {
      hitMe = traceLaser(st.board, other).hits.has(st.current)
    }
  }
  if (hitOpp) out.fill(1, ch * size * size, (ch + 1) * size * size)
  if (hitMe) out.fill(1, (ch + 1) * size * size, (ch + 2) * size * size)
  if (ply) out.fill(st.ply / Math.max(st.maxPlies, 1), (ch + 2) * size * size, (ch + 3) * size * size)
  ch += ply ? 3 : 2

  // 坐标平面（np.linspace(0, 1, size)）
  for (let i = 0; i < size; i++) {
    const v = size > 1 ? i / (size - 1) : 0
    for (let j = 0; j < size; j++) {
      out[ch * size * size + j * size + i] = v // x 坐标
      out[(ch + 1) * size * size + i * size + j] = v // y 坐标
    }
  }
  return out
}
