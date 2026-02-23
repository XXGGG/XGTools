<script setup lang="ts">
import { ref, computed, onMounted, toRaw } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import { CalendarDate } from '@internationalized/date'
import type { DateValue } from '@internationalized/date'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Dialog, DialogContent, DialogHeader, DialogFooter, DialogTitle,
} from '@/components/ui/dialog'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'

// ── Types ──

type RepeatType = 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'

interface TodoItem {
  id: string
  text: string
  completed: boolean
  createdAt: string
  completedAt: string | null
  dueDate: string | null
  repeat: RepeatType
  repeatDay: number | null
}

const REPEAT_OPTIONS: { value: RepeatType; label: string }[] = [
  { value: 'none', label: '不重复' },
  { value: 'daily', label: '每天' },
  { value: 'weekdays', label: '工作日' },
  { value: 'weekly', label: '每周' },
  { value: 'monthly', label: '每月' },
  { value: 'yearly', label: '每年' },
]

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六']

// ── Date conversion ──

function strToDateValue(str: string): DateValue {
  const [y, m, d] = str.split('-').map(Number)
  return new CalendarDate(y, m, d)
}

function dateValueToStr(dv: DateValue): string {
  return `${dv.year}-${String(dv.month).padStart(2, '0')}-${String(dv.day).padStart(2, '0')}`
}

// ── State ──

const todos = ref<TodoItem[]>([])
const dialogOpen = ref(false)
const editingId = ref<string | null>(null)
const calendarOpen = ref(false)

const dialogForm = ref({
  text: '',
  dueDate: '' as string,
  repeat: 'none' as RepeatType,
  repeatDay: undefined as number | undefined,
})

const calendarValue = computed({
  get: () => dialogForm.value.dueDate ? strToDateValue(dialogForm.value.dueDate) : undefined,
  set: (val: DateValue | undefined) => {
    dialogForm.value.dueDate = val ? dateValueToStr(val) : ''
    calendarOpen.value = false
  },
})

// ── Store ──

const store = new LazyStore('todo.json')

onMounted(async () => {
  await store.init()
  const saved = await store.get<TodoItem[]>('todos')
  if (saved) todos.value = saved
})

watchDebounced(todos, async () => {
  await store.set('todos', toRaw(todos.value.map(t => ({ ...t }))))
  await store.save()
}, { deep: true, debounce: 500 })

// ── Computed ──

const incompleteItems = computed(() =>
  todos.value
    .filter(t => !t.completed)
    .sort((a, b) => {
      if (a.dueDate && !b.dueDate) return -1
      if (!a.dueDate && b.dueDate) return 1
      if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate)
      return new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
    })
)

const completedItems = computed(() =>
  todos.value
    .filter(t => t.completed)
    .sort((a, b) =>
      new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime()
    )
)

// ── Helpers ──

