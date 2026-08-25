/**
 * 极简 i18n。
 *
 * 没有引 vue-i18n：只有中英两种语言、纯键值查找，不需要复数规则和消息编译器，
 * 自己这四十来行就够，也不用为此背一份运行时。真要上第三种语言或者复数变化再换。
 *
 * 语言来源的优先级：用户在设置里选过 → 用那个；没选过 → 看系统语言。
 * 系统语言用 navigator.language 读 —— WebView2 里它就是 Windows 的显示语言，
 * 不用为此再装 @tauri-apps/plugin-os。
 */
import { computed, reactive } from 'vue'
import { zh } from './zh'
import { en } from './en'

export type Locale = 'zh' | 'en'

/** 叶子放宽成 string:zh 用了 as const,不放宽的话英文那份会被要求逐字等于中文原文。 */
type DeepString<T> = { [K in keyof T]: T[K] extends string ? string : DeepString<T[K]> }
export type Messages = DeepString<typeof zh>

const DICTS: Record<Locale, Messages> = { zh, en }

/** 系统语言 → 我们支持的两种之一。中文的各种变体（zh-CN / zh-TW / zh-HK…）统统归到 zh。 */
export function detectLocale(): Locale {
  const langs = [navigator.language, ...(navigator.languages ?? [])]
  for (const l of langs) {
    if (!l) continue
    if (l.toLowerCase().startsWith('zh')) return 'zh'
    if (l.toLowerCase().startsWith('en')) return 'en'
  }
  return 'en'   // 既不是中文也不是英文的系统，给英文
}

const state = reactive<{ locale: Locale }>({ locale: detectLocale() })

export const locale = computed(() => state.locale)
export function setLocale(l: Locale) {
  state.locale = l
  document.documentElement.lang = l === 'zh' ? 'zh-CN' : 'en'
}

/**
 * 取一条文案。key 用点号分段，例如 t('settings.general')。
 * 找不到时回退到中文，再找不到就把 key 原样返回 —— 界面上出现 key 本身，
 * 比默默显示空字符串更容易被发现。
 */
export function t(key: string, vars?: Record<string, string | number>): string {
  const pick = (d: Messages) =>
    key.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), d)
  let s = pick(DICTS[state.locale])
  if (typeof s !== 'string') s = pick(DICTS.zh)
  if (typeof s !== 'string') return key
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v))
  return s
}

/**
 * 副窗口（截图、贴图）用：它们是独立的 WebView，各有一套 JS 环境，
 * 拿不到主窗口 useAppSettings 里那份 state。而 useAppSettings 一 import 就会
 * 起主题监听和自动保存，副窗口不需要也不该跟着写盘，所以这里只读语言这一个键。
 */
export async function applySavedLocale() {
  try {
    const { LazyStore } = await import('@tauri-apps/plugin-store')
    const store = new LazyStore('settings.json')
    await store.init()
    const saved = await store.get<{ language?: 'auto' | Locale }>('app_settings')
    const lang = saved?.language ?? 'auto'
    setLocale(lang === 'auto' ? detectLocale() : lang)
  } catch {
    setLocale(detectLocale())   // 读不到就跟系统，别把副窗口卡在这
  }
}

/** 组件里用：const { t } = useI18n()。t 是响应式的 —— 切语言时模板会自动重算。 */
export function useI18n() {
  return { t, locale, setLocale }
}
