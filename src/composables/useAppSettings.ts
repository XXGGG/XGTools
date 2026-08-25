/**
 * 全应用共享的设置状态(模块级单例)。
 * App.vue / TitleBar.vue / Settings.vue 引的是同一个 reactive 对象,
 * 所以设置页一改,侧栏和顶栏立刻跟着变,不需要事件通道。
 *
 * 持久化到 settings.json —— 该文件已被按键显示等功能使用,所以只读写自己的键,不整体覆盖。
 */
import { reactive, watch } from 'vue'
import { LazyStore } from '@tauri-apps/plugin-store'
import { invoke } from '@tauri-apps/api/core'
import { detectLocale, setLocale, type Locale } from '@/i18n'

// 没有 'blur':apply_blur 走的是 Win11 已废弃的 ACCENT_ENABLE_BLURBEHIND,渲染成一层压死的暗色,不可用
export type BlurKind = 'none' | 'mica' | 'acrylic'

export type AppSettings = {
  /** 配置格式版本。语义变了(而不只是加字段)时 +1,并在 loadSettings 里做一次性迁移。 */
  v: number
  /** 界面语言。'auto' = 跟随系统(每次启动重新检测),否则用用户选定的那个。 */
  language: Locale | 'auto'
  /** 主题。'auto' = 跟随系统深浅色,并在系统切换时实时跟着变。 */
  theme: ThemeMode
  blurKind: BlurKind
  /** 亚克力/模糊的不透明度 0~100:越小越通透,越大越接近实心 */
  blurOpacity: number
  sidebarOrder: string[]
  sidebarHidden: string[]
  /** 条目归哪一组的用户覆盖(id → 'tool' | 'config')。空表示用代码里的默认分组。 */
  sidebarGroups: Record<string, string>

  // ── 智能体页 ──
  /** 会话侧栏宽度(px)。用户可以拖,写回这里。范围由 AGENT_SIDEBAR 约束。 */
  agentSidebarWidth: number
  /** 空态那句招呼语。留空就用当前语言的默认文案 —— 存空串而不是存默认值,
   *  否则切语言时会被钉死在设置那天的那个语种上。 */
  agentGreeting: string
  /** 聊天区外观:'card' 和侧栏一样是张浮空卡片;'flat' 直接铺在窗口材质上,更透。 */
  agentChatSurface: ChatSurface

  // ── 笔记页 ──
  vaultTreeWidth: number
  vaultChatWidth: number
  /** 右边那栏收起来的状态。没配 DSH 的人不该被一个用不了的面板占掉屏幕。 */
  vaultChatOpen: boolean
}

/** 会话侧栏可拖的范围。maxRatio 是「最多占窗口宽的几成」—— 光设 max 挡不住小窗口下把聊天区挤没。 */
export const AGENT_SIDEBAR = { min: 200, max: 420, minChat: 460 } as const

export type ChatSurface = 'card' | 'flat'

const SETTINGS_VERSION = 2

const DEFAULTS: AppSettings = {
  v: SETTINGS_VERSION,
  language: 'auto',
  theme: 'auto',
  blurKind: 'none',
  blurOpacity: 40,
  sidebarOrder: [],
  sidebarHidden: [],
  sidebarGroups: {},
  agentSidebarWidth: 240,
  agentGreeting: '',
  agentChatSurface: 'card',
  vaultTreeWidth: 260,
  vaultChatWidth: 320,
  vaultChatOpen: true,
}

export const settings = reactive<AppSettings>({ ...DEFAULTS })

/** 首帧还没读到磁盘时为 false —— 用来避免「默认值先渲染一下再跳到真实值」的闪烁。 */
export const settingsReady = reactive({ value: false })

const KEY = 'app_settings'
let store: LazyStore | null = null
let loaded = false

/**
 * 强制重读一次设置。
 *
 * loadSettings 有 `if (loaded) return` 的一次性守卫,再调是空转 —— 对主窗口没问题
 * (它自己改自己),但**常驻的附属窗口(命令面板、托盘菜单)是独立 webview,
 * 各有一份自己的 settings**,主界面里改了主题/材质它们一无所知,
 * 会一直停在启动那一刻的样子。那两扇窗每次显示前要调这个。
 */
export async function reloadSettings() {
  loaded = false
  await loadSettings()
}

