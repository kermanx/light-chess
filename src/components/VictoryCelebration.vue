<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { PALETTE, type Color } from '../game'

const props = defineProps<{ winner: Color; timedOut: Color[] }>()
const emit = defineEmits<{ confirm: [] }>()
const palette = computed(() => PALETTE.find(p => p.id === props.winner)!)
const timeoutNames = computed(() => props.timedOut.map(c => `${PALETTE.find(p => p.id === c)!.name}方`).join('、'))
const dialog = ref<HTMLDialogElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)
const ready = ref(false)
const reduced = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let previousOverflow = ''
const confetti = Array.from({ length: 30 }, (_, i) => {
  const angle = (i * 137.5) * Math.PI / 180
  const distance = 90 + (i % 5) * 18
  return {
    '--dx': `${Math.cos(angle) * distance}px`,
    '--dy': `${Math.sin(angle) * distance - 25}px`,
    '--spin': `${(i % 2 ? 1 : -1) * (120 + i * 31)}deg`,
    '--delay': `${850 + (i % 6) * 45}ms`,
    color: ['var(--winner)', '#e7ad30', '#e96b52', '#4b9b89', '#fff8de'][i % 5],
  }
})

onMounted(() => {
  reduced.value = matchMedia('(prefers-reduced-motion: reduce)').matches
  previousOverflow = document.body.style.overflow
  document.body.style.overflow = 'hidden'
  dialog.value?.showModal()
  timer = setTimeout(async () => {
    ready.value = true
    await nextTick()
    confirmButton.value?.focus()
  }, reduced.value ? 150 : 2600)
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  dialog.value?.close()
  document.body.style.overflow = previousOverflow
})
</script>

<template>
  <Teleport to="body">
    <dialog ref="dialog" class="victory-dialog" :class="{ ready, reduced }" :style="{ '--winner': palette.hex }"
      :aria-label="`${palette.name}方获胜`" @cancel.prevent="ready && emit('confirm')">
      <div class="victory-card">
        <div class="victory-eyebrow"><span>光 镜 棋</span><span>好棋，值得喝彩！</span></div>
        <svg class="victory-art" viewBox="0 0 440 285" aria-hidden="true">
          <circle class="halo" cx="220" cy="160" r="96" />
          <circle class="orbit" cx="220" cy="160" r="112" />
          <g class="rays" stroke="currentColor" stroke-width="3" stroke-linecap="round">
            <path v-for="i in 12" :key="i" d="M220 45v-13" :transform="`rotate(${i * 30} 220 160)`" />
          </g>
          <g class="mirrors" fill="#fffaf0" stroke="#3d3627" stroke-width="2.5">
            <rect x="81" y="202" width="27" height="9" rx="3" transform="rotate(-45 94 206)" />
            <rect x="81" y="88" width="27" height="9" rx="3" transform="rotate(-45 94 92)" />
            <rect x="207" y="88" width="27" height="9" rx="3" transform="rotate(45 220 92)" />
          </g>
          <path class="beam beam-glow" d="M12 206H94V92H220V152" pathLength="1" />
          <path class="beam" d="M12 206H94V92H220V152" pathLength="1" />
          <ellipse class="base-shadow" cx="220" cy="245" rx="45" ry="7" />
          <g transform="translate(220 160)">
            <g v-for="(piece, i) in confetti" :key="i" class="confetti" :style="piece">
              <path v-if="i % 3 === 0" d="M0-7 2-2 7 0 2 2 0 7-2 2-7 0-2-2Z" fill="currentColor" />
              <rect v-else x="-3" y="-5" width="6" height="10" rx="1" fill="currentColor" />
            </g>
          </g>
          <g class="champion">
            <path class="cape" d="M188 183Q166 218 161 238L191 227 213 242 230 197Z" />
            <g class="base-body">
              <rect x="176" y="143" width="88" height="80" rx="23" fill="currentColor" stroke="#3d3627" stroke-width="3" />
              <path d="M186 165V158Q186 153 193 153H211" fill="none" stroke="white" stroke-opacity=".65" stroke-width="4" stroke-linecap="round" />
              <path d="M198 177Q202 171 206 177M234 177Q238 171 242 177" fill="none" stroke="#302c23" stroke-width="3.5" stroke-linecap="round" />
              <path d="M209 190Q220 204 231 190Z" fill="#302c23" />
              <ellipse cx="195" cy="188" rx="6" ry="3" fill="#fff4e1" opacity=".55" />
              <ellipse cx="245" cy="188" rx="6" ry="3" fill="#fff4e1" opacity=".55" />
              <path d="M193 223 187 233M247 223 254 232" fill="none" stroke="#3d3627" stroke-width="4" stroke-linecap="round" />
              <path d="M176 183 161 173M264 183 278 168" fill="none" stroke="#3d3627" stroke-width="4" stroke-linecap="round" />
            </g>
            <g class="crown">
              <path d="M188 112 202 122 219 101 237 122 252 111 245 139H195Z" fill="#f8c84c" stroke="#3d3627" stroke-width="2.5" stroke-linejoin="round" />
              <path d="M199 131H240" stroke="#fff4c7" stroke-width="3" stroke-linecap="round" />
              <path d="m219 119 4 5-4 5-4-5Z" fill="currentColor" />
              <circle cx="188" cy="109" r="4" fill="#f8c84c" stroke="#3d3627" stroke-width="2" />
              <circle cx="219" cy="99" r="4" fill="#f8c84c" stroke="#3d3627" stroke-width="2" />
              <circle cx="253" cy="108" r="4" fill="#f8c84c" stroke="#3d3627" stroke-width="2" />
            </g>
          </g>
          <g class="little-stars" fill="#e7ad30">
            <path d="m326 136 4 10 10 4-10 4-4 10-4-10-10-4 10-4Z" />
            <path d="m131 154 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />
            <path d="m294 64 3 7 7 3-7 3-3 7-3-7-7-3 7-3Z" />
          </g>
        </svg>
        <div class="victory-copy" aria-live="polite">
          <div class="victory-tag">漂亮的一局</div>
          <h2><span>{{ palette.name }}方</span>获胜！</h2>
          <p>{{ timedOut.length ? `${timeoutNames}用时耗尽，本局结束` : '光芒到达，胜负落定。' }}</p>
        </div>
        <div class="victory-actions">
          <button v-if="ready" ref="confirmButton" class="victory-confirm" @click="emit('confirm')">确定 <span aria-hidden="true">↗</span></button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>

