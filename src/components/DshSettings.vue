<script setup lang="ts">
import { computed, nextTick, reactive, ref } from 'vue'
import { clearDshConfig, deleteDshProfile, dshDefaults, dshProfiles, findDshProfile, saveDshProfile, type DshProfile } from '../ai/config'

const dialog = ref<HTMLDialogElement>()
const opened = ref(false)
const form = reactive<DshProfile>({ ...dshDefaults, id: '', name: '', remember: true })
const baseline = ref('')
const dirty = computed(() => JSON.stringify(form) !== baseline.value)
const message = ref('')
const failed = ref(false)
const showKey = ref(false)
const deleting = ref(false)
const pending = ref<(() => void) | null>(null)
function load(profile?: DshProfile) {
  Object.assign(form, profile ?? { ...dshDefaults, id: '', name: '', remember: true })
  baseline.value = JSON.stringify(form)
  message.value = ''; failed.value = false; showKey.value = false; deleting.value = false
}
async function open() {
  load(dshProfiles[0])
  opened.value = true
  await nextTick()
  dialog.value?.showModal()
}
function guard(action: () => void) {
  if (dirty.value) pending.value = action
  else action()
}
function discard() { const action = pending.value; pending.value = null; action?.() }
function close() { dialog.value?.close(); opened.value = false; pending.value = null }
function save() {
  try {
    form.id = saveDshProfile(form)
    baseline.value = JSON.stringify(form)
    message.value = form.remember ? '已保存，下次打开仍可使用。' : '已应用，仅在本次页面中保留。'
    failed.value = false
  } catch (error) { message.value = (error as Error).message; failed.value = true }
}
function remove() {
  try { deleteDshProfile(form.id); load(dshProfiles[0]) }
  catch (error) { message.value = (error as Error).message; failed.value = true }
}
function clear() {
  try {
    clearDshConfig(form.id); load(findDshProfile(form.id))
    message.value = 'API Key 已清除。'; failed.value = false
  } catch (error) { message.value = (error as Error).message; failed.value = true }
}
function duplicate() {
  const copy = { ...form, id: '', name: `${form.name} 副本` }
  load(); Object.assign(form, copy)
}
</script>

