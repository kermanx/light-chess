<script setup lang="ts">
import { PALETTE, type Color } from '../game'
import { formatTime } from '../clock'
import { clockNow, remainingTime, state } from '../store'
const palette = (color: Color) => PALETTE.find(p => p.id === color)!
const active = (color: Color) => state.phase === 'play' && state.current === color && !state.peerLeft
</script>

<template>
  <section v-if="state.clockSettings.enabled" class="chess-clock" aria-label="棋钟">
    <div class="clock-heading">
      <span>棋钟</span><span>每步 +{{ state.clockSettings.incrementMs / 1000 }} 秒</span>
    </div>
    <div v-for="color in state.players" :key="color" class="clock-row" :data-color="color"
      :class="{ active: active(color), dead: state.dead.includes(color), low: active(color) && remainingTime(color, clockNow) < 20000 }"
      :style="{ '--player-color': palette(color).hex }">
      <span class="clock-player">{{ palette(color).name }}方
        <small v-if="state.timedOut.includes(color)">超时</small>
        <small v-else-if="state.dead.includes(color)">出局</small>
        <small v-else-if="state.winner === color">获胜</small>
        <small v-else-if="active(color)">计时中</small>
      </span>
      <time class="clock-value">{{ formatTime(remainingTime(color, clockNow)) }}</time>
    </div>
    <div v-if="state.phase === 'setup'" class="clock-hint">所有人布置完成后开始计时</div>
    <div v-else-if="state.peerLeft && state.phase === 'play'" class="clock-hint">等待重连，棋钟暂停</div>
  </section>
</template>

<style scoped>
.chess-clock { flex: none; padding: 10px; border: 2px solid #3d3627; border-radius: 9px 5px 8px 6px; background: #fbf6ea; }
.clock-heading { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 12px; color: #6f6552; }
.clock-row { display: flex; justify-content: space-between; align-items: center; padding: 6px 8px; margin-top: 3px; border: 1px solid transparent; border-left: 4px solid var(--player-color); border-radius: 4px; }
.clock-row.active { background: #fff; border-color: var(--player-color); }
.clock-player { color: var(--player-color); font-size: 14px; font-weight: 600; }
.clock-player small { display: block; font-size: 10px; font-weight: 400; }
.clock-value { font: 600 25px/1.15 ui-monospace, monospace; font-variant-numeric: tabular-nums; color: #35301f; }
.clock-row.low .clock-value { color: #b91c1c; }
.clock-row.dead { opacity: .5; }
.clock-hint { margin-top: 7px; font-size: 11px; color: #756950; text-align: center; }
</style>
