<script setup lang="ts">
import { computed } from 'vue'
import type { HabitItem } from '@/types/todo'
import { useTodoStore, getLocalDate } from '@/composables/useTodoStore'
import {
  Tooltip, TooltipContent, TooltipProvider, TooltipTrigger,
} from '@/components/ui/tooltip'

const props = withDefaults(defineProps<{
  habit: HabitItem
  year: number
  interactive?: boolean
}>(), {
  interactive: false,
})

const store = useTodoStore()

const DAY_LABELS = ['', '一', '', '三', '', '五', '', ]

/** 计算 52×7 网格数据 */
const weeks = computed(() => {
  const y = props.year
  const jan1 = new Date(y, 0, 1)
  // 找到 Jan 1 所在周的周一
  const startDay = jan1.getDay()
  const offset = startDay === 0 ? -6 : 1 - startDay
  const start = new Date(jan1)
  start.setDate(start.getDate() + offset)

  const todayStr = store.todayDate.value
  const result: { date: string; checked: boolean; active: boolean; inYear: boolean }[][] = []
  let currentWeek: typeof result[0] = []
  const d = new Date(start)

  while (true) {
    const ds = getLocalDate(d)
    const inYear = d.getFullYear() === y
    currentWeek.push({
      date: ds,
      checked: inYear && !!props.habit.checkins[ds],
      active: inYear && ds >= props.habit.createdAt && ds <= todayStr,
      inYear,
    })
    if (currentWeek.length === 7) {
      result.push(currentWeek)
      currentWeek = []
      // 已经过了这一年就停
      if (d.getFullYear() > y) break
    }
    d.setDate(d.getDate() + 1)
  }
  // 补齐最后一周
  if (currentWeek.length > 0) {
    while (currentWeek.length < 7) {
      currentWeek.push({ date: '', checked: false, active: false, inYear: false })
    }
    result.push(currentWeek)
  }
  return result
})

/** 月标签位置 */
const monthLabels = computed(() => {
  const labels: { text: string; col: number }[] = []
  const monthNames = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月']
  let lastMonth = -1
  for (let wi = 0; wi < weeks.value.length; wi++) {
    // 取每周的周一（index 0）来判断月份
    const firstDay = weeks.value[wi][0]
    if (!firstDay.inYear) continue
    const m = parseInt(firstDay.date.slice(5, 7)) - 1
    if (m !== lastMonth) {
      labels.push({ text: monthNames[m], col: wi })
      lastMonth = m
    }
  }
  return labels
})

function cellClass(day: typeof weeks.value[0][0]): string {
  if (!day.inYear) return 'bg-transparent'
  if (!day.active) return 'bg-muted-foreground/10'
  if (day.checked) return 'bg-primary/70'
  return 'bg-muted-foreground/20'
}

function onClickCell(day: typeof weeks.value[0][0]) {
  if (!props.interactive || !day.active) return
  store.toggleHabitCheckinForDate(props.habit, day.date)
}

// ── Canvas 导出 ──

function exportAsCanvas(): HTMLCanvasElement {
  const cellSize = 11
  const gap = 2
  const labelW = 20
  const headerH = 16
  const w = labelW + weeks.value.length * (cellSize + gap)
  const h = headerH + 7 * (cellSize + gap) + 24

  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!

  // 背景
  ctx.fillStyle = '#09090b'
  ctx.fillRect(0, 0, w, h)

  // 月标签
  ctx.fillStyle = '#666'
  ctx.font = '9px sans-serif'
  for (const ml of monthLabels.value) {
    ctx.fillText(ml.text, labelW + ml.col * (cellSize + gap), 11)
  }

  // 格子
  for (let wi = 0; wi < weeks.value.length; wi++) {
    for (let di = 0; di < 7; di++) {
      const day = weeks.value[wi][di]
      const x = labelW + wi * (cellSize + gap)
      const y = headerH + di * (cellSize + gap)

      if (!day.inYear) continue
      if (!day.active) {
        ctx.fillStyle = 'rgba(255,255,255,0.05)'
      } else if (day.checked) {
        ctx.fillStyle = 'hsl(142, 71%, 45%)'
      } else {
        ctx.fillStyle = 'rgba(255,255,255,0.1)'
      }
      ctx.beginPath()
      ctx.roundRect(x, y, cellSize, cellSize, 2)
      ctx.fill()
    }
  }

  // 底部统计
  const yCheckins = store.getHabitYearlyCheckins(props.habit, props.year)
  const yRate = store.getHabitYearlyRate(props.habit, props.year)
  ctx.fillStyle = '#888'
  ctx.font = '10px sans-serif'
  ctx.fillText(`${props.habit.text} · ${props.year} · 完成率 ${yRate}% · 累计 ${yCheckins} 天`, labelW, h - 6)

  return canvas
}

defineExpose({ exportAsCanvas })
</script>

<template>
  <TooltipProvider :delay-duration="200">
    <div class="overflow-x-auto">
      <!-- 月标签（绝对定位在正确的列位置） -->
      <div class="relative ml-5 mb-1 h-3.5">
        <span v-for="ml in monthLabels" :key="ml.col"
          class="absolute text-[9px] text-muted-foreground/60"
          :style="{ left: `${ml.col * 13}px` }">
          {{ ml.text }}
        </span>
      </div>

      <div class="flex gap-0.5">
        <!-- 星期标签 -->
        <div class="flex flex-col gap-0.5 pr-0.5">
          <div v-for="(label, i) in DAY_LABELS" :key="i"
            class="h-[11px] w-4 flex items-center justify-end text-[9px] text-muted-foreground/40">
            {{ label }}
          </div>
        </div>

        <!-- 周列 -->
        <div v-for="(week, wi) in weeks" :key="wi" class="flex flex-col gap-0.5">
          <Tooltip v-for="(day, di) in week" :key="di">
            <TooltipTrigger as-child>
              <div
                class="w-[11px] h-[11px] rounded-[2px] transition-colors"
                :class="[
                  cellClass(day),
                  interactive && day.active ? 'cursor-pointer hover:ring-1 hover:ring-primary/50' : '',
                ]"
                @click="onClickCell(day)"
              />
            </TooltipTrigger>
            <TooltipContent v-if="day.inYear && day.active" side="top" class="text-xs py-1 px-2">
              {{ day.date }} {{ day.checked ? '✓' : '✗' }}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>
    </div>
  </TooltipProvider>
</template>