<template>
  <div class="dsh-settings">
    <button class="llm-manage" type="button" @click="open"><span>管理 LLM 配置</span><span class="count">{{ dshProfiles.length }} 份</span><span aria-hidden="true">↗</span></button>
    <Teleport to="body">
      <dialog v-if="opened" ref="dialog" class="llm-dialog" aria-labelledby="llm-title" @cancel.prevent="guard(close)" @click="event => { if (event.target === dialog) guard(close) }">
        <header class="dialog-head"><div><p class="eyebrow">光镜棋 · 模型库</p><h2 id="llm-title">LLM 配置</h2><p>为不同席位选择不同模型，让它们在棋盘上交手。</p></div><button class="icon-btn" aria-label="关闭 LLM 配置" type="button" @click="guard(close)">×</button></header>
        <div class="dialog-body">
          <nav class="profile-list" aria-label="已保存的 LLM 配置">
            <button class="add-btn" type="button" @click="guard(() => load())">＋ 添加配置</button>
            <button v-for="profile in dshProfiles" :key="profile.id" type="button" class="profile-item" :class="{ selected: form.id === profile.id }" :aria-pressed="form.id === profile.id" @click="guard(() => load(profile))">
              <strong>{{ profile.name }}</strong><span>{{ profile.model }}</span><small>{{ profile.apiKey ? '已配置' : '待填写 Key' }}{{ profile.remember ? '' : ' · 仅本次' }}</small>
            </button>
            <p v-if="!dshProfiles.length" class="empty">添加第一份配置后，即可分配给 DSH 席位。</p>
          </nav>
          <form class="profile-editor" @submit.prevent="save">
            <div class="editor-heading"><h3>{{ form.id ? '编辑配置' : '新建配置' }}</h3><span v-if="dirty" class="unsaved">未保存</span><button v-if="form.id" class="text-btn" type="button" @click="guard(duplicate)">复制配置</button></div>
            <label>配置名称<input v-model="form.name" placeholder="例如：DeepSeek · 进攻手" required maxlength="80" autocomplete="off" aria-label="LLM 配置名称" /></label>
            <label>模型<input v-model="form.model" required autocomplete="off" aria-label="DSH 模型" placeholder="deepseek-flash" /></label>
            <label>API 地址<input v-model="form.baseURL" type="url" required autocomplete="off" aria-label="DSH API 地址" placeholder="https://api.deepseek.com/anthropic" /><small>使用 DSH 的 DeepSeek Messages 兼容接口。</small></label>
            <label>API Key<span class="key-field"><input v-model="form.apiKey" :type="showKey ? 'text' : 'password'" required autocomplete="off" spellcheck="false" aria-label="DSH API Key" placeholder="输入 API Key" /><button class="text-btn" type="button" :aria-label="showKey ? '隐藏 API Key' : '显示 API Key'" @click="showKey = !showKey">{{ showKey ? '隐藏' : '显示' }}</button></span></label>
            <label class="remember"><input v-model="form.remember" type="checkbox" />记住 API 配置（包括 Key）</label>
            <p class="privacy">配置保存在此浏览器。Key 不写入棋局记录，也不发送给其他玩家。模型请求可能产生 API 费用。</p>
            <p v-if="message" :class="['message', { failed }]" role="status">{{ message }}</p>
            <div v-if="pending" class="confirmation" role="alert"><p>当前修改还未保存，要放弃吗？</p><button class="text-btn" type="button" @click="pending = null">继续编辑</button><button class="text-btn danger" type="button" @click="discard">放弃更改</button></div>
            <div v-else-if="deleting" class="confirmation" role="alert"><p>删除「{{ form.name }}」？正在使用它的席位需要重新选择配置。</p><button class="text-btn" type="button" @click="deleting = false">取消</button><button class="text-btn danger" type="button" @click="remove">确认删除</button></div>
            <footer class="editor-actions"><div><button v-if="form.id" class="text-btn danger" type="button" @click="deleting = true">删除配置</button><button v-if="form.id && form.apiKey" class="text-btn" type="button" @click="guard(clear)">清除 Key</button></div><button class="save-btn" type="submit">保存配置</button></footer>
          </form>
        </div>
        <footer class="dialog-foot"><span>保存后，在每个 DSH 席位下选择要使用的配置。</span><button class="done-btn" type="button" @click="guard(close)">完成</button></footer>
      </dialog>
    </Teleport>
  </div>
</template>

