<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { toPng } from 'html-to-image'
import { save } from '@tauri-apps/plugin-dialog'
import { writeTextFile, writeFile } from '@tauri-apps/plugin-fs'
import { useTodoStore, getLocalDate } from '@/composables/useTodoStore'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import HabitYearlyHeatmap from './HabitYearlyHeatmap.vue'
import HabitClickableCalendar from './HabitClickableCalendar.vue'

const open = defineModel<boolean>('open', { default: false })
const store = useTodoStore()

type ExportType = 'json' | 'heatmap' | 'calendar'
type ExportMode = 'merge' | 'batch'

const exportType = ref<ExportType>('json')
const exportMode = ref<ExportMode>('merge')
const selectedIds = ref<Set<string>>(new Set())
const heatmapYear = ref(new Date().getFullYear())
const calendarYear = ref(new Date().getFullYear())
const calendarMonth = ref(new Date().getMonth())
const exporting = ref(false)
const renderForExport = ref(false)
const exportContainer = ref<HTMLElement | null>(null)
// 批量导出时，逐个渲染的索引
const batchIndex = ref(0)

const isImageType = computed(() => exportType.value !== 'json')
const showModeSwitch = computed(() => isImageType.value && selectedIds.value.size > 1)

watch(open, (v) => {
  if (v) {
    selectedIds.value = new Set(store.activeHabits.value.map(h => h.id))
    exportMode.value = 'merge'
  }
})

const allSelected = computed(() =>
  store.activeHabits.value.length > 0 && selectedIds.value.size === store.activeHabits.value.length
)

function toggleAll() {
  selectedIds.value = allSelected.value
    ? new Set()
    : new Set(store.activeHabits.value.map(h => h.id))
}

function toggleHabit(id: string) {
  const s = new Set(selectedIds.value)
  s.has(id) ? s.delete(id) : s.add(id)
  selectedIds.value = s
}

const selectedHabits = computed(() =>
  store.activeHabits.value.filter(h => selectedIds.value.has(h.id))
)

// 批量导出时当前渲染的单个习惯
const batchHabit = computed(() => selectedHabits.value[batchIndex.value])

const calendarMonthLabel = computed(() => `${calendarYear.value}年${calendarMonth.value + 1}月`)

function prevCalendarMonth() {
  if (calendarMonth.value === 0) { calendarMonth.value = 11; calendarYear.value-- }
  else { calendarMonth.value-- }
}
function nextCalendarMonth() {
  if (calendarMonth.value === 11) { calendarMonth.value = 0; calendarYear.value++ }
  else { calendarMonth.value++ }
}

async function doExport() {
  if (selectedIds.value.size === 0) return
  exporting.value = true
  try {
    if (exportType.value === 'json') {
      await exportJSON()
    } else if (exportMode.value === 'merge' || selectedHabits.value.length === 1) {
      await exportImageMerge()
    } else {
      await exportImageBatch()
    }
  } finally {
    exporting.value = false
  }
}

async function exportJSON() {
  const data = store.exportHabitsJSON(selectedIds.value)
  const json = JSON.stringify(data, null, 2)
  const filePath = await save({
    defaultPath: `habits_${getLocalDate()}.json`,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (filePath) {
    await writeTextFile(filePath, json)
  }
}

async function captureElement(): Promise<Uint8Array | null> {
  if (!exportContainer.value) return null
  const bgColor = getComputedStyle(document.documentElement).getPropertyValue('--background').trim()
  const resolvedBg = bgColor ? `hsl(${bgColor})` : '#ffffff'

  const dataUrl = await toPng(exportContainer.value, {
    pixelRatio: 2,
    backgroundColor: resolvedBg,
  })
  const base64 = dataUrl.split(',')[1]
  const binaryStr = atob(base64)
  const bytes = new Uint8Array(binaryStr.length)
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i)
  }
  return bytes
}

function getFileName(habit?: typeof selectedHabits.value[0]): string {
  if (exportType.value === 'heatmap') {
    return habit
      ? `${habit.text}_${heatmapYear.value}_heatmap.png`
      : `habits_${heatmapYear.value}_heatmap.png`
  }
  return habit
    ? `${habit.text}_${calendarMonthLabel.value}.png`
    : `habits_${calendarMonthLabel.value}.png`
}

async function exportImageMerge() {
  batchIndex.value = -1 // -1 表示合并模式
  renderForExport.value = true
  await nextTick()
  await new Promise(r => setTimeout(r, 300))

  const bytes = await captureElement()
  renderForExport.value = false
  if (!bytes) return

  const filePath = await save({
    defaultPath: getFileName(),
    filters: [{ name: 'PNG Image', extensions: ['png'] }],
  })
  if (filePath) {
    await writeFile(filePath, bytes)
  }
}

