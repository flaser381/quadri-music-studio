<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import { COT_LABEL, LANGUAGES, SECTIONS, STYLE_TAGS } from '../../../shared/music.ts'
import type { Cot } from '../../../shared/types.ts'
import { styleTags } from '../format.ts'
import { activeJobs, clearScore, create, S, writeLyrics } from '../studio.ts'

const d = computed(() => S.draft)
const lyricsEl = ref<HTMLTextAreaElement>()
const advanced = ref(false)
const showTags = ref(false)
const showScore = ref(false)
const writerOpen = ref(false)
const idea = ref('')

const COTS: { key: Cot; hint: string }[] = [
  { key: 'full', hint: 'YuE2 writes a score with melody and chords first, then sings it. Best quality (default).' },
  { key: 'melody', hint: 'Melody-only score. Recommended for covers of an existing melody.' },
  { key: 'off', hint: 'No score, sings directly. Slightly faster, less structured.' },
]

/** insert "[Chorus]" at the cursor, on its own line with a blank line before */
function insertSection(tag: string) {
  const el = lyricsEl.value
  const text = S.draft.lyrics
  const pos = el ? el.selectionStart : text.length
  const before = text.slice(0, pos).replace(/\s*$/, '')
  const ins = `${before ? '\n\n' : ''}[${tag}]\n`
  S.draft.lyrics = before + ins + text.slice(pos).replace(/^\s*/, '')
  nextTick(() => {
    if (!el) return
    el.focus()
    const at = before.length + ins.length
    el.setSelectionRange(at, at)
  })
}

const tags = computed(() => new Set(styleTags(S.draft.style).map((t) => t.toLowerCase())))
function toggleTag(t: string) {
  const list = styleTags(S.draft.style)
  const i = list.findIndex((x) => x.toLowerCase() === t)
  if (i >= 0) list.splice(i, 1)
  else list.push(t)
  S.draft.style = list.join(', ')
}

function randomSeed() {
  S.draft.seed = Math.floor(Math.random() * 2 ** 31)
  S.draft.randomSeed = false
}

function startWriter() {
  const text = idea.value.trim() || S.draft.title.trim()
  if (!text) return
  writeLyrics(text)
}

const running = computed(() => activeJobs().length)
const ready = computed(() => {
  const m = S.status?.models
  return !m || (m.yue2 && m.vae && m.venv)
})
const missing = computed(() => {
  const m = S.status?.models
  if (!m) return ''
  if (!m.venv) return 'Python worker not installed: run install.sh / install.bat'
  if (!m.yue2 || !m.vae) return 'model weights missing or incomplete: run install.sh / install.bat'
  return ''
})
const engine = computed(() => {
  const nv = S.status?.gpu === 'nvidia'
  const graphs = S.settings.backend === 'torch' ? (nv ? 'CUDA graphs' : 'HIP graphs') : 'eager'
  return `PyTorch ${nv ? 'CUDA' : 'ROCm'} · bf16 · 48 kHz · ${graphs}`
})
/** file name of the bundled model, or the server address */
const lyricsModel = computed(() => S.paths?.llmGguf?.split(/[/\\]/).pop()?.replace(/\.gguf$/, '') ?? S.paths?.llmUrl ?? 'the LLM')
const lines = computed(() => S.draft.lyrics.split('\n').filter((l) => l.trim() && !/^\[.*\]$/.test(l.trim())).length)
const writerPreview = computed(() => S.writer.text.split('\n').slice(-8).join('\n'))
</script>

