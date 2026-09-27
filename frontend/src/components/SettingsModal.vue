<script setup lang="ts">
import { computed } from 'vue'
import { activeJobs, freeWorker, S, updateSettings } from '../studio.ts'

const rows = computed(() => {
  const p = S.paths
  const m = S.status?.models
  if (!p) return []
  return [
    { k: 'Data (songs)', v: p.dataDir },
    { k: 'YuE2-3B (4B, bf16)', v: p.modelDir, ok: m?.yue2 },
    { k: 'YuE2-Vae (48 kHz)', v: p.vaeDir, ok: m?.vae },
    { k: `Python (PyTorch ${S.status?.gpu === 'nvidia' ? 'CUDA' : 'ROCm'})`, v: p.python, ok: m?.venv },
    { k: 'Worker', v: p.worker },
    ...(S.status?.engine ? [{ k: 'GPU', v: S.status.engine }] : []),
    { k: 'Lyrics LLM', v: `${p.llmUrl}${S.status?.llmModel ? ` · ${S.status.llmModel}` : ''}`, ok: S.status?.llmReady || undefined },
    ...(p.llmGguf ? [{ k: 'Lyrics model (llama.cpp)', v: p.llmGguf }] : []),
  ]
})
const KEEP = [0, 2, 5, 10, 30, 60]
</script>

<template>
  <div class="modal-back" @click.self="S.modal = null">
    <div class="modal settings">
      <div class="modal-head">
        <h2>Paths &amp; settings</h2>
        <button class="btn ghost" @click="S.modal = null">✕</button>
      </div>
      <div class="body">
        <div class="label">Files</div>
        <div v-for="r in rows" :key="r.k" class="row">
          <span class="k">{{ r.k }}</span>
          <span class="v mono">{{ r.v }}</span>
          <span v-if="r.ok !== undefined" class="dot" :class="r.ok ? 'ok' : 'bad'">{{ r.ok ? '✓' : 'missing' }}</span>
        </div>

        <div class="label sp">GPU &amp; memory</div>
        <label v-if="S.status?.others.length || S.settings.autoStopOthers === false" class="check">
          <input type="checkbox" :checked="S.settings.autoStopOthers" @change="updateSettings({ autoStopOthers: ($event.target as HTMLInputElement).checked })" />
          <div>
            <div class="t">Stop other GPU apps before singing</div>
            <div class="hint">Stops the containers listed in STOP_CONTAINERS (config.env) before YuE2 loads; it needs up to 14 GB of VRAM.</div>
          </div>
        </label>
        <div class="line">
          <div>
            <div class="t">Keep YuE2 loaded after a song</div>
            <div class="hint">Saves the model load for the next song. It holds RAM and VRAM meanwhile; other apps can ask it to unload (POST /api/free).</div>
          </div>
          <select class="field keep" :value="S.settings.keepLoadedMin" @change="updateSettings({ keepLoadedMin: Number(($event.target as HTMLSelectElement).value) })">
            <option v-for="k in KEEP" :key="k" :value="k">{{ k ? `${k} min` : 'unload now' }}</option>
          </select>
        </div>
        <div class="line">
          <div>
            <div class="t">Decode backend</div>
            <div class="hint">Graphs replay each decode step as one CUDA/HIP graph (fast). Eager is plain PyTorch, a fallback if graphs misbehave on your driver.</div>
          </div>
          <div class="seg be">
            <button :class="{ on: S.settings.backend === 'torch' }" @click="updateSettings({ backend: 'torch' })">graphs</button>
            <button :class="{ on: S.settings.backend === 'torch-eager' }" @click="updateSettings({ backend: 'torch-eager' })">eager</button>
          </div>
        </div>
        <div class="acts">
          <button class="btn" :disabled="!!activeJobs().length || S.status?.worker === 'stopped'" @click="freeWorker()">Unload YuE2 now</button>
        </div>
        <p class="hint lic">YuE2 weights: CC BY-NC 4.0 (non-commercial use). Settings like ports, model folders and the lyrics LLM are in config.env.</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.settings {
  width: min(840px, 100%);
}
.body {
  padding: 16px;
  overflow-y: auto;
  display: grid;
  gap: 10px;
}
.row {
  display: grid;
  grid-template-columns: 190px 1fr auto;
  gap: 12px;
  align-items: baseline;
  font-size: 12.5px;
}
.k {
  color: var(--text-2);
}
.v {
  font-size: 11.5px;
  word-break: break-all;
}
.dot {
  font-size: 11px;
}
.dot.ok {
  color: var(--ok);
}
.dot.bad {
  color: var(--warn);
}
.sp {
  margin-top: 12px;
}
.check .hint,
.line .hint {
  margin-top: 2px;
}
.line {
  display: flex;
  gap: 16px;
  align-items: center;
  padding-left: 25px;
}
.line > div:first-child {
  flex: 1;
}
.t {
  font-weight: 600;
  font-size: 13px;
}
.keep {
  width: 190px;
  height: 30px;
  font-size: 12.5px;
}
.be {
  width: 190px;
}
.be button {
  height: 22px;
}
.acts {
  display: flex;
  gap: 8px;
  margin-top: 6px;
}
.lic {
  margin: 4px 0 0;
}
</style>
