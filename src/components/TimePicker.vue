<script setup lang="ts">
/**
 * 选时间（HH:MM）。不用浏览器自带的 <input type="time">：那个弹出来的是系统样式的滚轮，和应用对不上。
 * 点开是两列：小时 0–23、分钟（默认 5 分钟一档），当前值滚到中间并高亮。
 */
import { computed, nextTick, ref, watch } from 'vue'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const props = withDefaults(defineProps<{ modelValue: string; minuteStep?: number }>(), { minuteStep: 5 })
const emit = defineEmits<{ 'update:modelValue': [string]; change: [string] }>()

const open = ref(false)
const hour = computed(() => Number(props.modelValue.split(':')[0] ?? 0))
const minute = computed(() => Number(props.modelValue.split(':')[1] ?? 0))
const HOURS = Array.from({ length: 24 }, (_, i) => i)
const minutes = computed(() => {
  const list = Array.from({ length: Math.ceil(60 / props.minuteStep) }, (_, i) => i * props.minuteStep)
  // 现在的值不在档位上（比如 07:03）也要列出来，不然选不中它
  if (!list.includes(minute.value)) list.push(minute.value)
  return list.sort((a, b) => a - b)
})
const pad = (n: number) => String(n).padStart(2, '0')

function set(h: number, m: number) {
  const v = `${pad(h)}:${pad(m)}`
  emit('update:modelValue', v)
  emit('change', v)
}

const hourCol = ref<HTMLElement | null>(null)
const minCol = ref<HTMLElement | null>(null)
watch(open, async (o) => {
  if (!o) return
  await nextTick()
  for (const col of [hourCol.value, minCol.value]) col?.querySelector<HTMLElement>('[data-on="1"]')?.scrollIntoView({ block: 'center' })
})
</script>

<template>
  <Popover v-model:open="open">
    <PopoverTrigger as-child>
      <button class="inline-flex items-center gap-1.5 rounded-md border bg-background/60 px-2 py-0.5 text-sm tabular-nums hover:bg-muted/60 transition-colors"
        :class="{ 'ring-1 ring-ring': open }">
        {{ modelValue }}
        <span class="icon-[lucide--clock] w-3.5 h-3.5 text-muted-foreground" />
      </button>
    </PopoverTrigger>
    <PopoverContent align="start" :side-offset="6" class="w-auto p-1.5">
      <div class="flex gap-1">
        <div ref="hourCol" class="h-52 w-12 overflow-y-auto scrollbar-none space-y-0.5">
          <button v-for="h in HOURS" :key="h" :data-on="h === hour ? 1 : 0"
            class="w-full rounded-md py-1 text-sm tabular-nums transition-colors"
            :class="h === hour ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
            @click="set(h, minute)">{{ pad(h) }}</button>
        </div>
        <div class="w-px bg-border my-1" />
        <div ref="minCol" class="h-52 w-12 overflow-y-auto scrollbar-none space-y-0.5">
          <button v-for="m in minutes" :key="m" :data-on="m === minute ? 1 : 0"
            class="w-full rounded-md py-1 text-sm tabular-nums transition-colors"
            :class="m === minute ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'"
            @click="set(hour, m); open = false">{{ pad(m) }}</button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
</template>

<style scoped>
.scrollbar-none { scrollbar-width: none; }
.scrollbar-none::-webkit-scrollbar { display: none; }
</style>
