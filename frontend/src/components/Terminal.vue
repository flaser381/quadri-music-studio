<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { api } from '../api.ts'
import { S } from '../studio.ts'

const tab = ref<'output' | 'worker'>('output')
const el = ref<HTMLElement>()
const stick = ref(true)

const lines = computed(() => {
  const all = S.logs.filter((l) => l.channel === tab.value)
  return all.slice(-600)
})

function onScroll() {
  const e = el.value!
  stick.value = e.scrollHeight - e.scrollTop - e.clientHeight < 30
}

watch(
  () => [lines.value.length, tab.value],
  () => {
    if (stick.value) nextTick(() => el.value && (el.value.scrollTop = el.value.scrollHeight))
  },
  { immediate: true },
)

async function clear() {
  await api.clearLogs(tab.value).catch(() => {})
  S.logs = S.logs.filter((l) => l.channel !== tab.value)
}
</script>

<template>
  <div class="term">
    <div class="bar">
      <span class="label">Terminal</span>
      <button :class="{ on: tab === 'output' }" @click="tab = 'output'">Output</button>
      <button :class="{ on: tab === 'worker' }" @click="tab = 'worker'">Worker log</button>
      <div class="grow" />
      <button class="link" @click="clear">clear</button>
    </div>
    <div ref="el" class="out mono" @scroll="onScroll">
      <div v-for="(l, i) in lines" :key="i" class="ln" :class="l.level">{{ l.text }}</div>
      <div v-if="!lines.length" class="ln dim">{{ tab === 'output' ? 'studio messages, lyrics writer, finished songs' : 'YuE2 worker: model loading, token rates, torch warnings, errors' }}</div>
    </div>
  </div>
</template>

<style scoped>
.term {
  flex: none;
  height: 30%;
  min-height: 160px;
  display: flex;
  flex-direction: column;
  border-top: 1px solid var(--border);
  background: #0e0f10;
}
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
}
.bar .label {
  margin-right: 8px;
}
.bar > button:not(.link) {
  height: 22px;
  padding: 0 9px;
  border-radius: 5px;
  border: 1px solid transparent;
  background: none;
  color: var(--text-3);
  font-size: 11.5px;
  cursor: pointer;
}
.bar > button.on {
  border-color: var(--border-hi);
  color: var(--text);
  background: var(--panel-2);
}
.grow {
  flex: 1;
}
.out {
  flex: 1;
  overflow-y: auto;
  padding: 2px 12px 12px;
  font-size: 11.5px;
  line-height: 1.5;
}
.ln {
  white-space: pre-wrap;
  word-break: break-word;
  color: #c9cdd1;
}
.ln.dim {
  color: var(--text-3);
}
.ln.ok {
  color: var(--ok);
}
.ln.warn {
  color: var(--warn);
}
.ln.error {
  color: var(--bad);
}
</style>
