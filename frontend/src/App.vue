<script setup lang="ts">
import { onMounted, watch } from 'vue'
import CreatePanel from './components/CreatePanel.vue'
import Library from './components/Library.vue'
import PlayerBar from './components/PlayerBar.vue'
import SettingsModal from './components/SettingsModal.vue'
import SongPanel from './components/SongPanel.vue'
import TopBar from './components/TopBar.vue'
import { P, skip, stopIf, toggle } from './player.ts'
import { boot, create, S, selectedSong, toast } from './studio.ts'

const typing = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null
  return !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
}

onMounted(() => {
  boot().catch((e) => toast(`Backend not reachable: ${(e as Error).message}`))
  // Ctrl/Cmd+Enter → create · Space → play/pause · ←/→ → seek 5 s
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault()
      create()
      return
    }
    if (e.key === 'Escape') S.modal = null
    if (typing(e) || e.ctrlKey || e.metaKey || e.altKey) return
    if (e.key === ' ') {
      e.preventDefault()
      toggle(P.songId ? null : selectedSong())
    } else if (e.key === 'ArrowRight') skip(5)
    else if (e.key === 'ArrowLeft') skip(-5)
  })
})

// a deleted song must not keep playing
watch(
  () => !P.songId || S.songs.some((s) => s.id === P.songId),
  (exists) => {
    if (!exists && P.songId) stopIf(P.songId)
  },
)
</script>

<template>
  <div class="app">
    <TopBar />
    <main v-if="S.ready">
      <CreatePanel />
      <Library />
      <SongPanel />
    </main>
    <div v-else class="boot">
      <div class="spinner" />
      <span>connecting to studio backend…</span>
    </div>
    <PlayerBar v-if="S.ready" />

    <SettingsModal v-if="S.modal === 'settings'" />

    <Transition name="toast">
      <div v-if="S.toast" class="toast" :class="S.toast.kind" @click="S.toast = null">{{ S.toast.text }}</div>
    </Transition>
  </div>
</template>

<style scoped>
.app {
  height: 100%;
  display: flex;
  flex-direction: column;
}
main {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 360px minmax(0, 1fr) 380px;
}
.boot {
  flex: 1;
  display: grid;
  place-content: center;
  justify-items: center;
  gap: 14px;
  color: var(--text-3);
}
.toast {
  position: fixed;
  left: 50%;
  bottom: 84px;
  transform: translateX(-50%);
  z-index: 80;
  max-width: min(720px, 90vw);
  padding: 10px 16px;
  border-radius: 10px;
  background: #2a1417;
  border: 1px solid #5a2129;
  color: #ffb3bb;
  font-size: 12.5px;
  white-space: pre-wrap;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
  cursor: pointer;
}
.toast.info {
  background: #1d1830;
  border-color: #3f3470;
  color: #d9ccff;
}
.toast-enter-active,
.toast-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translate(-50%, 8px);
}
@media (max-width: 1280px) {
  main {
    grid-template-columns: 320px minmax(0, 1fr) 330px;
  }
}
</style>
