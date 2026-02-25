<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import type { TodoItemType, ReminderFrequency, ReminderNotifyBefore, TaskSchedule } from '@/types/todo'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const store = useTodoStore()

const open = defineModel<boolean>('open', { default: false })

const itemType = ref<TodoItemType>('taskflow')
const text = ref('')

// 习惯专用
const habitIcon = ref('icon-[lucide--circle-check]')
const habitScheduleType = ref<'daily' | 'weekdays' | 'custom'>('daily')
const habitCustomDays = ref<number[]>([])

// 提醒专用
const reminderFreqType = ref<'monthly' | 'weekly' | 'yearly'>('monthly')
const reminderDay = ref(1)
const reminderDayOfWeek = ref(1)
const reminderMonth = ref(1)
const reminderNotifyBefore = ref<ReminderNotifyBefore>('none')

const TYPE_OPTIONS: { value: TodoItemType; label: string; icon: string }[] = [
  { value: 'dailytask', label: '每日任务', icon: 'icon-[lucide--calendar-check]' },
  { value: 'habit', label: '习惯打卡', icon: 'icon-[lucide--flame]' },
  { value: 'reminder', label: '定期提醒', icon: 'icon-[lucide--bell]' },
  { value: 'taskflow', label: '任务流', icon: 'icon-[lucide--list-ordered]' },
  { value: 'backlog', label: '待办池', icon: 'icon-[lucide--inbox]' },
]

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

// 打开时重置表单
watch(open, (v) => {
  if (v) {
    text.value = ''
    habitIcon.value = 'icon-[lucide--circle-check]'
    habitScheduleType.value = 'daily'
    habitCustomDays.value = []
    reminderFreqType.value = 'monthly'
    reminderDay.value = 1
    reminderDayOfWeek.value = 1
    reminderMonth.value = 1
    reminderNotifyBefore.value = 'none'
  }
})

function toggleCustomDay(day: number) {
  const idx = habitCustomDays.value.indexOf(day)
  if (idx >= 0) {
    habitCustomDays.value.splice(idx, 1)
  } else {
    habitCustomDays.value.push(day)
  }
}

const dayHint = computed(() => {
  if (itemType.value !== 'reminder') return ''
  if (reminderFreqType.value === 'weekly') return ''
  const d = reminderDay.value
  if (d == null || d < 1) return ''
  if (d > 31) return '日期不能超过 31'
  if (d === 31) return '2月、4月、6月、9月、11月不足31天，届时将在月末最后一天提醒'
  if (d > 28) return '2月不足' + d + '天，届时将在2月最后一天提醒'
  return ''
})

function confirm() {
  const t = text.value.trim()
  if (!t) return

  switch (itemType.value) {
    case 'dailytask': {
      let schedule: TaskSchedule
      if (habitScheduleType.value === 'daily') {
        schedule = { type: 'daily' }
      } else if (habitScheduleType.value === 'weekdays') {
        schedule = { type: 'weekdays' }
      } else {
        schedule = { type: 'custom', days: [...habitCustomDays.value].sort() }
      }
      store.addDailyTask(t, habitIcon.value, schedule)
      break
    }
    case 'habit':
      store.addHabit(t, habitIcon.value)
      break
    case 'reminder': {
      const day = Math.max(1, Math.min(31, reminderDay.value || 1))
      const month = Math.max(1, Math.min(12, reminderMonth.value || 1))
      let frequency: ReminderFrequency
      if (reminderFreqType.value === 'monthly') {
        frequency = { type: 'monthly', day }
      } else if (reminderFreqType.value === 'weekly') {
        frequency = { type: 'weekly', dayOfWeek: reminderDayOfWeek.value }
      } else {
        frequency = { type: 'yearly', month, day }
      }
      store.addReminder(t, frequency, reminderNotifyBefore.value)
      break
    }
    case 'taskflow':
      store.addTaskFlowItem(t)
      break
    case 'backlog':
      store.addBacklogItem(t)
      break
  }

  open.value = false
}
</script>

