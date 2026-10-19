<script setup lang="ts">
/**
 * 24 小时待办清单本体：主窗口的「待办」页和桌面置顶便签都用它（compact = 便签里那种紧凑样子）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { DAY, isActive, loadTodos, nextAt, remaining, saveTodos, type Todo } from '@/lib/todo24'

const props = defineProps<{ compact?: boolean }>()

const items = ref<Todo[]>([])
const now = ref(Date.now())
const text = ref('')
/** 期限：'24h' = 立下后 24 小时；其他是 HH:mm */
const until = ref('24h')

const QUICK = [
  { id: '1h', label: '1 小时' },
  { id: '3h', label: '3 小时' },
  { id: '24h', label: '24 小时' },
]

const active = computed(() => items.value.filter(t => isActive(t, now.value)).sort((a, b) => a.deadline - b.deadline))
const doneToday = computed(() => items.value.filter(t => t.doneAt && now.value - t.doneAt < DAY).sort((a, b) => b.doneAt! - a.doneAt!))

async function reload() {
  items.value = await loadTodos()
}

async function add() {
  const t = text.value.trim()
  if (!t) return
  const created = Date.now()
  let deadline = created + DAY
  if (until.value === '1h') deadline = created + 3600e3
  else if (until.value === '3h') deadline = created + 3 * 3600e3
  else if (/^\d{1,2}:\d{2}$/.test(until.value)) deadline = nextAt(until.value, created)
  items.value = [...items.value, { id: `t${created}`, text: t, createdAt: created, deadline }]
  text.value = ''
  await saveTodos(items.value)
}

async function toggle(t: Todo) {
  items.value = items.value.map(x => x.id === t.id ? { ...x, doneAt: x.doneAt ? undefined : Date.now() } : x)
  await saveTodos(items.value)
}

async function remove(t: Todo) {
  items.value = items.value.filter(x => x.id !== t.id)
  await saveTodos(items.value)
}

let timer = 0
let off: UnlistenFn | null = null
onMounted(async () => {
  await reload()
  timer = window.setInterval(() => { now.value = Date.now() }, 1000)
  off = await listen('todo24-changed', reload)
})
onBeforeUnmount(() => {
  window.clearInterval(timer)
  off?.()
})
</script>

<template>
  <div class="flex flex-col gap-3 min-h-0" :class="props.compact ? 'text-sm' : ''">
    <form class="flex gap-2 items-center" @submit.prevent="add">
      <input v-model="text" placeholder="24 小时内要做完的事…" class="flex-1 min-w-0 rounded-lg bg-background/60 border px-3 py-1.5 outline-none focus:border-primary/60">
      <template v-if="!props.compact">
        <button v-for="q in QUICK" :key="q.id" type="button" class="rounded-md px-2 py-1 text-xs"
          :class="until === q.id ? 'bg-primary/20 text-foreground' : 'text-muted-foreground hover:text-foreground'" @click="until = q.id">{{ q.label }}</button>
        <input type="time" class="rounded-md bg-background/60 border px-1.5 py-1 text-xs" title="或者挑一个时刻（24 小时内）"
          :value="/:/.test(until) ? until : ''" @change="(e) => { const v = (e.target as HTMLInputElement).value; if (v) until = v }">
      </template>
      <button type="submit" class="rounded-lg bg-primary/80 text-primary-foreground px-3 py-1.5 text-sm hover:bg-primary">立下</button>
    </form>

    <div class="flex-1 min-h-0 overflow-auto flex flex-col gap-1.5">
      <div v-if="!active.length" class="text-xs text-muted-foreground py-4 text-center">这 24 小时还没立下要做的事</div>
      <div v-for="t in active" :key="t.id" class="group rounded-lg px-3 py-2 bg-card/50 flex items-center gap-3">
        <button class="w-4 h-4 rounded-full border-2 border-muted-foreground/60 hover:border-primary shrink-0" @click="toggle(t)" />
        <div class="flex-1 min-w-0">
          <div class="truncate">{{ t.text }}</div>
          <div class="h-1 mt-1 rounded-full bg-muted overflow-hidden">
            <div class="h-full rounded-full transition-[width]" :class="remaining(t, now).ratio < 0.15 ? 'bg-red-400' : 'bg-primary/70'"
              :style="{ width: Math.max(2, remaining(t, now).ratio * 100) + '%' }" />
          </div>
        </div>
        <span class="xg-digits text-xs shrink-0" :class="remaining(t, now).over ? 'text-red-400' : 'text-muted-foreground'">{{ remaining(t, now).text }}</span>
        <button class="opacity-0 group-hover:opacity-100 text-muted-foreground hover:text-red-400" title="删除" @click="remove(t)">
          <span class="icon-[lucide--x] w-3.5 h-3.5" />
        </button>
      </div>

      <template v-if="doneToday.length && !props.compact">
        <div class="text-xs text-muted-foreground mt-3 px-1">今天做完的</div>
        <div v-for="t in doneToday" :key="t.id" class="group rounded-lg px-3 py-1.5 flex items-center gap-3 text-muted-foreground">
          <button class="w-4 h-4 rounded-full bg-primary/60 shrink-0 grid place-items-center" @click="toggle(t)">
            <span class="icon-[lucide--check] w-3 h-3 text-primary-foreground" />
          </button>
          <span class="flex-1 min-w-0 truncate line-through">{{ t.text }}</span>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* 倒计时每秒跳：数字要等宽，不然旁边跟着晃 */
.xg-digits {
  font-family: 'Segoe UI Variable Text', 'Segoe UI', sans-serif;
  font-variant-numeric: tabular-nums;
}
</style>
