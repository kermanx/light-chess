import { mkdir, readFile, writeFile, copyFile, readdir, unlink } from 'node:fs/promises'
import { resolve, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { build } from 'rolldown'

// Reuse DSH's published-view VFS packer and stock self-contained browser
// Worker. No custom lowering, module loader or agent loop lives in this repo.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(process.env.DSH_SOURCE ?? join(root, '../deepseek-harness'))
const packer = await import(pathToFileURL(join(source, 'packages/experimental/webworker-packer/lib/index.js')).href)
const directory = join(root, '.dsh-build/plugin'), output = join(root, 'public/dsh')
await mkdir(directory, { recursive: true })
await mkdir(output, { recursive: true })
let previous
try { previous = JSON.parse(await readFile(join(output, 'manifest.json'), 'utf8')) }
catch (error) { if (error.code !== 'ENOENT') throw error }
const plugin = '@light-chess/dsh-browser'
const sources = [join(root, 'scripts/dsh-browser/plugin.mjs'), ...(await readdir(join(root, 'scripts/dsh'))).filter(f => f.endsWith('.mjs')).map(f => join(root, 'scripts/dsh', f))]
const code = (await Promise.all(sources.map(p => readFile(p, 'utf8')))).join('\n')
const deps = [...new Set([...code.matchAll(/from '(@deepseek-ai\/[^']+)'/g)].map(m => m[1]))]
await writeFile(join(directory, 'package.json'), JSON.stringify({ name: plugin, version: '1.0.0', type: 'module', main: 'index.js', exports: { '.': './index.js' }, files: ['index.js'], dependencies: Object.fromEntries(deps.map(d => [d, '*'])) }, null, 2))
await build({ input: join(root, 'scripts/dsh-browser/plugin.mjs'), external: id => id.startsWith('@deepseek-ai/'), platform: 'browser', output: { file: join(directory, 'index.js'), format: 'esm' } })
const workspaces = packer.indexWorkspacePackages(source)
workspaces.set(plugin, directory)
console.log('Packing the DSH browser runtime with light-chess tools…')
const packed = packer.packVfsImage({
  profile: 'web', roster: [...packer.profileRoster(source, 'web').roster, plugin], workspaces,
  resolveFrom: join(source, 'apps/cli'), installation: packer.installationManifest(source), configTrees: packer.configTrees(source),
  homePatch: [
    { id: 'session-persistence-jsonl', config: { root: '/dsh/home/sessions', compression: 'none' } },
    { id: 'session-title-llm', disabled: true },
    { insert: [{ id: 'light-chess-browser', name: plugin }] },
  ],
})
if (packed.missing.length) throw new Error(`DSH build products are incomplete: ${packed.missing.join(', ')}`)
const worker = await readFile(join(source, 'packages/experimental/webworker-runtime/lib/worker.js'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex').slice(0, 16)
// .gz is treated as HTTP Content-Encoding by some static servers. The DSH
// runtime needs the gzip bytes themselves, so serve this archive as .bin.
const workerName = `worker-${digest(worker)}.js`, imageName = `image-${digest(packed.image)}.bin`
await writeFile(join(output, imageName), packed.image)
await copyFile(join(source, 'packages/experimental/webworker-runtime/lib/worker.js'), join(output, workerName))
for (const archive of packed.lazyArchives) {
  await mkdir(dirname(join(output, archive.name)), { recursive: true })
  await writeFile(join(output, archive.name), archive.image)
}
await copyFile(join(source, 'LICENSE'), join(output, 'LICENSE.dsh'))
const manifest = { worker: workerName, image: imageName, dshCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), sourceDirty: !!execFileSync('git', ['status', '--porcelain'], { cwd: source, encoding: 'utf8' }).trim(), builtAt: new Date().toISOString() }
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2))
// Retain the previous generation for a page whose manifest fetch raced this
// build; all live engines already hold their image in their own Worker.
const keep = new Set([workerName, imageName, previous?.worker, previous?.image])
for (const file of await readdir(output)) if (/^(image-[a-f0-9]+\.(bin|tar\.gz)|worker-[a-f0-9]+\.js)$/.test(file) && !keep.has(file)) await unlink(join(output, file))
console.log(`DSH image ${(packed.image.length / 1024 / 1024).toFixed(1)} MiB, Worker ${(worker.length / 1024).toFixed(0)} KiB; ${packed.packages.size} packages.`)