async function exportImageBatch() {
  // 让用户选择保存目录（用第一个文件的 save 对话框来确定目录）
  for (let i = 0; i < selectedHabits.value.length; i++) {
    batchIndex.value = i
    renderForExport.value = true
    await nextTick()
    await new Promise(r => setTimeout(r, 300))

    const bytes = await captureElement()
    renderForExport.value = false
    if (!bytes) continue

    const filePath = await save({
      defaultPath: getFileName(selectedHabits.value[i]),
      filters: [{ name: 'PNG Image', extensions: ['png'] }],
    })
    if (filePath) {
      await writeFile(filePath, bytes)
    }
  }
}

const EXPORT_TYPES: { value: ExportType; label: string; icon: string }[] = [
  { value: 'json', label: 'JSON', icon: 'icon-[lucide--file-json]' },
  { value: 'heatmap', label: '热力图', icon: 'icon-[lucide--grid-3x3]' },
  { value: 'calendar', label: '月度日历', icon: 'icon-[lucide--calendar]' },
]
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-110">
      <DialogHeader>
        <DialogTitle>导出数据</DialogTitle>
      </DialogHeader>

      <div class="space-y-4">
        <!-- 导出类型 -->
        <div class="flex items-center gap-2">
          <button
            v-for="opt in EXPORT_TYPES" :key="opt.value"
            @click="exportType = opt.value"
            class="flex items-center gap-2 px-3 py-2 rounded-md text-xs font-medium transition-colors"
            :class="exportType === opt.value
              ? 'bg-primary text-primary-foreground'
              : 'border hover:bg-accent text-muted-foreground'"
          >
            <span :class="opt.icon" class="w-4 h-4" />
            {{ opt.label }}
          </button>
        </div>

        <!-- 热力图：年份选择 -->
        <div v-if="exportType === 'heatmap'" class="flex items-center gap-2">
          <button @click="heatmapYear--" class="p-1 rounded hover:bg-accent">
            <span class="icon-[lucide--chevron-left] w-3.5 h-3.5" />
          </button>
          <span class="text-sm font-medium min-w-10 text-center">{{ heatmapYear }}</span>
          <button @click="heatmapYear++" class="p-1 rounded hover:bg-accent">
            <span class="icon-[lucide--chevron-right] w-3.5 h-3.5" />
          </button>
        </div>

        <!-- 月度日历：月份选择 -->
        <div v-if="exportType === 'calendar'" class="flex items-center gap-2">
          <button @click="prevCalendarMonth" class="p-1 rounded hover:bg-accent">
            <span class="icon-[lucide--chevron-left] w-3.5 h-3.5" />
          </button>
          <span class="text-sm font-medium min-w-20 text-center">{{ calendarMonthLabel }}</span>
          <button @click="nextCalendarMonth" class="p-1 rounded hover:bg-accent">
            <span class="icon-[lucide--chevron-right] w-3.5 h-3.5" />
          </button>
        </div>

        <!-- 习惯多选 -->
        <div class="border rounded-lg divide-y">
          <div class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors" @click="toggleAll">
            <span :class="allSelected ? 'icon-[lucide--check-square] text-primary' : 'icon-[lucide--square] text-muted-foreground/40'" class="w-4 h-4 shrink-0" />
            <span class="text-xs font-medium">全部选择</span>
            <span class="text-[10px] text-muted-foreground ml-auto">{{ selectedIds.size }}/{{ store.activeHabits.value.length }}</span>
          </div>
          <div
            v-for="h in store.activeHabits.value" :key="h.id"
            class="flex items-center gap-3 px-3 py-2 cursor-pointer hover:bg-accent/50 transition-colors"
            @click="toggleHabit(h.id)"
          >
            <span :class="selectedIds.has(h.id) ? 'icon-[lucide--check-square] text-primary' : 'icon-[lucide--square] text-muted-foreground/40'" class="w-4 h-4 shrink-0" />
            <span :class="h.icon" class="w-3.5 h-3.5 shrink-0" />
            <span class="text-xs">{{ h.text }}</span>
          </div>
        </div>

        <!-- 导出方式：合并/逐个（仅图片 + 多选时显示） -->
        <div v-if="showModeSwitch" class="flex items-center gap-2">
          <button
            @click="exportMode = 'merge'"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            :class="exportMode === 'merge'
              ? 'bg-primary text-primary-foreground'
              : 'border hover:bg-accent text-muted-foreground'"
          >
            <span class="icon-[lucide--layers] w-3.5 h-3.5" />
            合并为一张
          </button>
          <button
            @click="exportMode = 'batch'"
            class="flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
            :class="exportMode === 'batch'
              ? 'bg-primary text-primary-foreground'
              : 'border hover:bg-accent text-muted-foreground'"
          >
            <span class="icon-[lucide--copy] w-3.5 h-3.5" />
            逐个导出
          </button>
        </div>

        <p class="text-xs text-muted-foreground/60">
          <template v-if="exportType === 'json'">
            导出选中习惯的 JSON 数据，含名称、图标、打卡记录
          </template>
          <template v-else-if="showModeSwitch && exportMode === 'batch'">
            将依次弹出保存对话框，逐个保存为独立图片
          </template>
          <template v-else>
            将生成与界面一致的 PNG 图片
          </template>
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">关闭</Button>
        <Button
          :disabled="exporting || selectedIds.size === 0"
          @click="doExport"
        >
          <span class="icon-[lucide--download] w-3.5 h-3.5 mr-1.5" />
          {{ exporting ? '导出中...' : '导出' }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>

  <!-- 隐藏的渲染容器 -->
  <Teleport to="body">
    <div v-if="renderForExport" style="position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0;">
      <div
        ref="exportContainer"
        class="bg-background p-6"
        style="width: max-content;"
      >
        <!-- ═══ 热力图：合并模式 ═══ -->
        <template v-if="exportType === 'heatmap' && batchIndex === -1">
          <div class="space-y-4">
            <div v-for="habit in selectedHabits" :key="habit.id"
              class="border rounded-lg p-3 space-y-2 w-fit">
              <div class="flex items-center gap-2">
                <span :class="habit.icon" class="w-4 h-4 shrink-0" />
                <span class="text-sm font-medium">{{ habit.text }}</span>
                <div class="flex-1" />
                <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span class="icon-[lucide--percent] w-3 h-3" />
                  <span>{{ store.getHabitYearlyRate(habit, heatmapYear) }}</span>
                </div>
                <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span class="icon-[lucide--calendar-check] w-3 h-3" />
                  <span>{{ store.getHabitYearlyCheckins(habit, heatmapYear) }}</span>
                </div>
              </div>
              <HabitYearlyHeatmap :habit="habit" :year="heatmapYear" />
            </div>
          </div>
        </template>

        <!-- ═══ 热力图：批量模式（单个） ═══ -->
        <template v-if="exportType === 'heatmap' && batchIndex >= 0 && batchHabit">
          <div class="border rounded-lg p-3 space-y-2 w-fit">
            <div class="flex items-center gap-2">
              <span :class="batchHabit.icon" class="w-4 h-4 shrink-0" />
              <span class="text-sm font-medium">{{ batchHabit.text }}</span>
              <div class="flex-1" />
              <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span class="icon-[lucide--percent] w-3 h-3" />
                <span>{{ store.getHabitYearlyRate(batchHabit, heatmapYear) }}</span>
              </div>
              <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span class="icon-[lucide--calendar-check] w-3 h-3" />
                <span>{{ store.getHabitYearlyCheckins(batchHabit, heatmapYear) }}</span>
              </div>
            </div>
            <HabitYearlyHeatmap :habit="batchHabit" :year="heatmapYear" />
          </div>
        </template>

        <!-- ═══ 月度日历：合并模式（和页面一致的 3 列网格） ═══ -->
        <template v-if="exportType === 'calendar' && batchIndex === -1">
          <div class="space-y-4">
            <div class="text-sm font-medium text-center">{{ calendarMonthLabel }}</div>
            <div class="grid gap-4" :style="{ gridTemplateColumns: `repeat(${Math.min(selectedHabits.length, 3)}, 220px)` }">
              <div v-for="habit in selectedHabits" :key="habit.id"
                class="border rounded-lg p-4">
                <div class="flex items-center gap-2 mb-3">
                  <span :class="habit.icon" class="w-4 h-4 shrink-0" />
                  <span class="text-sm font-medium truncate">{{ habit.text }}</span>
                  <div class="flex-1" />
                  <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span class="icon-[lucide--percent] w-3 h-3" />
                    <span>{{ store.getHabitMonthlyRate(habit, calendarYear, calendarMonth + 1) }}</span>
                  </div>
                  <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                    <span class="icon-[lucide--calendar-check] w-3 h-3" />
                    <span>{{ store.getHabitMonthlyCheckins(habit, calendarYear, calendarMonth + 1) }}</span>
                  </div>
                </div>
                <HabitClickableCalendar
                  :habit="habit"
                  :year="calendarYear"
                  :month="calendarMonth"
                  hide-footer
                />
              </div>
            </div>
          </div>
        </template>

        <!-- ═══ 月度日历：批量模式（单个） ═══ -->
        <template v-if="exportType === 'calendar' && batchIndex >= 0 && batchHabit">
          <div class="space-y-4">
            <div class="text-sm font-medium text-center">{{ calendarMonthLabel }}</div>
            <div class="border rounded-lg p-4" style="width: 220px;">
              <div class="flex items-center gap-2 mb-3">
                <span :class="batchHabit.icon" class="w-4 h-4 shrink-0" />
                <span class="text-sm font-medium truncate">{{ batchHabit.text }}</span>
                <div class="flex-1" />
                <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span class="icon-[lucide--percent] w-3 h-3" />
                  <span>{{ store.getHabitMonthlyRate(batchHabit, calendarYear, calendarMonth + 1) }}</span>
                </div>
                <div class="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <span class="icon-[lucide--calendar-check] w-3 h-3" />
                  <span>{{ store.getHabitMonthlyCheckins(batchHabit, calendarYear, calendarMonth + 1) }}</span>
                </div>
              </div>
              <HabitClickableCalendar
                :habit="batchHabit"
                :year="calendarYear"
                :month="calendarMonth"
                hide-footer
              />
            </div>
          </div>
        </template>
      </div>
    </div>
  </Teleport>
</template>
