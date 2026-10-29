import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const build = spawnSync('cargo', ['build', '--manifest-path', 'ai/Cargo.toml', '--locked', '--release', '--target', 'wasm32-unknown-unknown', '--lib'], { cwd: root, stdio: 'inherit' })
if (build.error || build.status !== 0) {
  console.error('AI WASM 构建失败。请先安装 Rust，并运行 rustup target add wasm32-unknown-unknown。')
  if (build.error) console.error(build.error.message)
  process.exit(build.status || 1)
}
mkdirSync(join(root, 'src/ai'), { recursive: true })
copyFileSync(join(root, 'ai/target/wasm32-unknown-unknown/release/light_chess_ai.wasm'), join(root, 'src/ai/engine.wasm'))
console.log('AI WASM → src/ai/engine.wasm')
