/**
 * 按时间自动切系统深色 / 浅色（启动台页里开）。
 *
 * 只在「跨过切换时刻」那一下切：比如 19:00 切深色之后你手动改回浅色，它不会每分钟又给你改回去，
 * 等到第二天 7:00 进入浅色时段才再动。打开开关时按现在的时段立刻切一次。
 */
import { invoke } from '@tauri-apps/api/core'
import { LazyStore } from '@tauri-apps/plugin-store'

export type AutoTheme = { enabled: boolean; lightAt: string; darkAt: string }
export const AUTO_THEME_DEFAULTS: AutoTheme = { enabled: false, lightAt: '07:00', darkAt: '19:00' }

const store = new LazyStore('autotheme.json')
let ready: Promise<void> | null = null
const init = () => (ready ??= store.init())

export async function loadAutoTheme(): Promise<AutoTheme> {
  await init()
  return { ...AUTO_THEME_DEFAULTS, ...((await store.get<Partial<AutoTheme>>('config')) ?? {}) }
}

export async function saveAutoTheme(c: AutoTheme) {
  await init()
  await store.set('config', c)
  // 改了时间 / 刚打开：清掉「这个时段已经切过」的记号，马上按新设置切一次
  await store.delete('applied')
  await store.save()
  await tick()
}

const minutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

/** 现在属于哪个时段：返回 { dark, key }，key 标记「哪天的哪一段」 */
function period(c: AutoTheme, now = new Date()) {
  const cur = now.getHours() * 60 + now.getMinutes()
  const l = minutes(c.lightAt), d = minutes(c.darkAt)
  const inLight = l <= d ? cur >= l && cur < d : cur >= l || cur < d
  // 跨过午夜的那段深色算前一天的（00:00–07:00 和昨晚 19:00 起是同一段）
  const day = new Date(now)
  if (!inLight && cur < l && l <= d) day.setDate(day.getDate() - 1)
  return { dark: !inLight, key: `${day.toDateString()}|${inLight ? 'light' : 'dark'}` }
}

async function tick() {
  const c = await loadAutoTheme()
  if (!c.enabled) return
  const p = period(c)
  if ((await store.get<string>('applied')) === p.key) return
  const isDark = await invoke<boolean>('system_theme_is_dark')
  if (isDark !== p.dark) await invoke('system_theme_set', { dark: p.dark })
  await store.set('applied', p.key)
  await store.save()
}

let timer = 0
/** 主窗口启动时调一次：之后每分钟看一眼 */
export function startAutoTheme() {
  if (timer) return
  timer = window.setInterval(() => void tick(), 60_000)
  void tick()
}
