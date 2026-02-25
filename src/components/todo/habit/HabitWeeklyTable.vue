<script setup lang="ts">
import { computed } from 'vue'
import { useTodoStore, getLocalDate } from '@/composables/useTodoStore'
import HabitStatCard from './HabitStatCard.vue'

const store = useTodoStore()

const WEEKDAY_LABELS = ['一', '二', '三', '四', '五', '六', '日']

/** 本周周一的日期 */
const weekStart = computed(() => {
  const d = new Date()
  const day = d.getDay()
  const offset = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - offset)
  return getLocalDate(d)
})

/** 本周 7 天的日期字符串 */
const weekDates = computed(() => {
  const dates: string[] = []
  const d = new Date(weekStart.value + 'T00:00')
  for (let i = 0; i < 7; i++) {
    dates.push(getLocalDate(d))
    d.setDate(d.getDate() + 1)
  }
  return dates
})

const todayStr = computed(() => store.todayDate.value)

/** 周打卡率 */
const weeklyRate = computed(() => {
  const habits = store.activeHabits.value
  if (habits.length === 0) return 0
  let checked = 0
  let total = 0
  for (const h of habits) {
    for (const date of weekDates.value) {
      if (date > todayStr.value) break
      if (date >= h.createdAt) {
        total++
        if (h.checkins[date]) checked++
      }
    }
  }
  if (total === 0) return 0
  return Math.round(checked / total * 100)
})

/** 完美天数（本周所有习惯都完成的天数） */
const perfectDays = computed(() => {
  const habits = store.activeHabits.value
  if (habits.length === 0) return 0
  let count = 0
  for (const date of weekDates.value) {
    if (date > todayStr.value) break
    const relevant = habits.filter(h => h.createdAt <= date)
    if (relevant.length > 0 && relevant.every(h => h.checkins[date])) {
      count++
    }
  }
  return count
})

/** 本周总完成数 */
const totalCheckins = computed(() => {
  let count = 0
  for (const h of store.activeHabits.value) {
    for (const date of weekDates.value) {
      if (date > todayStr.value) break
      if (h.checkins[date]) count++
    }
  }
  return count
})

/** 本周最高连续 */
const maxStreak = computed(() => {
  let max = 0
  for (const h of store.activeHabits.value) {
    const s = store.getHabitStreak(h)
    if (s > max) max = s
  }
  return max
})

function isClickable(date: string, createdAt: string): boolean {
  return date <= todayStr.value && date >= createdAt
}

function onClickCell(habitId: string, date: string) {
  const h = store.activeHabits.value.find(h => h.id === habitId)
  if (!h) return
  if (!isClickable(date, h.createdAt)) return
  store.toggleHabitCheckinForDate(h, date)
}
</script>

<template>
  <div class="space-y-4">
    <!-- 周表格 -->
    <div class="border rounded-lg overflow-hidden">
      <!-- 表头 -->
      <div class="grid border-b bg-muted/30" :style="{ gridTemplateColumns: 'minmax(100px, 1fr) repeat(7, 40px)' }">
        <div class="p-2 text-xs text-muted-foreground/60 font-medium">习惯</div>
        <div v-for="(label, i) in WEEKDAY_LABELS" :key="i"
          class="p-2 text-center text-xs font-medium"
          :class="weekDates[i] === todayStr ? 'text-primary' : 'text-muted-foreground/60'">
          <div>{{ label }}</div>
          <div class="text-[10px]">{{ parseInt(weekDates[i].slice(8)) }}</div>
        </div>
      </div>

      <!-- 每个习惯一行 -->
      <div v-for="habit in store.activeHabits.value" :key="habit.id"
        class="grid border-b last:border-b-0" :style="{ gridTemplateColumns: 'minmax(100px, 1fr) repeat(7, 40px)' }">
        <div class="p-2 flex items-center gap-2 min-w-0">
          <span :class="habit.icon" class="w-4 h-4 shrink-0" />
          <span class="text-sm truncate">{{ habit.text }}</span>
        </div>
        <div v-for="(date, i) in weekDates" :key="i"
          class="flex items-center justify-center transition-colors"
          :class="[
            isClickable(date, habit.createdAt) ? 'cursor-pointer hover:bg-accent/50' : '',
            date > todayStr ? 'opacity-20' : '',
          ]"
          @click="onClickCell(habit.id, date)"
        >
          <span v-if="habit.checkins[date]"
            class="icon-[lucide--check] w-4 h-4 text-primary" />
          <span v-else-if="date <= todayStr && date >= habit.createdAt"
            class="w-2 h-2 rounded-full bg-muted/50" />
        </div>
      </div>
    </div>

    <!-- 统计卡片 -->
    <div class="grid grid-cols-4 gap-3">
      <HabitStatCard label="打卡率" :value="weeklyRate" suffix="%" icon="icon-[lucide--percent]" />
      <HabitStatCard label="完美天数" :value="perfectDays" icon="icon-[lucide--sparkles]" />
      <HabitStatCard label="总完成" :value="totalCheckins" icon="icon-[lucide--check-check]" />
      <HabitStatCard label="最高连续" :value="maxStreak" suffix="天" icon="icon-[lucide--flame]" />
    </div>
  </div>
</template>
