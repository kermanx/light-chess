import { PALETTE, DX, DY, edgeOf, createsEnclosure, simulate, type BoardState, type Color, type Dir, type Home } from '../../src/game.ts'
import { isAiAction, type AiAction, type AiRequest } from '../../src/ai/protocol.ts'

const colors = PALETTE.map(p => p.id)
type Position = { board: BoardState; players: Color[]; alive: Color[]; current: Color; phase: 'setup' | 'play'; winner: Color | null }
type Move = Exclude<AiAction, { kind: 'setup' }>
const compact = (points: { x: number; y: number }[] | undefined) => points?.filter((p, i) => {
  if (!i || i === points.length - 1) return true
  const a = points[i - 1], b = points[i + 1], ux = p.x - a.x, uy = p.y - a.y, vx = b.x - p.x, vy = b.y - p.y
  return ux * vy !== uy * vx || ux * vx + uy * vy <= 0
}) ?? null
const paths = (value: ReturnType<typeof simulate>['hitPaths']) => Object.fromEntries(Object.entries(value).map(([c, p]) => [c, compact(p)]))

export function decode(request: AiRequest): Position {
  const n = request.size
  if (!Number.isInteger(n) || n < 2 || request.horizontal.length !== n * (n + 1) || request.vertical.length !== n * (n + 1) || request.diagonals.length !== n * n) throw new Error('Invalid board dimensions')
  if (request.version !== 1 || !['setup', 'play'].includes(request.phase) || request.players.length < 2 || request.players.length > 4 ||
    new Set(request.players).size !== request.players.length || request.players.some(c => !Number.isInteger(c) || c < 0 || c > 3) ||
    !request.players.includes(request.current) || !(request.aliveMask & (1 << request.current))) throw new Error('Invalid players or phase')
  const board: BoardState = { size: n, boundaryReflects: true, homes: {}, edges: new Map(), diags: new Map() }
  request.homes.forEach((h, c) => { if (h) board.homes[colors[c]] = { ...h } })
  request.horizontal.forEach((c, i) => { if (c) board.edges.set(`h:${i % n}:${Math.floor(i / n)}`, { color: colors[c - 1] }) })
  request.vertical.forEach((c, i) => { if (c) board.edges.set(`v:${i % (n + 1)}:${Math.floor(i / (n + 1))}`, { color: colors[c - 1] }) })
  request.diagonals.forEach((c, i) => { if (c) board.diags.set(`${i % n},${Math.floor(i / n)}`, { color: colors[Math.floor((c - 1) / 2)], ori: c % 2 ? '/' : '\\' }) })
  const players = request.players.map(c => colors[c])
  return { board, players, alive: players.filter(c => request.aliveMask & (1 << colors.indexOf(c))), current: colors[request.current], phase: request.phase, winner: null }
}

export const RULES = `你在玩光棋。目标是用自己的光束命中敌方基地，在自己回合开头结算并淘汰全部对手。
坐标 x 向右、y 向下，从 0 开始。格心几何坐标为 (x+0.5,y+0.5)。h:x:y 是 (x,y)→(x+1,y) 的边，v:x:y 是 (x,y)→(x,y+1)。dir 0右、1下、2左、3上。
基地始终向四个方向发光。dir 只决定基地四边中哪一边不放镜子，其余三边自动放己方镜子；它不是发光方向，己方光束能穿过自己的基地镜。己方镜子半透半反射，光束同时穿过与反射；敌方镜子只反射。斜镜 /：右→上、下→左、左→下、上→右；斜镜 \\：右→下、下→右、左→上、上→左。边镜令光束原路反转。棋盘边界全反射。
每步放一面永久镜子，不能覆盖、移动、旋转或撤回。基地格不能放斜镜，边框不能放边镜。同色镜子与边框不得分隔存活基地（精确禁围检查会拒绝）。
关键时序：你落子→下一存活玩家回合开头仅结算他的光束→他落子→再下一玩家开头结算……攻击不是落子即胜！双人局如果你的落子后敌方光束仍命中你，你立刻输，无法交换基地；但你自己的进攻给对手一手防守机会。多人局顺序见 players，safeNextTurn 仅检查下一玩家，不能保证整个回合安全。
有即时致命威胁，先确定性验证能守住；无需防守时，优先直接攻击和持续逼防。敌人能挡一手不意味着进攻无价值。优先斜镜，两个方向对己方基本等价、对敌方不同，须实际验证。
setup 阶段直接通过 play({action:{kind:"setup",home:{x,y,dir}}}) 选择基地。此时 analyze 只接受空 sequence，不能试下基地布置，也不需要查询尚未建立的基地光路。基地间 Chebyshev 距离至少 2，开口不能朝棋盘外，初始先手光束不能立即击杀。
当前权威局面随每轮消息提供。analyze 可验证 0～8 手交替变化，再精确枚举最终行动方的进攻和防守；不改变实盘，不替你作战略选择。按需提供 light 查询具体光路。选定后在回复正文中用一句中文简述理由，并在同一回复调用 play({action})；工具参数只传动作。禁止把文字回答当落子。`

