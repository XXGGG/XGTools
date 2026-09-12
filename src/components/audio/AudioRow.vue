<script setup lang="ts">
/**
 * 音频试听页的一行：播放键 · 名字 · 波形（带裁剪把手）· 时长。
 *
 * # 一行上的几种按法
 *
 *  · 点一下（没怎么动）      —— 交给父组件：单选并试听 / Ctrl 加减选 / Shift 连选
 *  · 按住拖出去              —— 交给父组件：选中的那一批一起拖（进 Godot、进目录树）
 *  · 拖波形两头的把手        —— 裁掉头尾。**只影响拖出去的那一份**，原文件不动
 *
 * 点和拖靠「按下之后移动了多少」来分：超过阈值才算拖，不然手一抖点击就变成拖动了。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { loadPeaks, type AudioFile, type Peaks, type Trim } from '@/lib/audioPeaks'

/** 松手时带出去的信息：按了哪些键、点在不在波形上、点在第几秒 */
export type Press = { ctrl: boolean; shift: boolean; wave: boolean; t: number }

const props = defineProps<{
  file: AudioFile
  accent: string
  /** 被选中（多选时可以好几行） */
  selected: boolean
  /** 正在放（或刚放过、停在这一行）的就是它 */
  current: boolean
  playing: boolean
  /** 播放头（秒），只有 current 时有意义 */
  position: number
  trim: Trim | null
}>()

const emit = defineEmits<{
  (e: 'press', p: Press): void
  (e: 'trim', v: Trim): void
  (e: 'drag-out'): void
  (e: 'duration', d: number): void
}>()

const root = ref<HTMLElement | null>(null)
const wave = ref<HTMLCanvasElement | null>(null)
const waveBox = ref<HTMLElement | null>(null)
const peaks = ref<Peaks | null>(null)
/** 解码完了但解不出来（浏览器不认的格式、太大的文件） */
const noWave = ref(false)
const duration = computed(() => peaks.value?.duration ?? 0)

