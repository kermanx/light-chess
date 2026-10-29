import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, appendFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { simulate, createsEnclosure, edgeOf } from '../../src/game.ts'

export const COLORS = ['blue', 'red']
export const other = color => color === 'blue' ? 'red' : 'blue'
export const RULES = {
  objective: '你是蓝方 DSH，对手是红方 Rust/WASM AI。让自己的激光命中对方基地并在你的下次回合开头结算。请自主选择落子，工具不替你作战略决策。',
  coordinates: '零基坐标。x 向右、y 向下。16×16 的格子坐标均为 0..15。h:x:y 是 (x,y) 到 (x+1,y) 的水平边；v:x:y 是 (x,y) 到 (x,y+1) 的竖直边。光路几何坐标的格心是 (x+0.5,y+0.5)。',
  actions: [{ kind: 'diag', x: 2, y: 13, ori: '/' }, { kind: 'diag', x: 2, y: 13, ori: '\\' }, { kind: 'edge', id: 'v:3:2' }],
  rules: [
    '双方基地已布置。蓝方 (2,2)，红方 (13,13)。无棋钟，边界对所有颜色全反射。',
    '基地向右、下、左、上四个方向发光，不是只向开口发光。基地周围三面家镜仍遵循普通镜子规则。',
    '己方镜子半透半反射：光束同时穿过与反射；敌方镜子只反射。斜镜 /：右→上、下→左、左→下、上→右；斜镜 \\：右→下、下→右、左→上、上→左。横竖边镜把入射方向原路反转。',
    '每次放一面永久镜子，不能移动、旋转、覆盖或撤回。基地格不能放斜镜。棋盘外框不能放边镜。',
    '同色镜子与边框不能把两个基地分隔成不同连通区域。工具会用原游戏的精确禁围判定拒绝非法落子。',
    '关键时序：蓝落子→红回合开头结算红光束→红落子→蓝回合开头结算蓝光束。因此攻击不是落子即胜：对方可以先挡；但若你落子后红光束仍打到蓝家，你立刻输，来不及靠蓝光束交换基地。',
    '当前轮到蓝时，若红光束已命中蓝家，必须先挡住。若没有即时危险，可以直接进攻，迫使对方防守。斜镜通常更有利，但两个方向对敌方效果不同，请用假设工具验证。',
    '每轮消息提供权威棋盘。analyze 验证假设变化，不落子。play 是唯一落子工具，每轮只成功一次；宿主检查局面版本、等待红方应手，成功只返回 {ok:true}，下一轮另行提供新状态。',
  ],
  tool_workflow: '阅读本轮棋盘，用 analyze({sequence:[]}) 或最多 8 手交替变化查询最终行动方的进攻、防守；按需提供 light 查看光路。最后 play({action})，在同一回复正文中用一句中文说明理由。宿主提供下一轮局面，持续对弈到 winner 非空。',
}

