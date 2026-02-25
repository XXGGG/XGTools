<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import type { HabitItem } from '@/types/todo'
import HabitClickableCalendar from './HabitClickableCalendar.vue'
import HabitYearlyHeatmap from './HabitYearlyHeatmap.vue'
import HabitStatCard from './HabitStatCard.vue'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const store = useTodoStore()

const selectedId = ref<string>('')
const now = new Date()
const heatmapYear = ref(now.getFullYear())

// 默认选第一个
watch(() => store.activeHabits.value, (habits) => {
  if (habits.length > 0 && !habits.find(h => h.id === selectedId.value)) {
    selectedId.value = habits[0].id
  }
}, { immediate: true })

const selectedHabit = computed<HabitItem | null>(() =>
  store.activeHabits.value.find(h => h.id === selectedId.value) ?? null
)

// ── 月度趋势（近 6 个月） ──

const monthlyTrend = computed(() => {
  if (!selectedHabit.value) return []
  const h = selectedHabit.value
  const result: { label: string; rate: number }[] = []
  const d = new Date()
  for (let i = 5; i >= 0; i--) {
    const date = new Date(d.getFullYear(), d.getMonth() - i, 1)
    const y = date.getFullYear()
    const m = date.getMonth() + 1
    result.push({
      label: `${m}月`,
      rate: store.getHabitMonthlyRate(h, y, m),
    })
  }
  return result
})

const maxTrendRate = computed(() => {
  const max = Math.max(...monthlyTrend.value.map(t => t.rate), 1)
  return Math.max(max, 100)
})
</script>

<template>
  <div class="space-y-6">
    <!-- 习惯选择 -->
    <div class="flex items-center gap-3">
      <Select v-model="selectedId">
        <SelectTrigger class="w-60">
          <SelectValue placeholder="选择习惯" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem v-for="h in store.activeHabits.value" :key="h.id" :value="h.id">
            <div class="flex items-center gap-2">
              <span :class="h.icon" class="w-4 h-4" />
              <span>{{ h.text }}</span>
            </div>
          </SelectItem>
        </SelectContent>
      </Select>
      <span v-if="selectedHabit" class="text-xs text-muted-foreground">
        开始于 {{ selectedHabit.createdAt }}
      </span>
    </div>

    <template v-if="selectedHabit">
      <!-- 月历 + 统计 -->
      <div class="flex gap-6">
        <div class="flex-1 border rounded-lg p-4">
          <HabitClickableCalendar :habit="selectedHabit" />
        </div>
        <div class="flex flex-col gap-3 w-40">
          <HabitStatCard label="当前连续" :value="store.getHabitStreak(selectedHabit)" suffix="天" icon="icon-[lucide--flame]" />
          <HabitStatCard label="最长连续" :value="store.getHabitLongestStreak(selectedHabit)" suffix="天" icon="icon-[lucide--trophy]" />
          <HabitStatCard label="总计" :value="Object.keys(selectedHabit.checkins).length" suffix="天" icon="icon-[lucide--calendar-check]" />
        </div>
      </div>

      <!-- 年度热力图 -->
      <div class="border rounded-lg p-4 space-y-3">
        <div class="flex items-center justify-between">
          <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">年度热力图</span>
          <div class="flex items-center gap-2">
            <button @click="heatmapYear--" class="p-1 rounded hover:bg-accent transition-colors">
              <span class="icon-[lucide--chevron-left] w-3.5 h-3.5" />
            </button>
            <span class="text-xs font-medium min-w-10 text-center">{{ heatmapYear }}</span>
            <button @click="heatmapYear++" class="p-1 rounded hover:bg-accent transition-colors">
              <span class="icon-[lucide--chevron-right] w-3.5 h-3.5" />
            </button>
          </div>
        </div>
        <HabitYearlyHeatmap :habit="selectedHabit" :year="heatmapYear" interactive />
        <div class="flex items-center gap-4 text-xs text-muted-foreground">
          <span>完成率 {{ store.getHabitYearlyRate(selectedHabit, heatmapYear) }}%</span>
          <span>累计 {{ store.getHabitYearlyCheckins(selectedHabit, heatmapYear) }} 天</span>
        </div>
      </div>

      <!-- 月度趋势 -->
      <div class="border rounded-lg p-4 space-y-3">
        <span class="text-xs font-medium text-muted-foreground uppercase tracking-wider">月度趋势</span>
        <div class="flex items-end gap-2 h-24">
          <div v-for="item in monthlyTrend" :key="item.label"
            class="flex-1 flex flex-col items-center gap-1">
            <span class="text-[10px] text-muted-foreground tabular-nums">{{ item.rate }}%</span>
            <div class="w-full bg-muted/30 rounded-t-sm relative" style="min-height: 4px"
              :style="{ height: `${Math.max(item.rate / maxTrendRate * 64, 4)}px` }">
              <div class="absolute inset-0 bg-primary/60 rounded-t-sm" />
            </div>
            <span class="text-[10px] text-muted-foreground/50">{{ item.label }}</span>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="text-sm text-muted-foreground/50 text-center py-8">
      请选择一个习惯查看详情
    </div>
  </div>
</template>
