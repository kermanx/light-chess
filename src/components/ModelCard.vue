<script setup lang="ts">
import { computed } from 'vue'
import type { ModelInfo } from '../ai'

const props = defineProps<{
  model: ModelInfo
  /** 当前选中的完整 id（run/genN），可选中该卡的任意一代 */
  selectedId: string
}>()
const emit = defineEmits<{ select: [id: string] }>()

const selected = computed(() => props.model.gens.some((g) => g.id === props.selectedId))
/** 该卡当前选中代（未选中卡时展示最新代） */
const shownGenId = computed(() =>
  selected.value ? props.selectedId : props.model.id,
)
const pct = (v: number | null) => (v === null ? '—' : `${(v * 100).toFixed(1)}%`)
</script>

<template>
  <div class="model-card" :class="{ selected, recommended: model.recommended }" @click="emit('select', shownGenId)">
    <div class="mc-head">
      <span class="mc-name">{{ model.name }}</span>
      <span v-if="model.recommended" class="mc-badge">推荐</span>
    </div>
    <p class="mc-recipe">{{ model.recipe }}</p>
    <div class="mc-meta">
      <span>{{ model.size ?? '?' }}×{{ model.size ?? '?' }} 棋盘</span>
      <span>vs random {{ pct(model.eval_random) }}</span>
      <span v-if="model.eval_vs_prev !== null">vs 前代 {{ pct(model.eval_vs_prev) }}</span>
    </div>
    <label class="mc-gen" @click.stop>
      代数
      <select :value="shownGenId" @change="emit('select', ($event.target as HTMLSelectElement).value)">
        <option v-for="g in [...model.gens].reverse()" :key="g.id" :value="g.id">
          gen{{ g.gen }}{{ g.eval !== null ? ` · ${(g.eval * 100).toFixed(1)}%` : '' }}
        </option>
      </select>
    </label>
  </div>
</template>

<style scoped>
.model-card {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: #fffdf6;
  border: 2px solid #3d3627;
  border-radius: 10px 3px 12px 3px / 3px 12px 3px 10px;
  box-shadow: 2px 2px 0 rgba(61, 54, 39, 0.2);
  cursor: pointer;
  transition: transform 0.12s ease, box-shadow 0.12s ease;
  text-align: left;
}
.model-card:hover {
  transform: translate(-1px, -1px);
  box-shadow: 3px 3px 0 rgba(61, 54, 39, 0.25);
}
.model-card.selected {
  background: #eaf1ff;
  border-color: #2f6fed;
  box-shadow: 3px 3px 0 rgba(47, 111, 237, 0.3);
}
.mc-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.mc-name {
  font-weight: 700;
  font-size: 14px;
  color: #35301f;
}
.mc-badge {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 8px;
  background: #2f6fed;
  color: #fff;
  white-space: nowrap;
}
.mc-recipe {
  margin: 0;
  font-size: 12px;
  color: #8a7f68;
  line-height: 1.5;
}
.mc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 10px;
  font-size: 12px;
  color: #5c5340;
}
.mc-gen {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: #8a7f68;
}
.mc-gen select {
  padding: 2px 6px;
  font-size: 12px;
  font-family: inherit;
  background: #fffdf6;
  border: 2px solid #3d3627;
  border-radius: 6px;
  outline: none;
  color: #35301f;
  cursor: pointer;
}
</style>