function put(board: BoardState, action: Move, color: Color) {
  if (action.kind === 'diag') board.diags.set(`${action.x},${action.y}`, { color, ori: action.ori })
  else board.edges.set(action.id, { color })
}
function remove(board: BoardState, action: Move) {
  if (action.kind === 'diag') board.diags.delete(`${action.x},${action.y}`)
  else board.edges.delete(action.id)
}
function options(p: Position): Move[] {
  const { board: b } = p, out: Move[] = []
  for (let y = 0; y < b.size; y++) for (let x = 0; x < b.size; x++) {
    if (!b.diags.has(`${x},${y}`) && !Object.values(b.homes).some(h => h.x === x && h.y === y)) {
      out.push({ kind: 'diag', x, y, ori: '/' }, { kind: 'diag', x, y, ori: '\\' })
    }
    if (x + 1 < b.size && !b.edges.has(`v:${x + 1}:${y}`)) out.push({ kind: 'edge', id: `v:${x + 1}:${y}` })
    if (y + 1 < b.size && !b.edges.has(`h:${x}:${y + 1}`)) out.push({ kind: 'edge', id: `h:${x}:${y + 1}` })
  }
  return out
}
function validate(p: Position, action: unknown, color = p.current): asserts action is AiAction {
  if (!isAiAction(action)) throw new Error('Invalid action')
  const { board: b } = p, n = b.size
  if (action.kind === 'setup') {
    const h = action.home
    if (p.phase !== 'setup' || b.homes[color] || h.x < 0 || h.y < 0 || h.x >= n || h.y >= n || h.dir < 0 || h.dir > 3) throw new Error('Invalid setup')
    if (Object.values(b.homes).some(v => Math.max(Math.abs(v.x - h.x), Math.abs(v.y - h.y)) < 2)) throw new Error('Base too close to another base')
    if (h.x + DX[h.dir] < 0 || h.x + DX[h.dir] >= n || h.y + DY[h.dir] < 0 || h.y + DY[h.dir] >= n) throw new Error('Base exit faces boundary')
    const trial = structuredClone(b)
    trial.homes[color] = { ...h }
    for (const d of [0, 1, 2, 3] as Dir[]) if (d !== h.dir) trial.edges.set(edgeOf(h.x, h.y, d), { color })
    if (simulate(trial, p.players[0]).hit) throw new Error('Setup causes immediate first-turn elimination')
    return
  }
  if (p.phase !== 'play') throw new Error('Choose your base first')
  if (action.kind === 'diag') {
    if (action.x < 0 || action.x >= n || action.y < 0 || action.y >= n || b.diags.has(`${action.x},${action.y}`) || Object.values(b.homes).some(h => h.x === action.x && h.y === action.y)) throw new Error('Occupied, base cell, or outside board')
  } else {
    const [axis, sx, sy] = action.id.split(':'), x = +sx, y = +sy
    if (b.edges.has(action.id) || (axis === 'h' ? x >= n || y < 1 || y >= n : x < 1 || x >= n || y >= n)) throw new Error('Occupied, boundary, or outside board')
  }
  put(b, action, color)
  try {
    const homes: Partial<Record<Color, Home>> = Object.fromEntries(Object.entries(b.homes).filter(([c]) => p.alive.includes(c as Color)))
    if (createsEnclosure(b.edges, color, homes, n, b.diags)) throw new Error('Illegal enclosure: same-color mirrors separate bases')
  } finally { remove(b, action) }
}
const next = (p: Position, color = p.current) => {
  let i = p.players.indexOf(color)
  do { i = (i + 1) % p.players.length } while (!p.alive.includes(p.players[i]))
  return p.players[i]
}
function info(p: Position) {
  const beams = p.alive.map(c => [c, simulate(p.board, c)] as const)
  return { phase: p.phase, size: p.board.size, players: p.players, alive: p.alive, current: p.current, winner: p.winner, homes: p.board.homes,
    threats: beams.filter(([c, s]) => c !== p.current && s.hits.includes(p.current)).map(([c]) => c), nextPlayer: next(p),
    beams: Object.fromEntries(beams.map(([c, s]) => [c, { hits: s.hits.filter(v => p.alive.includes(v)), hitPaths: paths(s.hitPaths) }])),
    edges: [...p.board.edges].map(([id, m]) => ({ id, color: m.color })), diags: [...p.board.diags].map(([cell, m]) => ({ cell, ...m })) }
}
function trace(p: Position, color: Color, target?: { x: number; y: number }) {
  if (!p.alive.includes(color) || !p.board.homes[color]) throw new Error('Unknown live base')
  const s = simulate(p.board, color), rows = new Map<number, Set<number>>()
  for (const segment of s.segments) for (const v of segment) if (v.x % 1 === .5 && v.y % 1 === .5) {
    const y = Math.floor(v.y), x = Math.floor(v.x)
    if (!rows.has(y)) rows.set(y, new Set())
    rows.get(y)!.add(x)
  }
  if (target && (!Number.isInteger(target.x) || !Number.isInteger(target.y) || target.x < 0 || target.x >= p.board.size || target.y < 0 || target.y >= p.board.size)) throw new Error('Invalid target')
  // The simulator accepts synthetic base ids at runtime; this board is isolated
  // and only the prefix ending at the queried cell is returned.
  let pathToTarget: ReturnType<typeof compact> | undefined
  if (target) {
    const home = p.board.homes[color]!
    const existing = Object.entries(p.board.homes).find(([, h]) => h.x === target.x && h.y === target.y)?.[0]
    if (home.x === target.x && home.y === target.y) pathToTarget = [{ x: home.x + .5, y: home.y + .5 }]
    else {
      const query = structuredClone(p.board), marker = existing ?? 'target'
      if (!existing) Object.assign(query.homes, { target: { ...target, dir: 0 } })
      pathToTarget = compact(simulate(query, color).hitPaths[marker as Color])
    }
  }
  return { color, hits: s.hits, hitPaths: paths(s.hitPaths), reachedRows: [...rows].sort((a, b) => a[0] - b[0]).map(([y, xs]) => ({ y, x: [...xs].sort((a, b) => a - b) })), ...(target ? { target, pathToTarget } : {}) }
}
function candidates(p: Position) {
  const color = p.current
  const foes = p.alive.filter(c => c !== color), threatened = foes.some(c => simulate(p.board, c).hits.includes(color)), candidates = []
  for (const action of options(p)) {
    try { validate(p, action, color) } catch { continue }
    put(p.board, action, color)
    try {
      const ours = simulate(p.board, color), threats = foes.filter(c => simulate(p.board, c).hits.includes(color)), attacks = ours.hits.filter(c => foes.includes(c))
      const safeNextTurn = !threats.includes(next(p, color)), safe = !threats.length
      candidates.push({ action, safe, safeNextTurn, attacks, threats })
    } finally { remove(p.board, action) }
  }
  candidates.sort((a, b) => Number(b.safeNextTurn) - Number(a.safeNextTurn) || b.attacks.length - a.attacks.length || Number(b.action.kind === 'diag') - Number(a.action.kind === 'diag'))
  return { threatened, candidates }
}

