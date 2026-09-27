<script setup lang="ts">
// Bar waveform from the song's peaks; played part in the accent colour, click/drag to seek.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ peaks: number[]; progress: number; height?: number }>()
const emit = defineEmits<{ seek: [frac: number] }>()

const canvas = ref<HTMLCanvasElement>()
const hover = ref<number | null>(null)
let ro: ResizeObserver | null = null

function css(name: string) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim()
}

function draw() {
  const c = canvas.value
  if (!c) return
  const dpr = window.devicePixelRatio || 1
  const w = c.clientWidth
  const h = props.height ?? 40
  if (!w) return
  c.width = Math.round(w * dpr)
  c.height = Math.round(h * dpr)
  const ctx = c.getContext('2d')!
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, w, h)
  const bar = 2
  const gap = 1.5
  const n = Math.max(1, Math.floor(w / (bar + gap)))
  const p = props.peaks.length ? props.peaks : [0]
  const played = css('--accent')
  const rest = '#3a3d42'
  const ahead = '#6b5a99'
  for (let i = 0; i < n; i++) {
    const a = Math.floor((i * p.length) / n)
    const b = Math.max(a + 1, Math.floor(((i + 1) * p.length) / n))
    let v = 0
    for (let k = a; k < b; k++) v = Math.max(v, p[k] ?? 0)
    const bh = Math.max(2, (v / 100) * (h - 2))
    const x = i * (bar + gap)
    const frac = (i + 0.5) / n
    ctx.fillStyle = frac <= props.progress ? played : hover.value !== null && frac <= hover.value ? ahead : rest
    ctx.beginPath()
    ctx.roundRect(x, (h - bh) / 2, bar, bh, 1)
    ctx.fill()
  }
}

function frac(e: MouseEvent) {
  const r = canvas.value!.getBoundingClientRect()
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width))
}
let dragging = false
function down(e: MouseEvent) {
  dragging = true
  emit('seek', frac(e))
  const move = (ev: MouseEvent) => dragging && emit('seek', frac(ev))
  const up = () => {
    dragging = false
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

onMounted(() => {
  ro = new ResizeObserver(draw)
  ro.observe(canvas.value!)
  draw()
})
onBeforeUnmount(() => ro?.disconnect())
watch(() => [props.peaks, props.progress, hover.value], draw)
</script>

<template>
  <canvas
    ref="canvas"
    class="wave"
    :style="{ height: `${height ?? 40}px` }"
    @mousedown="down"
    @mousemove="hover = frac($event)"
    @mouseleave="hover = null"
  />
</template>

<style scoped>
.wave {
  display: block;
  width: 100%;
  cursor: pointer;
}
</style>
