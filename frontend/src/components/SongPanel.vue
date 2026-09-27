<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { COT_LABEL, fmtDuration, splitSections } from '../../../shared/music.ts'
import { downloadUrl } from '../api.ts'
import { fmtSec, styleTags } from '../format.ts'
import { P, play, seek, toggle } from '../player.ts'
import { deleteSong, fromScore, renameSong, reuse, S, selectedSong, toggleStar } from '../studio.ts'
import CoverArt from './CoverArt.vue'
import ScoreView from './ScoreView.vue'
import Terminal from './Terminal.vue'
import Waveform from './Waveform.vue'

const song = computed(() => selectedSong())
const tab = ref<'lyrics' | 'score' | 'info'>('lyrics')
const renaming = ref(false)
const nameInput = ref('')
const dl = ref(false)
watch(
  () => song.value?.id,
  () => {
    renaming.value = false
    dl.value = false
    if (tab.value === 'score' && !song.value?.score) tab.value = 'lyrics'
  },
)

const sections = computed(() => splitSections(song.value?.lyrics ?? ''))
const isCurrent = computed(() => !!song.value && P.songId === song.value.id)
const progress = computed(() => (isCurrent.value && P.duration ? P.time / P.duration : 0))

function onSeek(f: number) {
  if (!song.value) return
  if (isCurrent.value) seek(f)
  else play(song.value, f)
}

function startRename() {
  nameInput.value = song.value?.title ?? ''
  renaming.value = true
}
function commitRename() {
  renaming.value = false
  if (song.value) renameSong(song.value, nameInput.value)
}

const timingRows = computed(() => {
  const t = song.value?.timings
  if (!t) return []
  const rows: [string, number | null][] = [
    ['Write (LLM)', t.write],
    ['Load', t.load],
    ['Compose score', t.compose],
    ['Sing', t.sing],
    ['Render', t.render],
    ['Decode', t.decode],
  ]
  return rows.filter((r) => r[1] !== null && r[1] > 0.05) as [string, number][]
})
</script>

<template>
  <aside>
    <div v-if="song" class="top">
      <div class="hero">
        <div class="art" @click="toggle(song)">
          <CoverArt :seed="song.id + song.style" :peaks="song.peaks" bars />
          <span class="bigplay">{{ isCurrent && P.playing ? '❚❚' : '▶' }}</span>
        </div>
      </div>

      <input v-if="renaming" v-model="nameInput" class="field title-in" autofocus @keydown.enter="commitRename" @keydown.esc="renaming = false" @blur="commitRename" />
      <h1 v-else class="title" title="Double-click to rename" @dblclick="startRename">{{ song.title }}</h1>
      <div class="tags">
        <span v-for="t in styleTags(song.style)" :key="t" class="stag">{{ t }}</span>
      </div>
      <div class="facts mono">
        {{ fmtDuration(song.duration) }} · {{ COT_LABEL[song.cot] }} · seed {{ song.seed }}{{ song.cfgScale != null ? ` · cfg ${song.cfgScale}` : '' }}
        <template v-if="song.source.kind !== 'new'"> · {{ song.source.kind }} of “{{ song.source.title }}”</template>
      </div>

      <Waveform class="wave" :peaks="song.peaks" :progress="progress" :height="44" @seek="onSeek" />

      <div class="acts">
        <button class="btn primary" @click="toggle(song)">{{ isCurrent && P.playing ? '❚❚ Pause' : '▶ Play' }}</button>
        <button class="btn" :class="{ starred: song.starred }" :title="song.starred ? 'Unstar' : 'Star'" @click="toggleStar(song)">{{ song.starred ? '★' : '☆' }}</button>
        <div class="dlwrap">
          <button class="btn" @click="dl = !dl">⤓ Download</button>
          <div v-if="dl" class="menu" @click="dl = false">
            <a :href="downloadUrl(song.id, 'flac')">FLAC <small>24-bit, lossless</small></a>
            <a v-if="S.status?.ffmpeg" :href="downloadUrl(song.id, 'mp3')">MP3 <small>320 kbit/s</small></a>
            <a v-if="S.status?.ffmpeg" :href="downloadUrl(song.id, 'wav')">WAV <small>16-bit</small></a>
            <a v-if="song.score" :href="downloadUrl(song.id, 'abc')">Score <small>.abc</small></a>
          </div>
        </div>
        <div class="grow" />
        <button class="btn ghost danger" title="Delete song" @click="deleteSong(song)">✕</button>
      </div>
      <div class="acts2">
        <button class="btn sm" title="Load lyrics + style into the form (new seed)" @click="reuse(song)">↺ Reuse</button>
        <button class="btn sm" :disabled="!song.score" title="Keep melody + chords, change the style" @click="fromScore(song, 'remix')">⧉ Remix</button>
        <button class="btn sm" :disabled="!song.score" title="Keep only the melody (melody-only planning), new style" @click="fromScore(song, 'cover')">♫ Cover</button>
      </div>

      <div class="tabs">
        <button :class="{ on: tab === 'lyrics' }" @click="tab = 'lyrics'">Lyrics</button>
        <button :class="{ on: tab === 'score' }" :disabled="!song.score" @click="tab = 'score'">Score</button>
        <button :class="{ on: tab === 'info' }" @click="tab = 'info'">Info</button>
      </div>

      <div v-if="tab === 'lyrics'" class="lyrics">
        <p v-if="song.description" class="desc">“{{ song.description }}”</p>
        <div v-for="(sec, i) in sections" :key="i" class="sec" :class="{ chorus: sec.tag?.toLowerCase().includes('chorus') }">
          <div v-if="sec.tag" class="stitle mono">{{ sec.tag }}</div>
          <div v-for="(l, k) in sec.lines" :key="k" class="ll">{{ l || ' ' }}</div>
          <div v-if="!sec.lines.some(Boolean)" class="ll inst">instrumental</div>
        </div>
      </div>
      <ScoreView v-else-if="tab === 'score' && song.score" :abc="song.score" />
      <div v-else class="info">
        <div class="kv"><span>Total</span><b class="mono">{{ fmtSec(song.timings.total) }}</b></div>
        <div v-for="[k, v] in timingRows" :key="k" class="kv">
          <span>{{ k }}</span><span class="mono">{{ fmtSec(v) }}</span>
        </div>
        <div class="kv"><span>Score tokens</span><span class="mono">{{ song.tokens.abc }}</span></div>
        <div class="kv">
          <span>Codec tokens</span><span class="mono">{{ song.tokens.semantic }}{{ song.tokens.tps ? ` · ${song.tokens.tps.toFixed(0)} tok/s` : '' }}</span>
        </div>
        <div v-if="song.truncated.semantic || song.truncated.abc" class="kv warn"><span>Truncated</span><span>hit the generation limit</span></div>
        <div class="kv"><span>Lyrics</span><span>{{ song.lyricsBy === 'llm' ? 'written by the LLM' : 'yours' }}</span></div>
        <div class="kv"><span>Files</span><span class="mono path">{{ S.paths?.dataDir.replace(/^\/home\/[^/]+/, '~') }}/{{ song.dir }}</span></div>
      </div>
    </div>
    <div v-else class="top none">
      <div class="hint">Select a song to see its lyrics, score and details.</div>
    </div>

    <Terminal />
  </aside>