export function boardOf(state) {
  return { size: state.size, boundaryReflects: true, homes: structuredClone(state.homes), edges: new Map(state.edges), diags: new Map(state.diags) }
}
export const packBoard = board => ({ size: board.size, homes: board.homes, edges: [...board.edges], diags: [...board.diags] })
export const moveId = action => action.kind === 'diag' ? `d:${action.x}:${action.y}:${action.ori}` : action.id
export function compactPath(points) {
  if (!points) return null
  return points.filter((p,i) => {
    if (i === 0 || i === points.length-1) return true
    const a=points[i-1],b=points[i+1],ux=p.x-a.x,uy=p.y-a.y,vx=b.x-p.x,vy=b.y-p.y
    return ux*vy !== uy*vx || ux*vx+uy*vy <= 0
  })
}
const compactPaths = paths => Object.fromEntries(Object.entries(paths).map(([color,points])=>[color,compactPath(points)]))
export function options(board) {
  const out = [], n = board.size
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    if (!board.diags.has(`${x},${y}`) && !Object.values(board.homes).some(h => h.x === x && h.y === y)) {
      for (const ori of ['/', '\\']) out.push({ kind: 'diag', x, y, ori })
    }
    if (x + 1 < n && !board.edges.has(`v:${x+1}:${y}`)) out.push({ kind: 'edge', id: `v:${x+1}:${y}` })
    if (y + 1 < n && !board.edges.has(`h:${x}:${y+1}`)) out.push({ kind: 'edge', id: `h:${x}:${y+1}` })
  }
  return out
}
export function validate(board, action, color) {
  if (!COLORS.includes(color)) return 'invalid color'
  if (!action || !['diag', 'edge'].includes(action.kind)) return 'invalid action kind'
  if (action.kind === 'diag') {
    if (!Number.isInteger(action.x) || !Number.isInteger(action.y) || !['/', '\\'].includes(action.ori)) return 'invalid diagonal coordinates/orientation'
  } else if (typeof action.id !== 'string') return 'invalid edge id'
  if (!options(board).some(m => m.kind === action.kind && moveId(m) === moveId(action))) return 'occupied, home cell, boundary, or outside board'
  put(board, action, color)
  const enclosed = createsEnclosure(board.edges, color, board.homes, board.size, board.diags)
  remove(board, action)
  return enclosed ? 'illegal enclosure: same-color mirrors separate the bases' : null
}
export function put(board, action, color) {
  if (action.kind === 'diag') board.diags.set(`${action.x},${action.y}`, { color, ori: action.ori })
  else board.edges.set(action.id, { color })
}
export function remove(board, action) {
  if (action.kind === 'diag') board.diags.delete(`${action.x},${action.y}`)
  else board.edges.delete(action.id)
}
export function advance(state, action, rationale, actor) {
  if (state.winner) throw new Error('Game already finished')
  const board = boardOf(state), color = state.current
  const error = validate(board, action, color)
  if (error) throw new Error(error)
  put(board, action, color)
  const next = other(color), hit = simulate(board, next).hits.includes(color)
  const move = { ply: state.ply + 1, color, action, rationale, actor }
  return { ...state, ...packBoard(board), current: next, winner: hit ? next : null,
    revision: state.revision + 1, ply: move.ply, moves: [...state.moves, move] }
}

