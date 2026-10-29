<script setup lang="ts">
import { computed } from 'vue'
import { state } from './store'
import { review } from './review'
import Game from './views/Game.vue'
import Lobby from './views/Lobby.vue'
import Review from './views/Review.vue'
import Replay from './views/Replay.vue'
import { replayRoute } from './replay/navigation'

const inLobby = computed(() => state.phase === 'lobby')
</script>

<template>
  <Replay v-if="replayRoute" :game-id="replayRoute.id" />
  <Review v-else-if="review.active" />
  <Lobby v-else-if="inLobby" />
  <Game v-else />
</template>