</template>

<style scoped>
aside {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  background: var(--panel);
}
.top {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 14px;
}
.none {
  display: grid;
  place-items: center;
  text-align: center;
}
.hero {
  display: flex;
  justify-content: center;
}
.art {
  position: relative;
  width: 100%;
  max-width: 180px;
  aspect-ratio: 1;
  border-radius: 12px;
  overflow: hidden;
  cursor: pointer;
  box-shadow: 0 14px 40px rgba(0, 0, 0, 0.45);
}
.bigplay {
  position: absolute;
  right: 10px;
  bottom: 10px;
  width: 42px;
  height: 42px;
  border-radius: 50%;
  display: grid;
  place-items: center;
  background: rgba(10, 10, 14, 0.7);
  color: #fff;
  font-size: 15px;
  backdrop-filter: blur(4px);
  transition: transform 0.12s;
}
.art:hover .bigplay {
  transform: scale(1.08);
}
.title {
  margin: 14px 0 0;
  font-size: 18px;
  font-weight: 700;
  letter-spacing: -0.01em;
  cursor: text;
  word-break: break-word;
}
.title-in {
  margin-top: 12px;
  font-size: 15px;
  font-weight: 650;
}
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 8px;
}
.stag {
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--panel-3);
  color: var(--text-2);
  font-size: 11.5px;
}
.facts {
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-3);
  line-height: 1.5;
}
.wave {
  margin-top: 12px;
}
.acts,
.acts2 {
  display: flex;
  gap: 6px;
  align-items: center;
  margin-top: 12px;
}
.acts2 {
  margin-top: 8px;
}
.acts2 .btn {
  flex: 1;
  justify-content: center;
}
.grow {
  flex: 1;
}
.starred {
  color: #ffd166;
}
.dlwrap {
  position: relative;
}
.menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 20;
  min-width: 190px;
  padding: 4px;
  background: var(--panel-3);
  border: 1px solid var(--border-hi);
  border-radius: 8px;
  box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
  display: grid;
}
.menu a {
  padding: 7px 9px;
  border-radius: 5px;
  color: var(--text);
  text-decoration: none;
  font-size: 12.5px;
}
.menu a:hover {
  background: var(--accent-bg);
}
.menu small {
  color: var(--text-3);
  margin-left: 6px;
}
.tabs {
  display: flex;
  gap: 4px;
  margin: 18px 0 12px;
  border-bottom: 1px solid var(--border);
}
.tabs button {
  height: 30px;
  padding: 0 12px;
  border: none;
  border-bottom: 2px solid transparent;
  background: none;
  color: var(--text-3);
  font-size: 12.5px;
  cursor: pointer;
  margin-bottom: -1px;
}
.tabs button.on {
  color: var(--text);
  border-bottom-color: var(--accent);
}
.tabs button:disabled {
  opacity: 0.4;
  cursor: default;
}
.lyrics {
  font-size: 13px;
  line-height: 1.6;
}
.desc {
  margin: 0 0 12px;
  color: var(--text-3);
  font-style: italic;
  font-size: 12px;
}
.sec {
  margin-bottom: 14px;
  padding-left: 10px;
  border-left: 2px solid var(--border);
}
.sec.chorus {
  border-left-color: var(--accent-2);
}
.stitle {
  font-size: 10.5px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 2px;
}
.sec.chorus .stitle {
  color: var(--accent);
}
.ll.inst {
  color: var(--text-3);
  font-style: italic;
  font-size: 12px;
}
.info {
  display: grid;
  gap: 7px;
}
.kv {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  font-size: 12.5px;
}
.kv > span:first-child {
  color: var(--text-2);
}
.kv.warn {
  color: var(--warn);
}
.path {
  font-size: 10.5px;
  word-break: break-all;
  text-align: right;
}
</style>