<template>
  <aside>
    <div class="scroll">
      <section>
        <div class="label">Model</div>
        <div class="model card">
          <div class="badge">Y2</div>
          <div class="info">
            <div class="name">YuE2-3B <span class="tag mono">+ YuE2-Vae</span></div>
            <div class="path mono">{{ S.paths?.modelDir.replace(/^\/home\/[^/]+/, '~') }}</div>
            <div v-if="missing" class="miss">{{ missing }}</div>
          </div>
        </div>
        <div class="row engine">
          <span class="label">Engine</span>
          <div class="enginev" :title="S.status?.engine ?? ''">{{ engine }}</div>
        </div>
      </section>

      <section>
        <div class="seg">
          <button :class="{ on: d.mode === 'simple' }" @click="S.draft.mode = 'simple'">Simple</button>
          <button :class="{ on: d.mode === 'custom' }" @click="S.draft.mode = 'custom'">Custom</button>
        </div>
      </section>

      <!-- ---------- simple: describe it ---------- -->
      <template v-if="d.mode === 'simple'">
        <section>
          <div class="head">
            <span class="label">Song description</span>
            <span class="hint mono">{{ d.description.length }}</span>
          </div>
          <textarea
            v-model="S.draft.description"
            class="field"
            rows="6"
            placeholder="an upbeat city pop song about driving through neon streets at 3 am, female vocals, groovy bass"
          />
          <p v-if="S.status && !S.status.llmAvailable" class="hint warn">
            No lyrics model is set up. Run the installer again without <span class="mono">--no-lyrics-llm</span>, set
            <span class="mono">LLM_URL</span> in config.env to an OpenAI-compatible server, or use Custom mode.
          </p>
          <p v-else class="hint">
            An LLM ({{ S.status?.llmModel ?? lyricsModel }}) writes title, style and lyrics, then YuE2 sings them. The LLM leaves the GPU before YuE2 loads.
          </p>
        </section>
        <section class="grid2">
          <div>
            <div class="label">Language</div>
            <select v-model="S.draft.language" class="field">
              <option v-for="l in LANGUAGES" :key="l">{{ l }}</option>
            </select>
          </div>
          <label class="check inst">
            <input v-model="S.draft.instrumental" type="checkbox" />
            <div>
              <div class="t">Instrumental</div>
              <div class="hint">no vocals (experimental)</div>
            </div>
          </label>
        </section>
      </template>

      <!-- ---------- custom: lyrics + style ---------- -->
      <template v-else>
        <section>
          <div class="head">
            <span class="label">Lyrics</span>
            <span class="hint mono">{{ lines }} lines</span>
            <div class="grow" />
            <button class="link" @click="writerOpen = !writerOpen">✦ Write with AI</button>
          </div>
          <div v-if="writerOpen || S.writer.active" class="writer card">
            <div class="wrow">
              <input
                v-model="idea"
                class="field"
                placeholder="what's it about? e.g. a summer road trip with old friends"
                :disabled="S.writer.active"
                @keydown.enter.prevent="startWriter"
              />
              <button class="btn" :class="{ primary: !S.writer.active }" :disabled="!S.writer.active && !idea.trim() && !d.title.trim()" @click="startWriter">
                {{ S.writer.active ? 'Stop' : 'Write' }}
              </button>
            </div>
            <div class="hint">
              <template v-if="S.writer.active">{{ S.writer.status }}</template>
              <template v-else>Writes title{{ d.style.trim() ? '' : ', style' }} and lyrics in {{ d.language }} with {{ S.status?.llmModel ?? lyricsModel }}. Replaces the lyrics below.</template>
            </div>
            <pre v-if="S.writer.active && S.writer.text" class="wtext mono">{{ writerPreview }}<i class="caret" /></pre>
            <div class="grid2 lang">
              <select v-model="S.draft.language" class="field sm" :disabled="S.writer.active">
                <option v-for="l in LANGUAGES" :key="l">{{ l }}</option>
              </select>
            </div>
          </div>
          <div class="sections">
            <button v-for="s in SECTIONS" :key="s" class="sec mono" :disabled="d.instrumental" @click="insertSection(s)">[{{ s }}]</button>
          </div>
          <textarea
            ref="lyricsEl"
            v-model="S.draft.lyrics"
            class="field lyrics"
            rows="14"
            spellcheck="false"
            :disabled="d.instrumental"
            :placeholder="'[Verse]\nStreetlights blinking, counting every face\nThe city hums a rhythm, keeps a steady pace\n\n[Chorus]\n…'"
          />
          <label class="check inst2">
            <input v-model="S.draft.instrumental" type="checkbox" />
            <span class="hint">Instrumental: song structure only, no words (experimental)</span>
          </label>
        </section>

        <section>
          <div class="head">
            <span class="label">Style of music</span>
            <button class="link" @click="showTags = !showTags">{{ showTags ? 'hide' : 'suggestions' }}</button>
          </div>
          <textarea
            v-model="S.draft.style"
            class="field"
            rows="3"
            placeholder="City Pop, upbeat, danceable, groovy bass, electric guitar, synth, female vocal"
          />
          <div v-if="showTags" class="taggroups">
            <div v-for="g in STYLE_TAGS" :key="g.group" class="tg">
              <span class="tgl">{{ g.group }}</span>
              <button v-for="t in g.tags" :key="t" class="tagb" :class="{ on: tags.has(t) }" @click="toggleTag(t)">{{ t }}</button>
            </div>
          </div>
        </section>

        <section>
          <div class="label">Title</div>
          <input v-model="S.draft.title" class="field" placeholder="optional, taken from the first line otherwise" />
        </section>
      </template>

      <!-- ---------- score reused from a song ---------- -->
      <section v-if="d.abc.trim()">
        <div class="card score">
          <div class="shead">
            <span class="chip">{{ d.abcFrom?.kind === 'cover' ? 'COVER' : d.abcFrom ? 'REMIX' : 'SCORE' }}</span>
            <span class="st">{{ d.abcFrom ? d.abcFrom.title : 'custom ABC score' }}</span>
            <div class="grow" />
            <button class="link" @click="showScore = !showScore">{{ showScore ? 'hide' : 'edit' }}</button>
            <button class="link" @click="clearScore">remove</button>
          </div>
          <div class="hint">
            {{ d.abcFrom?.kind === 'cover' ? 'Keeps the melody (chords removed), sings it in the new style.' : 'Keeps melody and chords, re-arranges in the new style.' }}
            Planning: {{ COT_LABEL[d.cot] }}.
          </div>
          <textarea v-if="showScore" v-model="S.draft.abc" class="field mono abc" rows="8" spellcheck="false" />
        </div>
      </section>

      <!-- ---------- advanced ---------- -->
      <section>
        <button class="link" @click="advanced = !advanced">{{ advanced ? '▾' : '▸' }} Advanced</button>
        <div v-if="advanced" class="adv">
          <div class="label">Planning</div>
          <div class="seg">
            <button v-for="c in COTS" :key="c.key" :class="{ on: d.cot === c.key }" :title="c.hint" @click="S.draft.cot = c.key">{{ COT_LABEL[c.key] }}</button>
          </div>
          <p class="hint">{{ COTS.find((c) => c.key === d.cot)?.hint }}</p>

          <div class="grid2 sp">
            <div>
              <div class="label">CFG scale</div>
              <input
                class="field"
                type="number"
                min="0"
                max="3"
                step="0.05"
                :value="d.cfgScale ?? ''"
                :placeholder="d.cot === 'off' ? '1.01' : '1.0'"
                @input="S.draft.cfgScale = ($event.target as HTMLInputElement).value === '' ? null : Number(($event.target as HTMLInputElement).value)"
              />
            </div>
            <div class="seed">
              <div class="label">Seed</div>
              <div class="seedrow">
                <input v-model.number="S.draft.seed" class="field" type="number" :disabled="d.randomSeed" @change="S.draft.randomSeed = false" />
                <button class="btn dice" title="New random seed" @click="randomSeed">⚄</button>
              </div>
            </div>
            <label class="check span2 rnd">
              <input v-model="S.draft.randomSeed" type="checkbox" />
              <span class="hint">random seed for every song</span>
            </label>
          </div>
          <p class="hint">CFG &gt; 1 (e.g. 1.2) follows the style text more strongly and runs a second branch (slower). Empty = model default.</p>

          <template v-if="!d.abc.trim()">
            <div class="label sp">Score (ABC)</div>
            <textarea v-model="S.draft.abc" class="field mono abc" rows="3" spellcheck="false" placeholder="optional: paste an ABC score to sing (e.g. from SheetSage2)" />
          </template>
        </div>
      </section>
    </div>

    <div class="go">
      <div class="takes">
        <span class="label">Songs</span>
        <div class="seg">
          <button :class="{ on: d.takes === 1 }" @click="S.draft.takes = 1">1</button>
          <button :class="{ on: d.takes === 2 }" title="two takes with different seeds" @click="S.draft.takes = 2">2</button>
        </div>
      </div>
      <button class="btn primary big" :disabled="!ready || S.writer.active" @click="create">
        ♪ {{ running ? 'Queue' : 'Create' }}
        <span class="kbd">Ctrl ↵</span>
      </button>
      <div class="hint gohint">
        <template v-if="missing">{{ missing }}</template>
        <template v-else-if="running">{{ running }} in progress</template>
        <template v-else>
          {{ d.mode === 'simple' ? 'lyrics by LLM → ' : '' }}{{ COT_LABEL[d.cot].toLowerCase() }}{{ d.abc.trim() ? ' · from score' : '' }} · ~1–3 min per song
        </template>
      </div>
    </div>
  </aside>
