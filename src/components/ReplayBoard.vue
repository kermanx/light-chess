<script setup lang="ts">
import { computed } from 'vue'
import { PALETTE, simulate, type Color, type Pt } from '../game'
import type { PlaybackFrame } from '../replay/recording'

const props = defineProps<{ frame: PlaybackFrame; visibleBeams: Color[] }>()
const colors = Object.fromEntries(PALETTE.map(p => [p.id, p.hex]))
const size = computed(() => props.frame.board.size)
const pad = 30, spacing = 28
const u = (v: number) => pad + v * spacing
const extent = computed(() => pad * 2 + size.value * spacing)
const dots = computed(() => Array.from({ length: (size.value + 1) ** 2 }, (_, i) => ({ x: i % (size.value + 1), y: Math.floor(i / (size.value + 1)) })))
const beams = computed(() => props.visibleBeams.filter(c => !props.frame.dead?.includes(c)).map(color => ({ color, ...simulate(props.frame.board, color) })))
const last = computed(() => props.frame.move?.action)
const segments = (points: Pt[]) => points.map(p => `${u(p.x)},${u(p.y)}`).join(' ')
function edge(id: string) {
  const [axis, xs, ys] = id.split(':'), x = Number(xs), y = Number(ys)
  return { x1: u(x), y1: u(y), x2: u(x + (axis === 'h' ? 1 : 0)), y2: u(y + (axis === 'v' ? 1 : 0)) }
}
function diag(key: string, ori: string) {
  const [x, y] = key.split(',').map(Number)
  return { x1: u(x), x2: u(x + 1), y1: u(y + (ori === '/' ? 1 : 0)), y2: u(y + (ori === '/' ? 0 : 1)) }
}
const lastEdge = (id: string) => last.value?.kind === 'edge' && last.value.id === id
const lastDiag = (key: string) => last.value?.kind === 'diag' && `${last.value.x},${last.value.y}` === key
</script>

<template>
  <div class="paper replay-board">
    <svg class="board-svg" :viewBox="`0 0 ${extent} ${extent}`" role="img" aria-label="历史棋盘，只读">
      <g class="coordinates">
        <template v-for="i in size" :key="i">
          <text :x="u(i - 0.5)" y="17" text-anchor="middle">{{ i - 1 }}</text>
          <text x="13" :y="u(i - 0.5) + 3" text-anchor="middle">{{ i - 1 }}</text>
        </template>
      </g>
      <circle v-for="p in dots" :key="`${p.x},${p.y}`" :cx="u(p.x)" :cy="u(p.y)" r="1.6" fill="#b1a589" />
      <g v-for="beam in beams" :key="beam.color" :data-beam="beam.color" :stroke="colors[beam.color]" fill="none">
        <line v-for="([a, b], i) in beam.segments" :key="i" :x1="u(a.x)" :y1="u(a.y)" :x2="u(b.x)" :y2="u(b.y)" stroke-width="1.1" opacity="0.4" />
        <polyline v-if="frame.winner === beam.color && beam.hitPath" :points="segments(beam.hitPath)" stroke-width="2.6" />
      </g>
      <g stroke-linecap="round">
        <template v-for="[id, mirror] in frame.board.edges" :key="id">
          <line v-if="lastEdge(id)" v-bind="edge(id)" stroke="#e9bb53" stroke-width="8" opacity="0.7" />
          <line v-bind="edge(id)" :stroke="colors[mirror.color]" stroke-width="2.6" :data-edge="id" :data-last="lastEdge(id) || undefined" />
        </template>
        <template v-for="[key, mirror] in frame.board.diags" :key="key">
          <line v-if="lastDiag(key)" v-bind="diag(key, mirror.ori)" stroke="#e9bb53" stroke-width="8" opacity="0.7" />
          <line v-bind="diag(key, mirror.ori)" :stroke="colors[mirror.color]" stroke-width="2.6" :data-diag="key" :data-ori="mirror.ori" :data-last="lastDiag(key) || undefined" />
        </template>
      </g>
      <template v-for="(home, color) in frame.board.homes" :key="color">
        <circle v-if="home" :cx="u(home.x + 0.5)" :cy="u(home.y + 0.5)" r="5.8" :fill="colors[color]" />
        <text v-if="home && frame.dead?.includes(color)" :x="u(home.x + 0.5)" :y="u(home.y + 0.5) + 4" text-anchor="middle" fill="white" font-size="13" :data-eliminated="color">×</text>
      </template>
    </svg>
  </div>
</template>

<style scoped>
.replay-board { width: 100%; border-radius: 22px 12px 26px 12px / 12px 26px 12px 22px; }
svg { display: block; width: 100%; height: auto; }
.coordinates { font: 9px ui-monospace, monospace; fill: #8a7f68; }
</style>
