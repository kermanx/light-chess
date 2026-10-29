import { reactive, ref } from 'vue'
import type { DshConfig } from './providers'

const KEY = 'light-chess:llm-profiles'
const LEGACY_KEY = 'light-chess:dsh-connection'
export interface DshProfile extends DshConfig { id: string; name: string; remember: boolean }
export const dshDefaults: DshConfig = { baseURL: 'https://api.deepseek.com/anthropic', model: 'deepseek-flash', apiKey: '' }
const isConfig = (v: any): v is DshConfig & Record<string, unknown> => v && ['baseURL', 'model', 'apiKey'].every(k => typeof v[k] === 'string')
function restored(): DshProfile[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (value?.version === 1 && Array.isArray(value.profiles)) {
      const ids = new Set<string>()
      return value.profiles.filter((p: any) => {
        if (!isConfig(p) || typeof p.id !== 'string' || !p.id || typeof p.name !== 'string' || ids.has(p.id)) return false
        ids.add(p.id); return true
      }).map((p: DshProfile) => ({ id: p.id, name: p.name, baseURL: p.baseURL, model: p.model, apiKey: p.apiKey, remember: true }))
    }
  } catch { /* Keep legacy configuration available when storage is unavailable. */ }
  let legacy: DshConfig | null = null
  for (const storage of [() => localStorage, () => sessionStorage]) {
    try { const value = JSON.parse(storage().getItem(LEGACY_KEY) ?? 'null'); if (isConfig(value)) { legacy = value; break } } catch { /* Try the other copy. */ }
  }
  const profiles = [{ ...dshDefaults, ...legacy, id: 'default', name: legacy?.model || 'DeepSeek', remember: true }]
  if (legacy) {
    try {
      localStorage.setItem(KEY, JSON.stringify({ version: 1, profiles }))
      localStorage.removeItem(LEGACY_KEY); sessionStorage.removeItem(LEGACY_KEY)
    } catch { /* Never remove the old copy until migration is saved. */ }
  }
  return profiles
}
export const dshProfiles = reactive<DshProfile[]>(restored())
// Compatibility for callers that configure a single default connection.
export const dshConnection = reactive({ ...dshDefaults, ...dshProfiles[0], remember: dshProfiles[0]?.remember ?? true })
export const dshConfigRevision = ref(0)
const revisions = reactive<Record<string, number>>({})
export const defaultDshProfileId = () => dshProfiles[0]?.id ?? ''
export const findDshProfile = (id?: string) => dshProfiles.find(p => p.id === (id || defaultDshProfileId()))
/** Changing another seat's config must not cancel the current model's request. */
export const dshConfigToken = (id?: string) => {
  const profile = findDshProfile(id)
  return profile ? `${profile.id}:${revisions[profile.id] ?? 0}` : `missing:${id ?? ''}`
}
function normalized(value: DshConfig): DshConfig {
  const baseURL = value.baseURL.trim().replace(/\/+$/, '')
  const model = value.model.trim(), apiKey = value.apiKey.trim()
  let url: URL
  try { url = new URL(baseURL) } catch { throw new Error('请输入有效的 API 地址') }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址应为 HTTP(S) 地址，不能包含账号、密码或查询参数')
  if (!model) throw new Error('请输入模型名称')
  if (!apiKey) throw new Error('请先配置 API Key')
  return { baseURL, model, apiKey }
}
export function readDshConfig(id?: string): DshConfig {
  const profile = findDshProfile(id)
  if (!profile) throw new Error('此席位的 LLM 配置已删除或未选择，请重新选择配置')
  return normalized(profile)
}
function changed(id: string) {
  revisions[id] = (revisions[id] ?? 0) + 1
  dshConfigRevision.value++
  Object.assign(dshConnection, dshProfiles[0] ?? { ...dshDefaults, remember: true })
  try {
    localStorage.setItem(KEY, JSON.stringify({ version: 1, profiles: dshProfiles.filter(p => p.remember) }))
    localStorage.removeItem(LEGACY_KEY); sessionStorage.removeItem(LEGACY_KEY)
  } catch { throw new Error('修改已在本次页面生效，但浏览器未能保存；刷新后可能恢复旧配置') }
}
export function saveDshProfile(value: DshConfig & { id?: string; name: string; remember?: boolean }): string {
  const name = value.name.trim()
  if (!name) throw new Error('请给配置起一个名称')
  const config = normalized(value)
  const id = value.id || crypto.randomUUID()
  const existing = dshProfiles.find(p => p.id === id)
  const profile = { ...config, id, name, remember: value.remember ?? true }
  if (existing) Object.assign(existing, profile)
  else dshProfiles.push(profile)
  changed(id)
  return id
}
export function deleteDshProfile(id: string) {
  const index = dshProfiles.findIndex(p => p.id === id)
  if (index < 0) return
  dshProfiles.splice(index, 1)
  changed(id)
}
export function saveDshConfig(value: DshConfig, remember = true) {
  return saveDshProfile({ ...value, id: defaultDshProfileId(), name: dshProfiles[0]?.name || value.model, remember })
}
export function clearDshConfig(id = defaultDshProfileId()) {
  const profile = findDshProfile(id)
  if (!profile) return
  profile.apiKey = ''
  changed(id)
}
