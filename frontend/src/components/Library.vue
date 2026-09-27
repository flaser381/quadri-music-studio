<script setup lang="ts">
import { computed, ref } from 'vue'
import { COT_SHORT, fmtDuration } from '../../../shared/music.ts'
import type { Song } from '../../../shared/types.ts'
import { downloadUrl } from '../api.ts'
import { fmtAgo } from '../format.ts'
import { P, play, toggle } from '../player.ts'
import { activeJobs, S, toggleStar, visibleSongs } from '../studio.ts'
import CoverArt from './CoverArt.vue'
import JobCard from './JobCard.vue'

const songs = computed(() => visibleSongs())
const jobs = computed(() => activeJobs())
const failed = computed(() => S.jobs.filter((j) => j.state === 'failed').slice(-2))
const now = ref(Date.now())
setInterval(() => (now.value = Date.now()), 30_000)

function onRowClick(s: Song) {
  S.selectedId = s.id
}
const isPlaying = (s: Song) => P.songId === s.id && P.playing
</script>

<template>
  <section class="center">
    <div class="lhead">
      <span class="label">Library</span>
      <span class="hint mono">{{ S.songs.length }} song{{ S.songs.length === 1 ? '' : 's' }}</span>
      <div class="grow" />
      <input v-model="S.query" class="field search" placeholder="Search title, style, lyrics…" />
      <div class="seg filt">
        <button :class="{ on: S.filter === 'all' }" @click="S.filter = 'all'">All</button>
        <button :class="{ on: S.filter === 'starred' }" @click="S.filter = 'starred'">★ Starred</button>
      </div>
    </div>

    <div class="list">
      <JobCard v-for="j in jobs" :key="j.id" :job="j" />
      <div v-for="j in failed" :key="j.id" class="failed">
        <span class="mono">failed</span> {{ j.title ?? j.label }} — {{ j.error }}
      </div>

      <div
        v-for="s in songs"
        :key="s.id"
        class="row"
        :class="{ on: s.id === S.selectedId, playing: P.songId === s.id }"
        @click="onRowClick(s)"
        @dblclick="play(s)"
      >
        <button class="art" :title="isPlaying(s) ? 'Pause' : 'Play'" @click.stop="toggle(s)">
          <CoverArt :seed="s.id + s.style" :peaks="s.peaks" />
          <span class="pl" :class="{ show: P.songId === s.id }">{{ isPlaying(s) ? '❚❚' : '▶' }}</span>
        </button>
        <div class="meta">
          <div class="title">
            <span class="t">{{ s.title }}</span>
            <span class="badge mono">{{ COT_SHORT[s.cot] }}</span>
            <span v-if="s.source.kind !== 'new'" class="badge mono acc">{{ s.source.kind.toUpperCase() }}</span>
            <span v-if="s.lyricsBy === 'llm'" class="badge mono" title="lyrics written by the LLM">AI</span>
            <span v-if="s.truncated.semantic" class="badge mono warn" title="hit the 6-minute token limit">CUT</span>
          </div>
          <div class="style">{{ s.style || '—' }}</div>
        </div>
        <div class="dur mono">{{ fmtDuration(s.duration) }}</div>
        <div class="ago">{{ fmtAgo(s.createdAt, now) }}</div>
        <div class="acts">
          <button class="btn sm ghost star" :class="{ on: s.starred }" :title="s.starred ? 'Unstar' : 'Star'" @click.stop="toggleStar(s)">{{ s.starred ? '★' : '☆' }}</button>
          <a class="btn sm ghost" :href="downloadUrl(s.id, S.status?.ffmpeg ? 'mp3' : 'flac')" title="Download" @click.stop>⤓</a>
        </div>
      </div>

      <div v-if="!songs.length && !jobs.length" class="empty">
        <div class="big">♪</div>
        <template v-if="S.songs.length">
          <div>No songs match.</div>
        </template>
        <template v-else>
          <div>Describe a song, or write lyrics and a style, then press <b>Create</b>.</div>
          <div class="hint">YuE2 composes a score, sings it and renders 48 kHz stereo. A 3-minute song takes a few minutes.</div>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.center {
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.lhead {
  flex: none;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.grow {
  flex: 1;
}
.search {
  width: 240px;
  height: 30px;
  font-size: 12.5px;
}
.filt {
  width: 170px;
}
.filt button {
  height: 22px;
  font-size: 12px;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding: 12px 14px;
}
.failed {
  font-size: 12px;
  color: var(--bad);
  padding: 8px 10px;
  margin-bottom: 8px;
  border-radius: var(--radius-sm);
  background: rgba(255, 93, 108, 0.07);
  white-space: pre-wrap;
}
.row {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr) 52px 84px 64px;
  align-items: center;
  gap: 12px;
  padding: 7px 8px;
  border-radius: 9px;
  cursor: pointer;
  border: 1px solid transparent;
}
.row:hover {
  background: var(--panel-2);
}
.row.on {
  background: var(--panel-2);
  border-color: var(--border-hi);
}
.art {
  position: relative;
  width: 52px;
  height: 52px;
  padding: 0;
  border: none;
  border-radius: 7px;
  overflow: hidden;
  cursor: pointer;
  background: var(--panel-3);
}
.pl {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  font-size: 15px;
  opacity: 0;
  transition: opacity 0.12s;
}
.row:hover .pl,
.pl.show {
  opacity: 1;
}
.meta {
  min-width: 0;
}
.title {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.title .t {
  font-weight: 600;
  font-size: 13.5px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row.playing .title .t {
  color: var(--accent);
}
.badge {
  flex: none;
  padding: 1px 5px;
  border-radius: 4px;
  background: var(--panel-3);
  color: var(--text-3);
  font-size: 9.5px;
  font-weight: 600;
  letter-spacing: 0.05em;
}
.badge.acc {
  background: var(--accent-bg);
  color: var(--accent);
}
.badge.warn {
  background: rgba(245, 184, 74, 0.12);
  color: var(--warn);
}
.style {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-2);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dur {
  font-size: 12px;
  color: var(--text-2);
  text-align: right;
}
.ago {
  font-size: 11.5px;
  color: var(--text-3);
  text-align: right;
  white-space: nowrap;
}
.acts {
  display: flex;
  justify-content: flex-end;
  opacity: 0;
  transition: opacity 0.12s;
}
.row:hover .acts,
.star.on {
  opacity: 1;
}
.acts a {
  text-decoration: none;
}
.star.on {
  color: #ffd166;
}
.row:hover .acts .star {
  opacity: 1;
}
.acts:has(.star.on) {
  opacity: 1;
}
.empty {
  margin-top: 12vh;
  text-align: center;
  color: var(--text-2);
  display: grid;
  gap: 8px;
  justify-items: center;
}
.empty .big {
  font-size: 34px;
  color: var(--accent);
}
.empty .hint {
  max-width: 440px;
}
@media (max-width: 1280px) {
  .row {
    grid-template-columns: 52px minmax(0, 1fr) 48px 64px;
  }
  .ago {
    display: none;
  }
}
</style>