<style scoped>
.victory-dialog { width: min(440px, calc(100vw - 28px)); max-height: calc(100dvh - 28px); padding: 0; border: 0; overflow: auto; background: transparent; color: #35301f; overscroll-behavior: contain; }
.victory-dialog::backdrop { background: #302b236b; backdrop-filter: blur(5px); animation: backdrop-in .25s ease both; }
.victory-card { position: relative; overflow: hidden; padding: 25px 25px 22px; border: 2px solid #40392d; border-radius: 26px 12px 25px 15px; background: radial-gradient(ellipse at 50% 35%, #fffef6, #f8efd9 78%); box-shadow: inset 0 0 0 7px #fffaf066; text-align: center; animation: card-in .5s cubic-bezier(.2,.85,.3,1.15) both; }
.victory-eyebrow { display: flex; justify-content: space-between; gap: 10px; color: #81745e; font-size: 12px; }
.victory-art { display: block; width: calc(100% + 36px); margin: -2px -18px -14px; overflow: visible; color: var(--winner); }
.halo { fill: currentColor; opacity: .07; transform-origin: 220px 160px; animation: halo-pop 1s .75s both; }
.orbit { fill: none; stroke: currentColor; stroke-opacity: .18; stroke-dasharray: 3 9; stroke-width: 1.5; transform-origin: 220px 160px; animation: orbit-in 2.2s ease-out both; }
.rays { opacity: 0; transform-origin: 220px 160px; animation: ray-burst .9s .85s ease-out both; }
.mirrors { animation: ink-in .4s .15s both; }
.beam { fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: beam-draw 1.3s .2s ease-in-out both; }
.beam-glow { stroke-width: 10; opacity: .18; }
.base-shadow { fill: #40392d; opacity: .13; transform-origin: 220px 245px; animation: shadow-hop 1.5s .7s ease both; }
.champion { transform-origin: 220px 220px; animation: champion-hop 1.8s .65s both; }
.cape { fill: currentColor; opacity: .3; }
.crown { transform-origin: 220px 130px; animation: crown-drop 1.1s .85s both; }
.confetti { opacity: 0; animation: confetti-fly 1.5s var(--delay) cubic-bezier(.1,.6,.35,1) both; }
.little-stars { transform-origin: 220px 160px; animation: star-pop 1.1s 1s both; }
.victory-copy { animation: copy-in .65s 1.15s both; }
.victory-tag { color: #8c7551; font-size: 13px; letter-spacing: 5px; }
h2 { margin: 8px 0 6px; font-size: clamp(30px, 8vw, 43px); font-weight: 900; letter-spacing: 2px; }
h2 span { color: var(--winner); }
.victory-copy p { margin: 0; font-size: 14px; line-height: 1.6; color: #81745e; }
.victory-actions { height: 59px; padding-top: 16px; }
.victory-confirm { width: min(220px, 100%); height: 43px; display: inline-flex; align-items: center; justify-content: center; gap: 28px; border: 2px solid #40392d; border-radius: 13px 5px 14px 6px; background: #fff9e9; color: #35301f; font-size: 17px; font-weight: 700; box-shadow: 3px 3px 0 var(--winner); cursor: pointer; animation: button-pop .3s cubic-bezier(.2,.8,.3,1.3) both; }
.victory-confirm span { color: var(--winner); font-family: system-ui, sans-serif; font-size: 24px; }
.victory-confirm:hover { background: #fff; transform: translateY(-2px); }
.victory-confirm:active { transform: translate(2px, 2px); box-shadow: 1px 1px 0 var(--winner); }
.victory-confirm:focus-visible { outline: 3px solid var(--winner); outline-offset: 5px; }
@keyframes backdrop-in { from { background: #302b2300; backdrop-filter: blur(0); } }
@keyframes card-in { from { opacity: 0; transform: translateY(22px) rotate(-4deg) scale(.88); } to { opacity: 1; transform: none; } }
@keyframes ink-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes orbit-in { from { opacity: 0; transform: rotate(-80deg) scale(.6); } to { opacity: 1; transform: none; } }
@keyframes halo-pop { 0% { transform: scale(.5); opacity: 0; } 45% { transform: scale(1.15); opacity: .15; } 100% { transform: scale(1); opacity: .07; } }
@keyframes beam-draw { 0% { stroke-dashoffset: 1; opacity: 0; } 8% { opacity: 1; } 70% { stroke-dashoffset: 0; opacity: 1; } 100% { stroke-dashoffset: 0; opacity: 0; } }
@keyframes ray-burst { 0% { opacity: 0; transform: scale(.5); } 30% { opacity: .6; } 100% { opacity: 0; transform: scale(1.25) rotate(12deg); } }
@keyframes champion-hop { 0%, 100% { transform: none; } 12% { transform: scale(1.08,.9); } 30% { transform: translateY(-26px) rotate(-9deg); } 46% { transform: translateY(-8px) rotate(7deg); } 60% { transform: scale(1.08,.92); } 77% { transform: translateY(-9px) rotate(-3deg); } }
@keyframes shadow-hop { 0%, 100% { transform: scaleX(1); } 30% { transform: scaleX(.65); opacity: .07; } 65% { transform: scaleX(1.1); } }
@keyframes crown-drop { 0% { opacity: 0; transform: translateY(-65px) rotate(-25deg) scale(.6); } 40% { opacity: 1; transform: translateY(4px) rotate(9deg); } 65% { transform: translateY(-6px) rotate(-6deg); } 100% { opacity: 1; transform: none; } }
@keyframes confetti-fly { 0% { opacity: 0; transform: scale(.2); } 12% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; transform: translate(var(--dx), var(--dy)) rotate(var(--spin)) scale(.6); } }
@keyframes star-pop { 0% { opacity: 0; transform: scale(.3) rotate(-15deg); } 60% { opacity: 1; transform: scale(1.1); } 100% { opacity: .85; transform: none; } }
@keyframes copy-in { from { opacity: 0; transform: translateY(14px) scale(.94); } to { opacity: 1; transform: none; } }
@keyframes button-pop { from { opacity: 0; transform: translateY(8px) scale(.9); } to { opacity: 1; transform: none; } }
.reduced *, .reduced::backdrop { animation: none !important; }
.reduced .beam, .reduced .rays, .reduced .confetti { display: none; }
@media (prefers-reduced-motion: reduce) { *, .victory-dialog::backdrop { animation: none !important; } .beam, .rays, .confetti { display: none; } }
@media (max-height: 580px) { .victory-card { padding-top: 15px; padding-bottom: 16px; } .victory-art { width: min(290px, 100%); margin: -10px auto -24px; } h2 { font-size: 30px; } }
</style>
