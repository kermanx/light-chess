import type { Color } from './game'
import { newOpeningSeed, normalizeOpeningSettings, validOpening, type OpeningPosition, type OpeningSettings, type OpeningProgress } from './opening'

/** Large boards are checked off the UI thread, before any live game is replaced. */
export async function prepareOpening(settings: OpeningSettings, size: number, players: Color[], boundaryReflects: boolean,
  signal: AbortSignal, progress: (status: OpeningProgress) => void = () => {}): Promise<OpeningPosition | undefined> {
  const config = normalizeOpeningSettings(settings, size, players.length)
  if (!config.enabled) return undefined
  signal.throwIfAborted()
  const worker = new Worker(new URL('./opening-worker.ts', import.meta.url), { type: 'module' })
  return new Promise((resolve, reject) => {
    const close = () => { worker.terminate(); signal.removeEventListener('abort', abort) }
    const abort = () => { close(); reject(new Error('已取消生成局面')) }
    signal.addEventListener('abort', abort, { once: true })
    worker.onerror = () => { close(); reject(new Error('预设局面生成器加载失败，请刷新后重试')) }
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') { progress(data.progress); return }
      close()
      if (data.type === 'error') reject(new Error(data.error))
      else if (!validOpening(data.position, size, players, boundaryReflects, config.mirrorsPerPlayer)) reject(new Error('预设局面校验失败，请重试'))
      else resolve(data.position)
    }
    worker.postMessage({ size, players: [...players], boundaryReflects, mirrorsPerPlayer: config.mirrorsPerPlayer, seed: newOpeningSeed() })
  })
}

export function openingProgressLabel(status: OpeningProgress): string {
  const retry = status.attempt > 1 ? `（重新生成，第 ${status.attempt} 次）` : ''
  return status.stage === 'tactics'
    ? `正在验证首手进攻与防守 · ${status.completed} / ${status.total}${retry}`
    : `正在生成并校验 · 每方 ${status.completed} / ${status.total} 面镜子${retry}`
}
