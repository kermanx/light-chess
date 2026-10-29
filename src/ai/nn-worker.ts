/**
 * NN 引擎 worker：与 upstream worker.ts 同构（收一条消息、回一条 AiResponse、错误结构化上报），
 * 但接收的是带模型配置的封装消息 { request, nn }。session 按模型 id 缓存——controller 复用
 * worker 时，后续每手不再重复加载权重。
 *
 * 推理全异步（ort wasm EP），不阻塞主线程；controller 以代际号丢弃迟到响应。
 */
import * as ort from 'onnxruntime-web'
import { chooseNnAction, type NnBackend } from './nn-core'
import { isNnModelInfo, loadNnModels, type NnModelInfo } from '../nn/models'
import type { AiRequest, AiResponse } from './protocol'

export interface NnWorkerMessage {
  request: AiRequest
  /** modelsBase 由主线程按 document.baseURI 算出（worker 里无法正确推导相对 base） */
  nn: { modelId: string; stochastic?: boolean; modelsBase: string }
}

// wasm 运行时走 vite 打包进 dist 的本地资产（onnxruntime-web 的 wasm 以 new URL 资产引用，
// vite 自动产出带指纹的本地文件），不走 CDN。
// 单线程：避免 SharedArrayBuffer/跨源隔离要求（GitHub Pages 等静态托管可直接部署）
ort.env.wasm.numThreads = 1

const sessions = new Map<string, Promise<{ backend: NnBackend; model: NnModelInfo }>>()

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`模型文件加载失败（HTTP ${r.status}）：${url}`)
  return new Uint8Array(await r.arrayBuffer())
}

function loadSession(modelId: string, modelsBase: string): Promise<{ backend: NnBackend; model: NnModelInfo }> {
  const key = `${modelsBase}|${modelId}`
  let pending = sessions.get(key)
  if (!pending) {
    pending = (async () => {
      const list = await loadNnModels(modelsBase)
      const model = list.find((m) => m.id === modelId)
      if (!model || !isNnModelInfo(model)) throw new Error(`未知 NN 模型：${modelId}`)
      const [onnx, data] = await Promise.all([
        fetchBytes(`${modelsBase}${model.file}`),
        fetchBytes(`${modelsBase}${model.dataFile}`),
      ])
      const session = await ort.InferenceSession.create(onnx, {
        // 权重在 .onnx.data 外部文件里，必须成对提供
        externalData: [{ path: model.dataFile, data }],
        executionProviders: ['wasm'],
      })
      const backend: NnBackend = {
        async run(features, channels, size) {
          const input = new ort.Tensor('float32', features, [1, channels, size, size])
          const out = await session.run({ x: input })
          return {
            policy: out.policy.data as Float32Array,
            value: (out.value.data as Float32Array)[0],
          }
        },
      }
      return { backend, model }
    })()
    pending.catch(() => sessions.delete(key)) // 失败不缓存，允许重试
    sessions.set(key, pending)
  }
  return pending
}

self.onmessage = async (event: MessageEvent<NnWorkerMessage>) => {
  let result: AiResponse
  try {
    const { request, nn } = event.data
    if (!request || request.version !== 1 || !nn?.modelId || !nn.modelsBase) throw new Error('NN 引擎收到了无效请求')
    const { backend, model } = await loadSession(nn.modelId, nn.modelsBase)
    if (model.boardSize !== request.size) {
      throw new Error(`模型 ${model.name} 只支持 ${model.boardSize}×${model.boardSize}，当前棋盘 ${request.size}×${request.size}`)
    }
    result = await chooseNnAction(backend, request, {
      featureVersion: model.featureVersion,
      stochastic: nn.stochastic,
      modelName: model.name,
    })
  } catch (error) {
    result = { action: null, error: error instanceof Error ? error.message : String(error) }
  }
  self.postMessage(result)
}
