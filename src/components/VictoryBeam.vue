<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { PALETTE, type Color, type Pt } from '../game'
import type { VictoryReplay } from '../store'

const props = defineProps<{ replay: VictoryReplay; spacing: number; padding: number }>()
const emit = defineEmits<{ impact: [color: Color]; complete: [] }>()
const root = ref<SVGGElement | null>(null)
const elapsed = ref(0)
const reduced = ref(false)
const color = computed(() => PALETTE.find(p => p.id === props.replay.source)!.hex)
const tracks = computed(() => props.replay.targets.map(target => {
  const points = target.path.map(p => ({ x: props.padding + p.x * props.spacing, y: props.padding + p.y * props.spacing }))
  const distances = [0]
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
  }
  return { color: target.color, points, distances, length: distances.at(-1)!, d: points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ') }
}))
const longest = computed(() => Math.max(1, ...tracks.value.map(t => t.length)))
const duration = computed(() => Math.max(1400, Math.min(3200, longest.value / 350 * 1000)))
const travel = computed(() => reduced.value ? longest.value : Math.min(longest.value, elapsed.value / duration.value * longest.value))
const beams = computed(() => tracks.value.map(track => {
  const distance = Math.min(track.length, travel.value)
  let head: Pt = track.points.at(-1)!
  let angle = 0
  for (let i = 1; i < track.points.length; i++) {
    const segment = track.distances[i] - track.distances[i - 1]
    if (distance > track.distances[i] || segment === 0) continue
    const a = track.points[i - 1], b = track.points[i]
    const fraction = Math.max(0, (distance - track.distances[i - 1]) / segment)
    head = { x: a.x + (b.x - a.x) * fraction, y: a.y + (b.y - a.y) * fraction }
    angle = Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI
    break
  }
  const impactAge = elapsed.value - track.length / longest.value * duration.value
  return { ...track, head, angle, distance, arrived: distance >= track.length, impactAge }
}))
let frame = 0
let timer: ReturnType<typeof setTimeout> | undefined
const impacted = new Set<Color>()
function sendImpacts() {
  for (const beam of beams.value) {
    if (beam.arrived && !impacted.has(beam.color)) {
      impacted.add(beam.color)
      emit('impact', beam.color)
    }
  }
}
onMounted(() => {
  root.value?.closest('.board-wrap')?.scrollIntoView({ block: 'center', behavior: 'instant' })
  reduced.value = matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduced.value) {
    sendImpacts()
    timer = setTimeout(() => emit('complete'), 200)
    return
  }
  const started = performance.now()
  const tick = (now: number) => {
    elapsed.value = now - started
    sendImpacts()
    if (elapsed.value >= duration.value + 450) emit('complete')
    else frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)
})
onBeforeUnmount(() => { cancelAnimationFrame(frame); clearTimeout(timer) })
</script>

<template>
  <g ref="root" class="victory-beams" :style="{ color }" aria-label="致胜光路">
    <g v-for="beam in beams" :key="beam.color" :data-target="beam.color">
      <path v-for="layer in ['glow', 'body', 'core']" :key="layer" :d="beam.d" :class="`victory-beam-${layer}`"
        :stroke-dasharray="`${beam.length} ${beam.length}`" :stroke-dashoffset="beam.length - beam.distance"
        vector-effect="non-scaling-stroke" />
      <g v-if="!beam.arrived" class="victory-photon" :transform="`translate(${beam.head.x} ${beam.head.y}) rotate(${beam.angle})`">
        <circle r="9" fill="currentColor" opacity=".25" />
        <circle r="4" fill="white" stroke="currentColor" stroke-width="2" />
        <path d="M-8-4 0 0-8 4" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" />
      </g>
      <circle v-if="beam.arrived && !reduced && beam.impactAge < 450" class="victory-impact"
        :cx="beam.points.at(-1)!.x" :cy="beam.points.at(-1)!.y" :r="7 + Math.max(0, beam.impactAge) / 450 * 22"
        :opacity="1 - Math.max(0, beam.impactAge) / 450" fill="none" stroke="currentColor" stroke-width="3"
        vector-effect="non-scaling-stroke" />
    </g>
  </g>
</template>

<style scoped>
.victory-beams { pointer-events: none; }
.victory-beams path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
.victory-beam-glow { stroke: currentColor; stroke-width: 11; opacity: .24; }
.victory-beam-body { stroke: currentColor; stroke-width: 3.5; }
.victory-beam-core { stroke: #fffdf0; stroke-width: 1.2; }
.victory-photon { filter: drop-shadow(0 0 5px currentColor); }
</style>
