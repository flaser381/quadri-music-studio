<script setup lang="ts">
// A song in the making: stage bar (like the Image Studio's), live counters and the score as YuE2 writes it.
import { computed, nextTick, ref, watch } from 'vue'
import { COT_SHORT, fmtDuration, TOKENS_PER_SECOND } from '../../../shared/music.ts'
import type { Job, Stage } from '../../../shared/types.ts'
import { fmtSec } from '../format.ts'
import { cancelJob, S } from '../studio.ts'
import CoverArt from './CoverArt.vue'

const props = defineProps<{ job: Job }>()
const j = computed(() => props.job)

const STAGES: { key: Stage; label: string }[] = [
  { key: 'write', label: 'Write' },
  { key: 'load', label: 'Load' },
  { key: 'compose', label: 'Compose' },
  { key: 'sing', label: 'Sing' },
  { key: 'render', label: 'Render' },
  { key: 'decode', label: 'Decode' },
]
const ORDER: Stage[] = ['write', 'load', 'compose', 'sing', 'render', 'decode', 'save']

function stageState(key: Stage): 'done' | 'active' | 'todo' | 'skip' {
  if (key === 'write' && j.value.mode !== 'simple') return 'skip'
  if (key === 'compose' && j.value.cot === 'off') return 'skip'
  if (!j.value.stage) return 'todo'
  const cur = ORDER.indexOf(j.value.stage)
  const i = ORDER.indexOf(key)
  return i < cur ? 'done' : i === cur ? 'active' : 'todo'
}

function stageProgress(key: Stage): number {
  const st = stageState(key)
  if (st !== 'active') return st === 'done' ? 100 : 0
  if (key === 'render' && j.value.renderTotal) return (100 * j.value.renderStep) / j.value.renderTotal
  if (key === 'decode' && j.value.decodeTotal) return (100 * j.value.decodeStep) / j.value.decodeTotal
  return -1 // indeterminate
}

function stageSub(key: Stage): string {
  const x = j.value
  switch (key) {
    case 'write':
      return x.mode === 'simple' ? 'LLM lyrics' : 'yours'
    case 'load':
      return 'YuE2 · bf16'
    case 'compose':
      return x.cot === 'off' ? 'off' : x.abcTokens ? `${x.abcTokens} tok` : COT_SHORT[x.cot].toLowerCase()
    case 'sing':
      return x.semanticTokens ? `${fmtDuration(x.semanticTokens / TOKENS_PER_SECOND)}${x.tps ? ` · ${x.tps.toFixed(0)}/s` : ''}` : 'codec tokens'
    case 'render':
      return x.renderTotal ? `${x.renderStep}/${x.renderTotal}` : 'flow match'
    case 'decode':
      return x.decodeTotal ? `${x.decodeStep}/${x.decodeTotal}` : 'VAE'
    default:
      return ''
  }
}

const HEADLINE: Record<Stage, string> = {
  write: 'writing lyrics…',
  load: 'loading YuE2…',
  compose: 'composing the score…',
  sing: 'singing…',
  render: 'rendering audio…',
  decode: 'decoding…',
  save: 'saving…',
}

const elapsed = ref(0)
setInterval(() => {
  elapsed.value = j.value.startedAt ? (Date.now() - j.value.startedAt) / 1000 : 0
}, 500)

const score = computed(() => S.scores[j.value.id] ?? '')
const scoreEl = ref<HTMLElement>()
const showScore = ref(true)
watch(score, () => nextTick(() => scoreEl.value && (scoreEl.value.scrollTop = scoreEl.value.scrollHeight)))
</script>