export interface AnalysisRequest {
  sequence?: unknown[]
  offset?: number
  limit?: number
  light?: { color: Color; target?: { x: number; y: number } }
}
interface CandidatePage {
  total: number
  offset: number
  nextOffset: number | null
  candidates: ReturnType<typeof candidates>['candidates']
}

function analyzePosition(p: Position, { sequence = [], offset = 0, limit = 8, light }: AnalysisRequest = {}) {
  if (!Array.isArray(sequence) || sequence.length > 8) throw new Error('Expected 0..8 alternating play moves')
  if (p.phase !== 'play' && sequence.length) throw new Error('During setup analyze accepts only an empty sequence')
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 20) throw new Error('Expected offset >= 0 and limit 1..20')
  const q = structuredClone(p), steps = []
  for (const action of sequence) {
    const color = q.current
    try { validate(q, action) } catch (error) { return { valid: false as const, step: steps.length + 1, color, error: String(error), steps } }
    if (action.kind === 'setup') throw new Error('Cannot set up during play')
    put(q.board, action, color)
    q.current = next(q)
    const eliminated = simulate(q.board, q.current).hits.filter(c => q.alive.includes(c))
    q.alive = q.alive.filter(c => !eliminated.includes(c))
    if (q.alive.length === 1) q.winner = q.alive[0]
    steps.push({ color, action, eliminated, current: q.current, winner: q.winner })
    if (q.winner) break
  }
  const beams = q.alive.map(color => [color, simulate(q.board, color)] as const)
  const position = { phase: q.phase, size: q.board.size, players: q.players, alive: q.alive, current: q.current, nextPlayer: q.winner ? null : next(q), winner: q.winner,
    threats: beams.filter(([color, beam]) => color !== q.current && beam.hits.includes(q.current)).map(([color]) => color),
    hits: Object.fromEntries(beams.map(([color, beam]) => [color, beam.hits.filter(hit => q.alive.includes(hit))])) }
  const result: { valid: true; steps: typeof steps; position: typeof position; light?: ReturnType<typeof trace>;
    moves?: { attack: CandidatePage; defend: CandidatePage; legal?: CandidatePage } } = {
    valid: true, steps, position, ...(light ? { light: trace(q, light.color, light.target) } : {}) }
  if (q.winner || q.phase !== 'play') return result
  const all = candidates(q)
  const attack = all.candidates.filter(c => c.safeNextTurn && c.attacks.length)
  const defend = all.threatened ? all.candidates.filter(c => c.safe) : []
  const page = (items: typeof all.candidates) => ({ total: items.length, offset,
    nextOffset: offset + limit < items.length ? offset + limit : null, candidates: items.slice(offset, offset + limit) })
  result.moves = { attack: page(attack), defend: page(defend),
    ...(!attack.length && !defend.length ? { legal: page(all.candidates) } : {}) }
  return result
}

// Host-only state injection; neither helper is registered as a model tool.
export const describePosition = (request: AiRequest) => info(decode(request))
export const analyze = (request: AiRequest, args: AnalysisRequest = {}) => analyzePosition(decode(request), args)

export function moveRationale(value: unknown): string {
  if (typeof value !== 'string') throw new Error('Expected a move explanation string')
  return value.trim()
}

/** Tools never mutate the actual game; only the controller may accept a selected move. */
export function createGameTools(request: AiRequest, select: (action: AiAction, rationale: string) => void) {
  const p = decode(request)
  let chosen = false
  return {
    analyze: (args: AnalysisRequest = {}) => analyzePosition(p, args),
    play: (args: { action: unknown; rationale: string }) => {
      if (chosen) throw new Error('A move has already been selected')
      validate(p, args.action)
      const rationale = moveRationale(args.rationale)
      chosen = true
      select(args.action, rationale)
      return { ok: true }
    },
  }
}
