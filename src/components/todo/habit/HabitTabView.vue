<script setup lang="ts">
import { ref, computed } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import HabitSection from '@/components/todo/HabitSection.vue'
import HabitWeeklyTable from './HabitWeeklyTable.vue'
import HabitMonthlyOverview from './HabitMonthlyOverview.vue'
import HabitYearlyHeatmap from './HabitYearlyHeatmap.vue'
import HabitDetailPanel from './HabitDetailPanel.vue'
import HabitExportDialog from './HabitExportDialog.vue'

const store = useTodoStore()

type SubView = 'habits' | 'weekly' | 'monthly' | 'yearly' | 'detail'
const activeView = ref<SubView>('habits')

const exportOpen = ref(false)

const now = new Date()
const heatmapYear = ref(now.getFullYear())

const WEEKDAY_NAMES = ['日', '一', '二', '三', '四', '五', '六']
const todayLabel = computed(() => {
  const d = new Date()
  const m = d.getMonth() + 1
  const day = d.getDate()
  const w = WEEKDAY_NAMES[d.getDay()]
  return `${m}月${day}日 周${w}`
})

const SUB_NAV: { value: SubView; label: string; icon: string }[] = [
  { value: 'habits', label: '习惯管理', icon: 'icon-[lucide--list]' },
  { value: 'weekly', label: '本周总览', icon: 'icon-[lucide--calendar-days]' },
  { value: 'monthly', label: '月度日历', icon: 'icon-[lucide--calendar]' },
  { value: 'yearly', label: '年度热力图', icon: 'icon-[lucide--grid-3x3]' },
  { value: 'detail', label: '单项详情', icon: 'icon-[lucide--focus]' },
]
</script>

<template>
  <div class="space-y-5">
    <!-- 子导航 -->
    <div class="flex items-center gap-2 flex-wrap">
      <button
        v-for="nav in SUB_NAV" :key="nav.value"
        @click="activeView = nav.value"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
        :class="activeView === nav.value
          ? 'bg-primary text-primary-foreground'
          : 'text-muted-foreground hover:bg-accent hover:text-foreground'"
      >
        <span :class="nav.icon" class="w-3.5 h-3.5" />
        {{ nav.label }}
      </button>

      <div class="flex-1" />

      <button
        @click="exportOpen = true"
        class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
      >
        <span class="icon-[lucide--download] w-3.5 h-3.5" />
        导出
      </button>
    </div>

    <!-- 今日日期 -->
    <div v-if="activeView === 'habits'" class="flex items-center justify-between">
      <span class="text-sm text-muted-foreground">{{ todayLabel }}</span>
      <span class="text-xs text-muted-foreground">{{ store.todayHabitsDone.value }}/{{ store.activeHabits.value.length }} 完成</span>
    </div>

    <!-- 内容区 -->

    <!-- 习惯管理 -->
    <HabitSection v-if="activeView === 'habits'" editable />

    <template v-if="store.activeHabits.value.length > 0">
      <!-- 本周总览 -->
      <HabitWeeklyTable v-if="activeView === 'weekly'" />

      <!-- 月度日历 -->
      <HabitMonthlyOverview v-else-if="activeView === 'monthly'" />

      <!-- 年度热力图 -->
      <div v-else-if="activeView === 'yearly'" class="space-y-6">
        <div class="flex items-center justify-center gap-4">
          <button @click="heatmapYear--" class="p-1.5 rounded-md hover:bg-accent transition-colors">
            <span class="icon-[lucide--chevron-left] w-4 h-4" />
          </button>
          <span class="text-sm font-medium min-w-12 text-center">{{ heatmapYear }}</span>
          <button @click="heatmapYear++" class="p-1.5 rounded-md hover:bg-accent transition-colors">
            <span class="icon-[lucide--chevron-right] w-4 h-4" />
          </button>
        </div>

        <div v-for="habit in store.activeHabits.value" :key="habit.id"
          class="border rounded-lg p-3 space-y-2 w-fit mx-auto">
          <div class="flex items-center gap-2">
            <span :class="habit.icon" class="w-4 h-4 shrink-0" />
            <span class="text-sm font-medium">{{ habit.text }}</span>
            <div class="flex-1" />
            <div class="flex items-center gap-1 text-[10px] text-muted-foreground" :title="`完成率 ${store.getHabitYearlyRate(habit, heatmapYear)}%`">
              <span class="icon-[lucide--percent] w-3 h-3" />
              <span>{{ store.getHabitYearlyRate(habit, heatmapYear) }}</span>
            </div>
            <div class="flex items-center gap-1 text-[10px] text-muted-foreground" :title="`累计 ${store.getHabitYearlyCheckins(habit, heatmapYear)} 天`">
              <span class="icon-[lucide--calendar-check] w-3 h-3" />
              <span>{{ store.getHabitYearlyCheckins(habit, heatmapYear) }}</span>
            </div>
          </div>
          <HabitYearlyHeatmap :habit="habit" :year="heatmapYear" interactive />
        </div>
      </div>

      <!-- 单项详情 -->
      <HabitDetailPanel v-else-if="activeView === 'detail'" />
    </template>

    <!-- 弹窗 -->
    <HabitExportDialog v-model:open="exportOpen" />
  </div>
</template>
