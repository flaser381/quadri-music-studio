<script setup lang="ts">
// Generated cover: two hues from the song's id + style, soft orb, and the song's own waveform as a ring of bars.
import { computed } from 'vue'
import { hash } from '../format.ts'

const props = defineProps<{ seed: string; peaks?: number[]; busy?: boolean; bars?: boolean }>()

const art = computed(() => {
  const h = hash(props.seed)
  const h1 = h % 360
  const h2 = (h1 + 40 + ((h >> 9) % 140)) % 360
  const angle = (h >> 17) % 360
  const ox = 25 + ((h >> 3) % 50)
  const oy = 20 + ((h >> 11) % 45)
  const id = `c${h.toString(36)}`
  return { h1, h2, angle, ox, oy, id }
})

/** 36 bars around a circle, lengths from the peaks */
const ring = computed(() => {
  const p = props.peaks
  if (!props.bars || !p?.length) return []
  const n = 36
  const out: { x1: number; y1: number; x2: number; y2: number }[] = []
  for (let i = 0; i < n; i++) {
    const a0 = Math.floor((i * p.length) / n)
    const a1 = Math.max(a0 + 1, Math.floor(((i + 1) * p.length) / n))
    const v = Math.max(...p.slice(a0, a1)) / 100
    const ang = (i / n) * Math.PI * 2 - Math.PI / 2
    const r0 = 22
    const r1 = r0 + 3 + v * 16
    out.push({ x1: 50 + Math.cos(ang) * r0, y1: 50 + Math.sin(ang) * r0, x2: 50 + Math.cos(ang) * r1, y2: 50 + Math.sin(ang) * r1 })
  }
  return out
})
</script>

<template>
  <svg class="cover" :class="{ busy }" viewBox="0 0 100 100" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
    <defs>
      <linearGradient :id="`${art.id}g`" :gradientTransform="`rotate(${art.angle} .5 .5)`">
        <stop offset="0" :stop-color="`hsl(${art.h1} 72% 58%)`" />
        <stop offset="1" :stop-color="`hsl(${art.h2} 70% 26%)`" />
      </linearGradient>
      <radialGradient :id="`${art.id}o`">
        <stop offset="0" :stop-color="`hsl(${art.h2} 90% 80% / .75)`" />
        <stop offset="1" :stop-color="`hsl(${art.h2} 90% 70% / 0)`" />
      </radialGradient>
    </defs>
    <rect width="100" height="100" :fill="`url(#${art.id}g)`" />
    <circle :cx="art.ox" :cy="art.oy" r="42" :fill="`url(#${art.id}o)`" />
    <rect width="100" height="100" fill="rgba(8,8,12,.18)" />
    <g v-if="ring.length" stroke="rgba(255,255,255,.78)" stroke-width="2.1" stroke-linecap="round">
      <line v-for="(l, i) in ring" :key="i" :x1="l.x1" :y1="l.y1" :x2="l.x2" :y2="l.y2" />
    </g>
    <circle v-if="ring.length" cx="50" cy="50" r="17" fill="rgba(10,10,14,.35)" stroke="rgba(255,255,255,.35)" stroke-width=".6" />
  </svg>
</template>

<style scoped>
.cover {
  display: block;
  width: 100%;
  height: 100%;
}
.cover.busy {
  animation: breathe 2.4s ease-in-out infinite;
}
@keyframes breathe {
  50% {
    filter: saturate(1.4) brightness(1.15);
  }
}
</style>
