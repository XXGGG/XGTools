<script setup lang="ts">
import { ref, computed } from 'vue'
import { useTodoStore } from '@/composables/useTodoStore'
import type { ReminderItem, ReminderFrequency, ReminderNotifyBefore } from '@/types/todo'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import {
  ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger,
} from '@/components/ui/context-menu'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

const store = useTodoStore()
// ── 编辑弹窗 ──
const editOpen = ref(false)
const editingReminder = ref<ReminderItem | null>(null)
const editText = ref('')
const editFreqType = ref<'monthly' | 'weekly' | 'yearly'>('monthly')
const editDay = ref(1)
const editDayOfWeek = ref(1)
const editMonth = ref(1)
const editNotifyBefore = ref<ReminderNotifyBefore>('same-day')

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function openEdit(reminder: ReminderItem) {
  editingReminder.value = reminder
  editText.value = reminder.text
  const f = reminder.frequency
  editFreqType.value = f.type
  editDay.value = f.type === 'weekly' ? 1 : f.day
  editDayOfWeek.value = f.type === 'weekly' ? f.dayOfWeek : 1
  editMonth.value = f.type === 'yearly' ? f.month : 1
  editNotifyBefore.value = reminder.notifyBefore ?? 'same-day'
  editOpen.value = true
}

const editDayHint = computed(() => {
  if (editFreqType.value === 'weekly') return ''
  const d = editDay.value
  if (d == null || d < 1) return ''
  if (d > 31) return '日期不能超过 31'
  if (d === 31) return '2月、4月、6月、9月、11月不足31天，届时将在月末最后一天提醒'
  if (d > 28) return '2月不足' + d + '天，届时将在2月最后一天提醒'
  return ''
})

function saveEdit() {
  if (!editingReminder.value || !editText.value.trim()) return
  const day = Math.max(1, Math.min(31, editDay.value || 1))
  const month = Math.max(1, Math.min(12, editMonth.value || 1))
  let frequency: ReminderFrequency
  if (editFreqType.value === 'monthly') {
    frequency = { type: 'monthly', day }
  } else if (editFreqType.value === 'weekly') {
    frequency = { type: 'weekly', dayOfWeek: editDayOfWeek.value }
  } else {
    frequency = { type: 'yearly', month, day }
  }
  store.updateReminder(editingReminder.value.id, {
    text: editText.value.trim(),
    frequency,
    notifyBefore: editNotifyBefore.value,
  })
  editOpen.value = false
}
</script>

