<script setup lang="ts">
/**
 * 选颜色。不用 <input type="color">：那个点开是 Windows 系统的取色对话框，和应用对不上。
 * 点开：上面一块饱和度 / 明度的方块，下面一条色相，再下面填十六进制。拖动就实时改。
 * 触发按钮由使用的地方自己放进默认插槽（比如一个虚线框加号）。
 */
import { computed, ref, watch } from 'vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const props = defineProps<{ modelValue: string }>()
const emit = defineEmits<{ 'update:modelValue': [string] }>()

const open = ref(false)
const h = ref(0)
const s = ref(0)
const v = ref(1)
const hex = ref('#ffffff')

function hexToHsv(x: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(x.trim())
  if (!m) return [0, 0, 1]
  const n = parseInt(m[1], 16)
  const r = (n >> 16 & 255) / 255, g = (n >> 8 & 255) / 255, b = (n & 255) / 255
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min
  let hh = 0
  if (d) hh = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [(hh * 60 + 360) % 360, max ? d / max : 0, max]
}
function hsvToHex(hh: number, ss: number, vv: number) {
  const f = (k: number) => {
    const n = (k + hh / 60) % 6
    return vv - vv * ss * Math.max(0, Math.min(n, 4 - n, 1))
  }
  return '#' + [f(5), f(3), f(1)].map(x => Math.round(x * 255).toString(16).padStart(2, '0')).join('')
}

watch(() => props.modelValue, (c) => {
  if (!/^#?[0-9a-f]{6}$/i.test(c)) return
  if (c.toLowerCase() === hex.value.toLowerCase()) return
  ;[h.value, s.value, v.value] = hexToHsv(c)
  hex.value = c.startsWith('#') ? c : `#${c}`
}, { immediate: true })

function commit() {
  hex.value = hsvToHex(h.value, s.value, v.value)
  emit('update:modelValue', hex.value)
}

const hueColor = computed(() => hsvToHex(h.value, 1, 1))

function drag(e: PointerEvent, el: HTMLElement, onMove: (x: number, y: number) => void) {
  const move = (ev: PointerEvent) => {
    const r = el.getBoundingClientRect()
    onMove(Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height)))
  }
  move(e)
  el.setPointerCapture(e.pointerId)
  el.onpointermove = move
  el.onpointerup = () => { el.onpointermove = null; el.onpointerup = null }
}
const onSV = (e: PointerEvent) => drag(e, e.currentTarget as HTMLElement, (x, y) => { s.value = x; v.value = 1 - y; commit() })
const onHue = (e: PointerEvent) => drag(e, e.currentTarget as HTMLElement, (x) => { h.value = x * 360; commit() })

function onHex(e: Event) {
  const val = (e.target as HTMLInputElement).value.trim()
  const c = val.startsWith('#') ? val : `#${val}`
  if (!/^#[0-9a-f]{6}$/i.test(c)) return
  ;[h.value, s.value, v.value] = hexToHsv(c)
  hex.value = c
  emit('update:modelValue', c)
}
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <slot />
    </PopoverTrigger>
    <PopoverContent :side-offset="6" class="w-56 p-3 space-y-3">
      <div class="relative h-36 rounded-md cursor-crosshair touch-none select-none"
        :style="{ background: `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, ${hueColor})` }"
        @pointerdown="onSV">
        <span class="absolute size-3.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow pointer-events-none"
          :style="{ left: `${s * 100}%`, top: `${(1 - v) * 100}%`, background: hex }" />
      </div>
      <div class="relative h-3 rounded-full cursor-pointer touch-none select-none"
        style="background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00)" @pointerdown="onHue">
        <span class="absolute top-1/2 size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white shadow pointer-events-none"
          :style="{ left: `${(h / 360) * 100}%`, background: hueColor }" />
      </div>
      <div class="flex items-center gap-2">
        <span class="size-7 shrink-0 rounded-md border" :style="{ background: hex }" />
        <input :value="hex" spellcheck="false"
          class="flex-1 min-w-0 rounded-md border bg-background/60 px-2 py-1 text-sm font-mono uppercase outline-none focus:ring-1 focus:ring-ring"
          @change="onHex">
      </div>
    </PopoverContent>
  </Popover>
</template>