export function traceSummary(board, color, target, segments = false) {
  if (!COLORS.includes(color)) throw new Error('color must be blue or red')
  const result = simulate(board, color), cells = new Set()
  for (const segment of result.segments) for (const p of segment) {
    if (p.x % 1 === 0.5 && p.y % 1 === 0.5) cells.add(`${Math.floor(p.x)},${Math.floor(p.y)}`)
  }
  const rows = []
  for (let y = 0; y < board.size; y++) {
    const xs = Array.from({ length: board.size }, (_, x) => x).filter(x => cells.has(`${x},${y}`))
    if (xs.length) rows.push({ y, x: xs })
  }
  let pathToTarget
  if (target) {
    if (![target.x, target.y].every(Number.isInteger) || target.x < 0 || target.y < 0 || target.x >= board.size || target.y >= board.size) throw new Error('invalid target cell')
    const home = board.homes[color]
    if (home.x === target.x && home.y === target.y) pathToTarget = [{ x: home.x + 0.5, y: home.y + 0.5 }]
    else {
      const actual = Object.entries(board.homes).find(([, h]) => h.x === target.x && h.y === target.y)?.[0]
      // A synthetic absorbing target stops at the queried cell. The prefix to
      // its first arrival uses exactly the original simulator's optical rules.
      const query = actual ? board : { ...board, homes: { ...board.homes, yellow: { ...target, dir: 0 } } }
      pathToTarget = simulate(query, color).hitPaths[actual ?? 'yellow'] ?? null
    }
  }
  return { color, hits: result.hits, hitPaths: compactPaths(result.hitPaths), reachedCells: cells.size,
    reachedRows: rows, ...(target ? { target, pathToTarget:compactPath(pathToTarget) } : {}), ...(segments ? { segments: result.segments } : {}) }
}
export function position(state) {
  const board = boardOf(state), beams = Object.fromEntries(COLORS.map(c => [c, simulate(board, c)]))
  const ascii = Array.from({ length: board.size }, (_, y) => `${String(y).padStart(2)} ` + Array.from({ length: board.size }, (_, x) => {
    const home = COLORS.find(c => board.homes[c].x === x && board.homes[c].y === y)
    if (home) return home === 'blue' ? ' B ' : ' R '
    const d = board.diags.get(`${x},${y}`)
    return d ? ` ${d.color[0]}${d.ori}` : ' . '
  }).join(''))
  return { gameId: state.id, revision: state.revision, ply: state.ply, current: state.current, winner: state.winner,
    size: state.size, homes: state.homes, mustDefend: !state.winner && beams[other(state.current)].hits.includes(state.current),
    hits: Object.fromEntries(COLORS.map(c => [c, beams[c].hits])),
    hitPaths: Object.fromEntries(COLORS.map(c => [c, compactPaths(beams[c].hitPaths)])),
    asciiLegend: 'B/R 基地，b/ b\\ 蓝斜镜，r/ r\\ 红斜镜，. 空。边镜单独列出。x 列从 0 向右，y 在左侧。',
    ascii, edges: state.edges.map(([id, m]) => ({ id, color: m.color })),
    diags: state.diags.map(([cell, m]) => ({ cell, ...m })),
    recentMoves: state.moves.slice(-8).map(({stats,...move}) => ({...move,...(stats?{thinkingMs:stats.elapsedMs}:{})})) }
}
export function findMoves(state, color, mode, offset = 0, limit = 24) {
  if (!COLORS.includes(color) || !['attack', 'defend', 'legal'].includes(mode)) throw new Error('invalid color/mode')
  if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 80) throw new Error('invalid pagination')
  const board = boardOf(state), enemy = other(color)
  const threatened = simulate(board, enemy).hits.includes(color), candidates = []
  for (const action of options(board)) {
    if (validate(board, action, color)) continue
    put(board, action, color)
    const ours = simulate(board, color), theirs = simulate(board, enemy)
    const safe = !theirs.hits.includes(color), attacks = ours.hits.includes(enemy)
    if (mode === 'legal' || (mode === 'attack' && safe && attacks) || (mode === 'defend' && threatened && safe)) {
      candidates.push({ action, safe, attacks, attackPath: attacks ? compactPath(ours.hitPaths[enemy]) : null })
    }
    remove(board, action)
  }
  candidates.sort((a, b) => Number(b.safe) - Number(a.safe) || Number(b.attacks) - Number(a.attacks)
    || Number(b.action.kind === 'diag') - Number(a.action.kind === 'diag') || moveId(a.action).localeCompare(moveId(b.action)))
  return { revision: state.revision, color, mode, threatened, total: candidates.length, offset,
    nextOffset: offset + limit < candidates.length ? offset + limit : null,
    note: '这是精确的一手枚举，不代表长期优劣。safe 仅表示不会被对方现有光束立即击败。',
    candidates: candidates.slice(offset, offset + limit) }
}
export function variation(state, sequence) {
  if (!Array.isArray(sequence) || sequence.length < 1 || sequence.length > 8) throw new Error('sequence must contain 1..8 alternating moves')
  let hypothetical = structuredClone(state)
  const steps = []
  for (const action of sequence) {
    const color = hypothetical.current
    try { hypothetical = advance(hypothetical, action, 'hypothetical', 'analysis') }
    catch (error) { return { valid: false, step: steps.length + 1, color, error: error.message, steps } }
    steps.push({ color, action, current: hypothetical.current, winner: hypothetical.winner,
      hits: Object.fromEntries(COLORS.map(c => [c, simulate(boardOf(hypothetical), c).hits])) })
    if (hypothetical.winner) break
  }
  return { valid: true, steps, position: position(hypothetical) }
}

