/**
 * 本地 NN 模型目录：读取 public/models/models.json（随站点静态分发）。
 * Lobby（座位引擎选择）、Game（顶栏模型名标签）与 nn-worker（按 id 加载权重）共用。
 * 权重为 ONNX + 外部数据文件（.onnx.data），onnxruntime-web 以 externalData 选项加载。
 */
import type { FeatureVersion } from './encoder'

export interface NnModelInfo {
  id: string
  name: string
  /** ONNX 结构文件（相对 models/ 目录） */
  file: string
  /** 外部权重数据文件，必须与 file 成对分发 */
  dataFile: string
  boardSize: number
  featureVersion: FeatureVersion
  channels: number
  elo: number
  recommended: boolean
}

/**
 * 模型目录的绝对 URL。vite base 是 './' 相对路径，必须以 document.baseURI 为基准转成绝对地址——
 * worker 里 self.location 指向 worker 脚本本身，直接用相对地址会解析到错误目录。
 * NN worker 不调用本常量，由 controller 在消息里把本值带过去（nn.modelsBase）。
 */
const baseHref =
  typeof document !== 'undefined' ? document.baseURI
    : typeof self !== 'undefined' && self.location ? self.location.href
      : 'http://localhost/'
export const MODELS_BASE = new URL('models/', new URL(import.meta.env?.BASE_URL ?? '/', baseHref)).href

let cache: Promise<NnModelInfo[]> | null = null

/** 加载模型目录；失败结果不缓存（网络抖动后可重试）。base 仅供 worker 显式指定。 */
export function loadNnModels(base: string = MODELS_BASE): Promise<NnModelInfo[]> {
  if (base !== MODELS_BASE) {
    return fetch(`${base}models.json`).then(async (r) => {
      if (!r.ok) throw new Error(`模型目录加载失败（HTTP ${r.status}）`)
      const list = (await r.json()) as NnModelInfo[]
      return Array.isArray(list) ? list : []
    })
  }
  cache ??= fetch(`${MODELS_BASE}models.json`)
    .then(async (r) => {
      if (!r.ok) throw new Error(`模型目录加载失败（HTTP ${r.status}）`)
      const list = (await r.json()) as NnModelInfo[]
      return Array.isArray(list) ? list : []
    })
    .catch((e) => {
      cache = null
      throw e
    })
  return cache
}

export const nnModelsForSize = (list: NnModelInfo[], size: number) =>
  list.filter((m) => m.boardSize === size)

export function isNnModelInfo(value: unknown): value is NnModelInfo {
  if (!value || typeof value !== 'object') return false
  const m = value as Record<string, unknown>
  return typeof m.id === 'string' && typeof m.file === 'string' && typeof m.dataFile === 'string' &&
    Number.isInteger(m.boardSize) && typeof m.featureVersion === 'string' &&
    Number.isInteger(m.channels)
}
