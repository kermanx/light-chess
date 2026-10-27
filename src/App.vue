<script setup lang="ts">
import { computed } from 'vue'
import { state } from './store'
import { review } from './review'
import Game from './views/Game.vue'
import Lobby from './views/Lobby.vue'
import Review from './views/Review.vue'

const inLobby = computed(() => state.phase === 'lobby')
</script>

<template>
  <Review v-if="review.active" />
  <Lobby v-else-if="inLobby" />
  <Game v-else />
</template>
