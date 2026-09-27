<script setup lang="ts">
import { computed } from 'vue'
import { fmtDuration, TOKENS_PER_SECOND } from '../../../shared/music.ts'
import { activeJobs, freeWorker, runningJob, S } from '../studio.ts'

const STAGE_LABEL = { write: 'writing lyrics', load: 'loading', compose: 'composing', sing: 'singing', render: 'rendering', decode: 'decoding', save: 'saving' }

const state = computed(() => {
  if (!S.online) return { cls: 'bad', text: 'backend offline' }
  const j = runningJob()
  if (j?.stage) {
    const extra =
      j.stage === 'sing' ? ` ${fmtDuration(j.semanticTokens / TOKENS_PER_SECOND)}` : j.stage === 'render' && j.renderTotal ? ` ${Math.round((100 * j.renderStep) / j.renderTotal)}%` : ''
    return { cls: 'busy', text: `${STAGE_LABEL[j.stage]}${extra}` }
  }
  if (j) return { cls: 'busy', text: 'starting' }
  return { cls: 'ok', text: 'idle' }
})

const vram = computed(() => {
  const st = S.status
  if (!st?.vramTotal || st.vramFree == null) return null
  const used = (st.vramTotal - st.vramFree) / 2 ** 30
  return { used, total: st.vramTotal / 2 ** 30, pct: (100 * (st.vramTotal - st.vramFree)) / st.vramTotal }
})

const WORKER = { stopped: '', starting: 'YuE2 loading', ready: 'YuE2 loaded', busy: 'YuE2 working' }
const others = computed(() => S.status?.others ?? [])
</script>

<template>
  <header>
    <div class="logo">quadri <b>music</b> <span>studio</span></div>
    <button class="btn" @click="S.modal = 'settings'">⚙ Settings</button>

    <div class="grow" />

    <div
      v-if="others.length"
      class="chip2 warn"
      :title="S.settings.autoStopOthers ? 'holds VRAM; stopped automatically before YuE2 sings' : 'auto-stop is off: YuE2 may run out of VRAM'"
    >
      {{ others.join(', ') }}
    </div>
    <div v-if="S.status?.llmLocal && S.status.llmLocal !== 'stopped'" class="chip2 info" title="lyrics writer (llama-server), stopped before YuE2 sings">
      lyrics LLM {{ S.status.llmLocal === 'starting' ? 'loading' : 'loaded' }}
    </div>
    <div v-if="S.status && S.status.worker !== 'stopped'" class="chip2 info" :title="`keeps loaded ${S.settings.keepLoadedMin} min after the last song`">
      {{ WORKER[S.status.worker] }}
    </div>
    <div v-if="S.status?.memAvailable" class="ram mono" title="available RAM">{{ (S.status.memAvailable / 2 ** 30).toFixed(0) }}<small> GB free</small></div>
    <div v-if="vram" class="vram" :title="`${vram.used.toFixed(1)} / ${vram.total.toFixed(1)} GiB VRAM in use`">
      <span class="mono">{{ vram.used.toFixed(1) }}<small>/{{ vram.total.toFixed(0) }} GB</small></span>
      <div class="bar"><i :style="{ width: `${vram.pct}%` }" /></div>
      <button class="btn ghost sm" :disabled="!!activeJobs().length || S.status?.worker === 'stopped'" title="Unload YuE2 (frees RAM + VRAM)" @click="freeWorker()">free</button>
    </div>
    <div class="status" :class="state.cls"><i />{{ state.text }}</div>
  </header>
</template>

<style scoped>
header {
  height: 50px;
  flex: none;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--panel);
}
.logo {
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  margin-right: 14px;
  white-space: nowrap;
}
.logo span {
  color: var(--accent);
  font-weight: 500;
}
.grow {
  flex: 1;
}
.status {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12.5px;
  color: var(--text-2);
  white-space: nowrap;
  min-width: 70px;
  justify-content: flex-end;
}
.status i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--ok);
}
.status.bad i {
  background: var(--bad);
}
.status.bad {
  color: var(--bad);
}
.status.busy i {
  background: var(--warn);
  animation: pulse 1s ease-in-out infinite;
}
.status.busy {
  color: var(--text);
}
@keyframes pulse {
  50% {
    opacity: 0.3;
  }
}
.ram {
  font-size: 12px;
  color: var(--text-2);
}
.ram small,
.vram small {
  color: var(--text-3);
}
.vram {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-2);
  padding-right: 6px;
}
.bar {
  width: 70px;
  height: 5px;
  border-radius: 3px;
  background: var(--panel-3);
  overflow: hidden;
}
.bar i {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, var(--accent-2), var(--accent));
  transition: width 0.4s;
}
.chip2 {
  font-size: 11.5px;
  padding: 3px 8px;
  border-radius: 6px;
  white-space: nowrap;
}
.chip2.warn {
  color: var(--warn);
  background: rgba(245, 184, 74, 0.1);
}
.chip2.info {
  color: var(--info);
  background: rgba(122, 167, 255, 0.1);
}
</style>
