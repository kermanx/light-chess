import { PALETTE, type Color, type Diag, type Home, type Mirror } from '../game.ts'
import type { ClockSettings } from '../clock.ts'
import type { Action, Phase, Snapshot } from '../store.ts'
import { describeMove, replayFrames, type ReplayAction, type ReplayDocument, type ReplayFrame } from './model.ts'

/** Only public game data. No room IDs, connection settings, credentials or model transcripts. */
export interface RecordedPosition {
  size: number
  boundaryReflects: boolean
  laserAllowed: boolean
  homes: Partial<Record<Color, Home>>
  edges: [string, Mirror][]
  diags: [string, Diag][]
  phase: Phase
  current: Color
  winner: Color | null
  dead: Color[]
  timedOut: Color[]
  actors: Partial<Record<Color, string>>
  clock: { settings: ClockSettings; remaining: Partial<Record<Color, number>> } | null
}
export type PositionPatch = Partial<Omit<RecordedPosition, 'edges' | 'diags'>> & {
  edges?: [string, Mirror | null][]
  diags?: [string, Diag | null][]
}
export interface RecordedEvent {
  kind: Action['kind'] | 'checkpoint'
  color: Color
  at: string
  label: string
  actor: string
  action?: ReplayAction
  rationale?: string
  thinkingMs?: number
  patch: PositionPatch
}
export interface RecordedGame {
  format: 'light-chess-replay'
  version: 2
  id: string
  title: string
  createdAt: string
  updatedAt: string
  mode: 'local' | 'online'
  players: Color[]
  historyComplete: boolean
  initial: RecordedPosition
  events: RecordedEvent[]
  winner: Color | null
}
export type AnyReplay = ReplayDocument | RecordedGame
export interface GameSummary {
  id: string
  title: string
  createdAt: string
  updatedAt?: string
  plies: number
  winner: Color | null
  phase?: Phase
  historyComplete?: boolean
  source?: 'browser' | 'published' | 'arena'
}
export interface PlaybackFrame extends Omit<ReplayFrame, 'current' | 'winner' | 'move'> {
  current: Color
  winner: Color | null
  move: (Omit<NonNullable<ReplayFrame['move']>, 'color'> & { color: Color }) | null
  phase?: Phase
  dead?: Color[]
  timedOut?: Color[]
  clock?: RecordedPosition['clock']
  actors?: RecordedPosition['actors']
  laserAllowed?: boolean
}
export interface Playback {
  frames: PlaybackFrame[]
  entries: Omit<RecordedEvent, 'patch'>[]
  players: Color[]
  historyComplete: boolean
}
export const playerName = (c: Color) => `${PALETTE.find(p => p.id === c)?.name ?? c}方`
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value))
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

