<script setup lang="ts">
import { ref, computed } from 'vue'
import type { HabitItem } from '@/types/todo'
import { getLocalDate } from '@/composables/useTodoStore'

const props = defineProps<{
  habit: HabitItem
}>()

defineEmits<{
  close: []
}>()

const now = new Date()
const viewYear = ref(now.getFullYear())
const viewMonth = ref(now.getMonth()) // 0-based

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

const monthLabel = computed(() =>
  `${viewYear.value}年${viewMonth.value + 1}月`
)

const days = computed(() => {
  const y = viewYear.value
  const m = viewMonth.value
  const firstDay = new Date(y, m, 1)
  const lastDay = new Date(y, m + 1, 0)
  const totalDays = lastDay.getDate()

  // 周一为起始 (getDay: 0=Sun → offset 6, 1=Mon → offset 0, ...)
  let startOffset = firstDay.getDay() - 1
  if (startOffset < 0) startOffset = 6

  const cells: { date: string; day: number; inMonth: boolean; checked: boolean; isToday: boolean }[] = []

  // 上月填充
  for (let i = 0; i < startOffset; i++) {
    cells.push({ date: '', day: 0, inMonth: false, checked: false, isToday: false })
  }

  const todayStr = getLocalDate()

  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    cells.push({
      date: dateStr,
      day: d,
      inMonth: true,
      checked: !!props.habit.checkins[dateStr],
      isToday: dateStr === todayStr,
    })
  }

  return cells
})

const streak = computed(() => {
  let count = 0
  const d = new Date()
  if (!props.habit.checkins[getLocalDate(d)]) {
    d.setDate(d.getDate() - 1)
  }
  while (props.habit.checkins[getLocalDate(d)]) {
    count++
    d.setDate(d.getDate() - 1)
  }
  return count
})

const totalCheckins = computed(() =>
  Object.keys(props.habit.checkins).length
)

function prevMonth() {
  if (viewMonth.value === 0) {
    viewMonth.value = 11
    viewYear.value--
  } else {
    viewMonth.value--
  }
}

function nextMonth() {
  if (viewMonth.value === 11) {
    viewMonth.value = 0
    viewYear.value++
  } else {
    viewMonth.value++
  }
}
</script>

<template>
  <div class="p-3 w-64">
    <!-- 头部 -->
    <div class="flex items-center justify-between mb-3">
      <button @click="prevMonth" class="p-1 rounded hover:bg-accent transition-colors">
        <span class="icon-[lucide--chevron-left] w-4 h-4" />
      </button>
      <span class="text-sm font-medium">{{ monthLabel }}</span>
      <button @click="nextMonth" class="p-1 rounded hover:bg-accent transition-colors">
        <span class="icon-[lucide--chevron-right] w-4 h-4" />
      </button>
    </div>

    <!-- 星期标题 -->
    <div class="grid grid-cols-7 gap-0.5 mb-1">
      <div v-for="label in WEEKDAY_LABELS" :key="label"
        class="text-center text-[10px] text-muted-foreground/50 font-medium">
        {{ label }}
      </div>
    </div>

    <!-- 日期格子 -->
    <div class="grid grid-cols-7 gap-0.5">
      <div v-for="(cell, i) in days" :key="i"
        class="aspect-square flex items-center justify-center text-xs rounded-md relative"
        :class="{
          'text-transparent': !cell.inMonth,
          'bg-primary/15 text-primary font-medium': cell.checked,
          'ring-1 ring-primary/50': cell.isToday,
          'text-muted-foreground': cell.inMonth && !cell.checked,
        }"
      >
        <span v-if="cell.inMonth">{{ cell.day }}</span>
        <span v-if="cell.checked"
          class="absolute bottom-0.5 w-1 h-1 rounded-full bg-primary" />
      </div>
    </div>

    <!-- 统计 -->
    <div class="mt-3 pt-3 border-t flex items-center justify-between text-xs text-muted-foreground">
      <div class="flex items-center gap-1">
        <span class="icon-[lucide--flame] w-3.5 h-3.5 text-orange-500" />
        <span>连续 {{ streak }} 天</span>
      </div>
      <span>累计 {{ totalCheckins }} 次</span>
    </div>
  </div>
</template>
