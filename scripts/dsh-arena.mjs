// Native DSH preset player, plus replay initialization, preview and export.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { initGame, loadState, position } from './arena/game.mjs'
import { publishReplay } from './arena/replay.ts'

const arg = name => process.argv[process.argv.indexOf(name)+1]
const directory = resolve(arg('--game') ?? '')
if (!process.argv.includes('--game')) throw new Error('Usage: node scripts/dsh-arena.mjs --init|--run|--watch|--publish --game DIRECTORY [--port 4174]')
if (process.argv.includes('--init')) {
  const wasm = fileURLToPath(new URL('../src/ai/engine.wasm',import.meta.url))
  console.log(JSON.stringify(position(initGame(directory,wasm)),null,2))
} else if (process.argv.includes('--run')) {
  const { prepareArena } = await import('./dsh/build-native.mjs')
  const launch = await prepareArena(directory, {
    model: process.env.DSH_MODEL ?? 'deepseek-flash',
    baseURL: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/anthropic',
  })
  const child = spawn(launch.command, launch.args, { env: launch.env, stdio: 'inherit' })
  const interrupt = () => child.kill('SIGINT'), terminate = () => child.kill('SIGTERM')
  process.once('SIGINT', interrupt); process.once('SIGTERM', terminate)
  const [code, signal] = await once(child, 'exit')
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', terminate)
  process.exitCode = code ?? (signal ? 1 : 0)
} else if (process.argv.includes('--watch')) {
  // The same app, routes and board as normal dev/preview; no separate spectator UI.
  process.env.LIGHT_CHESS_ARENA_DIR = dirname(directory)
  const { preview } = await import('vite')
  const port=process.argv.includes('--port')?Number(arg('--port')):4174
  await preview({ root: fileURLToPath(new URL('..',import.meta.url)), preview: {host:'127.0.0.1',port,strictPort:true} })
  console.log(`Replay in app: http://127.0.0.1:${port}/replay/${loadState(directory).id}`)
} else if (process.argv.includes('--publish')) {
  const game = publishReplay(directory,fileURLToPath(new URL('../public/replays',import.meta.url)))
  console.log(`Published ${game.moves.length} plies, winner ${game.winner}: /replay/${game.id}`)
} else throw new Error('Specify --init, --run, --watch or --publish')
