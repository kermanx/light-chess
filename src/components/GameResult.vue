<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PALETTE, type Color } from '../game'
const props = defineProps<{ winner: Color; timedOut: Color[]; laserWin: boolean; showReview?: boolean }>()
const emit = defineEmits<{ confirm: []; review: [] }>()
const dialog = ref<HTMLDialogElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)
const winner = computed(() => PALETTE.find(p => p.id === props.winner)!)
const timeoutNames = computed(() => props.timedOut.map(c => `${PALETTE.find(p => p.id === c)!.name}方`).join('、'))
onMounted(() => { dialog.value?.showModal(); confirmButton.value?.focus() })
onBeforeUnmount(() => dialog.value?.close())
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="victory-dialog" :aria-label="`${winner.name}方获胜`" @cancel.prevent="emit('confirm')">
      <h2 :style="{ color: winner.hex }">{{ winner.name }}方获胜</h2>
      <p v-if="!laserWin && timedOut.length">{{ timeoutNames }}用时耗尽</p>
      <div class="result-btns">
        <button v-if="showReview" class="btn-plain" @click="emit('review')">复盘分析</button>
        <button ref="confirmButton" class="btn-primary" @click="emit('confirm')">确定</button>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.victory-dialog { width: min(300px, calc(100vw - 32px)); padding: 25px; border: 2px solid #40392d; border-radius: 12px; background: #fbf6ea; text-align: center; color: #35301f; box-shadow: 4px 4px 0 #40392d40; }
.victory-dialog::backdrop { background: #302b232e; }
h2 { margin: 0 0 20px; font-size: 28px; }
p { margin: -5px 0 20px; }
.result-btns { display: flex; gap: 12px; justify-content: center; }
</style>
