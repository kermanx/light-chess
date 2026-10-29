import { generateOpening, type OpeningPosition } from './opening'

self.onmessage = (event: MessageEvent<Omit<OpeningPosition, 'homes' | 'edges' | 'diags'>>) => {
  const config = event.data
  try {
    const board = generateOpening(config.size, config.players, config.boundaryReflects, config.mirrorsPerPlayer, config.seed,
      progress => self.postMessage({ type: 'progress', progress }))
    self.postMessage({ type: 'result', position: { ...config, homes: board.homes, edges: [...board.edges], diags: [...board.diags] } })
  } catch (error) { self.postMessage({ type: 'error', error: error instanceof Error ? error.message : String(error) }) }
}