export async function loadSettings() {
  if (loaded) return
  loaded = true
  try {
    store = new LazyStore('settings.json')
    await store.init()
    const saved = await store.get<Partial<AppSettings>>(KEY)
    if (saved && typeof saved === 'object') {
      // 逐键合并:磁盘上没有的键保持默认,磁盘上多出来的旧键丢弃
      for (const k of Object.keys(DEFAULTS) as (keyof AppSettings)[]) {
        if (saved[k] !== undefined) (settings as any)[k] = saved[k]
      }
    }
  } catch (e) {
    console.error('读取设置失败,使用默认值:', e)
  } finally {
    // v1 → v2:blurOpacity 的含义从「卡片不透明度」改成「底面不透明度」,
    // 沿用旧值会让底面几乎不透明、看着像特效失效。语义变了就重置成新默认值。
    if (settings.v !== SETTINGS_VERSION) {
      settings.blurOpacity = DEFAULTS.blurOpacity
      settings.v = SETTINGS_VERSION
    }
    settings.blurOpacity = Math.min(100, Math.max(0, settings.blurOpacity))
    settings.agentSidebarWidth = Math.min(AGENT_SIDEBAR.max,
      Math.max(AGENT_SIDEBAR.min, Math.round(settings.agentSidebarWidth)))
    // 旧存档可能选的是已移除的高斯模糊,迁到亚克力,免得停在一个界面上不存在的选项
    if ((settings.blurKind as string) === 'blur') settings.blurKind = 'acrylic'
    // 语言:选了 auto 就每次启动重新看系统语言,否则用存档里选定的那个
    setLocale(settings.language === 'auto' ? detectLocale() : settings.language)
    applyTheme()
    watchSystemTheme()
    settingsReady.value = true
    startAutoSave()
  }
}

let saveTimer: number | undefined
function startAutoSave() {
  watch(settings, () => {
    if (!store) return
    window.clearTimeout(saveTimer)
    saveTimer = window.setTimeout(async () => {
      try {
        await store!.set(KEY, { ...settings })
        await store!.save()
      } catch (e) {
        console.error('保存设置失败:', e)
      }
    }, 300)
  }, { deep: true })
}

/**
 * 各材质真正「有效」的不透明度上限。
 * 超过这个值材质就被染实了,看着跟没开特效一样 —— 亚克力大约到 50、云母到 20 就到头。
 * 所以滑块对用户永远是 0~100(行程完整、两种材质一致),内部再缩放到各自的可用区间。
 */
const KIND_MAX: Record<BlurKind, number> = { none: 0, mica: 20, acrylic: 50 }

/** 把当前设置写进 CSS 变量。样式那边只认 --vibrancy-alpha,换算集中在这里一处。 */
export function applyVibrancyVars() {
  const alpha = (settings.blurOpacity / 100) * (KIND_MAX[settings.blurKind] ?? 0)
  document.documentElement.style.setProperty('--vibrancy-alpha', alpha.toFixed(2))
}


export type ThemeMode = 'auto' | 'dark' | 'light'

const DARK_QUERY = '(prefers-color-scheme: dark)'

/** 当前是否该用深色。auto 时读系统偏好。 */
export function isDarkNow(): boolean {
  if (settings.theme === 'dark') return true
  if (settings.theme === 'light') return false
  return window.matchMedia(DARK_QUERY).matches
}

/**
 * 把主题落到 DOM 上,并让窗口材质跟着换深浅。
 *
 * 不用 VueUse 的 useDark:它自带一套 localStorage 持久化,和我们的 settings.json
 * 就成了两个真相源,改一边另一边不知道。这里只认 settings.theme 一处。
 */
export function applyTheme() {
  document.documentElement.classList.toggle('dark', isDarkNow())
  void applyWindowEffect()   // 材质的深浅属性要跟着主题走
}

/**
 * 应用窗口背景材质。启动恢复、设置页改动、主题切换三处都走这里 ——
 * 散成几份迟早会不同步(深色属性就是最容易漏的那个)。
 *
 * 返回 null 表示成功,否则是错误消息。
 *
 * 注意 r/g/b/a 在 Win11 build >= 22523 上会被 DWM 忽略,仍然传是为了兼容老版本
 * 走 SetWindowCompositionAttribute 的那条路径。
 */
export async function applyWindowEffect(
  kind: BlurKind = settings.blurKind,
  /** 目标窗口。命令面板要跟主窗口用同一套材质,所以这里能指定标签。 */
  label?: string,
): Promise<string | null> {
  const dark = isDarkNow()
  const tint = dark ? [10, 10, 12] : [246, 246, 248]
  try {
    await invoke('set_window_effect', {
      kind,
      r: tint[0], g: tint[1], b: tint[2],
      a: Math.round((settings.blurOpacity / 100) * 255),
      dark,
      label,
    })
    return null
  } catch (e: any) {
    // 把错误消息回传而不是吞掉:设置页要把具体原因显示给用户(比如"云母不可用")
    return String(e?.message ?? e)
  }
}

/** 系统深浅色变化时,只有 auto 模式需要跟着动。 */
export function watchSystemTheme() {
  window.matchMedia(DARK_QUERY).addEventListener('change', () => {
    if (settings.theme === 'auto') applyTheme()
  })
}