export function recordedPosition(s: Snapshot): RecordedPosition {
  const players = s.players ?? ['blue', 'red']
  return copy({
    size: s.size, boundaryReflects: s.boundaryReflects ?? false, laserAllowed: s.laserAllowed,
    homes: s.homes, edges: s.edges, diags: s.diags,
    phase: s.phase, current: s.current, winner: s.winner,
    dead: s.dead ?? [], timedOut: s.timedOut ?? [],
    actors: Object.fromEntries(players.map(c => [c, s.aiPlayers?.includes(c) ? s.aiProviders?.[c] === 'dsh' ? 'DSH' : '规则 AI' : '人类'])),
    clock: s.clockSettings?.enabled && s.clock ? { settings: s.clockSettings, remaining: s.clock.remaining } : null,
  })
}
export function newRecording(s: Snapshot, options: { id?: string; at?: string; complete?: boolean } = {}): RecordedGame {
  const initial = recordedPosition(s), at = options.at ?? new Date().toISOString()
  const players = s.players ?? ['blue', 'red']
  return {
    format: 'light-chess-replay', version: 2, id: options.id ?? crypto.randomUUID(),
    title: `${s.mode === 'online' ? '联机' : '单机'} · ${players.map(c => `${playerName(c)} ${initial.actors[c]}`).join(' vs ')}`,
    createdAt: at, updatedAt: at, mode: s.mode, players: [...players],
    historyComplete: options.complete ?? true, initial, events: [], winner: s.winner,
  }
}
function mapDiff<T>(before: [string, T][], after: [string, T][]): [string, T | null][] {
  const a = new Map(before), b = new Map(after)
  return [...new Set([...a.keys(), ...b.keys()])].flatMap(key => same(a.get(key), b.get(key)) ? [] : [[key, b.get(key) ?? null]])
}
function diff(before: RecordedPosition, after: RecordedPosition): PositionPatch {
  const { edges, diags, ...meta } = after
  const patch: PositionPatch = {}
  for (const key of Object.keys(meta) as (keyof typeof meta)[]) {
    if (!same(before[key], meta[key])) Object.assign(patch, { [key]: meta[key] })
  }
  // Record remaining time at the action, not an extrapolated clock running in the viewer.
  if (after.clock) patch.clock = after.clock
  const changedEdges = mapDiff(before.edges, edges), changedDiags = mapDiff(before.diags, diags)
  if (changedEdges.length) patch.edges = changedEdges
  if (changedDiags.length) patch.diags = changedDiags
  return patch
}
function label(a: Action) {
  if (a.kind === 'diag' || a.kind === 'edge') return describeMove(a)
  if (a.kind === 'setup') return `布置基地 (${a.home.x}, ${a.home.y})，出口向${['右', '下', '左', '上'][a.home.dir]}`
  if (a.kind === 'board-size') return `棋盘调整为 ${a.size} × ${a.size}`
  if (a.kind === 'boundary-setting') return a.enabled ? '开启边界反射' : '关闭边界反射'
  if (a.kind === 'laser-setting') return a.allow ? '允许显示光路' : '禁止显示光路'
  if (a.kind === 'ai-provider-setting') return `${playerName(a.target)}切换为 ${a.provider === 'dsh' ? 'DSH' : '规则 AI'}`
  return ({ undo: '撤回一步', timeout: '棋钟超时', 'clock-setting': '调整棋钟' } as Record<string, string>)[a.kind] ?? a.kind
}
export function appendRecording(game: RecordedGame, before: Snapshot, after: Snapshot, a?: Action, at = new Date().toISOString()): RecordedGame {
  if (a && !['setup', 'diag', 'edge', 'undo', 'timeout', 'board-size', 'boundary-setting', 'clock-setting', 'laser-setting', 'ai-provider-setting'].includes(a.kind)) return game
  const patch = diff(recordedPosition(before), recordedPosition(after))
  // Time passing between logged actions is not a missing move or a replay step.
  if (!a && Object.keys(patch).every(key => key === 'clock')) return game
  if (!Object.keys(patch).length) return game
  const action: ReplayAction | undefined = a?.kind === 'diag' ? { kind: 'diag', x: a.x, y: a.y, ori: a.ori }
    : a?.kind === 'edge' ? { kind: 'edge', id: a.id } : undefined
  const analysis = action ? after.lastMove?.aiAnalysis : undefined
  const color = a?.color ?? after.current
  const event: RecordedEvent = {
    kind: a?.kind ?? 'checkpoint', color, at, label: a ? label(a) : '恢复保存的局面（中间操作缺失）',
    actor: recordedPosition(before).actors[color] ?? '人类', action,
    rationale: analysis?.reason, thinkingMs: analysis?.elapsedMs, patch,
  }
  return { ...game, updatedAt: at, historyComplete: game.historyComplete && !!a, events: [...game.events, event], winner: after.winner }
}
function applyPatch(position: RecordedPosition, patch: PositionPatch): RecordedPosition {
  const update = <T>(entries: [string, T][], changes: [string, T | null][] = []) => {
    const map = new Map(entries)
    for (const [key, value] of changes) { if (value === null) map.delete(key); else map.set(key, value) }
    return [...map]
  }
  return { ...position, ...patch, edges: update(position.edges, patch.edges), diags: update(position.diags, patch.diags) }
}
function validatePosition(p: RecordedPosition, players: Color[]) {
  const fail = () => { throw new Error('无效的回放局面') }
  const color = (c: Color) => players.includes(c)
  if (!Number.isInteger(p.size) || p.size < 2 || p.size > 256 || !color(p.current) || p.winner && !color(p.winner) ||
    !['setup', 'play', 'over'].includes(p.phase) || !Array.isArray(p.dead) || p.dead.some(c => !color(c)) ||
    !Array.isArray(p.timedOut) || p.timedOut.some(c => !color(c)) || typeof p.boundaryReflects !== 'boolean') fail()
  const cell = (v: number) => Number.isInteger(v) && v >= 0 && v < p.size
  for (const [c, h] of Object.entries(p.homes)) if (!color(c as Color) || !cell(h.x) || !cell(h.y) || ![0, 1, 2, 3].includes(h.dir)) fail()
  if (new Set(p.edges.map(([k]) => k)).size !== p.edges.length || new Set(p.diags.map(([k]) => k)).size !== p.diags.length) fail()
  for (const [key, m] of p.edges) {
    if (!/^[hv]:\d+:\d+$/.test(key) || !color(m.color)) fail()
    const [axis, x, y] = key.split(':')
    if (axis === 'h' ? !cell(+x) || +y > p.size : +x > p.size || !cell(+y)) fail()
  }
  for (const [key, m] of p.diags) {
    const xy = key.split(',').map(Number)
    if (!/^\d+,\d+$/.test(key) || !xy.every(cell) || !color(m.color) || !['/', '\\'].includes(m.ori)) fail()
  }
}
export function playback(game: AnyReplay): Playback {
  if (game.version === 1) return {
    frames: replayFrames(game), players: ['blue', 'red'], historyComplete: true,
    entries: game.moves.map(m => ({ ...m, kind: m.action.kind, label: describeMove(m.action), at: m.at ?? game.createdAt })),
  }
  if (game.format !== 'light-chess-replay' || game.version !== 2 || !Array.isArray(game.events) ||
    !Array.isArray(game.players) || game.players.length < 2 || game.players.length > 4 || new Set(game.players).size !== game.players.length ||
    game.players.some(c => !PALETTE.some(p => p.id === c))) throw new Error('不支持的回放格式')
  let position = game.initial
  const frame = (event?: RecordedEvent): PlaybackFrame => {
    validatePosition(position, game.players)
    return { ...position, board: { ...position, edges: new Map(position.edges), diags: new Map(position.diags) },
      move: event?.action ? { color: event.color, actor: event.actor, rationale: event.rationale ?? '', thinkingMs: event.thinkingMs, action: event.action } : null }
  }
  const frames = [frame()]
  for (const event of game.events) {
    if (!game.players.includes(event.color) || typeof event.label !== 'string' || !event.patch) throw new Error('无效的回放操作')
    position = applyPatch(position, event.patch)
    frames.push(frame(event))
  }
  if (game.winner !== position.winner) throw new Error('回放结果与最后局面不一致')
  return { frames, entries: game.events, players: game.players, historyComplete: game.historyComplete }
}
export function recordingSummary(game: RecordedGame): GameSummary {
  return { id: game.id, title: game.title, createdAt: game.createdAt, updatedAt: game.updatedAt,
    plies: game.events.filter(e => e.action).length, winner: game.winner, historyComplete: game.historyComplete,
    phase: game.events.reduce((phase, e) => e.patch.phase ?? phase, game.initial.phase), source: 'browser' }
}

/** A legacy save may be behind its archive (another tab, old build or missing events).
 * Keep the discrepancy explicit instead of replaying a board that never matched the resumed game. */
export function alignRecording(game: RecordedGame, snapshot: Snapshot): RecordedGame {
  const last = game.events.reduce((p, e) => applyPatch(p, e.patch), game.initial)
  const patch = diff(last, recordedPosition(snapshot))
  if (Object.keys(patch).every(key => key === 'clock')) return game
  const at = new Date().toISOString()
  return { ...game, historyComplete: false, winner: snapshot.winner, updatedAt: at, events: [...game.events, {
    kind: 'checkpoint', color: snapshot.current, actor: '', at,
    label: '恢复保存的局面（中间操作缺失）', patch,
  }] }
}