<style scoped>
.llm-manage { width: 100%; display: flex; align-items: center; gap: 9px; padding: 10px 12px; border: 1px solid #b7aa8d; border-radius: 8px; background: #fffaf0; color: #453d2e; cursor: pointer; font: inherit; font-size: 13px; }
.count { margin-left: auto; color: #8a7f68; font-size: 12px; }
.llm-dialog { width: min(790px, calc(100vw - 32px)); max-height: calc(100dvh - 40px); padding: 0; border: 1px solid #bcaf94; border-radius: 18px; background: #fffcf5; color: #35301f; box-shadow: 0 24px 90px #29241355; font-family: 'PingFang SC', 'Microsoft YaHei', system-ui, sans-serif; }
.llm-dialog::backdrop { background: #302a205c; backdrop-filter: blur(4px); }
.dialog-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; padding: 25px 28px 22px; border-bottom: 1px solid #e6dfd0; }
h2, h3, p { margin: 0; }
h2 { margin: 5px 0 8px; font-size: 25px; letter-spacing: -.6px; } h3 { font-size: 15px; }
.eyebrow { color: #9a8660; font-size: 11px; letter-spacing: 2px; }
.dialog-head p:not(.eyebrow) { color: #827660; font-size: 12px; line-height: 1.6; }
.icon-btn { width: 32px; height: 32px; padding: 0; border: 0; border-radius: 50%; background: #efe9dc; color: #766b56; font-size: 24px; cursor: pointer; }
.dialog-body { display: grid; grid-template-columns: 210px minmax(0, 1fr); }
.profile-list { padding: 20px 14px; border-right: 1px solid #e6dfd0; background: #f5f0e5; overflow-wrap: anywhere; }
.add-btn { width: 100%; padding: 10px; margin-bottom: 13px; border: 1px dashed #baa981; border-radius: 8px; color: #746246; background: transparent; cursor: pointer; font-size: 12px; }
.profile-item { display: flex; flex-direction: column; width: 100%; text-align: left; gap: 5px; padding: 12px; margin: 5px 0; border: 1px solid transparent; border-radius: 9px; background: transparent; cursor: pointer; color: #635740; }
.profile-item.selected { background: #fffdf8; border-color: #c6b68f; box-shadow: 0 2px 5px #50402109; }
.profile-item strong { font-size: 13px; font-weight: 600; } .profile-item span { font-size: 11px; color: #8a7f68; } .profile-item small { font-size: 10px; color: #8d805f; }
.profile-editor { min-width: 0; padding: 23px 28px; }
.editor-heading { display: flex; align-items: center; gap: 10px; margin-bottom: 18px; }
.editor-heading .text-btn { margin-left: auto; } .unsaved { font-size: 10px; color: #9b7840; }
label { display: flex; flex-direction: column; gap: 7px; margin: 13px 0; color: #625744; font-size: 12px; }
input:not([type=checkbox]) { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px 11px; border: 1px solid #d4cbb8; border-radius: 7px; background: #fffefa; color: #35301f; font: 13px system-ui, sans-serif; }
input:focus-visible, button:focus-visible { outline: 2px solid #2f6fed; outline-offset: 2px; }
small, .privacy, .empty { font-size: 11px; color: #978a72; line-height: 1.6; }
.key-field { display: flex; align-items: center; gap: 8px; } .key-field input { flex: 1; } .key-field .text-btn { flex-shrink: 0; }
.remember { flex-direction: row; align-items: center; margin: 16px 0 7px; gap: 6px; } input[type=checkbox] { accent-color: #2f6fed; }
.text-btn { padding: 4px; border: 0; background: transparent; color: #7e6d4c; cursor: pointer; font-size: 11px; }
.danger { color: #ad5546; } .text-btn:hover { text-decoration: underline; }
.editor-actions { display: flex; justify-content: space-between; gap: 12px; align-items: center; margin-top: 22px; }
.save-btn, .done-btn { border: 0; border-radius: 8px; padding: 10px 17px; cursor: pointer; font-size: 12px; }
.save-btn { background: #2f6fed; color: white; } .done-btn { background: #eae3d4; color: #65573c; }
.message { font-size: 12px; color: #31704e; margin-top: 12px; line-height: 1.6; } .message.failed { color: #b5372d; }
.confirmation { padding: 12px; margin-top: 14px; border: 1px solid #dcc9a5; background: #fff5e2; border-radius: 8px; font-size: 12px; line-height: 1.6; }
.confirmation button { margin: 7px 10px 0 0; }
.dialog-foot { padding: 15px 28px; border-top: 1px solid #e6dfd0; display: flex; align-items: center; justify-content: space-between; gap: 12px; font-size: 11px; color: #8a7f68; }
@media (max-width: 600px) {
  .llm-dialog { width: calc(100vw - 20px); max-height: calc(100dvh - 20px); border-radius: 12px; }
  .dialog-head { padding: 20px; } .dialog-body { display: block; }
  .profile-list { border-right: 0; border-bottom: 1px solid #e6dfd0; padding: 12px; display: flex; gap: 8px; overflow-x: auto; }
  .profile-item { min-width: 135px; width: 135px; margin: 0; } .add-btn { min-width: 100px; width: 100px; margin: 0; }
  .profile-editor { padding: 20px; } .dialog-foot { padding: 14px 20px; }
}
</style>
