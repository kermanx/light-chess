import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadState, loadEngine, aiRequest, play } from './game.mjs'
import { analyze, moveRationale } from '../dsh-browser/tools.ts'

export async function createArenaTools(directory) {
  const engine = await loadEngine(readFileSync(join(directory, 'engine.wasm')))
  // Bind both tools to the board supplied in this turn's message. The host
  // creates a fresh pair next turn; model arguments cannot override revision.
  const state = loadState(directory), request = aiRequest(state)
  let chosen = false
  return {
    analyze: args => {
      if (state.winner) throw new Error('Game already finished')
      return analyze(request, args)
    },
    play: async args => {
      if (chosen) throw new Error('A move has already been selected')
      const result = await play(directory, { action: args.action, rationale: moveRationale(args.rationale), revision: state.revision }, engine)
      chosen = true
      return result
    },
  }
}
