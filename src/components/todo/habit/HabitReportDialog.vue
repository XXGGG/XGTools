<script setup lang="ts">
import { ref, computed } from 'vue'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile } from '@tauri-apps/plugin-fs'
import { useTodoStore, getLocalDate } from '@/composables/useTodoStore'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'

const open = defineModel<boolean>('open', { default: false })

const store = useTodoStore()

type ReportType = 'weekly' | 'monthly' | 'yearly'
const reportType = ref<ReportType>('weekly')

// ── 周报数据 ──

const weekStart = computed(() => {
  const d = new Date()
  const day = d.getDay()
  const offset = day === 0 ? 6 : day - 1
  d.setDate(d.getDate() - offset)
  return getLocalDate(d)
})

const weekEnd = computed(() => {
  const d = new Date(weekStart.value + 'T00:00')
  d.setDate(d.getDate() + 6)
  return getLocalDate(d)
})

const weekDates = computed(() => {
  const dates: string[] = []
  const d = new Date(weekStart.value + 'T00:00')
  for (let i = 0; i < 7; i++) {
    dates.push(getLocalDate(d))
    d.setDate(d.getDate() + 1)
  }
  return dates
})

// ── 月报数据 ──

const now = new Date()
const reportYear = ref(now.getFullYear())
const reportMonth = ref(now.getMonth() + 1)

// ── 报告内容 ──

const reportContent = computed(() => {
  const habits = store.activeHabits.value
  const todayStr = store.todayDate.value

  if (reportType.value === 'weekly') {
    let total = 0, checked = 0, perfect = 0
    for (const date of weekDates.value) {
      if (date > todayStr) break
      const relevant = habits.filter(h => h.createdAt <= date)
      let allDone = relevant.length > 0
      for (const h of relevant) {
        total++
        if (h.checkins[date]) checked++
        else allDone = false
      }
      if (allDone && relevant.length > 0) perfect++
    }
    const rate = total > 0 ? Math.round(checked / total * 100) : 0

    const lines: string[] = [
      `# 习惯周报`,
      `> ${weekStart.value} ~ ${weekEnd.value}`,
      '',
      `## 总体`,
      `- 打卡率: **${rate}%**`,
      `- 完美天数: **${perfect}/7**`,
      `- 总打卡: **${checked}** 次`,
      '',
      `## 各习惯`,
    ]

    for (const h of habits) {
      const hChecked = store.getHabitWeeklyCheckins(h, weekStart.value)
      const hRate = Math.round(hChecked / 7 * 100)
      const bar = '█'.repeat(Math.round(hChecked / 7 * 10)) + '░'.repeat(10 - Math.round(hChecked / 7 * 10))
      lines.push(`- ${h.text}: ${hChecked}/7 (${hRate}%) ${bar}`)
    }

    return lines.join('\n')
  }

  if (reportType.value === 'monthly') {
    const y = reportYear.value
    const m = reportMonth.value
    const rate = store.getOverallMonthlyRate(y, m)
    const perfect = store.getPerfectDaysInMonth(y, m)

    const lines: string[] = [
      `# 习惯月报`,
      `> ${y}年${m}月`,
      '',
      `## 总体`,
      `- 完成率: **${rate}%**`,
      `- 完美天数: **${perfect}**`,
      '',
      `## 各习惯`,
    ]

    for (const h of habits) {
      const hChecked = store.getHabitMonthlyCheckins(h, y, m)
      const hRate = store.getHabitMonthlyRate(h, y, m)
      const streak = store.getHabitStreak(h)
      lines.push(`- ${h.text}: ${hChecked}天 (${hRate}%) 连续${streak}天`)
    }

    return lines.join('\n')
  }

  // yearly
  const y = reportYear.value
  const lines: string[] = [
    `# 习惯年报`,
    `> ${y}年`,
    '',
    `## 月度趋势`,
  ]

  for (let m = 1; m <= 12; m++) {
    const mRate = store.getOverallMonthlyRate(y, m)
    if (store.getHabitMonthlyActiveDays(habits[0] || {} as any, y, m) > 0 || m <= now.getMonth() + 1) {
      lines.push(`- ${m}月: ${mRate}%`)
    }
  }

  lines.push('', `## 各习惯年度汇总`)

  for (const h of habits) {
    const hChecked = store.getHabitYearlyCheckins(h, y)
    const hRate = store.getHabitYearlyRate(h, y)
    const longest = store.getHabitLongestStreak(h)
    lines.push(`- ${h.text}: 累计${hChecked}天 完成率${hRate}% 最长连续${longest}天`)
  }

  return lines.join('\n')
})

async function exportReport() {
  const ext = 'md'
  const typeName = reportType.value === 'weekly' ? '周报' : reportType.value === 'monthly' ? '月报' : '年报'
  const filePath = await save({
    defaultPath: `习惯${typeName}_${getLocalDate()}.${ext}`,
    filters: [{ name: 'Markdown', extensions: ['md'] }],
  })
  if (filePath) {
    await writeTextFile(filePath, reportContent.value)
  }
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-150">
      <DialogHeader>
        <DialogTitle>习惯报告</DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <!-- 报告类型切换 -->
        <div class="flex items-center gap-2">
          <button
            v-for="opt in ([
              { value: 'weekly', label: '周报' },
              { value: 'monthly', label: '月报' },
              { value: 'yearly', label: '年报' },
            ] as const)" :key="opt.value"
            @click="reportType = opt.value"
            class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            :class="reportType === opt.value
              ? 'bg-primary text-primary-foreground'
              : 'border hover:bg-accent text-muted-foreground'"
          >
            {{ opt.label }}
          </button>

          <!-- 年月选择（月报/年报时） -->
          <template v-if="reportType !== 'weekly'">
            <div class="flex items-center gap-1 ml-4">
              <button @click="reportYear--" class="p-1 rounded hover:bg-accent">
                <span class="icon-[lucide--chevron-left] w-3.5 h-3.5" />
              </button>
              <span class="text-xs min-w-10 text-center">{{ reportYear }}</span>
              <button @click="reportYear++" class="p-1 rounded hover:bg-accent">
                <span class="icon-[lucide--chevron-right] w-3.5 h-3.5" />
              </button>
            </div>
            <div v-if="reportType === 'monthly'" class="flex items-center gap-1">
              <button @click="reportMonth = Math.max(1, reportMonth - 1)" class="p-1 rounded hover:bg-accent">
                <span class="icon-[lucide--chevron-left] w-3.5 h-3.5" />
              </button>
              <span class="text-xs min-w-8 text-center">{{ reportMonth }}月</span>
              <button @click="reportMonth = Math.min(12, reportMonth + 1)" class="p-1 rounded hover:bg-accent">
                <span class="icon-[lucide--chevron-right] w-3.5 h-3.5" />
              </button>
            </div>
          </template>
        </div>

        <!-- 报告预览 -->
        <div class="border rounded-lg p-4 max-h-80 overflow-auto">
          <pre class="text-xs text-foreground/80 whitespace-pre-wrap font-mono leading-relaxed">{{ reportContent }}</pre>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">关闭</Button>
        <Button @click="exportReport">
          <span class="icon-[lucide--download] w-3.5 h-3.5 mr-1.5" />
          导出 Markdown
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