<template>
  <div v-if="store.reminders.value.length > 0" class="flex flex-col gap-1.5">
    <ContextMenu v-for="reminder in store.reminders.value" :key="reminder.id">
      <ContextMenuTrigger as-child>
        <div
          class="flex items-center gap-3 p-3 rounded-lg border transition-colors cursor-pointer"
          :class="store.isReminderCompleted(reminder)
            ? 'opacity-50 hover:bg-accent/50'
            : store.shouldNotifyReminder(reminder)
              ? 'border-destructive/30 bg-destructive/5'
              : 'hover:bg-accent/50'"
          @click="store.isReminderCompleted(reminder) ? store.uncompleteReminder(reminder) : store.completeReminder(reminder)"
        >
          <!-- 图标 -->
          <span :class="store.isReminderCompleted(reminder)
            ? 'icon-[lucide--circle-check] text-muted-foreground/30'
            : store.shouldNotifyReminder(reminder)
              ? 'icon-[lucide--bell-ring] text-destructive'
              : 'icon-[lucide--bell] text-muted-foreground/40'"
            class="w-4 h-4 shrink-0" />

          <!-- 内容 -->
          <div class="flex-1 min-w-0">
            <div class="flex items-center gap-2">
              <span class="text-sm truncate"
                :class="store.isReminderCompleted(reminder) ? 'line-through text-muted-foreground/50' : ''">
                {{ reminder.text }}
              </span>
              <span class="text-xs text-muted-foreground/70 shrink-0">
                {{ store.getNextReminderDate(reminder) }}
              </span>
            </div>
            <div class="flex items-center gap-1.5 mt-0.5">
              <span v-if="reminder.notifyBefore !== 'none'"
                class="px-1.5 py-0.5 rounded text-[10px] font-medium bg-primary/10 text-primary">
                {{ store.formatNotifyBefore(reminder.notifyBefore) }}
              </span>
              <span v-else
                class="text-[10px] text-muted-foreground/40">
                不提醒
              </span>
            </div>
          </div>

          <!-- 频率标签 -->
          <span class="text-xs text-muted-foreground/50 shrink-0">
            {{ store.formatFrequency(reminder.frequency) }}
          </span>
        </div>
      </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem v-if="store.isReminderCompleted(reminder)" @click="store.uncompleteReminder(reminder)">
              <span class="icon-[lucide--circle] w-3.5 h-3.5 mr-2" />
              标记未完成
            </ContextMenuItem>
            <ContextMenuItem v-else @click="store.completeReminder(reminder)">
              <span class="icon-[lucide--circle-check] w-3.5 h-3.5 mr-2" />
              标记完成
            </ContextMenuItem>
            <ContextMenuItem @click="openEdit(reminder)">
              <span class="icon-[lucide--pencil] w-3.5 h-3.5 mr-2" />
              编辑
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem class="text-destructive" @click="store.removeReminder(reminder.id)">
              <span class="icon-[lucide--trash-2] w-3.5 h-3.5 mr-2" />
              删除
            </ContextMenuItem>
          </ContextMenuContent>
    </ContextMenu>

    <!-- 编辑弹窗 -->
    <Dialog v-model:open="editOpen">
      <DialogContent class="sm:max-w-125">
        <DialogHeader>
          <DialogTitle>编辑提醒</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4">
          <Input v-model="editText" placeholder="提醒内容" @keydown.enter="saveEdit" />

          <Select v-model="editFreqType">
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
          <div v-if="editFreqType === 'weekly'" class="flex items-center gap-1.5">
            <button
              v-for="(day, i) in WEEKDAYS" :key="i"
              @click="editDayOfWeek = i"
              :class="[
                'w-8 h-8 rounded-md text-xs font-medium transition-colors',
                editDayOfWeek === i
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'
              ]"
            >{{ day.replace('周', '') }}</button>
          </div>

          <!-- 每月：选几号 -->
          <div v-if="editFreqType === 'monthly'" class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground">每月</span>
            <Input type="number" :min="1" :max="31" v-model.number="editDay" class="w-20 text-center" />
            <span class="text-sm text-muted-foreground">号</span>
          </div>

          <!-- 每年：选月和日 -->
          <div v-if="editFreqType === 'yearly'" class="flex items-center gap-2">
            <span class="text-sm text-muted-foreground">每年</span>
            <Input type="number" :min="1" :max="12" v-model.number="editMonth" class="w-16 text-center" />
            <span class="text-sm text-muted-foreground">月</span>
            <Input type="number" :min="1" :max="31" v-model.number="editDay" class="w-16 text-center" />
            <span class="text-sm text-muted-foreground">日</span>
          </div>

          <!-- 日期提示 -->
          <p v-if="editDayHint" class="text-xs" :class="editDay > 31 ? 'text-destructive' : 'text-muted-foreground'">
            {{ editDayHint }}
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
                @click="editNotifyBefore = opt.value"
                class="px-3 py-1.5 rounded-md text-xs font-medium transition-colors"
                :class="editNotifyBefore === opt.value
                  ? 'bg-primary text-primary-foreground'
                  : 'border hover:bg-accent text-muted-foreground'"
              >
                {{ opt.label }}
              </button>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" @click="editOpen = false">取消</Button>
          <Button :disabled="!editText.trim() || (editFreqType !== 'weekly' && editDay > 31)" @click="saveEdit">保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </div>
</template>