export function aiRequest(state) {
  const n = state.size, horizontal = Array(n*(n+1)).fill(0), vertical = Array(n*(n+1)).fill(0), diagonals = Array(n*n).fill(0)
  for (const [id, m] of state.edges) {
    const [axis, x, y] = id.split(':'); (axis === 'h' ? horizontal : vertical)[+y*(axis === 'h' ? n : n+1)+ +x] = COLORS.indexOf(m.color)+1
  }
  for (const [cell, m] of state.diags) { const [x,y]=cell.split(',').map(Number); diagonals[y*n+x] = 1+2*COLORS.indexOf(m.color)+Number(m.ori === '\\') }
  return { version: 1, phase: 'play', size: n, players: [0,1], current: COLORS.indexOf(state.current), aliveMask: 3,
    homes: [state.homes.blue, state.homes.red, null, null], horizontal, vertical, diagonals, budgetMs: state.aiBudgetMs }
}
export async function loadEngine(bytes) {
  const { instance: { exports: wasm } } = await WebAssembly.instantiate(bytes, { env: { now_ms: () => performance.now() } })
  return request => {
    const data = new TextEncoder().encode(JSON.stringify(request)), input = wasm.alloc(data.length)
    let output = 0, length = 0
    try {
      new Uint8Array(wasm.memory.buffer, input, data.length).set(data)
      output = wasm.choose_action(input, data.length); length = wasm.result_len()
      return JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, output, length)))
    } finally { wasm.dealloc(input, data.length); if (output) wasm.dealloc(output, length) }
  }
}
export function initGame(directory, wasmPath) {
  if (existsSync(join(directory, 'state.json'))) throw new Error('Game already exists')
  mkdirSync(directory, { recursive: true })
  const bytes = readFileSync(wasmPath)
  writeFileSync(join(directory, 'engine.wasm'), bytes)
  const homes = { blue: {x:2,y:2,dir:0}, red:{x:13,y:13,dir:2} }, edges = []
  for (const color of COLORS) for (let d=0;d<4;d++) if (d!==homes[color].dir) edges.push([edgeOf(homes[color].x,homes[color].y,d),{color}])
  const state = { id: randomUUID(), size: 16, homes, edges, diags: [], current:'blue', winner:null,
    revision:0, ply:0, moves:[], aiBudgetMs:10_000, createdAt:new Date().toISOString(),
    dshRuntime:'DSH native preset / light-chess', engineSha256:createHash('sha256').update(bytes).digest('hex') }
  persist(directory,state)
  record(directory,'game-start',{state, rules:RULES})
  return state
}
export const loadState = directory => JSON.parse(readFileSync(join(directory,'state.json'),'utf8'))
export function persist(directory,state) {
  const file = join(directory,`state.${process.pid}.tmp`)
  writeFileSync(file, JSON.stringify(state,null,2)); renameSync(file,join(directory,'state.json'))
}
export function record(directory,type,detail) {
  appendFileSync(join(directory,'events.jsonl'),JSON.stringify({at:new Date().toISOString(),type,detail})+'\n')
}
export async function play(directory, args, engine) {
  let state = loadState(directory)
  if (args.revision !== state.revision) throw new Error('Stale position: wait for a fresh board from the host')
  if (state.current !== 'blue' || state.winner) throw new Error('Not a live blue turn')
  if (typeof args.rationale !== 'string') throw new Error('Provide your move rationale')
  const before = state
  state = advance(state, args.action, args.rationale, 'dsh')
  record(directory,'move',{move:state.moves.at(-1),before,after:state}); persist(directory,state)
  if (!state.winner) {
    const request = aiRequest(state)
    record(directory,'ai-search-start',{request})
    const result = engine(request)
    record(directory,'ai-search-result',{result})
    if (result.error || !result.action) throw new Error(`Red AI failed: ${result.error ?? 'no action'}`)
    const beforeAI = state
    state = advance(state,result.action,result.stats?.reason ?? '', 'rust-wasm')
    state.moves.at(-1).stats = result.stats
    record(directory,'move',{move:state.moves.at(-1),before:beforeAI,after:state}); persist(directory,state)
  }
  if (state.winner) record(directory,'game-over',{winner:state.winner,ply:state.ply})
  return { ok: true }
}