<template>
  <Dialog v-model:open="open">
    <DialogContent class="sm:max-w-125">
      <DialogHeader>
        <DialogTitle>添加事项</DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <!-- 类型选择 -->
        <div class="grid grid-cols-5 gap-2">
          <button
            v-for="opt in TYPE_OPTIONS" :key="opt.value"
            @click="itemType = opt.value"
            class="flex flex-col items-center gap-1.5 p-2.5 rounded-lg border transition-all duration-200 text-xs"
            :class="itemType === opt.value
              ? 'bg-primary/10 border-primary/30 text-primary'
              : 'border-dashed text-muted-foreground hover:bg-accent/50'"
          >
            <span :class="opt.icon" class="w-4.5 h-4.5" />
            <span>{{ opt.label }}</span>
          </button>
        </div>

        <!-- 文本输入 -->
        <Input v-model="text" placeholder="内容" @keydown.enter="confirm" />

        <!-- 每日任务：图标 + 周期选择 -->
        <div v-if="itemType === 'dailytask'" class="space-y-3">
          <div class="space-y-2">
            <span class="text-xs text-muted-foreground">选择图标</span>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="ico in HABIT_ICONS" :key="ico.value"
                @click="habitIcon = ico.value"
                :title="ico.label"
                class="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
                :class="habitIcon === ico.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'"
              >
                <span :class="ico.value" class="w-4 h-4" />
              </button>
            </div>
          </div>

          <!-- 每日任务：周期选择 -->
          <div class="space-y-2">
            <span class="text-xs text-muted-foreground">执行周期</span>
            <div class="flex items-center gap-2">
              <button
                v-for="opt in ([
                  { value: 'daily', label: '每天' },
                  { value: 'weekdays', label: '工作日' },
                  { value: 'custom', label: '自定义' },
                ] as const)" :key="opt.value"
                @click="habitScheduleType = opt.value"
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                :class="habitScheduleType === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'"
              >
                {{ opt.label }}
              </button>
            </div>

            <!-- 自定义星期选择 -->
            <div v-if="habitScheduleType === 'custom'" class="flex items-center gap-1.5">
              <button
                v-for="(day, i) in WEEKDAYS" :key="i"
                @click="toggleCustomDay(i)"
                :class="[
                  'w-8 h-8 rounded-md text-xs font-medium transition-colors',
                  habitCustomDays.includes(i)
                    ? 'bg-primary text-primary-foreground'
                    : 'border hover:bg-accent text-muted-foreground'
                ]"
              >{{ day.replace('周', '') }}</button>
            </div>
          </div>
        </div>

        <!-- 习惯：仅图标选择 -->
        <div v-if="itemType === 'habit'" class="space-y-2">
          <span class="text-xs text-muted-foreground">选择图标</span>
          <div class="flex flex-wrap gap-1.5">
            <button
              v-for="ico in HABIT_ICONS" :key="ico.value"
              @click="habitIcon = ico.value"
              :title="ico.label"
              class="w-8 h-8 rounded-md flex items-center justify-center transition-colors"
              :class="habitIcon === ico.value
                ? 'bg-primary text-primary-foreground'
                : 'border hover:bg-accent text-muted-foreground'"
            >
              <span :class="ico.value" class="w-4 h-4" />
            </button>
          </div>
        </div>

        <!-- 提醒：频率设置 -->
        <div v-if="itemType === 'reminder'" class="space-y-3">
          <Select v-model="reminderFreqType">
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="weekly">每周</SelectItem>
              <SelectItem value="monthly">每月</SelectItem>
              <SelectItem value="yearly">每年</SelectItem>
            </SelectContent>
          </Select>

          <!-- 每周：选星期几 -->
          <div v-if="reminderFreqType === 'weekly'" class="flex items-center gap-1.5">
            <button
              v-for="(day, i) in WEEKDAYS" :key="i"
              @click="reminderDayOfWeek = i"
              :class="[
                'w-8 h-8 rounded-md text-xs font-medium transition-colors',
                reminderDayOfWeek === i
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'
              ]"
            >{{ day.replace('周', '') }}</button>
          </div>

          <!-- 每月：选几号 -->
          <div v-if="reminderFreqType === 'monthly'" class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground">每月</span>
            <Input
              type="number"
              :min="1" :max="31"
              v-model.number="reminderDay"
              class="w-20 text-center"
            />
            <span class="text-sm text-muted-foreground">号</span>
          </div>

          <!-- 每年：选月和日 -->
          <div v-if="reminderFreqType === 'yearly'" class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground">每年</span>
            <Input
              type="number"
              :min="1" :max="12"
              v-model.number="reminderMonth"
              class="w-16 text-center"
            />
            <span class="text-sm text-muted-foreground">月</span>
            <Input
              type="number"
              :min="1" :max="31"
              v-model.number="reminderDay"
              class="w-16 text-center"
            />
            <span class="text-sm text-muted-foreground">日</span>
          </div>

          <!-- 日期提示 -->
          <p v-if="dayHint" class="text-xs" :class="reminderDay > 31 ? 'text-destructive' : 'text-muted-foreground'">
            {{ dayHint }}
          </p>

          <!-- 提醒时机 -->
          <div class="space-y-2">
            <span class="text-xs text-muted-foreground">提醒时机</span>
            <div class="flex items-center gap-2">
              <button
                v-for="opt in ([
                  { value: 'none', label: '无需提醒' },
                  { value: 'same-day', label: '当天' },
                  { value: '1-day', label: '提前1天' },
                  { value: '1-week', label: '提前1周' },
                ] as const)" :key="opt.value"
                @click="reminderNotifyBefore = opt.value"
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                :class="reminderNotifyBefore === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="open = false">取消</Button>
        <Button :disabled="!text.trim() || (itemType === 'reminder' && reminderDay > 31)" @click="confirm">添加</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
