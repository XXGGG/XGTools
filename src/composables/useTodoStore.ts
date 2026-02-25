import { ref, computed, toRaw } from 'vue'
import { watchDebounced } from '@vueuse/core'
import { LazyStore } from '@tauri-apps/plugin-store'
import type {
  LocalDate, DailyTaskItem, TaskSchedule, HabitItem, ReminderItem, TaskFlowItem, BacklogItem,
  TodoStoreData, ReminderFrequency, ReminderNotifyBefore, LegacyTodoItem,
} from '@/types/todo'

// ── 工具函数 ──

/** 获取本地日期字符串，修复 toISOString 的 UTC 时区问题 */
export function getLocalDate(date = new Date()): LocalDate {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

function genId(): string {
  return crypto.randomUUID()
}

// ── 模块级状态 ──

const dailytasks = ref<DailyTaskItem[]>([])
const habits = ref<HabitItem[]>([])
const reminders = ref<ReminderItem[]>([])
const taskflow = ref<TaskFlowItem[]>([])
const backlog = ref<BacklogItem[]>([])
const todayDate = ref(getLocalDate())

let store: LazyStore | null = null
let initialized = false
let saveQueued = false

// ── 持久化 ──

async function save() {
  if (!store) return
  const data: TodoStoreData = {
    version: 2,
    dailytasks: toRaw(dailytasks.value).map(d => ({ ...d, checkins: { ...d.checkins } })),
    habits: toRaw(habits.value).map(h => ({ ...h, checkins: { ...h.checkins } })),
    reminders: toRaw(reminders.value).map(r => ({ ...r, frequency: { ...r.frequency } })),
    taskflow: toRaw(taskflow.value).map(t => ({ ...t })),
    backlog: toRaw(backlog.value).map(b => ({ ...b })),
  }
  await store.set('data', data)
  await store.save()
}

function queueSave() {
  if (saveQueued) return
  saveQueued = true
  setTimeout(async () => {
    saveQueued = false
    await save()
  }, 500)
}

// ── 数据迁移 ──

function migrateFromV1(legacy: LegacyTodoItem[]): TodoStoreData {
  const data: TodoStoreData = {
    version: 2,
    dailytasks: [],
    habits: [],
    reminders: [],
    taskflow: [],
    backlog: [],
  }

  let habitOrder = 0
  let reminderOrder = 0
  let backlogOrder = 0

  for (const item of legacy) {
    // 已完成的旧数据丢弃
    if (item.completed) continue

    if (item.repeat === 'daily' || item.repeat === 'weekdays') {
      // 每天 / 工作日 → 习惯打卡
      data.habits.push({
        id: item.id,
        type: 'habit',
        text: item.text,
        icon: 'icon-[lucide--circle-check]',
        createdAt: getLocalDate(new Date(item.createdAt)),
        archived: false,
        checkins: {},
        sortOrder: habitOrder++,
      })
    } else if (item.repeat !== 'none') {
      // 其他重复 → 定期提醒
      let frequency: ReminderFrequency
      if (item.repeat === 'weekly') {
        frequency = { type: 'weekly', dayOfWeek: item.repeatDay ?? new Date().getDay() }
      } else if (item.repeat === 'monthly') {
        frequency = { type: 'monthly', day: item.repeatDay ?? 1 }
      } else {
        // yearly
        const d = item.dueDate ? new Date(item.dueDate + 'T00:00') : new Date()
        frequency = { type: 'yearly', month: d.getMonth() + 1, day: d.getDate() }
      }
      data.reminders.push({
        id: item.id,
        type: 'reminder',
        text: item.text,
        frequency,
        notifyBefore: 'same-day',
        lastAcknowledgedAt: null,
        createdAt: getLocalDate(new Date(item.createdAt)),
        sortOrder: reminderOrder++,
      })
    } else {
      // 无重复、未完成 → 待办池
      data.backlog.push({
        id: item.id,
        type: 'backlog',
        text: item.text,
        completed: false,
        createdAt: item.createdAt,
        completedAt: null,
        sortOrder: backlogOrder++,
      })
    }
  }

  return data
}

// ── 初始化 ──

async function init() {
  if (initialized) return
  initialized = true

  store = new LazyStore('todo.json')
  await store.init()

  // 尝试加载 v2 数据
  const saved = await store.get<TodoStoreData>('data')
  if (saved && saved.version === 2) {
    // 向后兼容：已有数据可能没有 dailytasks / schedule 字段
    dailytasks.value = (saved.dailytasks ?? []).map(d => ({
      ...d,
      schedule: d.schedule ?? { type: 'daily' as const },
    }))
    habits.value = saved.habits.map(h => {
      const { schedule: _, ...rest } = h as any
      return rest
    })
    reminders.value = saved.reminders.map(r => ({
      ...r,
      notifyBefore: r.notifyBefore ?? 'none' as const,
    }))
    taskflow.value = saved.taskflow
    backlog.value = saved.backlog
  } else {
    // 尝试迁移 v1 数据
    const legacy = await store.get<LegacyTodoItem[]>('todos')
    if (legacy && Array.isArray(legacy)) {
      const migrated = migrateFromV1(legacy)
      habits.value = migrated.habits
      reminders.value = migrated.reminders
      taskflow.value = migrated.taskflow
      backlog.value = migrated.backlog
      // 保存 v2 格式，并清除旧数据
      await save()
      await store.delete('todos')
      await store.save()
    }
  }

  // 30 秒轮询检测日期变化
  setInterval(() => {
    const now = getLocalDate()
    if (now !== todayDate.value) {
      todayDate.value = now
    }
  }, 30_000)

  // 自动保存
  watchDebounced([dailytasks, habits, reminders, taskflow, backlog], () => {
    queueSave()
  }, { deep: true, debounce: 500 })
}

// ── 每日任务 ──

function isDailyTaskCheckedToday(task: DailyTaskItem): boolean {
  return !!task.checkins[todayDate.value]
}

function toggleDailyTaskCheckin(task: DailyTaskItem) {
  if (task.checkins[todayDate.value]) {
    delete task.checkins[todayDate.value]
  } else {
    task.checkins[todayDate.value] = true
  }
}

function isDailyTaskActiveToday(task: DailyTaskItem): boolean {
  const schedule = task.schedule ?? { type: 'daily' }
  if (schedule.type === 'daily') return true
  const dayOfWeek = new Date().getDay() // 0=Sun
  if (schedule.type === 'weekdays') return dayOfWeek >= 1 && dayOfWeek <= 5
  return schedule.days.includes(dayOfWeek)
}

function addDailyTask(text: string, icon: string, schedule: TaskSchedule = { type: 'daily' }) {
  dailytasks.value.push({
    id: genId(),
    type: 'dailytask',
    text,
    icon,
    createdAt: todayDate.value,
    archived: false,
    checkins: {},
    schedule,
    sortOrder: dailytasks.value.length,
  })
}

function removeDailyTask(id: string) {
  dailytasks.value = dailytasks.value.filter(d => d.id !== id)
}

function updateDailyTask(id: string, updates: Partial<Pick<DailyTaskItem, 'text' | 'icon' | 'schedule'>>) {
  const d = dailytasks.value.find(d => d.id === id)
  if (d) Object.assign(d, updates)
}

// ── 习惯打卡 ──

function isHabitCheckedToday(habit: HabitItem): boolean {
  return !!habit.checkins[todayDate.value]
}

function toggleHabitCheckin(habit: HabitItem) {
  if (habit.checkins[todayDate.value]) {
    delete habit.checkins[todayDate.value]
  } else {
    habit.checkins[todayDate.value] = true
  }
}

function getHabitStreak(habit: HabitItem): number {
  let streak = 0
  const d = new Date()
  // 如果今天没打卡，从昨天开始算
  if (!habit.checkins[getLocalDate(d)]) {
    d.setDate(d.getDate() - 1)
  }
  while (habit.checkins[getLocalDate(d)]) {
    streak++
    d.setDate(d.getDate() - 1)
  }
  return streak
}

function addHabit(text: string, icon: string) {
  habits.value.push({
    id: genId(),
    type: 'habit',
    text,
    icon,
    createdAt: todayDate.value,
    archived: false,
    checkins: {},
    sortOrder: habits.value.length,
  })
}

function removeHabit(id: string) {
  habits.value = habits.value.filter(h => h.id !== id)
}

function updateHabit(id: string, updates: Partial<Pick<HabitItem, 'text' | 'icon'>>) {
  const h = habits.value.find(h => h.id === id)
  if (h) Object.assign(h, updates)
}

function reorderHabits(items: HabitItem[]) {
  habits.value = habits.value.map(h => {
    const idx = items.findIndex(i => i.id === h.id)
    return idx >= 0 ? { ...h, sortOrder: idx } : h
  }).sort((a, b) => a.sortOrder - b.sortOrder)
}

// ── 习惯统计 ──

/** 补打卡：切换任意日期的打卡状态 */
function toggleHabitCheckinForDate(habit: HabitItem, date: LocalDate) {
  if (date > todayDate.value) return
  if (habit.checkins[date]) {
    delete habit.checkins[date]
  } else {
    habit.checkins[date] = true
  }
}

/** 单习惯某月打卡次数 */
function getHabitMonthlyCheckins(habit: HabitItem, year: number, month: number): number {
  const prefix = `${year}-${String(month).padStart(2, '0')}`
  return Object.keys(habit.checkins).filter(d => d.startsWith(prefix)).length
}

/** 单习惯某月有效天数（createdAt ~ today） */
function getHabitMonthlyActiveDays(habit: HabitItem, year: number, month: number): number {
  const monthStart = `${year}-${String(month).padStart(2, '0')}-01`
  const daysInMonth = new Date(year, month, 0).getDate()
  const monthEnd = `${year}-${String(month).padStart(2, '0')}-${String(daysInMonth).padStart(2, '0')}`
  const effectiveStart = habit.createdAt > monthStart ? habit.createdAt : monthStart
  const effectiveEnd = todayDate.value < monthEnd ? todayDate.value : monthEnd
  if (effectiveStart > effectiveEnd) return 0
  const start = new Date(effectiveStart + 'T00:00')
  const end = new Date(effectiveEnd + 'T00:00')
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1
}

/** 单习惯月完成率 0-100 */
function getHabitMonthlyRate(habit: HabitItem, year: number, month: number): number {
  const active = getHabitMonthlyActiveDays(habit, year, month)
  if (active === 0) return 0
  return Math.round(getHabitMonthlyCheckins(habit, year, month) / active * 100)
}

/** 单习惯某年打卡总次数 */
function getHabitYearlyCheckins(habit: HabitItem, year: number): number {
  const prefix = `${year}-`
  return Object.keys(habit.checkins).filter(d => d.startsWith(prefix)).length
}

/** 单习惯某年有效天数 */
function getHabitYearlyActiveDays(habit: HabitItem, year: number): number {
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`
  const effectiveStart = habit.createdAt > yearStart ? habit.createdAt : yearStart
  const effectiveEnd = todayDate.value < yearEnd ? todayDate.value : yearEnd
  if (effectiveStart > effectiveEnd) return 0
  const start = new Date(effectiveStart + 'T00:00')
  const end = new Date(effectiveEnd + 'T00:00')
  return Math.floor((end.getTime() - start.getTime()) / 86400000) + 1
}

/** 单习惯年完成率 0-100 */
function getHabitYearlyRate(habit: HabitItem, year: number): number {
  const active = getHabitYearlyActiveDays(habit, year)
  if (active === 0) return 0
  return Math.round(getHabitYearlyCheckins(habit, year) / active * 100)
}

/** 某月所有习惯都完成的天数 */
function getPerfectDaysInMonth(year: number, month: number): number {
  const active = activeHabits.value
  if (active.length === 0) return 0
  const daysInMonth = new Date(year, month, 0).getDate()
  let perfect = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const ds = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`
    if (ds > todayDate.value) break
    const relevant = active.filter(h => h.createdAt <= ds)
    if (relevant.length > 0 && relevant.every(h => h.checkins[ds])) {
      perfect++
    }
  }
  return perfect
}

