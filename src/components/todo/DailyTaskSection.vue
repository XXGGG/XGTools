<script setup lang="ts">
import { ref } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import type { DailyTaskItem, TaskSchedule } from '@/types/todo'
import { Input } from '@/components/ui/input'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

const store = useTodoStore()

const SCHEDULE_LABELS: Record<string, string> = {
  daily: '每天',
  weekdays: '工作日',
  custom: '自定义',
}

function getScheduleLabel(task: DailyTaskItem): string {
  const s = task.schedule ?? { type: 'daily' }
  if (s.type === 'custom') {
    const DAYS = ['日', '一', '二', '三', '四', '五', '六']
    return s.days.map(d => DAYS[d]).join('')
  }
  return SCHEDULE_LABELS[s.type] || '每天'
}

// ── 编辑弹窗 ──
const editOpen = ref(false)
const editingTask = ref<DailyTaskItem | null>(null)
const editText = ref('')
const editIcon = ref('')
const editScheduleType = ref<'daily' | 'weekdays' | 'custom'>('daily')
const editCustomDays = ref<number[]>([])

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const HABIT_ICONS: { value: string; label: string }[] = [
  { value: 'icon-[lucide--flame]', label: '火焰' },
  { value: 'icon-[lucide--pencil]', label: '练字' },
  { value: 'icon-[lucide--book-open]', label: '阅读' },
  { value: 'icon-[lucide--dumbbell]', label: '运动' },
  { value: 'icon-[lucide--droplets]', label: '喝水' },
  { value: 'icon-[lucide--music]', label: '音乐' },
  { value: 'icon-[lucide--code]', label: '编程' },
  { value: 'icon-[lucide--languages]', label: '语言' },
  { value: 'icon-[lucide--heart]', label: '心形' },
  { value: 'icon-[lucide--star]', label: '星星' },
  { value: 'icon-[lucide--circle-check]', label: '默认' },
  { value: 'icon-[lucide--gamepad-2]', label: '游戏' },
]

function openEdit(task: DailyTaskItem) {
  editingTask.value = task
  editText.value = task.text
  editIcon.value = task.icon
  const s = task.schedule ?? { type: 'daily' as const }
  editScheduleType.value = s.type === 'custom' ? 'custom' : s.type === 'weekdays' ? 'weekdays' : 'daily'
  editCustomDays.value = s.type === 'custom' ? [...s.days] : []
  editOpen.value = true
}

function toggleEditCustomDay(day: number) {
  const idx = editCustomDays.value.indexOf(day)
  if (idx >= 0) editCustomDays.value.splice(idx, 1)
  else editCustomDays.value.push(day)
}

function saveEdit() {
  if (!editingTask.value || !editText.value.trim()) return
  let schedule: TaskSchedule
  if (editScheduleType.value === 'daily') schedule = { type: 'daily' }
  else if (editScheduleType.value === 'weekdays') schedule = { type: 'weekdays' }
  else schedule = { type: 'custom', days: [...editCustomDays.value].sort() }

  store.updateDailyTask(editingTask.value.id, {
    text: editText.value.trim(),
    icon: editIcon.value,
    schedule,
  })
  editOpen.value = false
}
</script>

<template>
  <div v-if="store.activeDailyTasks.value.length > 0" class="space-y-3">
    <div class="flex items-center justify-between">
      <h3 class="text-xs font-medium text-muted-foreground uppercase tracking-wider">每日任务</h3>
      <span class="text-xs text-muted-foreground">
        {{ store.todayDailyTasksDone.value }}/{{ store.activeDailyTasks.value.length }} 完成
      </span>
    </div>

    <div class="flex flex-col gap-1.5">
      <ContextMenu v-for="task in store.activeDailyTasks.value" :key="task.id">
        <ContextMenuTrigger as-child>
          <button
            class="flex items-center gap-2.5 p-3 rounded-lg border transition-all duration-200 text-left group"
            :class="store.isDailyTaskCheckedToday(task)
              ? 'bg-primary/10 border-primary/30'
              : store.isDailyTaskActiveToday(task)
                ? 'border-dashed hover:bg-accent/50'
                : 'border-dashed opacity-40'"
            @click="store.toggleDailyTaskCheckin(task)"
          >
            <span :class="task.icon" class="w-4.5 h-4.5 shrink-0" />
            <div class="flex-1 min-w-0">
              <span class="text-sm truncate block">{{ task.text }}</span>
              <span v-if="(task.schedule?.type ?? 'daily') !== 'daily'"
                class="text-[10px] text-muted-foreground/50">
                {{ getScheduleLabel(task) }}
              </span>
            </div>
            <span v-if="store.isDailyTaskCheckedToday(task)"
              class="icon-[lucide--check] w-4 h-4 text-primary shrink-0" />
            <span v-else-if="store.isDailyTaskActiveToday(task)"
              class="icon-[lucide--circle] w-4 h-4 text-muted-foreground/30 shrink-0" />
            <span v-else
              class="text-[10px] text-muted-foreground/30 shrink-0">休息</span>
          </button>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem @click="openEdit(task)">
            <span class="icon-[lucide--pencil] w-3.5 h-3.5 mr-2" />
            编辑
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem class="text-destructive" @click="store.removeDailyTask(task.id)">
            <span class="icon-[lucide--trash-2] w-3.5 h-3.5 mr-2" />
            删除
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>

    <!-- 编辑弹窗 -->
    <Dialog v-model:open="editOpen">
      <DialogContent class="sm:max-w-100">
        <DialogHeader>
          <DialogTitle>编辑每日任务</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4">
          <Input v-model="editText" placeholder="任务内容" />

          <div class="space-y-2">
            <span class="text-xs text-muted-foreground">选择图标</span>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="ico in HABIT_ICONS" :key="ico.value"
                @click="editIcon = ico.value"
                :title="ico.label"
                class="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
                :class="editIcon === ico.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'"
              >
                <span :class="ico.value" class="w-4 h-4" />
              </button>
            </div>
          </div>

          <div class="space-y-2">
            <span class="text-xs text-muted-foreground">执行周期</span>
            <div class="flex items-center gap-2">
              <button
                v-for="opt in ([
                  { value: 'daily', label: '每天' },
                  { value: 'weekdays', label: '工作日' },
                  { value: 'custom', label: '自定义' },
                ] as const)" :key="opt.value"
                @click="editScheduleType = opt.value"
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                :class="editScheduleType === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'"
              >
                {{ opt.label }}
              </button>
            </div>
            <div v-if="editScheduleType === 'custom'" class="flex items-center gap-1.5">
              <button
                v-for="(day, i) in WEEKDAYS" :key="i"
                @click="toggleEditCustomDay(i)"
                :class="[
                  'w-8 h-8 rounded-md text-xs font-medium transition-colors',
                  editCustomDays.includes(i)
                    ? 'bg-primary text-primary-foreground'
                    : 'border hover:bg-accent text-muted-foreground'
                ]"
              >{{ day.replace('周', '') }}</button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">取消</Button>
          <Button :disabled="!editText.trim()" @click="saveEdit">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
