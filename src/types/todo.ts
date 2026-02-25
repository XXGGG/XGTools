/** 本地日期字符串 'YYYY-MM-DD'，始终使用系统本地时区 */
export type LocalDate = string

// ── 0. 每日任务 ──

export type TaskSchedule =
  | { type: 'daily' }                    // 每天
  | { type: 'weekdays' }                 // 工作日（周一至周五）
  | { type: 'custom'; days: number[] }   // 自定义星期：[1,3,5] = 周一三五

export interface DailyTaskItem {
  id: string
  type: 'dailytask'
  text: string
  icon: string
  createdAt: LocalDate
  archived: boolean
  checkins: Record<LocalDate, boolean>
  schedule: TaskSchedule
  sortOrder: number
}

// ── 1. 习惯打卡（每天都要打卡，无需周期设置） ──

export interface HabitItem {
  id: string
  type: 'habit'
  text: string
  icon: string
  createdAt: LocalDate
  archived: boolean
  checkins: Record<LocalDate, boolean>
  sortOrder: number
}

// ── 2. 定期提醒 ──

export type ReminderFrequency =
  | { type: 'monthly'; day: number }
  | { type: 'weekly'; dayOfWeek: number } // 0=周日, 1=周一, ...
  | { type: 'yearly'; month: number; day: number }

export type ReminderNotifyBefore = 'none' | 'same-day' | '1-day' | '1-week'

export interface ReminderItem {
  id: string
  type: 'reminder'
  text: string
  frequency: ReminderFrequency
  notifyBefore: ReminderNotifyBefore
  lastAcknowledgedAt: LocalDate | null
  createdAt: LocalDate
  sortOrder: number
}

// ── 3. 任务流 ──

export interface TaskFlowItem {
  id: string
  type: 'taskflow'
  text: string
  completed: boolean
  createdAt: string
  completedAt: string | null
  sortOrder: number
}

// ── 4. 待办池 ──

export interface BacklogItem {
  id: string
  type: 'backlog'
  text: string
  completed: boolean
  createdAt: string
  completedAt: string | null
  sortOrder: number
}

// ── 存储结构 ──

export interface TodoStoreData {
  version: 2
  dailytasks: DailyTaskItem[]
  habits: HabitItem[]
  reminders: ReminderItem[]
  taskflow: TaskFlowItem[]
  backlog: BacklogItem[]
}

// ── 添加弹窗类型 ──

export type TodoItemType = 'dailytask' | 'habit' | 'reminder' | 'taskflow' | 'backlog'

// ── 旧版数据结构（用于迁移） ──

export interface LegacyTodoItem {
  id: string
  text: string
  completed: boolean
  createdAt: string
  completedAt: string | null
  dueDate: string | null
  repeat: 'none' | 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'yearly'
  repeatDay: number | null
}