function repeatLabel(repeat: RepeatType, repeatDay: number | null): string {
  const base = REPEAT_OPTIONS.find(o => o.value === repeat)?.label || ''
  if (repeat === 'weekly' && repeatDay != null) return `${base} 周${WEEKDAYS[repeatDay]}`
  if (repeat === 'monthly' && repeatDay) return `${base} ${repeatDay}号`
  return base
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + 'T00:00')
  const now = new Date()
  const todayStr = now.toISOString().slice(0, 10)
  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  const tomorrowStr = tomorrow.toISOString().slice(0, 10)

  if (dateStr === todayStr) return '今天'
  if (dateStr === tomorrowStr) return '明天'
  if (date.getFullYear() === now.getFullYear()) {
    return `${date.getMonth() + 1}月${date.getDate()}日`
  }
  return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`
}

function formatRelativeTime(isoStr: string | null): string {
  if (!isoStr) return ''
  const diff = Date.now() - new Date(isoStr).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '刚刚'
  if (mins < 60) return `${mins}分钟前`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return formatDate(isoStr.slice(0, 10))
}

function isOverdue(item: TodoItem): boolean {
  if (!item.dueDate || item.completed) return false
  return item.dueDate < new Date().toISOString().slice(0, 10)
}

function daysInMonth(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate()
}

function getNextOccurrence(item: TodoItem): string | null {
  if (!item.dueDate || item.repeat === 'none') return null
  const base = new Date(`${item.dueDate}T00:00`)

  switch (item.repeat) {
    case 'daily':
      base.setDate(base.getDate() + 1)
      return base.toISOString().slice(0, 10)
    case 'weekdays':
      do { base.setDate(base.getDate() + 1) }
      while (base.getDay() === 0 || base.getDay() === 6)
      return base.toISOString().slice(0, 10)
    case 'weekly':
      base.setDate(base.getDate() + 7)
      return base.toISOString().slice(0, 10)
    case 'monthly': {
      base.setMonth(base.getMonth() + 1)
      if (item.repeatDay) base.setDate(Math.min(item.repeatDay, daysInMonth(base)))
      return base.toISOString().slice(0, 10)
    }
    case 'yearly':
      base.setFullYear(base.getFullYear() + 1)
      return base.toISOString().slice(0, 10)
  }
  return null
}

// ── Actions ──

function completeItem(item: TodoItem) {
  item.completed = true
  item.completedAt = new Date().toISOString()

  if (item.repeat !== 'none') {
    const nextDate = getNextOccurrence(item)
    if (nextDate) {
      todos.value.push({
        id: crypto.randomUUID(),
        text: item.text,
        completed: false,
        createdAt: new Date().toISOString(),
        completedAt: null,
        dueDate: nextDate,
        repeat: item.repeat,
        repeatDay: item.repeatDay,
      })
    }
  }
}

function uncompleteItem(item: TodoItem) {
  item.completed = false
  item.completedAt = null
}

function deleteItem(id: string) {
  todos.value = todos.value.filter(t => t.id !== id)
}

function clearCompleted() {
  todos.value = todos.value.filter(t => !t.completed)
}

// ── Dialog ──

function openAddDialog() {
  editingId.value = null
  dialogForm.value = { text: '', dueDate: '', repeat: 'none', repeatDay: undefined }
  dialogOpen.value = true
}

function editItem(item: TodoItem) {
  editingId.value = item.id
  dialogForm.value = {
    text: item.text,
    dueDate: item.dueDate || '',
    repeat: item.repeat,
    repeatDay: item.repeatDay ?? undefined,
  }
  dialogOpen.value = true
}

function confirmDialog() {
  const f = dialogForm.value
  if (!f.text.trim()) return

  if (editingId.value) {
    const item = todos.value.find(t => t.id === editingId.value)
    if (item) {
      item.text = f.text.trim()
      item.dueDate = f.dueDate || null
      item.repeat = f.repeat
      item.repeatDay = f.repeatDay ?? null
    }
  } else {
    todos.value.push({
      id: crypto.randomUUID(),
      text: f.text.trim(),
      completed: false,
      createdAt: new Date().toISOString(),
      completedAt: null,
      dueDate: f.dueDate || null,
      repeat: f.repeat,
      repeatDay: f.repeatDay ?? null,
    })
  }

  dialogOpen.value = false
}

function clearDate() {
  dialogForm.value.dueDate = ''
}
</script>

<template>
  <div class="h-full w-full flex flex-col p-8 relative">
    <div class="flex-1 overflow-hidden flex flex-col max-w-2xl mx-auto w-full">

      <ScrollArea class="flex-1">
        <div class="space-y-2 pr-3">

          <!-- Empty state -->
          <div v-if="incompleteItems.length === 0 && completedItems.length === 0"
            class="border border-dashed rounded-lg p-12 flex flex-col items-center justify-center space-y-4 text-muted-foreground/60 mt-4">
            <span class="icon-[lucide--circle-check-big] w-12 h-12" />
            <div class="text-center space-y-1">
              <h3 class="font-medium text-base">没有待办事项</h3>
              <p class="text-sm">点击右下角按钮添加任务</p>
            </div>
          </div>

          <!-- Incomplete items -->
          <div
            v-for="item in incompleteItems" :key="item.id"
            class="flex items-center gap-3 p-3 border border-dashed rounded-lg opacity-90 hover:bg-accent/50 transition-colors group cursor-pointer"
            @click="completeItem(item)"
          >
            <span class="icon-[lucide--circle] w-4.5 h-4.5 shrink-0 text-muted-foreground/50" />
            <span class="text-sm flex-1 min-w-0 truncate">{{ item.text }}</span>
            <span v-if="item.dueDate"
              class="text-xs shrink-0"
              :class="isOverdue(item) ? 'text-destructive' : 'text-muted-foreground'"
            >{{ formatDate(item.dueDate) }}</span>
            <span v-if="item.repeat !== 'none'"
              class="text-xs px-2 py-0.5 bg-secondary text-secondary-foreground shrink-0">
              {{ repeatLabel(item.repeat, item.repeatDay) }}
            </span>
            <button
              class="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-foreground"
              @click.stop="editItem(item)">
              <span class="icon-[lucide--pencil] w-3.5 h-3.5" />
            </button>
            <button
              class="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-muted-foreground hover:text-destructive"
              @click.stop="deleteItem(item.id)">
              <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
            </button>
          </div>

          <!-- Completed items -->
          <div
            v-for="item in completedItems" :key="item.id"
            class="flex items-center gap-3 p-3 border rounded-lg hover:bg-accent/50 transition-colors group cursor-pointer"
            @click="uncompleteItem(item)"
          >
            <span class="icon-[lucide--circle-check] w-4.5 h-4.5 shrink-0 text-muted-foreground/40" />
            <span class="text-sm flex-1 min-w-0 truncate line-through text-muted-foreground/50">{{ item.text }}</span>
            <span class="text-xs text-muted-foreground/40 shrink-0">{{ formatRelativeTime(item.completedAt) }}</span>
            <button
              class="opacity-0 group-hover:opacity-100 transition-opacity shrink-0 text-destructive hover:text-destructive"
              @click.stop="deleteItem(item.id)">
              <span class="icon-[lucide--trash-2] w-3.5 h-3.5" />
            </button>
          </div>

          <!-- Clear all completed -->
          <button v-if="completedItems.length > 1"
            class="text-xs text-muted-foreground/40 hover:text-destructive transition-colors pt-1"
            @click="clearCompleted">
            清除全部已完成
          </button>
        </div>
      </ScrollArea>
    </div>

    <!-- Floating add button -->
    <button
      class="absolute bottom-8 right-8 w-12 h-12 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg hover:opacity-80 transition-opacity"
      @click="openAddDialog"
      title="添加任务"
    >
      <span class="icon-[lucide--plus] w-5 h-5" />
    </button>
  </div>

  <!-- Add/Edit Dialog -->
  <Dialog v-model:open="dialogOpen">
    <DialogContent class="sm:max-w-105">
      <DialogHeader>
        <DialogTitle>{{ editingId ? '编辑任务' : '新建任务' }}</DialogTitle>
      </DialogHeader>

      <div class="flex flex-col gap-4">
        <Input v-model="dialogForm.text" placeholder="任务内容" @keydown.enter="confirmDialog" />

        <!-- Date picker: Popover + Calendar -->
        <Popover v-model:open="calendarOpen">
          <PopoverTrigger as-child>
            <Button variant="outline" :class="['w-full justify-start text-left font-normal', !dialogForm.dueDate && 'text-muted-foreground']">
              <span class="icon-[lucide--calendar] w-4 h-4 mr-2" />
              <span v-if="dialogForm.dueDate">{{ formatDate(dialogForm.dueDate) }}</span>
              <span v-else>选择日期</span>
              <button v-if="dialogForm.dueDate" class="ml-auto text-muted-foreground hover:text-foreground" @click.stop="clearDate">
                <span class="icon-[lucide--x] w-3.5 h-3.5" />
              </button>
            </Button>
          </PopoverTrigger>
          <PopoverContent class="w-auto p-0" align="start">
            <Calendar v-model="calendarValue" locale="zh-CN" />
          </PopoverContent>
        </Popover>

        <!-- Repeat -->
        <Select v-model="dialogForm.repeat">
          <SelectTrigger>
            <SelectValue placeholder="不重复" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem v-for="opt in REPEAT_OPTIONS" :key="opt.value" :value="opt.value">
              {{ opt.label }}
            </SelectItem>
          </SelectContent>
        </Select>

        <!-- Weekly: day picker -->
        <div v-if="dialogForm.repeat === 'weekly'" class="flex items-center gap-1.5">
          <span class="text-sm text-muted-foreground mr-1">每周</span>
          <button
            v-for="(day, i) in WEEKDAYS" :key="i"
            @click="dialogForm.repeatDay = i"
            :class="[
              'w-8 h-8 rounded-md text-xs font-medium transition-colors',
              dialogForm.repeatDay === i
                ? 'bg-primary text-primary-foreground'
                : 'border hover:bg-accent text-muted-foreground'
            ]"
          >{{ day }}</button>
        </div>

        <!-- Monthly: day input -->
        <div v-if="dialogForm.repeat === 'monthly'" class="flex items-center gap-2">
          <span class="text-sm text-muted-foreground">每月</span>
          <Input
            type="number"
            :min="1" :max="31"
            v-model.number="dialogForm.repeatDay"
            class="w-20 text-center"
          />
          <span class="text-sm text-muted-foreground">号</span>
        </div>
      </div>

      <DialogFooter>
        <Button variant="outline" @click="dialogOpen = false">取消</Button>
        <Button :disabled="!dialogForm.text.trim()" @click="confirmDialog">确认</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
