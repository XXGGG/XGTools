<script setup lang="ts">
import { ref, computed } from 'vue'
import type { HabitItem } from '@/types/todo'
import { useTodoStore, getLocalDate } from '@/composables/useTodoStore'

const props = defineProps<{
  habit: HabitItem
  /** 外部控制年月（用于月度总览同步导航） */
  year?: number
  month?: number // 0-based
  /** 隐藏底部统计栏 */
  hideFooter?: boolean
}>()

const store = useTodoStore()

const now = new Date()
const internalYear = ref(now.getFullYear())
const internalMonth = ref(now.getMonth())

const viewYear = computed(() => props.year ?? internalYear.value)
const viewMonth = computed(() => props.month ?? internalMonth.value)

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

  let startOffset = firstDay.getDay() - 1
  if (startOffset < 0) startOffset = 6

  const cells: { date: string; day: number; inMonth: boolean; checked: boolean; isToday: boolean; clickable: boolean }[] = []

  for (let i = 0; i < startOffset; i++) {
    cells.push({ date: '', day: 0, inMonth: false, checked: false, isToday: false, clickable: false })
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
      clickable: dateStr <= todayStr,
    })
  }

  return cells
})

const checkedCount = computed(() => {
  const y = viewYear.value
  const m = viewMonth.value + 1
  return store.getHabitMonthlyCheckins(props.habit, y, m)
})

const rate = computed(() => {
  const y = viewYear.value
  const m = viewMonth.value + 1
  return store.getHabitMonthlyRate(props.habit, y, m)
})

function prevMonth() {
  if (internalMonth.value === 0) {
    internalMonth.value = 11
    internalYear.value--
  } else {
    internalMonth.value--
  }
}

function nextMonth() {
  if (internalMonth.value === 11) {
    internalMonth.value = 0
    internalYear.value++
  } else {
    internalMonth.value++
  }
}

function onClickDay(cell: typeof days.value[0]) {
  if (!cell.clickable) return
  store.toggleHabitCheckinForDate(props.habit, cell.date)
}
</script>

<template>
  <div>
    <!-- 头部（仅在无外部控制时显示导航） -->
    <div v-if="year == null" class="flex items-center justify-between mb-3">
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
        class="aspect-square flex items-center justify-center text-xs rounded-full relative transition-colors"
        :class="[
          !cell.inMonth ? 'text-transparent' : '',
          cell.checked ? 'bg-primary text-primary-foreground font-medium hover:opacity-90' : '',
          cell.isToday && !cell.checked ? 'font-medium text-foreground' : '',
          cell.inMonth && !cell.checked ? 'text-muted-foreground' : '',
          cell.clickable && !cell.checked ? 'cursor-pointer hover:bg-accent/50' : '',
          cell.clickable && cell.checked ? 'cursor-pointer' : '',
        ]"
        @click="onClickDay(cell)"
      >
        <span v-if="cell.inMonth">{{ cell.day }}</span>
      </div>
    </div>

    <!-- 统计 -->
    <div v-if="!hideFooter" class="mt-3 pt-3 border-t flex items-center justify-end gap-3 text-[10px] text-muted-foreground">
      <div class="flex items-center gap-1" :title="`完成率 ${rate}%`">
        <span class="icon-[lucide--percent] w-3 h-3" />
        <span>{{ rate }}</span>
      </div>
      <div class="flex items-center gap-1" :title="`本月 ${checkedCount} 次`">
        <span class="icon-[lucide--calendar-check] w-3 h-3" />
        <span>{{ checkedCount }}</span>
      </div>
    </div>
  </div>
</template>
