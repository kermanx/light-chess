import type { AiRequest, AiResponse } from './protocol'

interface EngineExports {
  memory: WebAssembly.Memory
  alloc(length: number): number
  dealloc(pointer: number, length: number): void
  choose_action(pointer: number, length: number): number
  result_len(): number
}

let engine: Promise<EngineExports> | undefined
async function loadEngine(): Promise<EngineExports> {
  const response = await fetch(new URL('./engine.wasm', import.meta.url))
  if (!response.ok) throw new Error(`AI 引擎加载失败（HTTP ${response.status}）`)
  const { instance } = await WebAssembly.instantiate(await response.arrayBuffer(), {
    env: { now_ms: () => performance.now() },
  })
  const exports = instance.exports as unknown as EngineExports
  if (!(exports.memory instanceof WebAssembly.Memory) ||
    !['alloc', 'dealloc', 'choose_action', 'result_len'].every(key => typeof instance.exports[key] === 'function')) {
    throw new Error('AI 引擎接口不兼容，请刷新页面')
  }
  return exports
}

self.onmessage = async (event: MessageEvent<AiRequest>) => {
  let result: AiResponse
  try {
    const wasm = await (engine ??= loadEngine())
    const input = new TextEncoder().encode(JSON.stringify(event.data))
    const pointer = wasm.alloc(input.length)
    let output = 0, length = 0
    try {
      new Uint8Array(wasm.memory.buffer, pointer, input.length).set(input)
      output = wasm.choose_action(pointer, input.length)
      length = wasm.result_len()
      result = JSON.parse(new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, output, length))) as AiResponse
    } finally {
      wasm.dealloc(pointer, input.length)
      if (output && length) wasm.dealloc(output, length)
    }
  } catch (error) {
    result = { action: null, error: error instanceof Error ? error.message : String(error) }
  }
  self.postMessage(result)
}
