<script setup lang="ts">
import { defaultDshProfileId } from '../ai/config'
import { computed } from 'vue'
import { aiTest, exportAiTestGame, startAiTestGame } from '../ai/test-session'
import { aiProviderFor, dispatch, state } from '../store'
import type { AiProvider } from '../ai/providers'
import DshSettings from './DshSettings.vue'
import DshProfileSelect from './DshProfileSelect.vue'
import { appBase } from '../replay/navigation'

function changeProvider(event: Event) {
  dispatch({ kind: 'ai-provider-setting', color: state.players[0], target: 'red', provider: (event.target as HTMLSelectElement).value as AiProvider })
  if (aiProviderFor('red') === 'dsh' && !state.aiProfileIds['red'] && defaultDshProfileId()) {
    dispatch({ kind: 'ai-profile-setting', color: state.players[0], target: 'red', profileId: defaultDshProfileId() })
  }
}

const storageText = computed(() => {
  switch (aiTest.storageStatus) {
    case 'saving': return '正在保存记录…'
    case 'saved': return aiTest.diskPath ? '记录已保存到本地文件' : '记录已保存'
    case 'browser-only': return '记录仅保存在浏览器，可导出备份'
    case 'error': return '保存失败，可导出当前记录'
  }
})
</script>

<template>
  <section class="ai-test-panel" aria-label="AI 测试记录">
    <h2>AI 测试</h2>
    <p class="fixed-rules">16 × 16 · 无棋钟 · 边界反射<br />蓝方人类 · 红方 AI</p>
    <label class="budget-control">AI 实现
      <select :value="aiProviderFor('red')" aria-label="测试 AI 实现" @change="changeProvider">
        <option value="wasm">Rust / WASM</option>
        <option value="dsh">DSH</option>
      </select>
    </label>
    <DshProfileSelect v-if="aiProviderFor('red') === 'dsh'" :model-value="state.aiProfileIds.red" label="红方 LLM 配置" @update:model-value="dispatch({ kind: 'ai-profile-setting', color: state.players[0], target: 'red', profileId: $event })" />
    <DshSettings v-if="aiProviderFor('red') === 'dsh'" />
    <p v-if="aiProviderFor('red') === 'dsh'" class="budget-hint">DSH 持续调用模型与工具，不受 WASM 思考上限限制；可随时取消。</p>
    <label v-else class="budget-control">
      WASM 每步最多思考
      <select v-model.number="state.aiBudgetMs" aria-label="AI 每步思考上限">
        <option :value="3000">3 秒</option>
        <option :value="10000">10 秒</option>
        <option :value="30000">30 秒</option>
      </select>
    </label>
    <p v-if="aiProviderFor('red') === 'wasm'" class="budget-hint">可提前落子；修改上限会重新计算当前搜索。</p>
    <p class="budget-hint">切换实现会取消当前搜索，并记录这次变更。</p>
    <p class="game-id">本局 <code>{{ aiTest.gameId || '准备中' }}</code></p>
    <p class="record-count">已记录 {{ aiTest.moveCount }} 步<span v-if="aiTest.archivedCount"> · 历史 {{ aiTest.archivedCount }} 局</span></p>
    <p class="storage-status" :class="aiTest.storageStatus" role="status" aria-live="polite">
      {{ storageText }}<span v-if="aiTest.pendingCount"> · 待保存 {{ aiTest.pendingCount }} 条</span>
    </p>
    <p v-if="aiTest.storageError" class="storage-error">{{ aiTest.storageError }}</p>
    <p v-if="aiTest.diskPath" class="disk-path">记录位置 <code>{{ aiTest.diskPath }}</code></p>
    <div class="test-actions">
      <button class="btn-plain" @click="startAiTestGame()">新对局</button>
      <button class="btn-plain" :disabled="!aiTest.gameId" @click="exportAiTestGame()">导出当前记录</button>
    </div>
    <p class="archive-hint">新对局会保留旧记录。</p>
    <a :href="`${appBase()}replays`">查看所有对局记录</a>
  </section>
</template>

<style scoped>
.ai-test-panel { display: flex; flex-direction: column; gap: 9px; }
h2 { margin: 0; font-size: 16px; }
p { margin: 0; }
.fixed-rules { font-size: 13px; line-height: 1.7; }
.budget-control { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; font-size: 13px; }
select { padding: 3px 5px; border: 1px solid #9e9278; border-radius: 5px; background: #fffaf0; font: inherit; color: inherit; }
.budget-hint, .archive-hint { color: #8a7f68; font-size: 12px; }
.game-id, .disk-path { color: #8a7f68; font-size: 11px; overflow-wrap: anywhere; }
code { font: inherit; font-family: ui-monospace, monospace; }
.record-count, .storage-status { font-size: 12px; }
.storage-status.saved { color: #287643; }
.storage-status.browser-only { color: #8a6428; }
.storage-status.error, .storage-error { color: #b5372d; }
.storage-error { font-size: 12px; overflow-wrap: anywhere; }
.test-actions { display: flex; flex-wrap: wrap; gap: 7px; }
.test-actions button { padding: 5px 9px; font-size: 12px; }
</style>
