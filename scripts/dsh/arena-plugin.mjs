// Native DSH profile entry. The CLI owns process startup/shutdown; the shared
// runtime mounts the light-chess preset, exactly as in the browser Worker.
import { openSync, closeSync, unlinkSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createChessPlayer } from './runtime.mjs'
import { createArenaTools } from '../arena/tools.mjs'
import { loadState, position, record, RULES } from '../arena/game.mjs'

export const name = 'light-chess-arena'
export const inject = ['appReady', 'appExit']

export function apply(host, config) {
  let player
  host.effect(() => () => player?.dispose())
  host.effect(() => host.appReady.onReady(() => { void run().then(() => host.appExit(0), error => {
    const message = String(error.message ?? error).split(process.env.DEEPSEEK_API_KEY || '\0').join('[redacted]')
    process.stderr.write(`Light chess: ${message}\n`)
    host.appExit(1)
  }) }))
  async function run() {
    const directory = config.directory, lock = join(directory, 'player.lock')
    // Exclusive ownership: launching a second runner must not advance a game.
    const fd = openSync(lock, 'wx')
    closeSync(fd)
    host.effect(() => () => unlinkSync(lock))
    let game = await createArenaTools(directory), selected = false
    const playCalls = new Set()
    if (loadState(directory).winner) throw new Error('Game already finished')
    const metadata = { runtime: 'DSH native preset', preset: 'light-chess', model: config.model, baseURL: config.baseURL, resumedAtPly: loadState(directory).ply }
    record(directory, 'dsh-run-start', metadata)
    player = await createChessPlayer({
      game: { analyze: args => game.analyze(args), play: args => game.play(args) },
      rules: RULES, mode: 'arena', config: { ...config, apiKey: process.env.DEEPSEEK_API_KEY },
      onSessionEvent(sessionId, event) {
        appendFileSync(join(directory, 'dsh-session.jsonl'), JSON.stringify({ sessionId, event }) + '\n')
        if (event.type === 'tool/call' && event.data.name === 'play') playCalls.add(event.data.callId)
        // Stop only after the acknowledgement is durable. The next turn gets
        // a fresh host message, rather than a board hidden in the tool result.
        if (selected && event.type === 'tool/result' && playCalls.has(event.data.message.source?.callId)) player.agent.cancel({ kind: 'parent' })
      },
      onTool(kind, { name, args, result }) {
        if (kind === 'call') record(directory, 'tool-call', { name, args, revision: loadState(directory).revision })
        else record(directory, result?.error ? 'tool-error' : 'tool-result', { name, value: result })
      },
      afterTool(name, result) {
        if (name !== 'play' || !result.ok) return
        selected = true
        const state = loadState(directory)
        process.stdout.write(JSON.stringify({ type: 'position', gameId: state.id, ply: state.ply, winner: state.winner }) + '\n')
      },
    })
    process.stdout.write(JSON.stringify({ type: 'ready', ...metadata }) + '\n')
    while (!loadState(directory).winner) {
      game = await createArenaTools(directory)
      selected = false
      playCalls.clear()
      const before = position(loadState(directory))
      await player.turn(`你执蓝，对抗红方 Rust/WASM AI。本轮只选择一手，使用 play 落子。不要自行判和、文字认输或询问是否继续；找不到防守也要提交合法手让规则结算。当前权威棋盘：\n${JSON.stringify(before)}`)
      const after = position(loadState(directory))
      if (!after.winner && after.revision === before.revision) {
        const ended = player.agent.session.snapshotEvents().findLast(e => e.type === 'turn/end')
        throw new Error(`DSH stopped without advancing the game: ${JSON.stringify(ended?.data?.reason)}`)
      }
    }
    record(directory, 'dsh-run-end', { winner: loadState(directory).winner, ply: loadState(directory).ply })
  }
}
