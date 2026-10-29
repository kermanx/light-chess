import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { aiTestRecorder } from './scripts/ai-test-recorder.ts'

const digest = (files: string[]) => {
  const hash = createHash('sha256')
  for (const file of files) {
    try { hash.update(readFileSync(new URL(file, import.meta.url))) } catch { hash.update('unavailable') }
  }
  return hash.digest('hex')
}

// https://vite.dev/config/
export default defineConfig({
  // 相对路径产物：可部署到 GitHub Pages 项目页（/<repo>/）等任意子路径
  base: './',
  build: {
    // A tab creates Workers lazily, including on later turns. Keep its hashed
    // JS/WASM assets available when rebuilding under a running local preview.
    // CI still starts from a clean checkout/output directory.
    emptyOutDir: false,
  },
  plugins: [vue(), aiTestRecorder()],
  define: {
    __AI_TEST_BUILD__: JSON.stringify({
      builtAt: new Date().toISOString(),
      engineSha256: digest(['./src/ai/engine.wasm']),
      rulesSha256: digest(['./src/game.ts', './src/store.ts', './src/ai/protocol.ts', './src/ai/controller.ts']),
    }),
  },
  server: {
    // 监听所有网卡（局域网可访问）；隧道场景下放行任意 Host 头
    host: true,
    allowedHosts: true,
  },
})
