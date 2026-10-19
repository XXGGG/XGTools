/**
 * 24 小时待办：只记今天这 24 小时里要做完的事。
 *
 * 规矩（2026-10-19 用户定的）：不排 24 小时以后的事；一条立下就开始倒计时，
 * 默认期限是立下之后 24 小时，也可以挑更早的时间，但不能晚于 24 小时。
 * 主窗口的「待办」页和桌面上的置顶便签（todo_note 窗口）共用这份数据，改了就广播 todo24-changed。
 */
import { emit } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { currentMonitor } from '@tauri-apps/api/window'
import { LazyStore } from '@tauri-apps/plugin-store'

export type Todo = {
  id: string
  text: string
  createdAt: number
  /** 截止时刻（ms），最晚 createdAt + 24h */
  deadline: number
  doneAt?: number
}

export const DAY = 24 * 3600 * 1000
const store = new LazyStore('todo24.json')
let ready: Promise<void> | null = null
const init = () => (ready ??= store.init())

export async function loadTodos(): Promise<Todo[]> {
  await init()
  await store.reload().catch(() => {})
  return (await store.get<Todo[]>('items')) ?? []
}

export async function saveTodos(items: Todo[]) {
  await init()
  await store.set('items', items)
  await store.save()
  await emit('todo24-changed')
}

/** 「HH:mm」→ 接下来 24 小时内最近的那个时刻；已经过了就算明天的 */
export function nextAt(hhmm: string, now = Date.now()) {
  const [h, m] = hhmm.split(':').map(Number)
  const d = new Date(now)
  d.setHours(h, m, 0, 0)
  if (d.getTime() <= now) d.setTime(d.getTime() + DAY)
  return Math.min(d.getTime(), now + DAY)
}

/** 剩余时间写成「3:05:09」或者「已超时 12 分钟」 */
export function remaining(t: Todo, now = Date.now()) {
  const left = t.deadline - now
  if (left <= 0) {
    const over = Math.ceil(-left / 60000)
    return { text: over < 60 ? `已超时 ${over} 分钟` : `已超时 ${Math.floor(over / 60)} 小时`, over: true, ratio: 0 }
  }
  const s = Math.floor(left / 1000)
  const pad = (n: number) => String(n).padStart(2, '0')
  return { text: `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}`, over: false, ratio: left / (t.deadline - t.createdAt) }
}

/** 做完的、立下超过 24 小时的都算「过去了」：不在清单里显示（数据留着） */
export const isActive = (t: Todo, now = Date.now()) => !t.doneAt && now - t.createdAt < DAY + 6 * 3600 * 1000

export const NOTE_LABEL = 'todo_note'

/** 打开桌面上的置顶便签（记住上次的位置）；开着的话什么都不做 */
export async function openTodoNote() {
  if (await WebviewWindow.getByLabel(NOTE_LABEL)) return
  await init()
  const pos = await store.get<{ x: number; y: number }>('notePos')
  const mon = await currentMonitor().catch(() => null)
  const sf = mon?.scaleFactor ?? 1
  const sw = mon ? mon.size.width / sf : 1920
  new WebviewWindow(NOTE_LABEL, {
    url: 'index.html',
    title: 'XGTools 待办',
    width: 300,
    height: 360,
    x: pos?.x ?? (mon ? mon.position.x / sf : 0) + sw - 300 - 24,
    y: pos?.y ?? (mon ? mon.position.y / sf : 0) + 80,
    minWidth: 220,
    minHeight: 160,
    decorations: false,
    transparent: true,
    shadow: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    maximizable: false,
    minimizable: false,
  })
  await store.set('noteOpen', true)
  await store.save()
}


/** 启动时：上次开着便签就再开 */
export async function restoreTodoNote() {
  await init()
  if (await store.get<boolean>('noteOpen')) await openTodoNote()
}

/** 收起便签 */
export async function closeTodoNote() {
  await (await WebviewWindow.getByLabel(NOTE_LABEL))?.destroy()
  await init()
  await store.set('noteOpen', false)
  await store.save()
}

/** 便签挪了位置就记下来（便签窗口自己调） */
export async function saveNotePos(x: number, y: number) {
  await init()
  await store.set('notePos', { x, y })
  await store.save()
}