</template>

<style scoped>
aside {
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-right: 1px solid var(--border);
  background: var(--panel);
}
.scroll {
  flex: 1;
  overflow-y: auto;
  padding: 14px 14px 6px;
}
section {
  margin-bottom: 18px;
}
section > .label {
  margin-bottom: 8px;
}
.head {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin-bottom: 8px;
}
.head .label {
  flex: none;
}
.head > .hint:not(:last-child) {
  flex: 1;
}
.grow {
  flex: 1;
}
p.hint {
  margin: 7px 0 0;
}
.model {
  display: flex;
  gap: 12px;
  padding: 12px;
}
.badge {
  flex: none;
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 7px;
  background: var(--accent-bg);
  color: var(--accent);
  font-weight: 700;
  font-size: 12px;
  font-family: var(--mono);
}
.info {
  min-width: 0;
}
.name {
  font-weight: 650;
  font-size: 13.5px;
}
.name .tag {
  font-weight: 400;
  font-size: 10.5px;
  color: var(--text-3);
  margin-left: 4px;
}
.path {
  margin-top: 3px;
  font-size: 10.5px;
  color: var(--text-3);
  word-break: break-all;
  line-height: 1.4;
}
.miss {
  color: var(--warn);
  font-size: 11px;
  margin-top: 4px;
}
.row.engine {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
}
.enginev {
  flex: 1;
  font-size: 12px;
  color: var(--text-2);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: var(--panel-2);
  border: 1px solid var(--border);
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px 10px;
  align-items: end;
}
.grid2 .label {
  margin-bottom: 6px;
}
.span2 {
  grid-column: 1 / -1;
}
.inst {
  align-self: center;
  padding-top: 18px;
}
.inst2 {
  margin-top: 8px;
  align-items: center;
}
.writer {
  padding: 10px;
  margin-bottom: 10px;
  display: grid;
  gap: 7px;
}
.wrow {
  display: flex;
  gap: 6px;
}
.wrow .btn {
  height: 34px;
}
.wtext {
  margin: 0;
  max-height: 150px;
  overflow: hidden;
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-2);
  white-space: pre-wrap;
}
.caret {
  display: inline-block;
  width: 6px;
  height: 12px;
  margin-left: 2px;
  vertical-align: -2px;
  background: var(--accent);
  animation: blink 1s steps(1) infinite;
}
@keyframes blink {
  50% {
    opacity: 0;
  }
}
.field.sm {
  height: 28px;
  font-size: 12px;
}
.lang {
  grid-template-columns: 1fr 1fr;
}
.sections {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 7px;
}
.sec {
  height: 22px;
  padding: 0 7px;
  border-radius: 5px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 10.5px;
  cursor: pointer;
}
.sec:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent-2);
}
.sec:disabled {
  opacity: 0.4;
  cursor: default;
}
.lyrics {
  font-size: 12.5px;
  line-height: 1.55;
  min-height: 220px;
}
.lyrics:disabled {
  opacity: 0.45;
}
.taggroups {
  margin-top: 9px;
  display: grid;
  gap: 7px;
}
.tg {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
}
.tgl {
  width: 100%;
  font-size: 10.5px;
  color: var(--text-3);
  text-transform: uppercase;
  letter-spacing: 0.08em;
}
.tagb {
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text-2);
  font-size: 11.5px;
  cursor: pointer;
}
.tagb:hover {
  border-color: var(--border-hi);
  color: var(--text);
}
.tagb.on {
  background: var(--accent-bg);
  border-color: var(--accent-2);
  color: var(--accent);
}
.score {
  padding: 10px 12px;
  display: grid;
  gap: 6px;
}
.shead {
  display: flex;
  align-items: center;
  gap: 8px;
}
.st {
  font-size: 12.5px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.abc {
  font-size: 11px;
  line-height: 1.45;
}
.adv {
  margin-top: 10px;
}
.adv > .label {
  margin-bottom: 6px;
}
.sp {
  margin-top: 14px;
}
.seedrow {
  display: flex;
  gap: 6px;
}
.dice {
  height: 34px;
  width: 34px;
  padding: 0;
  justify-content: center;
  font-size: 16px;
  flex: none;
}
.rnd {
  align-items: center;
}
.go {
  flex: none;
  padding: 12px 14px 14px;
  border-top: 1px solid var(--border);
  background: var(--panel);
}
.takes {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
}
.takes .seg {
  flex: 1;
}
.big {
  width: 100%;
  height: 40px;
  justify-content: center;
  font-size: 14px;
  position: relative;
}
.kbd {
  position: absolute;
  right: 12px;
  font-size: 10.5px;
  font-weight: 500;
  opacity: 0.6;
  font-family: var(--mono);
}
.gohint {
  margin-top: 7px;
  text-align: center;
}
.hint.warn {
  color: var(--warn);
}
</style>
