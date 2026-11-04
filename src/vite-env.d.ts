/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 云端复盘分析服务 baseUrl（如 http://host:8931）；未定义时复盘页无云端数据源 */
  readonly VITE_REVIEW_SERVICE_URL?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
