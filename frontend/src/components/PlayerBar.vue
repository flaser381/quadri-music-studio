<script setup lang="ts">
import { computed } from 'vue'
import { fmtDuration } from '../../../shared/music.ts'
import { current, next, P, prev, seek, setVolume, toggle } from '../player.ts'
import { S } from '../studio.ts'
import CoverArt from './CoverArt.vue'
import Waveform from './Waveform.vue'

const song = computed(() => current())
const progress = computed(() => (P.duration ? P.time / P.duration : 0))
</script>

<template>
  <footer :class="{ empty: !song }">
    <div class="now" @click="song && (S.selectedId = song.id)">
      <div class="art">
        <CoverArt v-if="song" :seed="song.id + song.style" :peaks="song.peaks" />
      </div>
      <div class="meta">
        <div class="t">{{ song?.title ?? 'Nothing playing' }}</div>
        <div class="s">{{ song?.style ?? 'Press ▶ on a song, or Space' }}</div>
      </div>
    </div>

    <div class="ctl">
      <button class="ib" title="Previous" :disabled="!song" @click="prev">⏮</button>
      <button class="play" :title="P.playing ? 'Pause (Space)' : 'Play (Space)'" :disabled="!S.songs.length" @click="toggle()">
        <span v-if="P.loading && P.playing" class="spinner sm" />
        <template v-else>{{ P.playing ? '❚❚' : '▶' }}</template>
      </button>
      <button class="ib" title="Next" :disabled="!song" @click="next()">⏭</button>
    </div>

    <div class="pos">
      <span class="tm mono">{{ fmtDuration(P.time) }}</span>
      <Waveform v-if="song" class="wf" :peaks="song.peaks" :progress="progress" :height="30" @seek="seek" />
      <div v-else class="wf line" />
      <span class="tm mono">{{ fmtDuration(P.duration) }}</span>
    </div>

    <div class="vol">
      <button class="ib" :title="P.volume ? 'Mute' : 'Unmute'" @click="setVolume(P.volume ? 0 : 0.85)">{{ P.volume ? '🔊' : '🔇' }}</button>
      <input class="range" type="range" min="0" max="1" step="0.01" :value="P.volume" @input="setVolume(Number(($event.target as HTMLInputElement).value))" />
    </div>
  </footer>
</template>

<style scoped>
footer {
  flex: none;
  height: 68px;
  display: grid;
  grid-template-columns: 300px auto minmax(0, 1fr) 150px;
  align-items: center;
  gap: 18px;
  padding: 0 16px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}
.now {
  display: flex;
  align-items: center;
  gap: 11px;
  min-width: 0;
  cursor: pointer;
}
.art {
  flex: none;
  width: 44px;
  height: 44px;
  border-radius: 7px;
  overflow: hidden;
  background: var(--panel-3);
}
.meta {
  min-width: 0;
}
.t {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.s {
  font-size: 11.5px;
  color: var(--text-3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 2px;
}
.empty .t {
  color: var(--text-2);
  font-weight: 500;
}
.ctl {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ib {
  width: 30px;
  height: 30px;
  border: none;
  border-radius: 50%;
  background: none;
  color: var(--text-2);
  font-size: 14px;
  cursor: pointer;
}
.ib:hover:not(:disabled) {
  color: var(--text);
  background: var(--panel-2);
}
.ib:disabled {
  opacity: 0.35;
  cursor: default;
}
.play {
  width: 40px;
  height: 40px;
  border: none;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: var(--text);
  color: #0b0c0d;
  font-size: 14px;
  cursor: pointer;
  transition: transform 0.1s;
}
.play:hover:not(:disabled) {
  transform: scale(1.06);
}
.play:disabled {
  opacity: 0.4;
  cursor: default;
}
.spinner.sm {
  width: 16px;
  height: 16px;
  border-color: #999;
  border-top-color: #0b0c0d;
}
.pos {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.wf {
  flex: 1;
  min-width: 0;
}
.wf.line {
  height: 2px;
  background: var(--panel-3);
  border-radius: 1px;
}
.tm {
  flex: none;
  font-size: 11px;
  color: var(--text-3);
  width: 34px;
  text-align: center;
}
.vol {
  display: flex;
  align-items: center;
  gap: 6px;
}
.vol .range {
  flex: 1;
  min-width: 0;
}
@media (max-width: 1180px) {
  footer {
    grid-template-columns: 220px auto minmax(0, 1fr) 110px;
  }
}
</style>
