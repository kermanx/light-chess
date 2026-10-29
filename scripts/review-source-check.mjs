// 复盘数据源检查入口（node scripts/review-source-check.mjs）：
// 实际逻辑在 review-source-check.ts（需要 TS 的 nn-mcts/source），这里用 tsx 拉起。
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const run = spawnSync('npx', ['tsx', join(root, 'scripts/review-source-check.ts')], { cwd: root, stdio: 'inherit' })
if (run.error) {
  console.error(run.error.message)
  process.exit(1)
}
process.exit(run.status ?? 1)
