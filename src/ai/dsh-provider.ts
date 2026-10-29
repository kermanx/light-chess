import type { AiWorkerRequest } from './providers'

/** Adapt the stock DSH Worker handshake to the same request/result interface
 * as WASM. The agent, its tools and all game simulation run in that Worker. */
export function createDshWorker(): Worker {
  const channel = new EventTarget()
  let worker: Worker | null = null, stopped = false
  let bootTimeout: ReturnType<typeof setTimeout> | undefined
  const loading = new AbortController()
  const adapter = {
    onmessage: null as Worker['onmessage'], onerror: null as Worker['onerror'], onmessageerror: null as Worker['onmessageerror'],
    addEventListener: channel.addEventListener.bind(channel), removeEventListener: channel.removeEventListener.bind(channel), dispatchEvent: channel.dispatchEvent.bind(channel),
    terminate() { stopped = true; clearTimeout(bootTimeout); loading.abort(); worker?.terminate(); worker = null },
    postMessage(request: AiWorkerRequest) {
      const send = (data: unknown) => {
        if (stopped) return
        const event = new MessageEvent('message', { data })
        adapter.onmessage?.call(adapter as Worker, event)
        channel.dispatchEvent(event)
      }
      void (async () => {
        bootTimeout = setTimeout(() => {
          send({ action: null, error: 'DSH 浏览器核心加载超时，请检查网络后重试' })
          adapter.terminate()
        }, 60_000)
        send({ type: 'progress', message: '正在加载 DSH 浏览器核心…' })
        // Resolve against Vite's base rather than the current /ai-test/:id route.
        const base = new URL(import.meta.env.DEV ? '../../' : '../', import.meta.url)
        const root = new URL('dsh/', base)
        const response = await fetch(new URL('manifest.json', root), { cache: 'no-cache', signal: loading.signal })
        if (!response.ok || !response.headers.get('content-type')?.includes('json')) throw new Error('DSH 浏览器资源未构建，请运行 npm run build:dsh')
        const manifest = await response.json() as { worker: string; image: string }
        if (!/^worker-[a-f0-9]+\.js$/.test(manifest.worker) || !/^image-[a-f0-9]+\.bin$/.test(manifest.image)) throw new Error('DSH 资源清单无效')
        send({ type: 'progress', message: '正在启动 DSH 浏览器核心…', detail: { runtime: manifest } })
        if (stopped) return
        worker = new Worker(new URL(manifest.worker, root), { type: 'module' })
        worker.onerror = event => { send({ action: null, error: event.message || 'DSH 浏览器核心加载失败' }) }
        worker.onmessage = event => {
          const data = event.data
          if (data?.channel !== 'light-chess') {
            if (data?.t === 'res' && ['boot', 'choose'].includes(data.id) && data.status >= 400) send({ action: null, error: String(data.message ?? 'DSH 初始化失败') })
            return
          }
          if (data.type === 'ready') {
            clearTimeout(bootTimeout)
            const body = new TextEncoder().encode(JSON.stringify(request)).buffer
            worker?.postMessage({ t: 'req', id: 'choose', method: 'POST', url: '/light-chess/choose', headers: { 'content-type': 'application/json' }, body }, [body])
          }
          else if (data.type === 'result') send(data.result)
          else if (data.type === 'progress') send({ type: 'progress', message: data.message, detail: data.detail })
          else if (data.type === 'trajectory') send({ type: 'trajectory', payload: data.payload })
        }
        worker.postMessage({ t: 'init', image: new URL(manifest.image, root).href, overlays: [] })
        worker.postMessage({ t: 'req', id: 'boot', method: 'GET', url: '/__boot__', headers: {} })
      })().catch(error => {
        clearTimeout(bootTimeout)
        send({ action: null, error: error instanceof Error ? error.message : String(error) })
      })
    },
  }
  return adapter as Worker
}