const ext = computed(() => props.file.name.split('.').pop()?.toUpperCase() ?? '')
const sizeText = computed(() => {
  const b = props.file.size
  if (b < 1024 * 1024) return `${Math.max(1, Math.round(b / 1024))} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
})

function fmt(t: number) {
  if (!isFinite(t) || t <= 0) return '0:00'
  if (t < 10) return t.toFixed(2) + 's'
  const m = Math.floor(t / 60)
  const s = Math.floor(t % 60)
  return `${m}:${String(s).padStart(2, '0')}`
}

/** 裁剪区间：没裁就是整段 */
const range = computed<Trim>(() => props.trim ?? { start: 0, end: duration.value })
const trimmed = computed(() => {
  const d = duration.value
  return !!props.trim && d > 0 && (props.trim.start > 0.005 || props.trim.end < d - 0.005)
})
const rangeLen = computed(() => Math.max(0, range.value.end - range.value.start))

// ── 波形：看得见才去解 ──

let io: IntersectionObserver | null = null
let ro: ResizeObserver | null = null
onMounted(() => {
  io = new IntersectionObserver((ents) => {
    if (!ents.some((e) => e.isIntersecting)) return
    io?.disconnect()
    io = null
    void loadPeaks(props.file.path, props.file.modified, props.file.size).then((p) => {
      peaks.value = p
      noWave.value = !p
      if (p) emit('duration', p.duration)
    })
  }, { rootMargin: '200px 0px' })
  if (root.value) io.observe(root.value)
  ro = new ResizeObserver(() => draw())
  if (waveBox.value) ro.observe(waveBox.value)
})
onBeforeUnmount(() => {
  io?.disconnect()
  ro?.disconnect()
})

function draw() {
  const c = wave.value
  const box = waveBox.value
  if (!c || !box) return
  const dpr = window.devicePixelRatio || 1
  const w = Math.max(1, Math.floor(box.clientWidth * dpr))
  const h = Math.max(1, Math.floor(box.clientHeight * dpr))
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  const g = c.getContext('2d')
  if (!g) return
  g.clearRect(0, 0, w, h)
  const p = peaks.value
  const d = duration.value
  if (!p || !p.max.length || d <= 0) return

  const fg = getComputedStyle(box).getPropertyValue('--foreground').trim() || '#888'
  const lit = props.current || trimmed.value
  const a = range.value.start / d
  const b = range.value.end / d
  const mid = h / 2
  const bar = Math.max(1, Math.round(dpr))

  for (let x = 0; x < w; x += bar + (dpr > 1 ? 1 : 0)) {
    const f0 = x / w
    const i0 = Math.floor(f0 * p.max.length)
    const i1 = Math.max(i0 + 1, Math.floor(((x + bar) / w) * p.max.length))
    let m = 0
    for (let i = i0; i < i1 && i < p.max.length; i++) if (p.max[i] > m) m = p.max[i]
    const bh = Math.max(bar, m * (h - 2 * dpr))
    const inside = f0 >= a && f0 <= b
    g.fillStyle = inside && lit ? props.accent : fg
    g.globalAlpha = inside ? (lit ? 0.95 : 0.55) : 0.16
    g.fillRect(x, mid - bh / 2, bar, bh)
  }
  g.globalAlpha = 1

  // 播放头
  if (props.current && props.position > 0) {
    const px = Math.round((props.position / d) * w)
    g.fillStyle = fg
    g.fillRect(px, 0, Math.max(1, Math.round(dpr)), h)
  }
}
watch([peaks, range, () => props.current, () => props.position, () => props.accent, trimmed], draw)

// ── 裁剪把手 ──

const handleA = computed(() => (duration.value ? (range.value.start / duration.value) * 100 : 0))
const handleB = computed(() => (duration.value ? (range.value.end / duration.value) * 100 : 100))
/** 两个把手之间至少留这么多秒，免得叠在一起抓不开 */
const MIN_GAP = 0.02

function timeAt(clientX: number) {
  const r = waveBox.value?.getBoundingClientRect()
  if (!r || !duration.value) return 0
  const f = Math.min(1, Math.max(0, (clientX - r.left) / r.width))
  return f * duration.value
}

function onHandleDown(which: 'start' | 'end', e: PointerEvent) {
  e.stopPropagation()
  e.preventDefault()
  if (!duration.value) return
  const el = e.currentTarget as HTMLElement
  el.setPointerCapture(e.pointerId)
  const move = (ev: PointerEvent) => {
    const t = timeAt(ev.clientX)
    const cur = range.value
    const next =
      which === 'start'
        ? { start: Math.min(t, cur.end - MIN_GAP), end: cur.end }
        : { start: cur.start, end: Math.max(t, cur.start + MIN_GAP) }
    emit('trim', { start: Math.max(0, next.start), end: Math.min(duration.value, next.end) })
  }
  const up = (ev: PointerEvent) => {
    el.releasePointerCapture(ev.pointerId)
    el.removeEventListener('pointermove', move)
    el.removeEventListener('pointerup', up)
  }
  el.addEventListener('pointermove', move)
  el.addEventListener('pointerup', up)
}

// ── 点 / 拖 ──

/** 按下之后移动超过这么多像素才算拖 */
const DRAG_THRESHOLD = 6

function onRowDown(e: PointerEvent) {
  if (e.button !== 0) return
  const onWave = !!waveBox.value?.contains(e.target as Node)
  const x0 = e.clientX
  const y0 = e.clientY
  let dragged = false
  const move = (ev: PointerEvent) => {
    if (dragged) return
    if (Math.abs(ev.clientX - x0) + Math.abs(ev.clientY - y0) < DRAG_THRESHOLD) return
    dragged = true
    cleanup()
    // 按钮还按着的时候交出去 —— 系统级的拖放必须在按住期间发起
    emit('drag-out')
  }
  const up = (ev: PointerEvent) => {
    cleanup()
    if (dragged) return
    const t = onWave && duration.value
      ? Math.min(range.value.end - 0.01, Math.max(range.value.start, timeAt(ev.clientX)))
      : 0
    emit('press', { ctrl: ev.ctrlKey || ev.metaKey, shift: ev.shiftKey, wave: onWave && duration.value > 0, t })
  }
  function cleanup() {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', up)
  }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', up)
}
</script>

<template>
  <div ref="root" @pointerdown="onRowDown"
    class="audio-row group grid items-center gap-3 rounded-lg px-2 py-1.5 select-none transition-colors"
    :class="selected ? 'bg-muted' : 'hover:bg-muted/50'">
    <!-- 播放键：一眼看出这一行能放、现在是不是在放 -->
    <span class="size-8 shrink-0 rounded-full flex items-center justify-center transition-colors"
      :style="current && playing ? { background: accent, color: '#fff' } : undefined"
      :class="current && playing ? '' : 'bg-muted-foreground/10 text-muted-foreground group-hover:text-foreground'">
      <span class="w-3.5 h-3.5" :class="current && playing ? 'icon-[lucide--pause]' : 'icon-[lucide--play]'" />
    </span>

    <div class="min-w-0">
      <div class="text-[14px] truncate" :title="file.name">{{ file.name }}</div>
      <!-- 连子文件夹一起列的时候，带上它在哪一层 —— 不然同名的分不清谁是谁 -->
      <div class="text-[11px] text-muted-foreground tabular-nums truncate" :title="file.dir || undefined">
        <template v-if="file.dir">{{ file.dir }} · </template>{{ ext }} · {{ sizeText }}
      </div>
    </div>

    <!-- 波形 + 两个裁剪把手 -->
    <div ref="waveBox" class="relative h-10 min-w-0 cursor-pointer">
      <canvas ref="wave" class="absolute inset-0 w-full h-full" />
      <div v-if="noWave" class="absolute inset-0 flex items-center">
        <div class="h-px w-full bg-muted-foreground/25" />
      </div>
      <template v-if="duration > 0">
        <div class="trim-handle" :style="{ left: handleA + '%', '--c': accent }"
          @pointerdown="onHandleDown('start', $event)" />
        <div class="trim-handle" :style="{ left: handleB + '%', '--c': accent }"
          @pointerdown="onHandleDown('end', $event)" />
      </template>
    </div>

    <div class="text-right tabular-nums w-16 shrink-0">
      <div class="text-[13px]" :style="trimmed ? { color: accent } : undefined">
        {{ fmt(trimmed ? rangeLen : duration) }}
      </div>
      <div v-if="trimmed" class="text-[11px] text-muted-foreground">
        <span class="icon-[lucide--scissors] w-3 h-3 align-[-2px]" /> {{ fmt(duration) }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.audio-row {
  grid-template-columns: auto minmax(0, 13rem) minmax(0, 1fr) auto;
}

/*
  裁剪把手：一条竖线，抓的地方比看得见的宽 —— 线只有 2px，
  真要让人对准 2px 去抓就太苛刻了，所以热区左右各多给 5px。
*/
.trim-handle {
  position: absolute;
  top: -2px;
  bottom: -2px;
  width: 12px;
  margin-left: -6px;
  cursor: ew-resize;
  z-index: 1;
}
.trim-handle::before {
  content: '';
  position: absolute;
  left: 5px;
  top: 0;
  bottom: 0;
  width: 2px;
  border-radius: 1px;
  background: var(--c);
  opacity: 0;
  transition: opacity 120ms ease;
}
.audio-row:hover .trim-handle::before,
.trim-handle:active::before {
  opacity: 0.9;
}
</style>
