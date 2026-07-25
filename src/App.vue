<script setup lang="ts">
import { computed } from 'vue'
import { state } from './store'
import Game from './views/Game.vue'
import Lobby from './views/Lobby.vue'

const inLobby = computed(() => state.phase === 'lobby')
</script>

<template>
  <Lobby v-if="inLobby" />
  <Game v-else />
</template>