/** 总体月完成率 */
function getOverallMonthlyRate(year: number, month: number): number {
  const active = activeHabits.value
  if (active.length === 0) return 0
  let totalCheckins = 0
  let totalPossible = 0
  for (const h of active) {
    totalCheckins += getHabitMonthlyCheckins(h, year, month)
    totalPossible += getHabitMonthlyActiveDays(h, year, month)
  }
  if (totalPossible === 0) return 0
  return Math.round(totalCheckins / totalPossible * 100)
}

/** 单习惯一周内打卡次数 */
function getHabitWeeklyCheckins(habit: HabitItem, weekStartDate: LocalDate): number {
  let count = 0
  const d = new Date(weekStartDate + 'T00:00')
  for (let i = 0; i < 7; i++) {
    if (habit.checkins[getLocalDate(d)]) count++
    d.setDate(d.getDate() + 1)
  }
  return count
}

/** 单习惯最长连续天数 */
function getHabitLongestStreak(habit: HabitItem): number {
  const dates = Object.keys(habit.checkins).sort()
  if (dates.length === 0) return 0
  let longest = 1
  let current = 1
  for (let i = 1; i < dates.length; i++) {
    const prev = new Date(dates[i - 1] + 'T00:00')
    const curr = new Date(dates[i] + 'T00:00')
    if (curr.getTime() - prev.getTime() === 86400000) {
      current++
      if (current > longest) longest = current
    } else {
      current = 1
    }
  }
  return longest
}