<template>
  <div class="job card" :class="j.state">
    <div class="top">
      <div class="art">
        <CoverArt :seed="j.id" busy />
        <div v-if="j.state === 'running'" class="spin spinner" />
      </div>
      <div class="meta">
        <div class="title">
          {{ j.title ?? j.label }}
          <span v-if="j.of > 1" class="chip muted">take {{ j.index + 1 }}/{{ j.of }}</span>
        </div>
        <div class="style">{{ j.style || (j.mode === 'simple' ? 'style: written by the LLM' : 'no style given') }}</div>
        <div class="now mono">
          <template v-if="j.state === 'queued'">queued · seed {{ j.seed }}</template>
          <template v-else>
            {{ j.stage ? HEADLINE[j.stage] : 'starting…' }} · {{ fmtSec(elapsed) }}
          </template>
        </div>
      </div>
      <button class="btn sm ghost" title="Cancel" @click="cancelJob(j.id)">✕</button>
    </div>

    <div v-if="j.state === 'running'" class="stages">
      <div v-for="s in STAGES" :key="s.key" class="st" :class="stageState(s.key)">
        <div class="track">
          <i v-if="stageProgress(s.key) >= 0" :style="{ width: `${stageProgress(s.key)}%` }" />
          <i v-else class="indet" />
        </div>
        <div class="sl">{{ s.label }}</div>
        <div class="ss mono">{{ stageSub(s.key) }}</div>
      </div>
    </div>

    <div v-if="j.state === 'running' && score" class="scorebox">
      <div class="shead">
        <span class="label">Score</span>
        <span class="hint mono">ABC · {{ j.abcTokens }} tokens</span>
        <div class="grow" />
        <button class="link" @click="showScore = !showScore">{{ showScore ? 'hide' : 'show' }}</button>
      </div>
      <pre v-if="showScore" ref="scoreEl" class="abc mono">{{ score }}<i v-if="j.stage === 'compose'" class="caret" /></pre>
    </div>
  </div>
</template>

<style scoped>
.job {
  padding: 12px;
  margin-bottom: 10px;
}
.job.running {
  border-color: rgba(177, 140, 255, 0.35);
}
.job.queued {
  opacity: 0.7;
}
.top {
  display: flex;
  gap: 12px;
  align-items: center;
}
.art {
  flex: none;
  position: relative;
  width: 52px;
  height: 52px;
  border-radius: 8px;
  overflow: hidden;
}
.spin {
  position: absolute;
  inset: 0;
  margin: auto;
  border-color: rgba(255, 255, 255, 0.25);
  border-top-color: #fff;
}
.meta {
  flex: 1;
  min-width: 0;
}
.title {
  font-weight: 650;
  font-size: 13.5px;
  display: flex;
  gap: 8px;
  align-items: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.style {
  font-size: 12px;
  color: var(--text-2);
  margin-top: 2px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.now {
  font-size: 11px;
  color: var(--accent);
  margin-top: 4px;
}
.job.queued .now {
  color: var(--text-3);
}
.stages {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 8px;
  margin-top: 12px;
}
.track {
  height: 3px;
  border-radius: 2px;
  background: var(--panel-3);
  overflow: hidden;
  position: relative;
}
.track i {
  display: block;
  height: 100%;
  background: var(--accent);
  transition: width 0.3s;
}
.track i.indet {
  width: 35%;
  position: absolute;
  animation: indet 1.2s ease-in-out infinite;
}
@keyframes indet {
  from {
    left: -35%;
  }
  to {
    left: 100%;
  }
}
.sl {
  margin-top: 7px;
  font-size: 12px;
  color: var(--text-2);
}
.ss {
  font-size: 10.5px;
  color: var(--text-3);
  margin-top: 1px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.st.active .sl {
  color: var(--accent);
}
.st.done .track i {
  background: var(--accent-2);
}
.st.skip {
  opacity: 0.35;
}
.scorebox {
  margin-top: 12px;
  border-top: 1px solid var(--border);
  padding-top: 10px;
}
.shead {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.grow {
  flex: 1;
}
.abc {
  margin: 8px 0 0;
  max-height: 150px;
  overflow-y: auto;
  font-size: 11px;
  line-height: 1.5;
  color: #c9cdd1;
  white-space: pre-wrap;
  word-break: break-all;
  background: #0e0f10;
  border-radius: 6px;
  padding: 8px 10px;
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
</style>
