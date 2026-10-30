// NN 引擎检查入口（node scripts/nn-engine-check.mjs）：
// 实际逻辑在 nn-engine-check.ts（需要 TS 的 encoder/nn-core），这里用 tsx 拉起。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const run = spawnSync('npx', ['tsx', join(root, 'scripts/nn-engine-check.ts')], { cwd: root, stdio: 'inherit' })
if (run.error) {
  console.error(run.error.message)
  process.exit(1)
}
process.exit(run.status ?? 1)
