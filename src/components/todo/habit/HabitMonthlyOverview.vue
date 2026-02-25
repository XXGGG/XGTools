<script setup lang="ts">
import { ref, computed } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import HabitClickableCalendar from './HabitClickableCalendar.vue'

const store = useTodoStore()

const now = new Date()
const viewYear = ref(now.getFullYear())
const viewMonth = ref(now.getMonth()) // 0-based

const monthLabel = computed(() => `${viewYear.value}年${viewMonth.value + 1}月`)

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
  <div class="space-y-6">
    <!-- 月份导航 -->
    <div class="flex items-center justify-center gap-4">
      <button @click="prevMonth" class="p-1.5 rounded-md hover:bg-accent transition-colors">
        <span class="icon-[lucide--chevron-left] w-4 h-4" />
      </button>
      <span class="text-sm font-medium min-w-24 text-center">{{ monthLabel }}</span>
      <button @click="nextMonth" class="p-1.5 rounded-md hover:bg-accent transition-colors">
        <span class="icon-[lucide--chevron-right] w-4 h-4" />
      </button>
    </div>

    <!-- 每个习惯的月历 -->
    <div class="grid grid-cols-3 gap-4">
      <div v-for="habit in store.activeHabits.value" :key="habit.id"
        class="border rounded-lg p-4">
        <div class="flex items-center gap-2 mb-3">
          <span :class="habit.icon" class="w-4 h-4 shrink-0" />
          <span class="text-sm font-medium truncate">{{ habit.text }}</span>
          <div class="flex-1" />
          <div class="flex items-center gap-1 text-[10px] text-muted-foreground" :title="`完成率 ${store.getHabitMonthlyRate(habit, viewYear, viewMonth + 1)}%`">
            <span class="icon-[lucide--percent] w-3 h-3" />
            <span>{{ store.getHabitMonthlyRate(habit, viewYear, viewMonth + 1) }}</span>
          </div>
          <div class="flex items-center gap-1 text-[10px] text-muted-foreground" :title="`本月 ${store.getHabitMonthlyCheckins(habit, viewYear, viewMonth + 1)} 次`">
            <span class="icon-[lucide--calendar-check] w-3 h-3" />
            <span>{{ store.getHabitMonthlyCheckins(habit, viewYear, viewMonth + 1) }}</span>
          </div>
        </div>
        <HabitClickableCalendar
          :habit="habit"
          :year="viewYear"
          :month="viewMonth"
          hide-footer
        />
      </div>
    </div>
  </div>
</template>
