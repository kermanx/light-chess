import { mkdir, writeFile, symlink, lstat } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'rolldown'

export async function prepareArena(directory, { model, baseURL }) {
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const source = resolve(process.env.DSH_SOURCE ?? join(root, '../deepseek-harness'))
  const packer = await import(pathToFileURL(join(source, 'packages/experimental/webworker-packer/lib/index.js')).href)
  const output = join(root, '.dsh-build/native'), workspaces = packer.indexWorkspacePackages(source)
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'package.json'), JSON.stringify({ name: '@light-chess/dsh-native', private: true, type: 'module' }))
  // Link only read-only DSH workspace artifacts, without installing anything
  // into the user's DSH checkout or modifying personal profiles/credentials.
  for (const [name, path] of workspaces) {
    const target = join(output, 'node_modules', name)
    await mkdir(dirname(target), { recursive: true })
    try { await lstat(target) } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await symlink(path, target, 'dir')
    }
  }
  await build({ input: join(root, 'scripts/dsh/arena-plugin.mjs'), external: id => id.startsWith('@deepseek-ai/'), platform: 'node', output: { file: join(output, 'arena.js'), format: 'esm' } })
  const home = join(resolve(directory), '.dsh'), profile = join(home, 'profiles/light-chess')
  await mkdir(profile, { recursive: true })
  // A normal CLI profile with one application plugin; capabilities belong to
  // its explicit agent preset. No inherited coding or MCP composition.
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'light-chess-profile', private: true, type: 'module', dsh: { profile: { bundles: [] } } }, null, 2))
  await writeFile(join(profile, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'light-chess-arena', name: pathToFileURL(join(output, 'arena.js')).href, config: { directory: resolve(directory), model, baseURL } }] }], null, 2))
  return { command: process.execPath, args: [join(source, 'apps/cli/lib/bin.js'), 'light-chess'], env: { ...process.env, DSH_HOME: home }, home }
}