/** 导出习惯数据为 JSON */
function exportHabitsJSON(habitIds?: Set<string>) {
  const list = habitIds
    ? activeHabits.value.filter(h => habitIds.has(h.id))
    : activeHabits.value
  return {
    exportedAt: new Date().toISOString(),
    app: 'XGTools',
    version: 1,
    habits: list.map(h => ({
      name: h.text,
      icon: h.icon,
      createdAt: h.createdAt,
      checkins: Object.keys(h.checkins).sort(),
    })),
  }
}

// ── 定期提醒 ──

function isReminderDue(reminder: ReminderItem): boolean {
  const today = todayDate.value
  const freq = reminder.frequency

  let dueDate: LocalDate
  const now = new Date()

  if (freq.type === 'monthly') {
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    const maxDay = new Date(y, m, 0).getDate()
    const day = Math.min(freq.day, maxDay)
    dueDate = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  } else if (freq.type === 'weekly') {
    // 找到本周该星期几的日期
    const currentDay = now.getDay()
    const diff = freq.dayOfWeek - currentDay
    const target = new Date(now)
    target.setDate(target.getDate() + diff)
    dueDate = getLocalDate(target)
  } else {
    // yearly
    const y = now.getFullYear()
    const maxDay = new Date(y, freq.month, 0).getDate()
    const day = Math.min(freq.day, maxDay)
    dueDate = `${y}-${String(freq.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  // 今天是到期日，且本周期未确认
  if (today === dueDate && reminder.lastAcknowledgedAt !== today) {
    return true
  }
  return false
}

/** 根据 notifyBefore 判断今天是否需要在总览页提醒用户 */
function shouldNotifyReminder(reminder: ReminderItem): boolean {
  if (reminder.notifyBefore === 'none') return false
  if (isReminderCompleted(reminder)) return false

  const now = new Date()
  const freq = reminder.frequency
  let dueDate: Date

  if (freq.type === 'monthly') {
    const y = now.getFullYear()
    const m = now.getMonth()
    const maxDay = new Date(y, m + 1, 0).getDate()
    const day = Math.min(freq.day, maxDay)
    dueDate = new Date(y, m, day)
  } else if (freq.type === 'weekly') {
    const currentDay = now.getDay()
    const diff = freq.dayOfWeek - currentDay
    dueDate = new Date(now)
    dueDate.setDate(dueDate.getDate() + diff)
    dueDate.setHours(0, 0, 0, 0)
  } else {
    const y = now.getFullYear()
    const maxDay = new Date(y, freq.month, 0).getDate()
    const day = Math.min(freq.day, maxDay)
    dueDate = new Date(y, freq.month - 1, day)
  }

  const todayMs = new Date(todayDate.value + 'T00:00').getTime()
  const dueMs = dueDate.getTime()

  if (reminder.notifyBefore === 'same-day') {
    return todayMs === dueMs
  } else if (reminder.notifyBefore === '1-day') {
    const oneDayMs = 86400000
    return todayMs >= dueMs - oneDayMs && todayMs <= dueMs
  } else {
    // '1-week'
    const oneWeekMs = 7 * 86400000
    return todayMs >= dueMs - oneWeekMs && todayMs <= dueMs
  }
}

function acknowledgeReminder(reminder: ReminderItem) {
  reminder.lastAcknowledgedAt = todayDate.value
}

function addReminder(text: string, frequency: ReminderFrequency, notifyBefore: ReminderNotifyBefore = 'none') {
  reminders.value.push({
    id: genId(),
    type: 'reminder',
    text,
    frequency,
    notifyBefore,
    lastAcknowledgedAt: null,
    createdAt: todayDate.value,
    sortOrder: reminders.value.length,
  })
}

function removeReminder(id: string) {
  reminders.value = reminders.value.filter(r => r.id !== id)
}

function updateReminder(id: string, updates: Partial<Pick<ReminderItem, 'text' | 'frequency' | 'notifyBefore'>>) {
  const r = reminders.value.find(r => r.id === id)
  if (r) Object.assign(r, updates)
}

// ── 任务流 ──

function addTaskFlowItem(text: string) {
  taskflow.value.push({
    id: genId(),
    type: 'taskflow',
    text,
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    sortOrder: taskflow.value.length,
  })
}

function toggleTaskFlowItem(id: string) {
  const item = taskflow.value.find(t => t.id === id)
  if (item) {
    item.completed = !item.completed
    item.completedAt = item.completed ? new Date().toISOString() : null
  }
}

function clearCompletedTaskFlow() {
  taskflow.value = taskflow.value.filter(t => !t.completed)
}

function removeTaskFlowItem(id: string) {
  taskflow.value = taskflow.value.filter(t => t.id !== id)
}

function updateTaskFlowItem(id: string, text: string) {
  const item = taskflow.value.find(t => t.id === id)
  if (item) item.text = text
}

function reorderTaskFlow(items: TaskFlowItem[]) {
  taskflow.value = items.map((item, i) => ({ ...item, sortOrder: i }))
}

// ── 待办池 ──

function addBacklogItem(text: string) {
  backlog.value.push({
    id: genId(),
    type: 'backlog',
    text,
    completed: false,
    createdAt: new Date().toISOString(),
    completedAt: null,
    sortOrder: backlog.value.length,
  })
}

function updateBacklogItem(id: string, text: string) {
  const item = backlog.value.find(b => b.id === id)
  if (item) item.text = text
}

function removeBacklogItem(id: string) {
  backlog.value = backlog.value.filter(b => b.id !== id)
}

// ── 任务流 ↔ 待办池互转 ──

function moveToTaskFlow(backlogId: string) {
  const item = backlog.value.find(b => b.id === backlogId)
  if (!item) return
  backlog.value = backlog.value.filter(b => b.id !== backlogId)
  taskflow.value.push({
    id: item.id,
    type: 'taskflow',
    text: item.text,
    completed: false,
    createdAt: item.createdAt,
    completedAt: null,
    sortOrder: taskflow.value.length,
  })
}

function moveToBacklog(taskflowId: string) {
  const item = taskflow.value.find(t => t.id === taskflowId)
  if (!item) return
  taskflow.value = taskflow.value.filter(t => t.id !== taskflowId)
  backlog.value.push({
    id: item.id,
    type: 'backlog',
    text: item.text,
    completed: false,
    createdAt: item.createdAt,
    completedAt: null,
    sortOrder: backlog.value.length,
  })
}

// ── 提醒增强 ──

/** 提前标记本周期已完成 */
function completeReminder(reminder: ReminderItem) {
  reminder.lastAcknowledgedAt = todayDate.value
}

/** 撤销本周期完成 */
function uncompleteReminder(reminder: ReminderItem) {
  reminder.lastAcknowledgedAt = null
}

/** 判断提醒本周期是否已完成 */
function isReminderCompleted(reminder: ReminderItem): boolean {
  if (!reminder.lastAcknowledgedAt) return false
  const freq = reminder.frequency
  const ack = reminder.lastAcknowledgedAt
  const now = new Date()

  if (freq.type === 'monthly') {
    // 本月内确认过
    const ackDate = new Date(ack + 'T00:00')
    return ackDate.getFullYear() === now.getFullYear() && ackDate.getMonth() === now.getMonth()
  } else if (freq.type === 'weekly') {
    // 本周内确认过（周一为起点）
    const ackDate = new Date(ack + 'T00:00')
    const todayMs = new Date(getLocalDate() + 'T00:00').getTime()
    const currentDay = now.getDay()
    const mondayOffset = currentDay === 0 ? 6 : currentDay - 1
    const weekStart = todayMs - mondayOffset * 86400000
    return ackDate.getTime() >= weekStart
  } else {
    // yearly: 本年内确认过
    const ackDate = new Date(ack + 'T00:00')
    return ackDate.getFullYear() === now.getFullYear()
  }
}

/** 获取提醒下一次到期的具体日期描述 */
function getNextReminderDate(reminder: ReminderItem): string {
  const freq = reminder.frequency
  const now = new Date()

  if (freq.type === 'monthly') {
    const y = now.getFullYear()
    const m = now.getMonth() + 1
    const maxDay = new Date(y, m, 0).getDate()
    const day = Math.min(freq.day, maxDay)
    return `${m}月${day}号`
  } else if (freq.type === 'weekly') {
    return WEEKDAYS[freq.dayOfWeek]
  } else {
    const y = now.getFullYear()
    const maxDay = new Date(y, freq.month, 0).getDate()
    const day = Math.min(freq.day, maxDay)
    return `${freq.month}月${day}号`
  }
}

// ── Computed ──

const activeDailyTasks = computed(() =>
  dailytasks.value.filter(d => !d.archived).sort((a, b) => a.sortOrder - b.sortOrder)
)

const todayDailyTasksDone = computed(() =>
  activeDailyTasks.value.filter(d => isDailyTaskCheckedToday(d)).length
)

const activeHabits = computed(() =>
  habits.value.filter(h => !h.archived).sort((a, b) => a.sortOrder - b.sortOrder)
)

const todayHabitsDone = computed(() =>
  activeHabits.value.filter(h => isHabitCheckedToday(h)).length
)

const dueReminders = computed(() =>
  reminders.value.filter(r => isReminderDue(r)).sort((a, b) => a.sortOrder - b.sortOrder)
)

const notifyingReminders = computed(() =>
  reminders.value.filter(r => shouldNotifyReminder(r)).sort((a, b) => a.sortOrder - b.sortOrder)
)

const activeTaskFlow = computed(() =>
  taskflow.value.filter(t => !t.completed).sort((a, b) => a.sortOrder - b.sortOrder)
)

const completedTaskFlow = computed(() =>
  taskflow.value.filter(t => t.completed).sort((a, b) =>
    new Date(b.completedAt!).getTime() - new Date(a.completedAt!).getTime()
  )
)

const activeBacklog = computed(() =>
  backlog.value.sort((a, b) => a.sortOrder - b.sortOrder)
)

// ── 提醒频率描述 ──

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function formatFrequency(freq: ReminderFrequency): string {
  if (freq.type === 'monthly') return `每月`
  if (freq.type === 'weekly') return `每${WEEKDAYS[freq.dayOfWeek]}`
  return `每年`
}

const NOTIFY_LABELS: Record<string, string> = {
  'none': '不提醒',
  'same-day': '当天提醒',
  '1-day': '提前1天',
  '1-week': '提前1周',
}

function formatNotifyBefore(nb: string): string {
  return NOTIFY_LABELS[nb] || '不提醒'
}

// ── 导出 ──

export function useTodoStore() {
  return {
    // 状态
    dailytasks,
    habits,
    reminders,
    taskflow,
    backlog,
    todayDate,

    // 计算属性
    activeDailyTasks,
    todayDailyTasksDone,
    activeHabits,
    todayHabitsDone,
    dueReminders,
    notifyingReminders,
    activeTaskFlow,
    completedTaskFlow,
    activeBacklog,

    // 初始化
    init,

    // 每日任务
    isDailyTaskActiveToday,
    isDailyTaskCheckedToday,
    toggleDailyTaskCheckin,
    addDailyTask,
    removeDailyTask,
    updateDailyTask,

    // 习惯
    isHabitCheckedToday,
    toggleHabitCheckin,
    toggleHabitCheckinForDate,
    getHabitStreak,
    getHabitLongestStreak,
    addHabit,
    removeHabit,
    updateHabit,
    reorderHabits,

    // 习惯统计
    getHabitMonthlyCheckins,
    getHabitMonthlyActiveDays,
    getHabitMonthlyRate,
    getHabitYearlyCheckins,
    getHabitYearlyActiveDays,
    getHabitYearlyRate,
    getPerfectDaysInMonth,
    getOverallMonthlyRate,
    getHabitWeeklyCheckins,
    exportHabitsJSON,

    // 提醒
    isReminderDue,
    isReminderCompleted,
    shouldNotifyReminder,
    acknowledgeReminder,
    completeReminder,
    uncompleteReminder,
    getNextReminderDate,
    addReminder,
    removeReminder,
    updateReminder,
    formatFrequency,
    formatNotifyBefore,

    // 任务流
    addTaskFlowItem,
    toggleTaskFlowItem,
    updateTaskFlowItem,
    removeTaskFlowItem,
    clearCompletedTaskFlow,
    reorderTaskFlow,

    // 待办池
    addBacklogItem,
    updateBacklogItem,
    removeBacklogItem,

    // 互转
    moveToTaskFlow,
    moveToBacklog,

    // 工具
    getLocalDate,
  }
}
