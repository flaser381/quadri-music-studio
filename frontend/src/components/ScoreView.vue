<script setup lang="ts">
// YuE2's plan as sheet music (abcjs, loaded on demand) with the raw ABC as fallback.
import { onMounted, ref, watch } from 'vue'

const props = defineProps<{ abc: string }>()
const el = ref<HTMLElement>()
const failed = ref<string | null>(null)
const raw = ref(false)

async function render() {
  if (raw.value || !el.value) return
  failed.value = null
  try {
    const abcjs = await import('abcjs')
    abcjs.renderAbc(el.value, props.abc, {
      responsive: 'resize',
      foregroundColor: '#dfe2e6',
      paddingtop: 6,
      paddingbottom: 6,
      paddingleft: 4,
      paddingright: 4,
      staffwidth: 520,
      wrap: { minSpacing: 1.6, maxSpacing: 2.8, preferredMeasuresPerLine: 4 },
    })
  } catch (e) {
    failed.value = (e as Error).message
    raw.value = true
  }
}

onMounted(render)
watch(() => [props.abc, raw.value], render, { flush: 'post' })

async function copy() {
  await navigator.clipboard.writeText(props.abc).catch(() => {})
}
</script>

<template>
  <div class="score">
    <div class="bar">
      <button class="link" @click="raw = !raw">{{ raw ? 'sheet music' : 'ABC text' }}</button>
      <button class="link" @click="copy">copy</button>
      <span v-if="failed" class="hint">could not render: {{ failed }}</span>
    </div>
    <pre v-if="raw" class="abc mono">{{ abc }}</pre>
    <div v-else ref="el" class="sheet" />
  </div>
</template>

<style scoped>
.bar {
  display: flex;
  gap: 12px;
  align-items: baseline;
  margin-bottom: 8px;
}
.sheet {
  background: #111214;
  border-radius: 8px;
  padding: 4px;
}
.sheet :deep(svg) {
  display: block;
}
/* abcjs ignores foregroundColor for voice names */
.sheet :deep(text) {
  fill: #dfe2e6;
}
.abc {
  margin: 0;
  font-size: 11px;
  line-height: 1.5;
  color: #c9cdd1;
  white-space: pre-wrap;
  word-break: break-all;
  background: #0e0f10;
  border-radius: 8px;
  padding: 10px;
}
</style>
